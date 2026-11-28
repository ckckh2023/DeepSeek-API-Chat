import { Capacitor } from '@capacitor/core'

/** 桌面端 Tauri：WebView 里注入 __TAURI_INTERNALS__，<a download> 会被静默写进下载目录且没有下载栏 */
export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 安卓 Capacitor：WebView 里注入 Capacitor 桥，不处理 <a download>，也不支持用 blob: 打开新页面 */
export const isCapacitor = () => typeof window !== 'undefined' && 'Capacitor' in window

/**
 * 安卓 App。只有这一端需要自定义的「拍照 / 相册 / 文件」面板：
 * iOS 的 <input type="file"> 本身就会弹系统三菜单，网页版和桌面端直接选文件。
 */
export const isAndroidApp = () => isCapacitor() && Capacitor.getPlatform() === 'android'

/**
 * 普通浏览器（网页版）。
 * 原生 WebView 打开 blob: 链接会白屏甚至卡死（Tauri 新建窗口失败、安卓把主页面导航过去回不来），
 * 这类能力只对网页版开放。
 */
export const isWebApp = () => !isTauri() && !isCapacitor()
