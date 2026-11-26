import { useTranslate } from '../../i18n/index.js'
import { CONTEXT_WINDOW_TOKENS, type TokenUsageSummary } from '../../services/chat/usage.js'
import { Button } from '../base/Button.js'
import styles from './TokenUsagePanel.module.css'

const formatTokens = (value: number) => value.toLocaleString('en-US')

const formatPercent = (value: number) => (value > 0 && value < 0.1 ? '<0.1%' : `${value.toFixed(1)}%`)

export const TokenUsagePanel = ({
  usage,
  detailed = true,
  onSummarize,
}: {
  usage: TokenUsageSummary
  detailed?: boolean
  /** 传入后在面板右上角显示「总结压缩」按钮 */
  onSummarize?: () => void
}) => {
  const t = useTranslate()
  const contextPercent = usage.contextRatio * 100
  return (
    <div className={styles.panel}>
      {onSummarize ? (
        <Button variant="outlined" size="m" className={styles.summarize} onClick={onSummarize}>
          {t('tokenUsageSummarize')}
        </Button>
      ) : null}
      <div className={styles.title}>{t('tokenUsageTitle')}</div>
      <div className={styles.total}>{formatTokens(usage.totalTokens)}</div>
      {detailed ? (
        <>
          <div className={styles.breakdown}>
            {t('tokenUsageBreakdown', {
              input: formatTokens(usage.inputTokens),
              output: formatTokens(usage.outputTokens),
            })}
          </div>
          <dl className={styles.stats}>
            <div className={styles.row}>
              <dt>{t('tokenUsageUncached')}</dt>
              <dd>{formatTokens(usage.uncachedTokens)}</dd>
            </div>
            <div className={styles.row}>
              <dt>{t('tokenUsageCached')}</dt>
              <dd>{formatTokens(usage.cachedTokens)}</dd>
            </div>
            <div className={styles.row}>
              <dt>{t('tokenUsageHitRate')}</dt>
              <dd>{formatPercent(usage.hitRate * 100)}</dd>
            </div>
          </dl>
        </>
      ) : (
        <div className={styles.hint}>{t('tokenUsageImportedHint')}</div>
      )}
      <div className={styles.divider} />
      <div className={styles.contextHeader}>
        <span>{t('tokenUsageContext')}</span>
        <span className={styles.contextPercent}>{formatPercent(contextPercent)}</span>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={t('tokenUsageContext')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(contextPercent))}
      >
        <span className={styles.fill} style={{ width: `${Math.min(100, contextPercent)}%` }} />
      </div>
      <div className={styles.contextTotal}>
        {t('tokenUsageContextUsage', {
          used: formatTokens(usage.contextTokens),
          limit: formatTokens(CONTEXT_WINDOW_TOKENS),
        })}
      </div>
    </div>
  )
}