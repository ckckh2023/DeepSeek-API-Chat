import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ThinkingEffort } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 思考内容的呈现方式：完全折叠 / 部分折叠（限高滚动）/ 不折叠 */
export type ThinkingCollapse = 'full' | 'partial' | 'none'

/** 对话内容与列表的字号档位；未保存过时标准 */
export type ChatFontSize = 'small' | 'standard' | 'large' | 'xlarge'

/** 插件在本机的状态；默认关闭，config 由各插件自行约定形状 */
export type PluginSettings = Record<
  string,
  { enabled: boolean; config?: Record<string, unknown> }
>

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、自动朗读、深度思考与强度、智能搜索开关、思考折叠、对话字号、侧边栏收起状态、插件状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  ttsAutoPlay: boolean
  thinking: boolean
  thinkingEffort: ThinkingEffort
  thinkingCollapse: ThinkingCollapse
  chatFontSize: ChatFontSize
  search: boolean
  siderCollapsed: boolean
  pluginSettings: PluginSettings
}

const KEYS = {
  apiKey: 'deepseek-api-chat:api-key',
  locale: 'deepseek-api-chat:locale',
  location: 'deepseek-api-chat:location',
  themePreference: 'deepseek-api-chat:theme-preference',
  ttsVoice: 'deepseek-api-chat:tts-voice',
  ttsAutoPlay: 'deepseek-api-chat:tts-auto-play',
  thinking: 'deepseek-api-chat:thinking',
  thinkingEffort: 'deepseek-api-chat:thinking-effort',
  thinkingCollapse: 'deepseek-api-chat:thinking-collapse',
  chatFontSize: 'deepseek-api-chat:chat-font-size',
  search: 'deepseek-api-chat:search',
  siderCollapsed: 'deepseek-api-chat:sider-collapsed',
  pluginSettings: 'deepseek-api-chat:plugin-settings',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 读取插件状态；结构损坏或字段非法时丢弃该条，避免坏数据影响请求组装 */
const parsePluginSettings = (): PluginSettings => {
  try {
    const parsed: unknown = JSON.parse(read(KEYS.pluginSettings) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const result: PluginSettings = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        continue
      }
      const state = value as { enabled?: unknown; config?: unknown }
      result[name] = {
        enabled: state.enabled === true,
        ...(state.config && typeof state.config === 'object' && !Array.isArray(state.config)
          ? { config: state.config as Record<string, unknown> }
          : {}),
      }
    }
    return result
  } catch {
    return {}
  }
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 未保存过时部分折叠：思考内容限制在固定高度的窗口内滚动 */
const initialThinkingCollapse = (): ThinkingCollapse => {
  const saved = read(KEYS.thinkingCollapse)
  return saved === 'full' || saved === 'none' ? saved : 'partial'
}

/** 未保存过时标准字号；非法值回退标准 */
const initialChatFontSize = (): ChatFontSize => {
  const saved = read(KEYS.chatFontSize)
  return saved === 'small' || saved === 'large' || saved === 'xlarge' ? saved : 'standard'
}

/** 旧版本只有开关：明确关闭过就保持关闭，其余（含新用户）默认高。 */
const initialThinkingEffort = (): ThinkingEffort => {
  const saved = read(KEYS.thinkingEffort)
  if (saved === 'none' || saved === 'low' || saved === 'high' || saved === 'max') {
    return saved
  }
  return read(KEYS.thinking) === 'false' ? 'none' : 'high'
}

const initialEffort = initialThinkingEffort()

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  ttsAutoPlay: read(KEYS.ttsAutoPlay) === 'true',
  thinking: initialEffort !== 'none',
  thinkingEffort: initialEffort,
  thinkingCollapse: initialThinkingCollapse(),
  chatFontSize: initialChatFontSize(),
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  pluginSettings: parsePluginSettings(),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setTtsAutoPlay = (ttsAutoPlay: boolean) => {
  write(KEYS.ttsAutoPlay, String(ttsAutoPlay))
  useSettings.setState({ ttsAutoPlay })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  const current = useSettings.getState().thinkingEffort
  const thinkingEffort = thinking ? (current === 'none' ? 'high' : current) : 'none'
  write(KEYS.thinking, String(thinking))
  write(KEYS.thinkingEffort, thinkingEffort)
  useSettings.setState({ thinking, thinkingEffort })
}

export const setThinkingEffort = (thinkingEffort: ThinkingEffort) => {
  write(KEYS.thinkingEffort, thinkingEffort)
  write(KEYS.thinking, String(thinkingEffort !== 'none'))
  useSettings.setState({ thinkingEffort, thinking: thinkingEffort !== 'none' })
}

export const setThinkingCollapse = (thinkingCollapse: ThinkingCollapse) => {
  write(KEYS.thinkingCollapse, thinkingCollapse)
  useSettings.setState({ thinkingCollapse })
}

export const setChatFontSize = (chatFontSize: ChatFontSize) => {
  write(KEYS.chatFontSize, chatFontSize)
  useSettings.setState({ chatFontSize })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
export const setPluginEnabled = (name: string, enabled: boolean) => {
  const current = useSettings.getState().pluginSettings
  const pluginSettings: PluginSettings = {
    ...current,
    [name]: { ...current[name], enabled },
  }
  write(KEYS.pluginSettings, JSON.stringify(pluginSettings))
  useSettings.setState({ pluginSettings })
}

export const setPluginConfig = (name: string, config: Record<string, unknown>) => {
  const current = useSettings.getState().pluginSettings
  const pluginSettings: PluginSettings = {
    ...current,
    [name]: { enabled: current[name]?.enabled === true, config },
  }
  write(KEYS.pluginSettings, JSON.stringify(pluginSettings))
  useSettings.setState({ pluginSettings })
}
