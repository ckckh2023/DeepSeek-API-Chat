import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { pushBackHandler } from '../../app/backStack.js'
import { isWebApp } from '../../app/platform.js'
import { openExternal } from '../../app/systemBars.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { registerVersionTap, setAdvancedMode, useAdvancedMode } from '../../services/advancedMode.js'
import {
  BAIDU_PAN_URL,
  GITEE_RELEASES_URL,
  PAN123_URL,
  QUARK_PAN_URL,
  RELEASES_URL,
  REPOSITORY,
  appVersion,
  checkLatestVersion,
  compareVersions,
} from '../../services/update.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { usePresence } from '../base/usePresence.js'
import { IconRightUpOutline14 } from '../base/icons.js'
import settingsStyles from './Settings.module.css'
import styles from './UpdateCheck.module.css'

const CHANNELS: { label: TranslationKey; url: string }[] = [
  { label: 'updateChannelGithub', url: RELEASES_URL },
  { label: 'updateChannelGitee', url: GITEE_RELEASES_URL },
  { label: 'updateChannelBaidu', url: BAIDU_PAN_URL },
  { label: 'updateChannel123', url: PAN123_URL },
  { label: 'updateChannelQuark', url: QUARK_PAN_URL },
]

const ABOUT_LINKS: { label: TranslationKey; url: string }[] = [
  { label: 'aboutRepositoryGithub', url: `https://github.com/${REPOSITORY}` },
  { label: 'aboutRepositoryGitee', url: `https://gitee.com/${REPOSITORY}` },
]

const FEEDBACK_GROUP_URL = 'https://qm.qq.com/q/qumn09jZjU'
const FEEDBACK_GROUP_NUMBER = '1126089764'

/** 关于我们：应用名称、版本、简介与仓库入口。 */
const AboutDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!mounted) {
      return
    }
    return pushBackHandler(() => onCloseRef.current())
  }, [mounted])

  if (!mounted) {
    return null
  }

  return (
    <Modal
      title={t('aboutUs')}
      closable
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <div className={styles.aboutFooter}>
          <span className={styles.aboutNote}>{t('aboutNonOfficial')}</span>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      }
    >
      <div className={styles.about}>
        <p className={styles.aboutName}>DeepSeek API Chat</p>
        <p className={styles.aboutMeta}>
          {t('updateCurrentVersion', { version: appVersion() || '—' })}
        </p>
        <p className={styles.aboutText}>{t('aboutDescription')}</p>
        <div className={styles.aboutDivider} />
        <p className={styles.aboutSectionTitle}>{t('aboutOpenSource')}</p>
        <div className={styles.channels}>
          {ABOUT_LINKS.map((link) => (
            <a
              key={link.url}
              className={styles.channel}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault()
                openExternal(link.url)
              }}
            >
              <span>{t(link.label)}</span>
              <IconRightUpOutline14 />
            </a>
          ))}
        </div>
        <div className={styles.aboutDivider} />
        <div className={styles.groupRow}>
          <span className={styles.groupLabel}>{t('aboutFeedbackGroup')}</span>
          <Button variant="primary" size="m" onClick={() => openExternal(FEEDBACK_GROUP_URL)}>
            {t('aboutJoinGroup')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** 启用高级模式后的风险提示：建议加入反馈群，可复制群号或直接跳转。 */
const AdvancedModeNotice = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  useEffect(() => {
    if (!mounted) {
      return
    }
    // 这个弹窗只能点右上角 X 关闭：返回键在此吞掉，也不会误关下层的设置弹窗
    return pushBackHandler(() => {})
  }, [mounted])

  if (!mounted) {
    return null
  }

  const copyGroupNumber = async () => {
    const copied = await copyText(FEEDBACK_GROUP_NUMBER)
    showToast({ key: copied ? 'copied' : 'copyFailed' })
  }

  return (
    <Modal
      title={t('advancedModeDialogTitle')}
      closable
      dismissible={false}
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={copyGroupNumber}>
            {t('advancedModeCopyGroup')}
          </Button>
          <Button
            variant="primary"
            size="m"
            onClick={() => {
              openExternal(FEEDBACK_GROUP_URL)
              onClose()
            }}
          >
            {t('advancedModeJoinNow')}
          </Button>
        </>
      }
    >
      <p className={styles.noticeText}>
        {t('advancedModeWarning')}
        <strong className={styles.noticeStrong}>{t('aboutFeedbackGroup')}</strong>
        {t('advancedModeWarningTail')}
      </p>
    </Modal>
  )
}

