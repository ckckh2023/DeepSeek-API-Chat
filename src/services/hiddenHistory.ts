import { create } from 'zustand'

const KEY = 'deepseek-api-chat:hidden-history'

/** off：不隐藏；pinned：隐藏置顶；all：切到公开数据空间 */
export type HiddenHistoryMode = 'off' | 'pinned' | 'all'

const MODES: readonly HiddenHistoryMode[] = ['off', 'pinned', 'all']

const read = (): HiddenHistoryMode => {
  try {
    const value = localStorage.getItem(KEY)
    return MODES.includes(value as HiddenHistoryMode) ? (value as HiddenHistoryMode) : 'off'
  } catch {
    return 'off'
  }
}

/** 隐藏历史对话：关闭高级模式后入口不显示，但这里的选择继续生效。 */
export const useHiddenHistory = create<{ mode: HiddenHistoryMode }>(() => ({ mode: read() }))

/** 只更新选择；切换数据空间时的缓存与连接重置由 store 协调。 */
export const setHiddenHistoryMode = (mode: HiddenHistoryMode) => {
  try {
    if (mode === 'off') {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, mode)
    }
  } catch {
    // 无法持久化时只保留本次打开期间的选择。
  }
  useHiddenHistory.setState({ mode })
}

/** 当前是否使用公开数据空间；数据库选择只依赖这个值。 */
export const usesPublicDataSpace = () => useHiddenHistory.getState().mode === 'all'