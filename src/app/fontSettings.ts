import { useSettings, type ChatFontSize } from '../services/settings.js'

/** 档位对应的缩放系数，乘在对话内容与对话列表的字号、行高和列表项高度上 */
const SCALES: Record<ChatFontSize, number> = {
  small: 0.9,
  standard: 1,
  large: 1.1,
  xlarge: 1.25,
}

let appliedScale: number | null = null

/** 应用当前档位；随字号设置变化更新 */
const syncChatFont = () => {
  const scale = SCALES[useSettings.getState().chatFontSize]
  if (scale === appliedScale) {
    return
  }
  appliedScale = scale
  document.documentElement.style.setProperty('--chat-font-scale', String(scale))
}

/** 首屏渲染前同步应用一次，之后随字号设置更新 */
export const setupChatFont = () => {
  syncChatFont()
  useSettings.subscribe(syncChatFont)
}
