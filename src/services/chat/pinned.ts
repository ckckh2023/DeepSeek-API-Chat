import { create } from 'zustand'
import { usesPublicDataSpace } from '../hiddenHistory.js'

const KEY = 'deepseek-api-chat:pinned-sessions'
/** 公开数据空间的置顶独立保存，避免切换档位后互相清理。 */
const PUBLIC_KEY = `${KEY}:public`

const key = () => (usesPublicDataSpace() ? PUBLIC_KEY : KEY)

const read = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key()) ?? '[]')
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === 'string'))]
      : []
  } catch {
    return []
  }
}

const write = (ids: string[]) => {
  try {
    localStorage.setItem(key(), JSON.stringify(ids))
  } catch {
    // 无法持久化时只保留本次打开期间的置顶状态。
  }
}

/** 置顶会话 id，顺序即列表里的展示顺序；会话正文与摘要仍存在 IndexedDB。 */
export const usePinnedSessions = create(() => ({ ids: read() }))

/** 切换数据空间后按当前库重读置顶。 */
export const reloadPinnedSessions = () => {
  usePinnedSessions.setState({ ids: read() })
}

const apply = (ids: string[]) => {
  write(ids)
  usePinnedSessions.setState({ ids })
}

/** 新置顶的排在最前。 */
export const togglePinnedSession = (id: string) => {
  const ids = usePinnedSessions.getState().ids
  apply(ids.includes(id) ? ids.filter((item) => item !== id) : [id, ...ids])
}

/** 批量置顶：传入顺序即新的展示顺序，已在置顶里的不会被取消，也不重复。 */
export const pinSessions = (ids: string[]) => {
  const current = usePinnedSessions.getState().ids
  const ordered = [...new Set(ids)]
  const rest = current.filter((id) => !ordered.includes(id))
  if (ordered.length === 0) {
    return
  }
  apply([...ordered, ...rest])
}

export const removePinnedSession = (id: string) => {
  const ids = usePinnedSessions.getState().ids
  if (ids.includes(id)) {
    apply(ids.filter((item) => item !== id))
  }
}

/** 删除或覆盖导入后清掉已经不存在的会话 id。 */
export const prunePinnedSessions = (existingIds: ReadonlySet<string>) => {
  const ids = usePinnedSessions.getState().ids
  const next = ids.filter((id) => existingIds.has(id))
  if (next.length !== ids.length) {
    apply(next)
  }
}