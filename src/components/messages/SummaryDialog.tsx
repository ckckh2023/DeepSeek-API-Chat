import { useEffect, useRef, useState } from 'react'
import { pushBackHandler } from '../../app/backStack.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { BLOCKED_TOAST, requestSummary } from '../../services/chat/summary.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconCopyOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { usePresence } from '../base/usePresence.js'
import { showToast } from '../base/toastState.js'
import styles from './SummaryDialog.module.css'

type SummaryState =
  | { status: 'busy' }
  | { status: 'failed' }
  | { status: 'blocked'; key: TranslationKey }
  | { status: 'ready'; text: string }


/** 上下文总结弹窗：打开即请求，只读展示结果，可复制；失败或缺少前置条件时给出提示。 */
export const SummaryDialog = ({
  open,
  sessionId,
  onClose,
}: {
  open: boolean
  sessionId: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  const [state, setState] = useState<SummaryState>({ status: 'busy' })
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!mounted) {
      return
    }
    return pushBackHandler(() => closeRef.current())
  }, [mounted])

  // 打开时优先取上次的总结缓存；只有显式「重新总结」才绕过缓存
  const load = async (refresh = false) => {
    const id = ++requestIdRef.current
    setState({ status: 'busy' })
    try {
      const result = await requestSummary(sessionRef.current, { refresh })
      if (requestIdRef.current !== id) {
        return
      }
      if (result.blocked !== undefined) {
        setState({ status: 'blocked', key: BLOCKED_TOAST[result.blocked] })
        return
      }
      setState({ status: 'ready', text: result.text })
    } catch {
      if (requestIdRef.current === id) {
        setState({ status: 'failed' })
      }
    }
  }

  useEffect(() => {
    if (open) {
      void load()
    }
  }, [open])

  if (!mounted) {
    return null
  }

  const copy = async () => {
    if (state.status !== 'ready') {
      return
    }
    const ok = await copyText(state.text)
    showToast(ok ? { key: 'copied' } : { key: 'copyFailed', type: 'error' })
  }

  return (
    <Modal
      title={t('summaryTitle')}
      className={styles.dialog}
      closable
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="outlined"
            size="m"
            disabled={state.status === 'busy'}
            onClick={() => void load(true)}
          >
            {t(state.status === 'busy' ? 'summaryBusy' : 'summaryRegenerate')}
          </Button>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('close')}
          </Button>
        </>
      }
    >
      {state.status === 'busy' ? (
        <p className={styles.status}>{t('summaryBusy')}</p>
      ) : state.status === 'failed' ? (
        <p className={styles.error}>{t('summaryFailed')}</p>
      ) : state.status === 'blocked' ? (
        <p className={styles.status}>{t(state.key)}</p>
      ) : (
        <div className={styles.textWrap}>
          <div className={styles.text}>{state.text}</div>
          <IconButton
            className={styles.copy}
            size="xs"
            icon={<IconCopyOutline16 />}
            tooltip={t('summaryCopy')}
            onClick={() => void copy()}
          />
        </div>
      )}
    </Modal>
  )
}