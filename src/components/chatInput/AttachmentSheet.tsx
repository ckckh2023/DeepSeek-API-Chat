import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { pushBackHandler } from '../../app/backStack.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCameraOutline20, IconFileOutline20, IconPhotoOutline20 } from '../base/icons.js'
import { usePresence } from '../base/usePresence.js'
import styles from './AttachmentSheet.module.css'

export type AttachmentSource = 'camera' | 'album' | 'files'

/** 向下拖过面板高度的这个比例就关闭（与 Modal 的跟手下拉一致） */
const PULL_CLOSE_RATIO = 0.25
/** 向下甩动速度阈值（px/ms）：手速快时不再要求拖够比例 */
const PULL_FLING_VELOCITY = 0.5

type PullState = {
  pointerId: number
  startY: number
  height: number
  samples: { y: number; t: number }[]
}

const pullVelocity = (samples: { y: number; t: number }[]) => {
  const now = performance.now()
  const recent = samples.filter((sample) => now - sample.t <= 100)
  if (recent.length < 2) {
    return 0
  }
  const first = recent[0]
  const last = recent[recent.length - 1]
  return last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0
}

/**
 * 移动端附件入口：底部上滑三个入口，由系统相机 / 系统图片选择器 / 系统文件选择器接管。
 * 三者都只拿用户主动选中的文件，不需要申请存储或相册权限。
 * 顶部小灰条与设置窗口一致，可跟手向下拖动关闭。
 */
export const AttachmentSheet = ({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (source: AttachmentSource) => void
}) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const sheetRef = useRef<HTMLDivElement>(null)
  const pullRef = useRef<PullState | null>(null)

  // 退出动画期间仍然拦截安卓返回键，避免误关下面的页面
  useEffect(() => {
    if (!mounted) {
      return
    }
    return pushBackHandler(() => onCloseRef.current())
  }, [mounted])

  useEffect(() => {
    if (!mounted) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mounted])

  /** 松手回弹：先恢复 CSS 过渡，下一帧再清掉内联位移 */
  const settlePull = (sheet: HTMLElement) => {
    sheet.style.transition = ''
    requestAnimationFrame(() => {
      sheet.style.removeProperty('transform')
    })
  }

  const onPullStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return
    }
    const sheet = sheetRef.current
    if (!sheet || pullRef.current) {
      return
    }
    pullRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      height: sheet.getBoundingClientRect().height,
      samples: [{ y: event.clientY, t: performance.now() }],
    }
    // 拖动时只改内联样式，不走 React 重渲染，跟手才不掉帧
    sheet.style.transition = 'none'
    try {
      // 按下就捕获：拖出面板范围松手也能收到 pointerup
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针已释放时忽略
    }
  }

  const onPullMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pull = pullRef.current
    const sheet = sheetRef.current
    if (!pull || !sheet || event.pointerId !== pull.pointerId) {
      return
    }
    const now = performance.now()
    pull.samples.push({ y: event.clientY, t: now })
    while (pull.samples.length > 2 && now - pull.samples[0].t > 100) {
      pull.samples.shift()
    }
    // 只跟手向下；向上最多回到原位
    const dy = Math.min(pull.height, Math.max(0, event.clientY - pull.startY))
    sheet.style.transform = `translateY(${dy}px)`
  }

  const onPullEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pull = pullRef.current
    const sheet = sheetRef.current
    if (!pull || !sheet || event.pointerId !== pull.pointerId) {
      return
    }
    pullRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    pull.samples.push({ y: event.clientY, t: performance.now() })
    const dy = Math.max(0, event.clientY - pull.startY)
    const velocity = pullVelocity(pull.samples)
    const shouldClose =
      velocity > PULL_FLING_VELOCITY || (velocity >= 0 && dy > pull.height * PULL_CLOSE_RATIO)
    if (!shouldClose) {
      settlePull(sheet)
      return
    }
    // 松手先把面板推到屏幕外，再交给退出动画收尾，避免从当前位置跳回去
    sheet.style.transition = ''
    sheet.style.transform = 'translateY(100%)'
    onCloseRef.current()
    requestAnimationFrame(() => {
      sheet.style.removeProperty('transform')
    })
  }

  const onPullCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pull = pullRef.current
    if (!pull || event.pointerId !== pull.pointerId) {
      return
    }
    pullRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const sheet = sheetRef.current
    if (sheet) {
      settlePull(sheet)
    }
  }

  if (!mounted) {
    return null
  }

  const options = [
    { source: 'camera', label: t('attachmentCamera'), icon: <IconCameraOutline20 /> },
    { source: 'album', label: t('attachmentAlbum'), icon: <IconPhotoOutline20 /> },
    { source: 'files', label: t('attachmentFiles'), icon: <IconFileOutline20 /> },
  ] as const

  return createPortal(
    <div
      className={styles.overlay}
      data-state={visible ? 'open' : 'closed'}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCloseRef.current()
        }
      }}
    >
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t('uploadFile')}
        onPointerDown={onPullStart}
        onPointerMove={onPullMove}
        onPointerUp={onPullEnd}
        onPointerCancel={onPullCancel}
      >
        <div className={styles.handle} aria-hidden="true">
          <span className={styles.bar} />
        </div>
        <div className={styles.options}>
          {options.map((option) => (
            <button
              key={option.source}
              type="button"
              className={styles.option}
              onClick={() => onPick(option.source)}
            >
              <span className={styles.icon}>{option.icon}</span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}