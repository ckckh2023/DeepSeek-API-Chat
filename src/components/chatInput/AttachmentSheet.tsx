import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { pushBackHandler } from '../../app/backStack.js'
import { useTranslate } from '../../i18n/index.js'
import { IconCameraOutline20, IconFileOutline20, IconPhotoOutline20 } from '../base/icons.js'
import { usePresence } from '../base/usePresence.js'
import styles from './AttachmentSheet.module.css'

export type AttachmentSource = 'camera' | 'album' | 'files'

/**
 * 移动端附件入口：底部上滑三个入口，由系统相机 / 系统图片选择器 / 系统文件选择器接管。
 * 三者都只拿用户主动选中的文件，不需要申请存储或相册权限。
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
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={t('uploadFile')}>
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
