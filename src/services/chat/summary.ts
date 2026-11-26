import { createMessage } from '../api/client.js'
import type { CreateMessageRequest, MessageParam } from '../api/types.js'
import { collectTurns, type MemoryTurn } from '../memory/turns.js'
import type { TranslationKey } from '../../i18n/index.js'
import { useSettings } from '../settings.js'
import { useChatStore } from './store.js'
import { loadSession } from './db.js'
import type { Session } from './types.js'


/** 交给下一个 AI 的交接提示词；用户定稿，不参与翻译 */
export const SUMMARY_PROMPT =
  '你的上下文满了，我现在需要你梳理所有的人设、剧情、时间线、注意事项、世界观、你的文笔还有语言风格和逻辑思维，交给下一个AI,让它能和你一样继续描写'

/** 最多带上最近 30 轮（问 + 答），单条正文截断 4000 字 */
const MAX_TURNS = 30
const MAX_TURN_CHARS = 4000

const SUMMARY_TIMEOUT = 60 * 1000

export type SummaryResult =
  | { readonly blocked: 'no-key' | 'no-session' | 'empty' }
  | { readonly blocked?: undefined; readonly text: string }

export const BLOCKED_TOAST: Record<
  NonNullable<SummaryResult['blocked']>,
  TranslationKey
> = {
  'no-key': 'summaryNoKey',
  'no-session': 'summaryNoSession',
  empty: 'summaryEmpty',
}

const readSession = async (sessionId: string): Promise<Session | undefined> => {
  const cached = useChatStore.getState().sessionCache[sessionId]
  return cached ?? (await loadSession(sessionId))
}

/** 字符数按码点算，与记忆整理同口径 */
const charCount = (text: string): number => [...text].length

const fit = (text: string, limit: number): string =>
  charCount(text) <= limit ? text : [...text].slice(0, limit).join('').trim()

/** 把会话轮次翻成请求消息：历史按角色展开，末尾追加交接提示词 */
export const buildSummaryMessages = (turns: readonly MemoryTurn[]): MessageParam[] => {
  const recent = turns.slice(-MAX_TURNS * 2)
  const messages: MessageParam[] = recent.map((turn) =>
    turn.role === 'user'
      ? { role: 'user' as const, content: fit(turn.text, MAX_TURN_CHARS) }
      : {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: fit(turn.text, MAX_TURN_CHARS) }],
        }
  )
  messages.push({ role: 'user', content: SUMMARY_PROMPT })
  return messages
}

/**
 * 手动总结一次指定会话。
 *
 * 失败（网络 / 协议）直接抛错由 UI 提示；没有 Key、读不到会话、没有上下文时
 * 返回 `blocked`，根本不发请求，避免白花一次调用。
 */
const runSummary = async (sessionId: string): Promise<SummaryResult> => {
  const apiKey = useSettings.getState().apiKey ?? ''
  if (!apiKey) {
    return { blocked: 'no-key' }
  }
  const session = await readSession(sessionId)
  if (!session) {
    return { blocked: 'no-session' }
  }
  const messages = buildSummaryMessages(collectTurns(session))
  if (messages.length <= 1) {
    return { blocked: 'empty' }
  }
  const request: CreateMessageRequest = {
    model: 'deepseek-flash',
    system: '',
    messages,
    thinking: { type: 'disabled' },
    tools: [],
    safety_check: { level: 'low' },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT)
  try {
    const text = (await createMessage(apiKey, request, controller.signal)).trim()
    if (!text) {
      throw new Error('empty-summary')
    }
    return { text }
  } finally {
    clearTimeout(timer)
  }
}

/** 已完成的总结：再次打开弹窗直接显示上次内容，不重复发请求 */
const cache = new Map<string, string>()

/** 进行中的总结：同一会话的重复触发复用它，避免并发发请求、白花一次调用 */
const inFlight = new Map<string, Promise<SummaryResult>>()

export const requestSummary = (
  sessionId: string,
  options: { refresh?: boolean } = {}
): Promise<SummaryResult> => {
  if (!options.refresh) {
    const cached = cache.get(sessionId)
    if (cached !== undefined) {
      return Promise.resolve({ text: cached })
    }
  }
  const running = inFlight.get(sessionId)
  if (running) {
    return running
  }
  const task = runSummary(sessionId)
    .then((result) => {
      if (result.blocked === undefined) {
        cache.set(sessionId, result.text)
      }
      return result
    })
    .finally(() => {
      if (inFlight.get(sessionId) === task) {
        inFlight.delete(sessionId)
      }
    })
  inFlight.set(sessionId, task)
  return task
}

/** 会话被删除或内容大改时可丢弃缓存；目前只在需要强制刷新时由 UI 触发 */
export const clearSummaryCache = (sessionId: string) => {
  cache.delete(sessionId)
}