import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { pushBackHandler } from '../../app/backStack.js'
import {
  canPickNativeDocuments,
  pickNativeDocuments,
  readPickedDocument,
} from '../../app/nativeDocuments.js'
import { isWebApp } from '../../app/platform.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { ShareError } from '../../services/chat/share/errors.js'
import { importSharedChat } from '../../services/chat/share/index.js'
import { importSharedSession } from '../../services/chat/store.js'
import { Button } from '../base/Button.js'
import { IconUploadOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { usePresence } from '../base/usePresence.js'
import type { HistoryImportProgress } from './historyImportState.js'
import { ImportProgress } from './ImportProgress.js'
import settingsStyles from './Settings.module.css'
import styles from './ImportDialog.module.css'

type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

type ImportDialogProps = {
  open: boolean
  onClose: () => void
  disabled: boolean
  archiveBusy: boolean
  archiveProgress: HistoryImportProgress | null
  archiveStatus: Status
  onSelectArchive: (file: File) => void
}

/**
 * 导入弹窗：ZIP 是覆盖式导入，分享链接只追加一条，两处用文案区分。
 * 分享链接接口不支持跨域，网页版直接禁用输入并给出说明。
 */
export const ImportDialog = ({
  open,
  onClose,
  disabled,
  archiveBusy,
  archiveProgress,
  archiveStatus,
  onSelectArchive,
}: ImportDialogProps) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  const inputRef = useRef<HTMLInputElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [link, setLink] = useState('')
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState<TranslationKey | null>(null)
  const webUnsupported = isWebApp()

  useEffect(() => {
    if (!mounted) {
      return
    }
    // 退出动画期间也继续拦截返回，避免把下面的设置一起关掉
    return pushBackHandler(() => onCloseRef.current())
  }, [mounted])

  if (!mounted) {
    return null
  }

  const pickArchive = () => {
    if (disabled || archiveBusy) {
      return
    }
    if (canPickNativeDocuments()) {
      // 安卓走系统 SAF，小米等 ROM 会进入「安全访问」的文件选择器
      void pickNativeDocuments().then(async (result) => {
        if (result.kind === 'unavailable') {
          inputRef.current?.click()
          return
        }
        if (result.kind === 'cancelled' || result.items.length === 0) {
          return
        }
        try {
          onSelectArchive(await readPickedDocument(result.items[0]))
        } catch {
          showToast(t('attachmentReadFailed'))
        }
      })
      return
    }
    inputRef.current?.click()
  }
  const submit = async () => {
    const value = link.trim()
    if (!value || linkBusy || disabled) {
      return
    }
    setLinkBusy(true)
    setLinkError(null)
    try {
      const session = await importSharedChat(value)
      await importSharedSession(session)
      setLink('')
      onClose()
      showToast({ key: 'shareImportDone' })
    } catch (error) {
      setLinkError(error instanceof ShareError ? error.key : 'shareImportFailed')
    } finally {
      setLinkBusy(false)
    }
  }

  return (
    <Modal
      title={t('importDialogTitle')}
      closable
      className={styles.dialog}
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          {archiveProgress || linkBusy ? (
            <span className={styles.footerHint}>{t('historyImportKeepForeground')}</span>
          ) : null}
          <Button variant="outlined" size="m" className={styles.footerAction} onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <section className={styles.section}>
          <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
            <div className={settingsStyles.text}>
              <div className={settingsStyles.label}>{t('historyImport')}</div>
              <div className={settingsStyles.description}>{t('historyImportDescription')}</div>
            </div>
            {archiveProgress ? null : (
              <Button
                variant="outlined"
                size="m"
                className={clsx(settingsStyles.cellButton, settingsStyles.uploadButton)}
                disabled={disabled || archiveBusy}
                onClick={pickArchive}
              >
                <IconUploadOutline14 />
                {t('importHistoryAction')}
              </Button>
            )}
          </div>
          {archiveProgress ? <ImportProgress progress={archiveProgress} /> : null}
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                onSelectArchive(file)
              }
            }}
          />
          {archiveStatus ? (
            <p className={clsx(styles.sectionStatus, archiveStatus.error && styles.error)}>
              {t(
                archiveStatus.key,
                archiveStatus.reason ? { message: t(archiveStatus.reason) } : archiveStatus.params
              )}
            </p>
          ) : null}
        </section>

        <section className={styles.section}>
          <div className={settingsStyles.label}>{t('shareImportTitle')}</div>
          <div className={settingsStyles.description}>{t('shareImportDescription')}</div>
          <div className={styles.linkRow}>
            <input
              className={styles.input}
              value={link}
              placeholder={t('shareImportPlaceholder')}
              aria-label={t('shareImportTitle')}
              disabled={webUnsupported || disabled || linkBusy}
              onChange={(event) => {
                setLink(event.target.value)
                setLinkError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            <Button
              variant="primary"
              size="m"
              className={clsx(settingsStyles.cellButton, settingsStyles.uploadButton)}
              disabled={webUnsupported || disabled || linkBusy || !link.trim()}
              onClick={() => void submit()}
            >
              {linkBusy ? t('shareImportBusy') : t('shareImportAction')}
            </Button>
          </div>
          {webUnsupported ? <p className={styles.notice}>{t('shareImportWebUnsupported')}</p> : null}
          {linkError ? <p className={styles.error}>{t(linkError)}</p> : null}
        </section>
      </div>
    </Modal>
  )
}