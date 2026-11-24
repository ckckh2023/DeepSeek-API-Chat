/**
 * 把冷路径接到真实世界：读本轮会话、读档案与便条、发请求、把结果写回去。
 *
 * `deriveProfile()` 刻意不认识网络与存储，所以这一层负责三件事：
 * 1. 取会话里「能进整理的轮次」（与上下文同规则：成对、且回答可用）；
 * 2. 用用户自己的 API Key 发一次 flash 请求，30 秒超时；
 * 3. 成功才落盘（档案 + 水位 + 便条回应 + 失败清零），失败只把失败计数 +1。
 *
 * 手动触发是这一步的唯一入口，自动调度留给下一步。
 */
import { createMessage } from '../api/client.js'
import type { CreateMessageRequest } from '../api/types.js'
import { loadSession } from '../chat/db.js'
import { useChatStore } from '../chat/store.js'
import type { Session } from '../chat/types.js'
import { useSettings } from '../settings.js'
import { deriveProfile, type DeriveOutcome } from './index.js'
import {
  configureMemoryAuto,
  createScheduler,
  latestActivitySession,
  pendingCount,
  requestAutoMemory,
  type SchedulerResult,
  type SchedulerSnapshot,
} from './scheduler.js'
import {
  readMemoryProfile,
  readMemoryState,
  writeMemoryProfile,
  writeMemoryState,
  type MemoryNote,
} from './store.js'
import { collectTurns } from './turns.js'

/** 整理请求的超时；超时算一次失败，旧档案一个字都不动 */
const DERIVE_TIMEOUT = 30 * 1000

