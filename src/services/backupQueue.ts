import { create } from 'zustand'

/** 导入、导出与全部删除共用串行队列，存在排队或执行中的任务时不允许切换数据空间。 */
export const useBackupQueue = create<{ pending: number }>(() => ({ pending: 0 }))

export const enterBackupTask = () =>
  useBackupQueue.setState((state) => ({ pending: state.pending + 1 }))

export const leaveBackupTask = () =>
  useBackupQueue.setState((state) => ({ pending: Math.max(0, state.pending - 1) }))