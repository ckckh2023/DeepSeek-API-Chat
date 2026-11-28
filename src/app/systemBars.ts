import { translate } from '../i18n/index.js'
import { showToast } from '../components/base/toastState.js'
import { isTauri } from './platform.js'

/** MainActivity 注入的原生桥接，只有 Android 上有 */
type SystemBarsBridge = {
  /** 返回 {"top":<CSS px>,"bottom":<CSS px>} */
  getInsets: () => string
  setDarkIcons: (dark: boolean) => void
  /** 交给系统浏览器打开链接（WebView 里 window.open 不可靠） */
  openExternal?: (url: string) => void
  /** 把缓存里的附件交给系统默认应用打开，失败时回调 window.__fileOpenFailed */
  openFile?: (uri: string, mimeType: string) => void
  /** 打开系统文档选择器（SAF），结果回调 window.__nativeDocumentsPicked */
  pickDocuments?: () => void
  /** 删除原生缓存里的附件副本 */
  deleteCachedDocument?: (path: string) => void
  /** 打开系统「保存到」对话框，把缓存里的 ZIP 复制到用户选择的位置 */
  saveDocument?: (sourcePath: string, name: string) => void
}

type Insets = { top: number; bottom: number }

declare global {
  interface Window {
    SystemBars?: SystemBarsBridge
    __applySystemInsets?: (top: number, bottom: number) => void
    __applyFontWeight?: (adjustment: number) => void
    __fileOpenFailed?: () => void
  }
}

const toCssPixels = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0

/**
 * 把系统安全区写成 CSS 变量，组件只读变量，不依赖 WebView 的 env()。
 * 页面高度不再由这里下发：安卓原生直接把 WebView 容器 resize 到键盘顶部，
 * CSS 的 100dvh / visualViewport 会自然跟随，避免两套高度互相打架。
 */
export const applySystemInsets = (top: number, bottom: number) => {
  const style = document.documentElement.style
  style.setProperty('--safe-top', `${toCssPixels(top)}px`)
  style.setProperty('--safe-bottom', `${toCssPixels(bottom)}px`)
}

/**
 * 安卓系统「字体粗细」：Configuration.fontWeightAdjustment 是 -1000..1000 的偏移量，
 * 直接叠加到四个字重档位上。网页端没有字重设置，保持 :root 里的默认值。
 */
export const applyFontWeight = (adjustment: number) => {
  const delta = Number.isFinite(adjustment) ? Math.round(adjustment) : 0
  const clamp = (value: number) => Math.min(1000, Math.max(1, Math.round(value)))
  const style = document.documentElement.style
  style.setProperty('--fw-normal', String(clamp(400 + delta)))
  style.setProperty('--fw-medium', String(clamp(500 + delta)))
  style.setProperty('--fw-semibold', String(clamp(600 + delta)))
  style.setProperty('--fw-bold', String(clamp(700 + delta)))
}

const parseInsets = (raw: string): Insets => {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) {
      return { top: 0, bottom: 0 }
    }
    const { top, bottom } = value as { top?: unknown; bottom?: unknown }
    return {
      top: toCssPixels(top),
      bottom: toCssPixels(bottom),
    }
  } catch {
    return { top: 0, bottom: 0 }
  }
}

/** 状态栏和导航栏的图标明暗跟随应用主题 */
export const syncSystemBarIcons = (dark: boolean) => {
  window.SystemBars?.setDarkIcons(dark)
}

const openWithAnchor = (url: string) => {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** 外部链接优先交给安卓原生系统浏览器；桌面 Tauri 交给系统默认浏览器；网页端用真实 <a> 点击 */
export const openExternal = (url: string) => {
  if (window.SystemBars?.openExternal) {
    try {
      // 必须带着 SystemBars 调用，不能把方法拆出来单独执行
      window.SystemBars.openExternal(url)
      return
    } catch {
      // 桥接不可用时继续走原生链接
    }
  }
  if (isTauri()) {
    // Tauri WebView 会拦截 target=_blank，必须经 opener 插件交给系统浏览器
    void import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(url))
      .catch(() => openWithAnchor(url))
    return
  }
  openWithAnchor(url)
}

/**
 * Tauri WebView 不会处理 target=_blank。在 document 冒泡阶段统一接管 http(s) 链接：
 * 组件里已经 preventDefault 并自行调用 openExternal 的会被跳过，其余交给系统浏览器。
 */
export const setupExternalLinks = () => {
  if (!isTauri()) {
    return
  }
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) {
      return
    }
    const target = event.target
    if (!(target instanceof Element)) {
      return
    }
    const anchor = target.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || !/^https?:\/\//i.test(anchor.href)) {
      return
    }
    event.preventDefault()
    openExternal(anchor.href)
  })
}

/** 接管全面屏留白；网页端没有桥接，保持 CSS 里的 env() 兜底 */
export const setupSystemBars = () => {
  // 即使桥接没注入，也允许原生主动推送（页面加载完成前后各推一次）
  window.__applySystemInsets = applySystemInsets
  window.__applyFontWeight = applyFontWeight
  // 安卓原生打开附件失败时回调，文案跟随当前语言
  window.__fileOpenFailed = () => showToast(translate('fileOpenFailed'))
  const systemBars = window.SystemBars
  if (!systemBars) {
    return
  }
  // 标记「高度由原生键盘驱动」，只有这时才给 .app-frame 加高度过渡：
  // 网页端 dvh 会随地址栏伸缩变化，加过渡会拖影。
  document.documentElement.dataset.nativeInsets = ''
  const { top, bottom } = parseInsets(systemBars.getInsets())
  applySystemInsets(top, bottom)
}
