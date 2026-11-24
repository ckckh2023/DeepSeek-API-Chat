/**
 * 记忆的宿主侧存储。
 *
 * 两个键，职责不同：
 * - `memory-profile`：派生物（三段 + 未解决清单 + 时间戳）。随时可删、可重建，原始会话一条不动。
 * - `memory-state`：控制数据（便条、每会话水位、失败计数、最后活动）。体积小，随读随写。
 *
 * 为什么不塞进 `pluginSettings.memory.config`：开关、正文、档案挤在一份 JSON 里等于给档案开
 * 第二套写入路径，而且 `config.text` 的语义是「覆盖插件内置正文」，档案不是正文。
 *
 * 铁律二只约束插件目录：插件不读 localStorage，档案由宿主在这里读出、经
 * `withMemoryProfile()` 挂到插件状态上传进去。
 */
import type { MemoryProfile } from '../../plugins/memory/prompt.js'
import { readProfile } from '../../plugins/memory/prompt.js'
import { createId } from '../../utils/id.js'

/** 派生物：档案独立一个键，注入时只读这一份 */
const PROFILE_KEY = 'deepseek-api-chat:memory-profile'
/** 控制数据：便条、水位、失败计数、最后活动 */
const STATE_KEY = 'deepseek-api-chat:memory-state'

/** 用户便条：输入而非输出。用户写，整理必须逐条回应 */
export interface MemoryNote {
  readonly id: string
  /** 单行，禁止换行 */
  readonly text: string
  readonly createdAt: number
  /** 整理回应后置位 */
  resolvedAt?: number
  /** 整理的回应：已改 / 没改，因为… */
  reply?: string
}

/** 每会话水位：记条数不记 id，序列变了由下界守卫兜住 */
export interface SessionWatermark {
  /** 已纳入整理的消息条数 */
  readonly processedCount: number
  readonly at: number
}

/**
 * 每会话最后活动。在回答结束的收尾处写，不挂在通用存盘出口：
 * `persist()` 被编辑、切分支、切版本共用，拿它当「又完成一轮」是错的。
 *
 * `turnCount` 必须与 `SessionWatermark.processedCount` 用同一把尺子：都是
 * `collectTurns()` 过滤后的条数（只算能进上下文的答疑对）。记原始可见条数会让第三步按
 * 差值算「未处理」时恒为负 —— 两个数都叫「条数」，但量的不是同一批东西。
 */
export interface SessionActivity {
  readonly turnCount: number
  readonly at: number
}

export interface MemoryState {
  notes: readonly MemoryNote[]
  watermarks: Readonly<Record<string, SessionWatermark>>
  activity: Readonly<Record<string, SessionActivity>>
  /** 连续失败次数，成功后清零；连续 3 次暂停自动整理，手动整理可解除 */
  failures: number
  lastDerivedAt: number
  /** 用户关掉自动整理时只留手动触发；默认开启，与插件开关相互独立 */
  autoEnabled: boolean
}

const emptyState = (): MemoryState => ({
  notes: [],
  watermarks: {},
  activity: {},
  failures: 0,
  lastDerivedAt: 0,
  autoEnabled: true,
})

const readItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 存储不可用（隐私模式 / 配额满）时静默跳过：最坏只是这轮没注入
  }
}

const removeItem = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch {
    // 同上
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

/** 收窄一条便条；坏数据整条丢弃，坏掉的便条不该让整理请求崩掉 */
const parseNote = (value: unknown): MemoryNote | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.text !== 'string') {
    return null
  }
  const text = value.text.replace(/\s+/g, ' ').trim()
  if (!value.id || !text) {
    return null
  }
  const resolvedAt = asCount(value.resolvedAt)
  const reply = typeof value.reply === 'string' ? value.reply : ''
  return {
    id: value.id,
    text,
    createdAt: asCount(value.createdAt),
    ...(resolvedAt > 0 ? { resolvedAt } : {}),
    ...(reply ? { reply } : {}),
  }
}

const parseWatermarks = (value: unknown): Record<string, SessionWatermark> => {
  const result: Record<string, SessionWatermark> = {}
  if (!isRecord(value)) {
    return result
  }
  for (const [id, entry] of Object.entries(value)) {
    if (isRecord(entry)) {
      result[id] = { processedCount: asCount(entry.processedCount), at: asCount(entry.at) }
    }
  }
  return result
}

const parseActivity = (value: unknown): Record<string, SessionActivity> => {
  const result: Record<string, SessionActivity> = {}
  if (!isRecord(value)) {
    return result
  }
  for (const [id, entry] of Object.entries(value)) {
    if (isRecord(entry)) {
      result[id] = { turnCount: asCount(entry.turnCount), at: asCount(entry.at) }
    }
  }
  return result
}

