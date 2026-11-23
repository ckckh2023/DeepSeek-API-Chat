import clsx from 'clsx'
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCircleChecked16,
  IconCircleOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconMultiSelectOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import { togglePinnedSession } from '../../services/chat/pinned.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  pinned,
  multi = false,
  selected = false,
  onDelete,
  onToggleSelect,
  onEnterMultiSelect,
}: {
  session: SessionSummary
  active: boolean
  pinned: boolean
  /** 多选模式：左侧显示勾选圈，点整行切换勾选，不再显示三点菜单 */
  multi?: boolean
  selected?: boolean
  onDelete: (session: SessionSummary) => void
  onToggleSelect?: (id: string) => void
  onEnterMultiSelect?: (id: string) => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const displayTitle = session.title || t('untitledChat')

  // 改名时侧栏保持整屏高度，键盘一弹就把输入框滚到键盘上方
  useEffect(() => {
    if (!editing) {
      return
    }
    const viewport = window.visualViewport
    let frame = 0
    const reveal = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const input = inputRef.current
        const scroll = input?.closest<HTMLElement>('[data-sider-scroll]')
        if (!input || !scroll) {
          return
        }
        const visibleBottom = viewport
          ? Math.round(viewport.offsetTop + viewport.height)
          : window.innerHeight
        const scrollTopEdge = scroll.getBoundingClientRect().top
        const rect = input.getBoundingClientRect()
        const gap = 8
        if (rect.bottom > visibleBottom - gap) {
          scroll.scrollTop += rect.bottom - visibleBottom + gap
        } else if (rect.top < scrollTopEdge + gap) {
          scroll.scrollTop -= scrollTopEdge + gap - rect.top
        }
      })
    }
    reveal()
    viewport?.addEventListener('resize', reveal)
    viewport?.addEventListener('scroll', reveal)
    window.addEventListener('resize', reveal)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', reveal)
      viewport?.removeEventListener('scroll', reveal)
      window.removeEventListener('resize', reveal)
    }
  }, [editing])

  if (editing && !multi) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        ref={inputRef}
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(
        styles.item,
        !multi && active && styles.active,
        multi && styles.multi,
        selected && styles.selected
      )}
      role={multi ? 'checkbox' : undefined}
      aria-checked={multi ? selected : undefined}
      onClick={() => {
        if (multi) {
          onToggleSelect?.(session.id)
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <span className={styles.check}>
        {multi && (selected ? <IconCircleChecked16 /> : <IconCircleOutline16 />)}
      </span>
      <div className={styles.title}>{displayTitle}</div>
      {multi ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            options={[
              {
                key: 'pin',
                label: t(pinned ? 'sessionItemMenuUnpinOption' : 'sessionItemMenuPinOption'),
                icon: <IconPinOutline16 off={pinned} />,
                onSelect: () => togglePinnedSession(session.id),
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'multi',
                label: t('sessionItemMenuMultiSelectOption'),
                icon: <IconMultiSelectOutline16 />,
                onSelect: () => onEnterMultiSelect?.(session.id),
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: () => onDelete(session),
              },
            ]}
          >
            {({ open, toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})