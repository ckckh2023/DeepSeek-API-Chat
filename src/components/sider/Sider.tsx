import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconPinOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import {
  groupSessions,
  limitSessionGroups,
  PINNED_GROUP_KEY,
} from '../../services/chat/sessionGroups.js'
import { pinSessions, usePinnedSessions } from '../../services/chat/pinned.js'
import { useHiddenHistory } from '../../services/hiddenHistory.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { usePresence } from '../base/usePresence.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { openHistorySearch } from '../search/historySearchState.js'
import { pushBackHandler } from '../../app/backStack.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import { UpdateBadge } from './UpdateBadge.js'
import styles from './Sider.module.css'

/** 首屏与每次滚动到底补载的会话条数 */
const PAGE_SIZE = 100

/** 抽屉关闭后会卸载，重新打开时用它恢复滚动位置和已加载条数 */
const scrollMemory = { top: 0, count: PAGE_SIZE }

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({
  mobile = false,
  collapsed = false,
}: {
  mobile?: boolean
  /** 桌面端收起：整块向左滑出，宽度由 App 的布局回收 */
  collapsed?: boolean
}) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const hiddenMode = useHiddenHistory((state) => state.mode)
  const hidePinned = hiddenMode === 'pinned'
  const pinnedIds = usePinnedSessions((state) => state.ids)
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.max(PAGE_SIZE, scrollMemory.count)
  )
  const listRef = useRef<HTMLDivElement>(null)
  /** 隐藏置顶只影响列表；搜索仍按全部对话索引。 */
  const listSessions = useMemo(
    () => (hidePinned ? sessions.filter((session) => !pinnedSet.has(session.id)) : sessions),
    [sessions, hidePinned, pinnedSet]
  )
  const groups = useMemo(
    () => groupSessions(listSessions, now, t, hidePinned ? [] : pinnedIds),
    [listSessions, now, t, hidePinned, pinnedIds]
  )
  const total = useMemo(
    () => groups.reduce((count, group) => count + group.sessions.length, 0),
    [groups]
  )
  const visibleGroups = useMemo(
    () => limitSessionGroups(groups, visibleCount),
    [groups, visibleCount]
  )
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState<SessionSummary[] | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const onDelete = useCallback((session: SessionSummary) => setDeleting(session), [])

  // 多选：点三点菜单进入，底部设置与余额替换成批量操作
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const exitMultiSelect = useCallback(() => {
    setMultiSelect(false)
    setSelectedIds(new Set())
  }, [])
  /** 从哪条对话的菜单进入多选，就默认勾上它 */
  const enterMultiSelect = useCallback((id: string) => {
    setMultiSelect(true)
    setSelectedIds(new Set([id]))
  }, [])
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])
  /** 按列表当前顺序取勾选的会话，批量置顶后顺序与看到的列表一致 */
  const selectedSessions = useMemo(
    () => visibleGroups.flatMap((group) => group.sessions).filter((item) => selectedIds.has(item.id)),
    [visibleGroups, selectedIds]
  )

  // 多选时先接管返回键：退出多选，而不是直接关掉抽屉
  useEffect(() => {
    if (!multiSelect) {
      return undefined
    }
    return pushBackHandler(exitMultiSelect)
  }, [multiSelect, exitMultiSelect])

  const pinSelected = () => {
    if (selectedSessions.length === 0) {
      return
    }
    pinSessions(selectedSessions.map((item) => item.id))
    exitMultiSelect()
  }

  const deleteSelected = async () => {
    if (!bulkDeleting) {
      return
    }
    setDeletePending(true)
    const remaining = new Set<string>()
    try {
      for (const item of bulkDeleting) {
        if (!(await removeSession(item.id))) {
          remaining.add(item.id)
        }
      }
    } finally {
      setDeletePending(false)
    }
    setBulkDeleting(null)
    if (remaining.size > 0) {
      setSelectedIds(remaining)
      showToast({ key: 'sessionDeleteFailed', type: 'error' })
    } else {
      exitMultiSelect()
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // 重新挂载时恢复上次的滚动位置；桌面常驻侧栏本身不会丢位置。
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) {
      el.scrollTop = scrollMemory.top
    }
  }, [])

  useLayoutEffect(() => {
    scrollMemory.count = visibleCount
  }, [visibleCount])

  // 首屏不足一屏时继续补载，避免滚动条不出现导致无法触发加载。
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || visibleCount >= total || el.scrollHeight > el.clientHeight) {
      return
    }
    setVisibleCount((value) => Math.min(total, value + PAGE_SIZE))
  }, [visibleCount, total])

  const loadMore = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    scrollMemory.top = el.scrollTop
    if (visibleCount >= total) {
      return
    }
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 120) {
      setVisibleCount((value) => Math.min(total, value + PAGE_SIZE))
    }
  }

  return (
    <div
      className={clsx(styles.sider, mobile && styles.mobile, collapsed && styles.siderCollapsed)}
      aria-hidden={collapsed || undefined}
    >
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <div className={styles.topActions}>
          <IconButton
            size="m"
            icon={<IconSearchOutline16 />}
            tooltip={t('searchConversations')}
            tooltipPlacement="bottom"
            onClick={openHistorySearch}
          />
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
          />
        </div>
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div
          ref={listRef}
          className={styles.list}
          data-sider-scroll=""
          onScroll={loadMore}
        >
          {visibleGroups.map((group, index) => {
            // 置顶分组下面还有内容时，在两者的间距中间加一条浅灰分割线
            const divider = group.key === PINNED_GROUP_KEY && index < visibleGroups.length - 1
            return (
              <div
                key={group.key}
                className={clsx(styles.section, divider && styles.sectionDivider)}
              >
                <div className={styles.sectionHeader}>{group.label}</div>
                {group.sessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeId}
                    pinned={pinnedSet.has(session.id)}
                    multi={multiSelect}
                    selected={selectedIds.has(session.id)}
                    onDelete={onDelete}
                    onToggleSelect={toggleSelected}
                    onEnterMultiSelect={enterMultiSelect}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </div>
      <div className={styles.bottom}>
        {multiSelect ? (
          <div className={styles.bulkActions}>
            <button
              type="button"
              className={styles.bulkAction}
              disabled={selectedSessions.length === 0}
              onClick={pinSelected}
            >
              <span className={styles.bulkActionIcon}>
                <IconPinOutline16 />
              </span>
              {t('pinSelectedSessions')}
            </button>
            <button
              type="button"
              className={clsx(styles.bulkAction, styles.bulkActionDanger)}
              disabled={selectedSessions.length === 0}
              onClick={() => setBulkDeleting(selectedSessions)}
            >
              <span className={styles.bulkActionIcon}>
                <IconTrashOutline16 />
              </span>
              {t('deleteSelectedSessions')}
            </button>
            <button
              type="button"
              className={clsx(styles.bulkAction, styles.bulkActionIconOnly)}
              aria-label={t('cancel')}
              title={t('cancel')}
              onClick={exitMultiSelect}
            >
              <IconCloseOutline16 />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={styles.settings}
              onClick={() => openSettings('general')}
            >
              <span className={styles.settingsIcon}>
                <IconSettingsOutline16 />
              </span>
              <span className={styles.settingsLabel}>{t('settings')}</span>
            </button>
            <UpdateBadge />
          </>
        )}
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
      {bulkDeleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setBulkDeleting(null)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={deletePending}
                onClick={() => setBulkDeleting(null)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={deletePending} onClick={deleteSelected}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionsWithFilesDescription', { count: bulkDeleting.length })}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭；手指拖动时全程跟手滑入、滑出 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const dragging = useMobileSider((state) => state.dragging)
  // 拖动阶段就要挂载，抽屉才会从第一像素跟着手指滑出；关闭时保留 DOM 播完滑出动画
  const { mounted, visible } = usePresence(open || dragging)
  const drawerRef = useRef<HTMLDivElement>(null)
  const maskRef = useRef<HTMLDivElement>(null)

  // 拖动时只改 CSS 变量和过渡类，不触发 React 重渲染，长列表才不会掉帧。
  // 用 layout effect 在首次绘制前写入进度，拖动挂载的首帧就不会闪在屏幕外
  useLayoutEffect(() => {
    const apply = (state: { progress: number; dragging: boolean }) => {
      const progress = String(state.progress)
      drawerRef.current?.style.setProperty('--drawer-progress', progress)
      maskRef.current?.style.setProperty('--drawer-progress', progress)
      drawerRef.current?.classList.toggle(styles.drawerDragging, state.dragging)
    }
    apply(useMobileSider.getState())
    return useMobileSider.subscribe(apply)
  }, [])

  if (!mounted) {
    return null
  }
  return (
    <>
      <div
        ref={maskRef}
        className={clsx(styles.drawerMask, open && styles.drawerOpen)}
        onClick={closeMobileSider}
      />
      <div
        ref={drawerRef}
        className={clsx(styles.drawer, visible && styles.drawerOpen)}
        data-mobile-sider
        aria-hidden={!visible || undefined}
      >
        <Sider mobile />
      </div>
    </>
  )
}
