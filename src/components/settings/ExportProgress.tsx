import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { HistoryExportProgress } from '../../services/chat/backup.js'
import styles from './Settings.module.css'

/** 导出进度：收集会话时显示不确定条与条数，打包 ZIP 时显示百分比。 */
export const ExportProgress = ({ progress }: { progress: HistoryExportProgress }) => {
  const t = useTranslate()
  const label =
    progress.phase === 'collecting'
      ? t('historyExportPreparing', { done: progress.done, total: progress.total })
      : progress.phase === 'writing'
        ? t('historyExportPacking', { percent: progress.percent })
        : t('historyExportSaving')
  const percent =
    progress.phase === 'writing' ? progress.percent : progress.phase === 'saving' ? 100 : undefined
  return (
    <div
      className={styles.importProgress}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span className={clsx(styles.importProgressTrack, styles.exportProgressTrack)}>
        <span
          className={clsx(
            styles.importProgressFill,
            percent === undefined && styles.importProgressIndeterminate
          )}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </span>
      <span className={styles.importProgressText}>{label}</span>
    </div>
  )
}