import { formatDate } from '../../utils/format.js'
import { enterBackupTask, leaveBackupTask } from '../backupQueue.js'
import * as db from './db.js'
import type { ExportArchiveProgress } from './history/exportArchive.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

/** 导出进度：收集会话、打包 ZIP，最后交给系统保存 */
export type HistoryExportProgress = ExportArchiveProgress | { phase: 'saving' }

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  enterBackupTask()
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task.finally(leaveBackupTask)
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 流式导出前先确定目标文件名 */
export const historyArchiveFileName = () => backupFileName(new Date())

/**
 * 导出开始时的会话快照：列表和已加载内容固定，
 * 未打开的会话逐条读取，不把详情缓存撑大。
 */
const snapshotHistory = () => {
  const { sessions, sessionCache } = useChatStore.getState()
  async function* readSessions(): AsyncGenerator<Session> {
    for (const summary of sessions) {
      const session = Object.hasOwn(sessionCache, summary.id)
        ? sessionCache[summary.id]
        : await db.loadSession(summary.id)
      if (!session) {
        throw new Error(`History session disappeared during export: ${summary.id}`)
      }
      // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
      yield { ...session, ...summary }
    }
  }
  return { sessions, readSessions }
}

/** 导出为历史会话导出格式的 ZIP，可再次导入（桌面与网页用，结果在内存）。 */
export const exportHistory = (
  onProgress?: (progress: HistoryExportProgress) => void
): Promise<{ name: string; blob: Blob; count: number }> =>
  enqueueBackup(async () => {
    const { sessions, readSessions } = snapshotHistory()
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions(), {
      total: sessions.length,
      onProgress,
    })
    return { name: backupFileName(now), blob, count: sessions.length }
  })

/**
 * 流式导出（移动端用）：每块 ZIP 数据立即交给 onChunk 写文件，
 * 内存里只保留当前会话，避免记录多时整包 ZIP 与整串 base64 撑爆 WebView。
 */
export const exportHistoryToSink = (
  onProgress: (progress: HistoryExportProgress) => void,
  onChunk: (chunk: Uint8Array) => Promise<void>
): Promise<number> =>
  enqueueBackup(async () => {
    const { sessions, readSessions } = snapshotHistory()
    const { exportArchiveStream } = await import('./history/exportArchive.js')
    return exportArchiveStream(readSessions(), {
      total: sessions.length,
      onProgress,
      onChunk,
    })
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (
  file: File,
  onProgress?: (ratio: number) => void
): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    return replaceHistory((report) => importArchive(file, report), onProgress)
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