/** 读控制数据；坏数据按默认值兜底，不让记忆把应用卡住 */
export const readMemoryState = (): MemoryState => {
  try {
    const parsed: unknown = JSON.parse(readItem(STATE_KEY) ?? '{}')
    if (!isRecord(parsed)) {
      return emptyState()
    }
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.flatMap((value) => {
          const note = parseNote(value)
          return note ? [note] : []
        })
      : []
    return {
      notes,
      watermarks: parseWatermarks(parsed.watermarks),
      activity: parseActivity(parsed.activity),
      failures: asCount(parsed.failures),
      lastDerivedAt: asCount(parsed.lastDerivedAt),
      // 缺字段按开启：老数据里没有这一项，不该让自动整理莫名关掉
      autoEnabled: parsed.autoEnabled !== false,
    }
  } catch {
    return emptyState()
  }
}

export const writeMemoryState = (state: MemoryState): void => {
  writeItem(
    STATE_KEY,
    JSON.stringify({
      notes: state.notes,
      watermarks: state.watermarks,
      activity: state.activity,
      failures: state.failures,
      lastDerivedAt: state.lastDerivedAt,
      autoEnabled: state.autoEnabled,
    })
  )
}

/** 自动整理开关；与插件开关分开：关掉它仍然可以手动整理 */
export const setMemoryAutoEnabled = (autoEnabled: boolean): void => {
  writeMemoryState({ ...readMemoryState(), autoEnabled })
}

/** 读当前档案；没有或坏数据时给一份空档案 */
export const readMemoryProfile = (): MemoryProfile => {
  try {
    return readProfile(JSON.parse(readItem(PROFILE_KEY) ?? '{}'))
  } catch {
    return readProfile(undefined)
  }
}

/** 写档案；只写三段 + 未解决清单 + 更新时间与已看轮数 */
export const writeMemoryProfile = (profile: MemoryProfile): void => {
  writeItem(
    PROFILE_KEY,
    JSON.stringify({
      identity: profile.identity,
      preferences: profile.preferences,
      ongoing: profile.ongoing,
      unresolved: profile.unresolved,
      updatedAt: profile.updatedAt,
      turnsSeen: profile.turnsSeen,
    })
  )
}

/**
 * 记一次会话活动：回答结束的收尾处调用。
 *
 * 只写「整理口径下现在有多少条、什么时候」，不推进已处理条数 —— 那要等整理真的成功。
 * 调用方必须传 `collectTurns()` 过滤后的条数，理由见 `SessionActivity`。
 */
export const noteSessionActivity = (sessionId: string, turnCount: number, now: number): void => {
  const state = readMemoryState()
  writeMemoryState({
    ...state,
    activity: { ...state.activity, [sessionId]: { turnCount, at: now } },
  })
}

/** 记一条便条。用户不改档案，只写便条，下次整理逐条回应（spec《便条》） */
export const addMemoryNote = (text: string, now: number): MemoryNote | null => {
  // 单行：换行压成空格。空便条不入库，否则整理会为一条空行要求一次回应
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) {
    return null
  }
  const note: MemoryNote = { id: createId(), text: line, createdAt: now }
  const state = readMemoryState()
  writeMemoryState({ ...state, notes: [...state.notes, note] })
  return note
}

/**
 * 忘掉一个会话的水位与活动记录。
 *
 * 删会话时必须调：留着旧记录会让「最近聊过的会话」选中一个已经不存在的 id，
 * 启动追赶整理它只会回 `no-session`，追赶就此卡死，别的会话的积压永远补不上。
 */
export const forgetSession = (sessionId: string): void => {
  const state = readMemoryState()
  // 用过滤而不是 delete：动态键删除会把这些对象推进字典模式，oxlint 也禁这一手
  const watermarks = Object.fromEntries(
    Object.entries(state.watermarks).filter(([id]) => id !== sessionId)
  )
  const activity = Object.fromEntries(
    Object.entries(state.activity).filter(([id]) => id !== sessionId)
  )
  if (
    Object.keys(watermarks).length === Object.keys(state.watermarks).length &&
    Object.keys(activity).length === Object.keys(state.activity).length
  ) {
    return
  }
  writeMemoryState({ ...state, watermarks, activity })
}

/** 清空全部记忆：档案与状态一起删，会话消息一条不动 */
export const clearMemory = (): void => {
  removeItem(PROFILE_KEY)
  removeItem(STATE_KEY)
}
