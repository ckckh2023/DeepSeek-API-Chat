import { useEffect } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import {
  useIsMobile,
  useKeyboardInset,
  useMobileViewport,
  usePreventPageScroll,
  usePreventZoom,
} from './viewport.js'
import { isCapacitor } from './platform.js'
import { setupSystemBars } from './systemBars.js'
import { setupUpdateCheck } from '../services/update.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { HistorySearch } from '../components/search/HistorySearch.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey, useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { ApiKeyGuide } from '../components/settings/ApiKeyGuide.js'
import { Toast } from '../components/base/Toast.js'
import { ImageViewer } from '../components/base/ImageViewer.js'
import { FileViewer } from '../components/files/FileViewer.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { primeReadAloud, stopReadAloud } from '../services/speech/readAloud.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import { closeMobileSider } from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { useSwipeDrawer } from '../components/sider/useSwipeDrawer.js'
import { setupSystemBack } from './systemBack.js'
import { setupMemoryAuto } from '../services/memory/run.js'
import styles from './App.module.css'

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const locale = useSettings((state) => state.locale)
  const ttsAutoPlay = useSettings((state) => state.ttsAutoPlay)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const saveError = useChatStore((state) => Object.values(state.sessionSaveErrors).some(Boolean))
  const importingHistory = useChatStore((state) => state.importingHistory)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )

  const frameRef = useMobileViewport(isMobile)
  // 侧栏底部设置项留在原位，键盘弹起只给列表留滚动空间
  useKeyboardInset()

  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )
  const activeId = useChatStore((state) => state.activeId)

  usePreventPageScroll(isMobile)
  // App 内禁用页面缩放，网页版保留浏览器缩放
  usePreventZoom(isMobile && isCapacitor())

  // 安卓：主界面与对话界面任意位置右滑拉出对话列表，抽屉上左滑收起；设置、搜索结果这类全屏浮层打开时不接管手势
  const settingsOpen = useSettingsDialog((state) => state.open)
  const searchOpen = useSearchPanel((state) => state.entry !== null)
  useSwipeDrawer(isMobile && !settingsOpen && !searchOpen)

  // 安卓端把真实安全区写进 CSS 变量，页面自己抬高底部、压低顶部
  useEffect(setupSystemBars, [])
  // 安卓系统返回键：设置 → 搜索结果 → 对话列表逐层关闭，最后才退出应用
  useEffect(setupSystemBack, [])

  // 启动半分钟后检查 GitHub Releases（只在 App 的 WebView 里跑）
  useEffect(setupUpdateCheck, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // 已开启自动朗读时，用页面上的第一次触摸补做音频解锁（例如重启应用后）
  useEffect(() => {
    if (!isMobile || !ttsAutoPlay) {
      return
    }
    document.addEventListener('pointerdown', primeReadAloud, { once: true })
    return () => document.removeEventListener('pointerdown', primeReadAloud)
  }, [isMobile, ttsAutoPlay])
  // 移动端选中会话、切换布局后收起抽屉
  useEffect(closeMobileSider, [activeId, isMobile])

  // 记忆的自动整理：先注册调度器与空闲定时器，再读列表（启动追赶就在 initChat 里发）
  useEffect(setupMemoryAuto, [])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key
    ensureApiKey()
  }, [])

  return (
    <>
      <div ref={frameRef} className={clsx(styles.frame, 'app-frame')}>
        {isMobile ? <MobileSider /> : <Sider collapsed={siderCollapsed} />}
        <main className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            {!ready || (activeId !== null && !session) ? (
              <div className={styles.loadingView}>
                {isMobile ? <MobileHeader /> : null}
                <div className={styles.loadingState} role="status" aria-live="polite">
                  <span>
                    {(!ready ? initError : sessionLoadError)
                      ? t(!ready ? 'sessionListLoadFailed' : 'sessionLoadFailed')
                      : t('sessionLoading')}
                  </span>
                  {(!ready ? initError : sessionLoadError) ? (
                    <Button
                      variant="outlined"
                      size="m"
                      onClick={() => {
                        if (!ready) {
                          void initChat()
                        } else if (activeId !== null) {
                          selectSession(activeId)
                        }
                      }}
                    >
                      {t('retry')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : session ? (
              <SessionView
                session={session}
                streaming={streaming}
                siderCollapsed={siderCollapsed}
              />
            ) : (
              <Welcome />
            )}
          </div>
        </main>
        <SearchPanel />
        <HistorySearch />
      </div>
      <SettingsDialog />
      <ApiKeyGuide />
      <ImageViewer />
      <FileViewer />
      <Toast />
    </>
  )
}
