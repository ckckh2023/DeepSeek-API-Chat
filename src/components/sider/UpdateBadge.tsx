import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { openUsage, useBalance } from '../../services/balance.js'
import { useSettings } from '../../services/settings.js'
import { useUpdateStore } from '../../services/update.js'
import { isPeakTime } from '../../utils/peakValley.js'
import { UpdateDialog } from '../settings/UpdateDialog.js'
import styles from './Sider.module.css'

/**
 * 设置按钮右侧的小徽标：有新版本时提示更新，没有新版本时显示人民币余额。
 * 余额前标出当前电价时段（峰/谷），余额不足 1 元时金额变红。
 */
export const UpdateBadge = () => {
  const t = useTranslate()
  const latest = useUpdateStore((state) => state.latest)
  const apiKey = useSettings((state) => state.apiKey)
  const amount = useBalance((state) => state.amount)
  const refresh = useBalance((state) => state.refresh)
  const [now, setNow] = useState(() => new Date())
  const [updateOpen, setUpdateOpen] = useState(false)

  useEffect(() => {
    void refresh()
  }, [apiKey, refresh])

  // 从后台切回应用时刷新，避免余额停留在上次打开时的数值
  useEffect(() => {
    if (!apiKey) {
      return undefined
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [apiKey, refresh])

  // 跨过 12:00、14:00、18:00 或零点时，峰谷标识需要自动切换
  useEffect(() => {
    const tick = () => setNow(new Date())
    const timer = window.setInterval(tick, 30_000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        tick()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  if (latest) {
    return (
      <>
        <button
          type="button"
          className={styles.updateBadge}
          title={t('updateAvailableHint', { version: latest })}
          onClick={() => setUpdateOpen(true)}
        >
          {t('updateAvailable')}
        </button>
        <UpdateDialog
          open={updateOpen}
          onClose={() => setUpdateOpen(false)}
          latest={latest}
          checkOnOpen={false}
        />
      </>
    )
  }

  const peak = isPeakTime(now)
  const lowBalance = amount !== null && Number(amount) < 1

  return (
    <button
      type="button"
      className={clsx(styles.updateBadge, styles.balanceBadge)}
      title={t('usageBalanceHint')}
      onClick={openUsage}
    >
      <span className={clsx(styles.balancePeriod, peak ? styles.balancePeak : styles.balanceValley)}>
        {t(peak ? 'peakPeriod' : 'valleyPeriod')}
      </span>
      <span className={clsx(lowBalance && styles.balanceLow)}>{`¥ ${amount ?? '—'}`}</span>
    </button>
  )
}