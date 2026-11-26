import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { pushBackHandler } from '../../app/backStack.js'
import { isWebApp } from '../../app/platform.js'
import { openExternal } from '../../app/systemBars.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { registerVersionTap, setAdvancedMode, useAdvancedMode } from '../../services/advancedMode.js'
import { REPOSITORY, appVersion } from '../../services/update.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { usePresence } from '../base/usePresence.js'
import { IconRightUpOutline14 } from '../base/icons.js'
import settingsStyles from './Settings.module.css'
import { UpdateDialog } from './UpdateDialog.js'
import styles from './UpdateCheck.module.css'

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
  const advancedEnabled = useAdvancedMode((state) => state.enabled)
  const current = appVersion()

  const tapVersion = () => {
    if (registerVersionTap() === true) {
      setAdvancedNoticeOpen(true)
    }
  }

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
            {isWebApp() ? (
              <Button
                variant="outlined"
                size="m"
                className={settingsStyles.cellButton}
                onClick={() => setOpen(true)}
              >
                {t('updateDownloadClient')}
              </Button>
            ) : (
              <Button
                variant="outlined"
                size="m"
                className={settingsStyles.cellButton}
                onClick={() => setOpen(true)}
              >
                {t('updateCheckButton')}
              </Button>
            )}
          </div>
        </div>
      </div>
      <UpdateDialog
        open={open}
        onClose={() => setOpen(false)}
        title={isWebApp() ? 'updateDownloadClient' : undefined}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <AdvancedModeNotice
        open={advancedNoticeOpen}
        onClose={() => setAdvancedNoticeOpen(false)}
      />
    </>
  )
}