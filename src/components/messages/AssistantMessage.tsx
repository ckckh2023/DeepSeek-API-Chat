import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useEffect, useRef } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  IconBranchOutline16,
  IconRefreshOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { describeReply } from '../../services/chat/describe.js'
import { canContinueReply } from '../../services/chat/reply.js'
import { branchSession, continueReply, regenerateReply } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import {
  describeReadAloudError,
  stopReadAloud,
  toggleReadAloud,
} from '../../services/speech/readAloud.js'
import type { AssistantMessage as AssistantMessageType } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { IconButton } from '../base/IconButton.js'
import { Button } from '../base/Button.js'
import { Markdown } from '../markdown/Markdown.js'
import { SiteThumbnails } from '../search/SiteLogo.js'
import { toggleSearchPanel, useSearchPanel } from '../search/searchPanelState.js'
import { showToast } from '../base/toastState.js'
import { ReadAloudButton } from './ReadAloudButton.js'
import { CopyButton } from './CopyButton.js'
import { TokenUsagePopover } from './TokenUsagePopover.js'
import { ReplyArea } from './ReplyArea.js'
import { useReplyView } from './useReplyView.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import styles from './AssistantMessage.module.css'

const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const AssistantMessage = memo(function AssistantMessage({
  sessionId,
  message,
  isLast,
  streaming,
  busy,
  versions,
  onSelectVersion,
  openedAt,
}: {
  sessionId: string
  message: AssistantMessageType
  isLast: boolean
  streaming: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
  /** 会话打开时间，早于它的消息按历史处理 */
  openedAt: number
}) {
  const t = useTranslate()
  const view = useReplyView(message, streaming)
  const panelEntry = useSearchPanel((state) => state.entry)
  const isMobile = useIsMobile()
  const ttsAutoPlay = useSettings((state) => state.ttsAutoPlay)
  const notice = streaming ? null : describeReply(message)
  // 安全拒绝：已下发的思考与正文按协议丢弃，只显示模板答复。
  const refused = message.stopReason === 'refusal'
  const answer = refused ? null : view.answer
  const responseText = [answer?.text, notice?.presentation === 'response' ? notice.text : null]
    .filter(Boolean)
    .join('\n\n')
  const copyText = responseText || notice?.text
  const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking
  const canContinue = isLast && canContinueReply(message)
  const summaryEntry = `${message.id}-summary`
  // 移动端自动朗读：只在流式结束的那一刻触发一次，打开历史会话不会读旧消息
  const wasStreaming = useRef(streaming)
  const finishedText = useRef(responseText)
  finishedText.current = responseText
  useEffect(() => {
    const finished = wasStreaming.current && !streaming
    wasStreaming.current = streaming
    if (!finished || !isMobile || !ttsAutoPlay || refused) {
      return
    }
    const text = finishedText.current
    if (!text) {
      return
    }
    toggleReadAloud(message.id, text, (error) => showToast(describeReadAloudError(error)))
  }, [isMobile, message.id, refused, streaming, ttsAutoPlay])
  return (
    <div className={styles.message} data-message-id={message.id}>
      {refused ? null : (
        <ReplyArea
          message={message}
          view={view}
          streaming={streaming}
          hasResponse={!!responseText}
          isHistory={message.createdAt < openedAt}
        />
      )}
      {answer ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={answer.markdown}
          loading={streaming}
          cacheKey={message.id}
          disableLink={false}
          sources={view.sources}
        />
      ) : null}
      {waiting ? (
        <div className={styles.waiting}>
          {[0, 1, 2].map((index) => (
            <span key={index} className={styles.waitingDot} />
          ))}
        </div>
      ) : null}
      {notice?.presentation === 'response' ? (
        <Markdown
          className="ds-assistant-message-main-content"
          content={notice.text}
          loading={false}
          cacheKey={`${message.id}-template`}
          disableLink={false}
        />
      ) : notice ? (
        <div className={styles.notice}>
          <IconWarningOutline16 />
          <span>
            {notice.text}
            {notice.action === 'apiKey' ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.noticeAction}
                  onClick={() => openSettings('data')}
                >
                  {t('changeApiKey')}
                </button>
              </>
            ) : null}
            {notice.action === 'topUp' ? (
              <>
                {' '}
                <a
                  className={styles.noticeAction}
                  href={TOP_UP_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('topUp')}
                </a>
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      {!streaming && !refused && view.searchResults.length > 0 ? (
        <div
          className={clsx(styles.summary, panelEntry === summaryEntry && styles.summaryActive)}
          onClick={() => toggleSearchPanel(summaryEntry, view.searchResults)}
        >
          <SiteThumbnails sources={view.searchResults} />
          <span>
            {t(
              view.searchResults.length === 1 ? 'messageSearchSummary' : 'messageSearchSummaries',
              { count: view.searchResults.length }
            )}
          </span>
        </div>
      ) : null}
      {streaming ? null : (
        <div className={styles.bottom}>
          <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
            {copyText ? <CopyButton text={copyText} /> : null}
            {responseText && !refused ? (
              <ReadAloudButton messageId={message.id} text={responseText} />
            ) : null}
            <IconButton
              icon={<IconRefreshOutline16 />}
              tooltip={t('regenerate')}
              tooltipPlacement="bottom"
              disabled={busy || refused}
              onClick={() => {
                stopReadAloud()
                regenerateReply(sessionId, message.id)
              }}
            />
            <IconButton
              icon={<IconBranchOutline16 />}
              tooltip={t('branchConversation')}
              tooltipPlacement="bottom"
              disabled={busy}
              onClick={() => {
                stopReadAloud()
                if (branchSession(sessionId, message.id)) {
                  showToast({ key: 'branchCreated' })
                }
              }}
            />
          </div>
          {canContinue || message.usage ? (
            <div className={styles.bottomRight}>
              {canContinue ? (
                <Button
                  variant="outlined"
                  size="s"
                  className={styles.continueButton}
                  disabled={busy}
                  onClick={() => {
                    stopReadAloud()
                    continueReply(sessionId, message.id)
                  }}
                >
                  {t('continueGenerating')}
                </Button>
              ) : null}
              {message.usage ? (
                <TokenUsagePopover usage={message.usage} sessionId={sessionId} />
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
})
