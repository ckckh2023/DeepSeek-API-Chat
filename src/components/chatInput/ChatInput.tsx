import clsx from 'clsx'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  IconThinkOutline14,
} from '../base/icons.js'
import { setSearch, setThinking, setThinkingEffort, useSettings } from '../../services/settings.js'
import { useChatMode } from '../../services/chatMode.js'
import { isCapacitor } from '../../app/platform.js'
import { stopMessageEdits, useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { AttachmentSheet, type AttachmentSource } from './AttachmentSheet.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { ACCEPT, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { Spectrum } from './Spectrum.js'
import { ThinkingEffortPanel } from './ThinkingEffortPanel.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const draftReady = useUploads((state) => prepareDraftMessage(draft, state.tasks) !== null)
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const thinking = useSettings((state) => state.thinking)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  // 只有 Capacitor 打包的安卓 / iOS App 用三入口面板；手机网页版保持直接选文件
  const nativeAttach = isCapacitor()
  const search = useSettings((state) => state.search)
  const proMode = useChatMode((state) => state.mode === 'pro')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const albumInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const togglesRef = useRef<HTMLDivElement>(null)
  const thinkingEffort = useSettings((state) => state.thinkingEffort)
  const [effortOpen, setEffortOpen] = useState(false)
  const {
    anchorRef: thinkRef,
    floatingRef: effortRef,
    position: effortPosition,
    side: effortSide,
  } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(effortOpen, {
    side: 'top',
    align: 'start',
    offset: 12,
  })
  const effortPositionRef = useRef(effortPosition)
  if (effortPosition) {
    effortPositionRef.current = effortPosition
  }
  const longPressTimer = useRef(0)
  const releaseTimer = useRef(0)
  const longPressStart = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)
  const [effortClosing, setEffortClosing] = useState(false)
  const effortCloseTimer = useRef(0)

  const closeEffort = () => {
    if (effortClosing) {
      return
    }
    setEffortClosing(true)
    effortCloseTimer.current = window.setTimeout(() => {
      setEffortOpen(false)
      setEffortClosing(false)
    }, 190)
  }

  const openEffort = () => {
    window.clearTimeout(effortCloseTimer.current)
    setEffortClosing(false)
    setEffortOpen(true)
  }

  useDismiss(effortOpen, [thinkRef, effortRef], closeEffort)

  useLayoutEffect(() => {
    const toggles = togglesRef.current
    if (!toggles) {
      return
    }

    const updateLabels = () => {
      toggles.classList.remove(styles.collapsedToggles)
      toggles.classList.toggle(styles.collapsedToggles, toggles.scrollWidth > toggles.clientWidth)
    }

    updateLabels()
    const observer = new ResizeObserver(updateLabels)
    observer.observe(toggles)
    return () => observer.disconnect()
  }, [t])

  useEffect(
    () => () => {
      window.clearTimeout(longPressTimer.current)
      window.clearTimeout(releaseTimer.current)
      window.clearTimeout(effortCloseTimer.current)
    },
    []
  )

  const cancelLongPress = () => {
    window.clearTimeout(longPressTimer.current)
    window.clearTimeout(releaseTimer.current)
    releaseTimer.current = window.setTimeout(() => {
      suppressClick.current = false
    }, 400)
  }
  const startThinkLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
      return
    }
    longPressStart.current = { x: event.clientX, y: event.clientY }
    cancelLongPress()
    longPressTimer.current = window.setTimeout(() => {
      // 长按后抬起可能补发一次 click，短暂忽略，避免同时开关深度思考。
      suppressClick.current = true
      openEffort()
    }, 500)
  }
  const moveThinkLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (
      Math.abs(event.clientX - longPressStart.current.x) > 8 ||
      Math.abs(event.clientY - longPressStart.current.y) > 8
    ) {
      cancelLongPress()
    }
  }
  const handleThinkClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    setThinking(!thinking)
  }
  const handleThinkContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (window.matchMedia('(pointer: coarse)').matches) {
      suppressClick.current = true
    }
    openEffort()
  }

  const acceptFiles = (files: File[]) => {
    if (files.length === 0 || useChatStore.getState().importingHistory || !ensureApiKey()) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }
  const onInputChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    acceptFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }
  /** 收起面板后同步触发隐藏 input：iOS 要求 click 仍发生在用户手势里 */
  const pickAttachment = (source: AttachmentSource) => {
    setAttachOpen(false)
    const input =
      source === 'camera'
        ? cameraInputRef.current
        : source === 'album'
          ? albumInputRef.current
          : fileInputRef.current
    input?.click()
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  })

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    if (!ensureApiKey() || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      // 编辑消息时点底部输入框就结束编辑，否则页面保持整屏会把输入框留在键盘后面
      onPointerDownCapture={stopMessageEdits}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {/* 深度思考 / 智能搜索开关，tooltip 在按钮上方 */}
        <div ref={togglesRef} className={styles.toggles}>
          <Tooltip content={effortOpen ? null : t('deactivatedThinkTooltip')}>
            <button
              ref={thinkRef}
              type="button"
              className={clsx(styles.toggle, thinking && styles.selected)}
              aria-label={t('thinkingSwitch')}
              aria-pressed={thinking}
              aria-haspopup="dialog"
              aria-expanded={effortOpen}
              onClick={handleThinkClick}
              onContextMenu={handleThinkContextMenu}
              onPointerDown={startThinkLongPress}
              onPointerMove={moveThinkLongPress}
              onPointerUp={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onPointerLeave={cancelLongPress}
            >
              <IconThinkOutline14 />
              <span className={styles.toggleLabel}>{t('thinkingSwitch')}</span>
            </button>
          </Tooltip>
          {effortOpen
            ? createPortal(
                <div
                  ref={effortRef}
                  className={styles.effortPopover}
                  data-state={effortClosing ? 'closed' : 'open'}
                  data-side={effortSide}
                  style={effortPositionRef.current ?? { top: 0, left: 0, visibility: 'hidden' }}
                  role="dialog"
                  aria-label={t('thinkingEffortLabel')}
                >
                  <ThinkingEffortPanel
                    value={thinkingEffort}
                    onSelect={(value) => {
                      setThinkingEffort(value)
                      closeEffort()
                    }}
                  />
                </div>,
                document.body
              )
            : null}
          <Tooltip content={t(proMode ? 'proSearchDisabledTooltip' : 'deactivatedSearchTooltip')}>
            <button
              type="button"
              className={clsx(styles.toggle, search && !proMode && styles.selected)}
              aria-label={t('search')}
              aria-pressed={!proMode && search}
              disabled={proMode}
              onClick={() => setSearch(!search)}
            >
              <IconGlobeLanguageOutline14 />
              <span className={styles.toggleLabel}>{t('search')}</span>
            </button>
          </Tooltip>
        </div>
        <div className={styles.right}>
          <VoiceButton
            status={voice.status}
            disabled={!voice.available}
            seconds={voice.seconds}
            onClick={() => {
              if (
                voice.status !== 'idle' ||
                (!useChatStore.getState().importingHistory && ensureApiKey())
              ) {
                void voice.toggle()
              }
            }}
          />
          <IconButton
            size="m"
            tone="primary"
            icon={<IconPaperclipOutline16 />}
            tooltip={t('uploadFile')}
            disabled={importingHistory}
            onClick={() => {
              if (!ensureApiKey()) {
                return
              }
              if (nativeAttach) {
                // 先收键盘再滑出面板，否则选择器返回后键盘会把面板顶住
                textareaRef.current?.blur()
                setAttachOpen(true)
                return
              }
              fileInputRef.current?.click()
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={onInputChange}
          />
          {nativeAttach ? (
            <>
              <input
                ref={cameraInputRef}
                type="file"
                hidden
                accept="image/*"
                capture="environment"
                onChange={onInputChange}
              />
              <input
                ref={albumInputRef}
                type="file"
                hidden
                multiple
                accept="image/*"
                onChange={onInputChange}
              />
            </>
          ) : null}
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {nativeAttach ? (
        <AttachmentSheet
          open={attachOpen}
          onClose={() => setAttachOpen(false)}
          onPick={pickAttachment}
        />
      ) : null}
      {dragging ? <DragMask /> : null}
    </div>
  )
}