/** 超时用 setTimeout + AbortController 手写：AbortSignal.timeout() 超出 legacy 目标 */
const sendWithTimeout = async (
  apiKey: string,
  request: CreateMessageRequest
): Promise<string> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DERIVE_TIMEOUT)
  try {
    return await createMessage(apiKey, request, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

const readSession = async (sessionId: string): Promise<Session | undefined> => {
  const cached = useChatStore.getState().sessionCache[sessionId]
  return cached ?? (await loadSession(sessionId))
}

/**
 * 手动整理的结果，两态判别联合：`blocked` 表示根本没发请求（原因不同，UI 提示也不同），
 * 否则必有 `outcome`。别拿一个 null 兼表「缺 Key」和「会话读不出来」，那会让用户
 * 以为要填的 Key 已经填过了。
 */
export type DeriveResult =
  | { readonly blocked: 'no-key' | 'no-session' }
  | { readonly blocked?: undefined; readonly outcome: DeriveOutcome }

/**
 * 把本次整理的便条回应合回当前的便条列表。
 *
 * `deriveProfile()` 看到的是 30 秒前的便条快照，这期间用户可能又写了一条。
 * 所以只把「已有 id 的回应」抄回去，列表以当前为准。
 */
const mergeNotes = (
  current: readonly MemoryNote[],
  resolved: readonly MemoryNote[]
): readonly MemoryNote[] => {
  const byId = new Map(resolved.map((note) => [note.id, note]))
  return current.map((note) => {
    const next = byId.get(note.id)
    if (!next) {
      return note
    }
    return {
      ...note,
      ...(next.reply ? { reply: next.reply } : {}),
      ...(next.resolvedAt ? { resolvedAt: next.resolvedAt } : {}),
    }
  })
}

/**
 * 手动整理一次指定会话。
 *
 * 没有 Key 时「只留未处理计数」—— 活动记录由回答收尾处写，这里不动水位。
 */
export const deriveMemoryForSession = async (
  sessionId: string | null
): Promise<DeriveResult> => {
  const apiKey = useSettings.getState().apiKey ?? ''
  if (!apiKey) {
    return { blocked: 'no-key' }
  }
  // 欢迎页（没有活动会话）时不算「缺 Key」：没有东西可整理而已
  if (sessionId === null) {
    return { blocked: 'no-session' }
  }
  const session = await readSession(sessionId)
  if (!session) {
    return { blocked: 'no-session' }
  }
  // 读一次就够：水位、便条、失败计数都来自同一份快照，避免三次读之间被写
  const state = readMemoryState()
  const outcome = await deriveProfile({
    profile: readMemoryProfile(),
    notes: state.notes,
    messages: collectTurns(session),
    processedCount: state.watermarks[sessionId]?.processedCount ?? 0,
    failures: state.failures,
    now: Date.now(),
    send: (request) => sendWithTimeout(apiKey, request),
  })
  // 落盘前重新读一次：上面那次请求最长挂 30 秒，这期间用户可能又聊了几轮
  // （活动记录被写过）、写了新便条、或关掉了自动整理。拿 30 秒前的快照整体覆盖
  // 会把这些写回去，所以只覆盖本次整理真正拥有的字段。
  const fresh = readMemoryState()
  if (outcome.status === 'updated') {
    // 档案、水位、便条回应同一笔落盘：要么都成，要么都不成
    writeMemoryProfile(outcome.profile)
    // 便条也按 id 合并：这期间新写的便条不在 outcome 里，直接用它会把新便条抹掉
    writeMemoryState({
      ...fresh,
      notes: mergeNotes(fresh.notes, outcome.notes),
      watermarks: {
        ...fresh.watermarks,
        [sessionId]: { processedCount: outcome.processedCount, at: outcome.profile.updatedAt },
      },
      failures: 0,
      lastDerivedAt: outcome.profile.updatedAt,
    })
  } else if (outcome.status === 'failed') {
    writeMemoryState({ ...fresh, failures: outcome.failures })
  }
  return { outcome }
}

/**
 * 整理目标：当前打开的会话；停在欢迎页（`activeId` 为 `null`）时取最近聊过的那个。
 *
 * 少了后半句，「关掉标签页隔天再打开、未整理轮次被补上」就永远补不上：
 * 重开应用落在欢迎页，没有活动会话可整理，积压会一直躺着。
 */
const targetSessionId = (): string | null => {
  const chat = useChatStore.getState()
  if (chat.activeId !== null) {
    return chat.activeId
  }
  // 欢迎页：挑最近聊过的、且确实还在的会话。已删除的会话若还在记忆状态里，
  // 整理它只会回 no-session，追赶就此卡死在一个不存在的会话上
  const known = new Set(chat.sessions.map((session) => session.id))
  return latestActivitySession(readMemoryState(), (id) => known.has(id))
}

/**
 * 判定用的快照：只读，不写。
 *
 * 每一项都现取而不是缓存：会话可能刚被切走、失败计数可能刚被手动整理清零、
 * 「正在回答」每秒都在变。缓存任何一项都会让「整理插进半轮答复」这类错误重新出现。
 */
const schedulerSnapshot = (sessionId: string | null): SchedulerSnapshot => {
  const memory = readMemoryState()
  const chat = useChatStore.getState()
  return {
    pending: pendingCount(memory, sessionId),
    lastActivityAt: sessionId ? (memory.activity[sessionId]?.at ?? 0) : 0,
    memoryEnabled: useSettings.getState().pluginSettings.memory?.enabled === true,
    failures: memory.failures,
    hasKey: Boolean(useSettings.getState().apiKey),
    streaming: chat.activeId !== null && Object.hasOwn(chat.streaming, chat.activeId),
  }
}

const scheduler = createScheduler({
  target: targetSessionId,
  snapshot: schedulerSnapshot,
  derive: (sessionId) => deriveMemoryForSession(sessionId),
  // 闸门直接读存储，不读快照：快照是判定用的世界状态，这是「用户有没有关掉它」
  autoEnabled: () => readMemoryState().autoEnabled,
})

/** 空闲检查的周期：判据本身看的是「距最后活动 5 分钟」，一分钟看一次足够 */
const IDLE_CHECK_INTERVAL = 60 * 1000

/**
 * 接线：`chat/store.ts` 在回答收尾、启动、切会话三处调用 `requestAutoMemory()`，
 * 这里负责注册真正能跑整理的 runner，并起一个空闲检查的定时器。
 *
 * 定时器只活在这一次页面打开期间 —— 关掉标签页就没了，所以「隔天再打开」靠的是
 * `opened` 那一处追赶，而不是定时器。
 *
 * 返回清理函数：App 卸载时撤销注册、停掉定时器。没接线时宿主的调用是空操作。
 */
export const setupMemoryAuto = (): (() => void) => {
  configureMemoryAuto(scheduler)
  // 定时器留在闭包里而不是模块级变量：严格模式下 effect 会跑两遍，模块级单例会被第二次
  // setup 覆盖，第一次的清理函数再跑就清不掉后来那个，留下一个永不停止的轮询。
  const timer = setInterval(() => {
    requestAutoMemory('idle')
  }, IDLE_CHECK_INTERVAL)
  return () => {
    clearInterval(timer)
    configureMemoryAuto(null)
  }
}

/**
 * 手动「立即整理」。
 *
 * 走调度器而不是直接调 `deriveMemoryForSession`：单飞锁由调度器统一持有，
 * 自动整理正跑着时点这个按钮只会拿到 `busy`，不会叠出第二个请求。
 * 手动不看退避（暂停期间用户点一次就是「解除」的意思），成功后退避自然消失。
 */
export const requestManualMemory = (): Promise<SchedulerResult> => scheduler.requestManual()
