import { getVisibleMessages } from './branches.js'
import { loadAllSessions, loadSession, reportStorageError } from './db.js'
import { initChat, useChatStore } from './store.js'
import type { AssistantMessage, Message, Session } from './types.js'

export type SearchHit = {
  sessionId: string
  sessionTitle: string
  updatedAt: number
  /** 标题命中时为 null，点击只打开会话 */
  messageId: string | null
  role: 'user' | 'assistant' | null
  /** 展示用片段：已压掉换行，命中词附近截取 */
  snippet: string
}

type IndexedMessage = { id: string; role: 'user' | 'assistant'; text: string }

type IndexedSession = { updatedAt: number; messages: IndexedMessage[] }

/** 一次读取全部会话正文建索引；之后只补读新增或更新过的会话 */
const index = new Map<string, IndexedSession>()
let initialized = false
let loading: Promise<void> | null = null
/** 切换数据空间时递增，进行中的构建结果据此丢弃。 */
let indexEpoch = 0

/** 每条消息取一条命中即可，结果太多反而难找 */
const RESULT_LIMIT = 60
/** 补索引时同时读取的会话数，避免一次并发打满 IndexedDB */
const LOAD_CHUNK = 6

const assistantText = (message: AssistantMessage) =>
  message.blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')

const messageText = (message: Message) =>
  message.role === 'user' ? message.content : assistantText(message)

const buildEntry = (session: Session): IndexedSession => ({
  updatedAt: session.updatedAt,
  messages: getVisibleMessages(session).flatMap((message) => {
    const text = messageText(message).trim()
    return text ? [{ id: message.id, role: message.role, text }] : []
  }),
})

/** 新建或刚复制出来的会话直接写入索引；索引尚未初始化时等首次全量构建即可。 */
export const registerSession = (session: Session) => {
  if (initialized) {
    index.set(session.id, buildEntry(session))
  }
}

/** 只补读取摘要里新出现或更新时间变化的会话，删除的会话直接丢掉 */
const refreshIndex = async (epoch: number) => {
  if (epoch !== indexEpoch) {
    return
  }
  const state = useChatStore.getState()
  const summaries = state.sessions
  const known = new Set(summaries.map((session) => session.id))
  for (const id of [...index.keys()]) {
    if (epoch !== indexEpoch) {
      return
    }
    if (!known.has(id)) {
      index.delete(id)
    }
  }
  const stale = summaries.filter(
    (summary) => index.get(summary.id)?.updatedAt !== summary.updatedAt
  )
  for (let start = 0; start < stale.length; start += LOAD_CHUNK) {
    await Promise.all(
      stale.slice(start, start + LOAD_CHUNK).map(async (summary) => {
        const cache = useChatStore.getState().sessionCache
        const session = Object.hasOwn(cache, summary.id)
          ? cache[summary.id]
          : await loadSession(summary.id)
        if (session && epoch === indexEpoch) {
          index.set(summary.id, buildEntry(session))
        }
      })
    )
    if (epoch !== indexEpoch) {
      return
    }
  }
}

export const isSearchIndexReady = () => initialized

/** 切换数据空间后丢弃旧库索引，下次打开搜索按当前库重建。 */
export const resetSearchIndex = () => {
  indexEpoch += 1
  index.clear()
  initialized = false
  loading = null
}

/** 打开搜索时调用：首次全量读取，之后增量刷新 */
export const ensureSearchIndex = (): Promise<void> => {
  if (loading) {
    return loading
  }
  const epoch = indexEpoch
  loading = (async () => {
    try {
      // 会话列表还没加载完时先等初始化，否则索引会拿到空列表
      if (!useChatStore.getState().ready) {
        await initChat()
      }
      if (epoch !== indexEpoch) {
        return
      }
      if (!initialized) {
        const known = new Set(useChatStore.getState().sessions.map((session) => session.id))
        const sessions = await loadAllSessions()
        if (epoch !== indexEpoch) {
          return
        }
        for (const session of sessions) {
          // 读取期间被删除的会话不再进入索引
          if (known.has(session.id)) {
            index.set(session.id, buildEntry(session))
          }
        }
        initialized = true
      }
      await refreshIndex(epoch)
    } catch (error) {
      if (epoch === indexEpoch) {
        reportStorageError('search sessions')(error)
      }
    } finally {
      if (epoch === indexEpoch) {
        loading = null
      }
    }
  })()
  return loading
}

const termsOf = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean)

const matches = (text: string, terms: string[]) => {
  const lower = text.toLowerCase()
  return terms.every((term) => lower.includes(term))
}

const snippetOf = (text: string, terms: string[]) => {
  const lower = text.toLowerCase()
  const first = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)[0]
  if (first === undefined) {
    return text.slice(0, 80)
  }
  const start = Math.max(0, first - 20)
  const end = Math.min(text.length, first + 70)
  const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`
}

/** 标题 + 当前可见消息正文，按会话更新时间倒序；空白以外的关键词按空格拆分、全部命中才算 */
export const searchConversations = (query: string): SearchHit[] => {
  const terms = termsOf(query)
  if (terms.length === 0) {
    return []
  }
  const hits: SearchHit[] = []
  for (const summary of useChatStore.getState().sessions) {
    const entry = index.get(summary.id)
    if (!entry) {
      continue
    }
    const title = summary.title.trim()
    if (title && matches(title, terms)) {
      hits.push({
        sessionId: summary.id,
        sessionTitle: title,
        updatedAt: summary.updatedAt,
        messageId: null,
        role: null,
        snippet: title,
      })
      if (hits.length >= RESULT_LIMIT) {
        break
      }
    }
    for (const message of entry.messages) {
      if (!matches(message.text, terms)) {
        continue
      }
      hits.push({
        sessionId: summary.id,
        sessionTitle: title,
        updatedAt: summary.updatedAt,
        messageId: message.id,
        role: message.role,
        snippet: snippetOf(message.text, terms),
      })
      if (hits.length >= RESULT_LIMIT) {
        break
      }
    }
    if (hits.length >= RESULT_LIMIT) {
      break
    }
  }
  return hits
}

/** 把查询拆成高亮用的关键词，界面与搜索共用同一套规则 */
export const highlightTerms = (query: string) => termsOf(query)
