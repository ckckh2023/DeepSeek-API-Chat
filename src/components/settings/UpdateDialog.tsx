import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { pushBackHandler } from '../../app/backStack.js'
import { openExternal } from '../../app/systemBars.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  BAIDU_PAN_URL,
  GITEE_RELEASES_URL,
  PAN123_URL,
  QUARK_PAN_URL,
  RELEASES_URL,
  appVersion,
  checkLatestVersion,
  compareVersions,
} from '../../services/update.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { usePresence } from '../base/usePresence.js'
import { IconRightUpOutline14 } from '../base/icons.js'
import styles from './UpdateCheck.module.css'

const CHANNELS: { label: TranslationKey; url: string }[] = [
  { label: 'updateChannelGithub', url: RELEASES_URL },
  { label: 'updateChannelGitee', url: GITEE_RELEASES_URL },
  { label: 'updateChannelBaidu', url: BAIDU_PAN_URL },
  { label: 'updateChannel123', url: PAN123_URL },
  { label: 'updateChannelQuark', url: QUARK_PAN_URL },
]

type UpdateDialogProps = {
  open: boolean
  onClose: () => void
  /** 已知的新版本 tag；传入后打开即展示，不重新联网检查 */
  latest?: string
  /** 打开时是否联网检查一次；角标已知版本时可关掉 */
  checkOnOpen?: boolean
}

/** 检查更新弹窗：展示版本状态与各下载渠道，设置页和角标共用。 */
export const UpdateDialog = ({
  open,
  onClose,
  latest: knownLatest = '',
  checkOnOpen = true,
}: UpdateDialogProps) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const knownLatestRef = useRef(knownLatest)
  knownLatestRef.current = knownLatest
  const checkOnOpenRef = useRef(checkOnOpen)
  checkOnOpenRef.current = checkOnOpen
  const [checking, setChecking] = useState(false)
  const [current, setCurrent] = useState(appVersion)
  const [latest, setLatest] = useState(knownLatest)

  useEffect(() => {
    if (!mounted) {
      return
    }
    return pushBackHandler(() => onCloseRef.current())
  }, [mounted])

  // 每次从关闭切到打开时重置状态；放在布局阶段，避免先闪一帧「未检测到新版本」
  useLayoutEffect(() => {
    if (!open) {
      return undefined
    }
    setCurrent(appVersion())
    setLatest(knownLatestRef.current)
    if (!checkOnOpenRef.current) {
      setChecking(false)
      return undefined
    }
    setChecking(true)
    let cancelled = false
    void (async () => {
      try {
        const result = await checkLatestVersion()
        if (cancelled) {
          return
        }
        setCurrent(result.current)
        setLatest(result.latest)
      } finally {
        if (!cancelled) {
          setChecking(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  if (!mounted) {
    return null
  }

  const hasUpdate = Boolean(current && latest && compareVersions(latest, current) > 0)

  return (
    <Modal
      title={t('updateDialogTitle')}
      closable
      state={visible ? 'open' : 'closed'}
      footer={
        <Button variant="outlined" size="m" onClick={onClose}>
          {t('close')}
        </Button>
      }
      onClose={onClose}
    >
      <div className={styles.dialog}>
        {checking ? (
          <p className={styles.status}>{t('updateChecking')}</p>
        ) : hasUpdate ? (
          <p className={styles.status}>{t('updateAvailableMessage', { version: latest })}</p>
        ) : (
          <>
            <p className={styles.statusTitle}>{t('updateNotFoundTitle')}</p>
            <p className={styles.hint}>{t('updateNotFoundHint')}</p>
          </>
        )}
        <p className={styles.current}>
          {t('updateCurrentVersion', { version: current || '—' })}
        </p>
        <p className={styles.sectionTitle}>{t('updateManualDownload')}</p>
        <div className={styles.channels}>
          {CHANNELS.map((channel) => (
            <a
              key={channel.url}
              className={styles.channel}
              href={channel.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault()
                openExternal(channel.url)
              }}
            >
              <span>{t(channel.label)}</span>
              <IconRightUpOutline14 />
            </a>
          ))}
        </div>
      </div>
    </Modal>
  )
}