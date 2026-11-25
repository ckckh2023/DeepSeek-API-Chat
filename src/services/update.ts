import { create } from 'zustand'
import { isCapacitor, isTauri } from '../app/platform.js'
import { openExternal } from '../app/systemBars.js'

export const REPOSITORY = 'ckckh2023/DeepSeek-API-Chat'
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases/latest`
export const GITEE_RELEASES_URL = `https://gitee.com/${REPOSITORY}/releases/latest`
export const BAIDU_PAN_URL = 'https://pan.baidu.com/s/1v_7pM502Ek31azc4Zv1uYw?pwd=3141'
export const PAN123_URL = 'https://1851751239.share.123pan.cn/123pan/XH7Bvd-n9rg'
export const QUARK_PAN_URL = 'https://pan.quark.cn/s/afb0f7ff3e64'
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`
const GITEE_LATEST_RELEASE_API = `https://gitee.com/api/v5/repos/${REPOSITORY}/releases/latest`
/** 打开应用后 5 秒再查，给首屏渲染和初始化请求留出时间 */
const CHECK_DELAY_MS = 5_000
/** 每个来源最多等 6 秒；GitHub 失败后再试 Gitee */
const FETCH_TIMEOUT_MS = 6_000

/** 打包时由 rspack 写进 index.html，见 rspack.config.ts 的 HtmlRspackPlugin meta */
export const appVersion = (): string =>
  document
    .querySelector('meta[name="application-version"]')
    ?.getAttribute('content')
    ?.trim() ?? ''

const toParts = (version: string): number[] =>
  version
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0))

/** 逐段比较，返回正数表示 left 更新 */
export const compareVersions = (left: string, right: string): number => {
  const a = toParts(left)
  const b = toParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

const readTag = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) {
    return ''
  }
  const tag = (value as { tag_name?: unknown }).tag_name
  return typeof tag === 'string' ? tag.trim() : ''
}

const fetchTag = async (url: string): Promise<string> => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      return ''
    }
    return readTag(await response.json())
  } catch {
    return ''
  } finally {
    window.clearTimeout(timer)
  }
}

/** 先查 GitHub；失败或没有可用 tag 时回退到 Gitee。 */
const fetchLatestVersion = async (): Promise<string> => {
  const github = await fetchTag(LATEST_RELEASE_API)
  if (github) {
    return github
  }
  return fetchTag(GITEE_LATEST_RELEASE_API)
}

export type UpdateCheckResult = { current: string; latest: string }

/** 手动检查：返回当前版本与最新 tag；网络失败时 latest 为空字符串 */
export const checkLatestVersion = async (): Promise<UpdateCheckResult> => ({
  current: appVersion(),
  latest: await fetchLatestVersion(),
})

type UpdateState = {
  /** 存在比当前更新的版本时是它的 tag，空字符串表示没有更新 */
  latest: string
  check: () => Promise<void>
}

export const useUpdateStore = create<UpdateState>((set) => ({
  latest: '',
  check: async () => {
    const { current, latest } = await checkLatestVersion()
    const hasUpdate = Boolean(current && latest && compareVersions(latest, current) > 0)
    set({ latest: hasUpdate ? latest : '' })
  },
}))

/** 启动后延迟检查一次；只在 App 的 WebView 里跑，网页版不检查 */
export const setupUpdateCheck = () => {
  if (!isTauri() && !isCapacitor()) {
    return undefined
  }
  const timer = window.setTimeout(() => {
    void useUpdateStore.getState().check()
  }, CHECK_DELAY_MS)
  return () => window.clearTimeout(timer)
}

/** 跳转 Releases：和页面里的普通外链一样，交给系统/WebView 打开 */
export const openReleases = () => openExternal(RELEASES_URL)