/** 高级模式下显示在软件版本上方，提供关闭入口。 */
const AdvancedModeSetting = () => {
  const t = useTranslate()
  const enabled = useAdvancedMode((state) => state.enabled)
  if (!enabled) {
    return null
  }
  return (
    <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
      <div className={settingsStyles.text}>
        <div className={settingsStyles.label}>{t('advancedModeLabel')}</div>
      </div>
      <Button
        variant="outlined"
        size="m"
        className={settingsStyles.cellButton}
        onClick={() => {
          setAdvancedMode(false)
          showToast({ key: 'advancedModeExited' })
        }}
      >
        {t('close')}
      </Button>
    </div>
  )
}

/**
 * 通用设置里的软件版本：客户端可手动检查更新，弹窗里提供四个下载入口；网页版没有更新通道，
 * 只保留版本号与「关于我们」。连续点五次版本号进入高级模式，网页版同样可用。
 */
export const UpdateCheck = () => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [advancedNoticeOpen, setAdvancedNoticeOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [current, setCurrent] = useState(appVersion)
  const [latest, setLatest] = useState('')
  const advancedEnabled = useAdvancedMode((state) => state.enabled)
  const { mounted, visible } = usePresence(open)

  useEffect(() => {
    if (!mounted) {
      return
    }
    // 退出动画期间也继续拦截返回，避免把下面的设置一起关掉
    return pushBackHandler(() => setOpen(false))
  }, [mounted])

  const runCheck = async () => {
    setChecking(true)
    setLatest('')
    try {
      const result = await checkLatestVersion()
      setCurrent(result.current)
      setLatest(result.latest)
    } finally {
      setChecking(false)
    }
  }

  const openDialog = () => {
    setOpen(true)
    void runCheck()
  }

  const tapVersion = () => {
    if (registerVersionTap() === true) {
      setAdvancedNoticeOpen(true)
    }
  }

  const hasUpdate = Boolean(current && latest && compareVersions(latest, current) > 0)

  return (
    <>
      <AdvancedModeSetting />
      <div className={settingsStyles.cell}>
        <div className={settingsStyles.row}>
          <div className={settingsStyles.text}>
            <div className={settingsStyles.label}>{t('updateSettingLabel')}</div>
            <button
              type="button"
              className={clsx(settingsStyles.description, styles.version)}
              disabled={advancedEnabled}
              onClick={tapVersion}
            >
              {t('updateCurrentVersion', { version: current || '—' })}
            </button>
          </div>
          <div className={settingsStyles.cellActions}>
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              onClick={() => setAboutOpen(true)}
            >
              {t('aboutUs')}
            </Button>
            {isWebApp() ? null : (
              <Button
                variant="outlined"
                size="m"
                className={settingsStyles.cellButton}
                onClick={openDialog}
              >
                {t('updateCheckButton')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {mounted ? (
        <Modal
          title={t('updateDialogTitle')}
          closable
          state={visible ? 'open' : 'closed'}
          footer={
            <Button variant="outlined" size="m" onClick={() => setOpen(false)}>
              {t('close')}
            </Button>
          }
          onClose={() => setOpen(false)}
        >
          <div className={styles.dialog}>
            {checking ? (
              <p className={styles.status}>{t('updateChecking')}</p>
            ) : hasUpdate ? (
              <p className={styles.status}>
                {t('updateAvailableMessage', { version: latest })}
              </p>
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
      ) : null}
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <AdvancedModeNotice
        open={advancedNoticeOpen}
        onClose={() => setAdvancedNoticeOpen(false)}
      />
    </>
  )
}