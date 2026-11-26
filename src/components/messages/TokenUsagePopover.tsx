import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import type { MessageUsage } from '../../services/api/types.js'
import { hasTokenBreakdown, summarizeUsage } from '../../services/chat/usage.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconButton } from '../base/IconButton.js'
import { IconDatabaseOutline16 } from '../base/icons.js'
import { SummaryDialog } from './SummaryDialog.js'
import { TokenUsagePanel } from './TokenUsagePanel.js'
import styles from './TokenUsagePopover.module.css'

const CLOSE_DURATION = 190

export const TokenUsagePopover = ({
  usage,
  sessionId,
}: {
  usage: MessageUsage
  sessionId: string
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const closeTimer = useRef(0)
  const { anchorRef, floatingRef, position, side } = useAnchoredPosition<
    HTMLSpanElement,
    HTMLDivElement
  >(open, { side: 'top', align: 'end', offset: 12 })
  const positionRef = useRef(position)
  if (position) {
    positionRef.current = position
  }

  const close = () => {
    if (closing) {
      return
    }
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
    }, CLOSE_DURATION)
  }

  const toggle = () => {
    if (open) {
      close()
      return
    }
    window.clearTimeout(closeTimer.current)
    setClosing(false)
    setOpen(true)
  }

  // 点「总结」先收起面板，再打开弹窗，避免两层浮层叠在一起
  const summarize = () => {
    close()
    setSummaryOpen(true)
  }

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])
  useDismiss(open, [anchorRef, floatingRef], close)

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        <IconButton
          icon={<IconDatabaseOutline16 />}
          tooltip={open ? undefined : t('tokenUsageButton')}
          tooltipPlacement="bottom"
          aria-label={t('tokenUsageButton')}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={open ? styles.active : undefined}
          onClick={toggle}
        />
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.popover}
              data-state={closing ? 'closed' : 'open'}
              data-side={side}
              style={positionRef.current ?? { top: 0, left: 0, visibility: 'hidden' }}
              role="dialog"
              aria-label={t('tokenUsageTitle')}
            >
              <TokenUsagePanel
                usage={summarizeUsage(usage)}
                detailed={hasTokenBreakdown(usage)}
                onSummarize={summarize}
              />
            </div>,
            document.body
          )
        : null}
      <SummaryDialog
        open={summaryOpen}
        sessionId={sessionId}
        onClose={() => setSummaryOpen(false)}
      />
    </>
  )
}