/**
 * 把档案交给插件的那一步。
 *
 * 铁律二规定插件不读 localStorage，所以 Profile 由宿主读出来、塞进插件状态传进去。
 * 真正的读写都在 store.ts（Profile 与其余控制状态分两个键）。
 *
 * 第二步起用户不再直接编辑档案（spec《便条》）：设置页只读展示 + 写便条，
 * 档案只有整理环节能写。所以这里只剩「塞进插件状态」一件事。
 */
import type { PluginState } from '../../plugins/index.js'
import type { MemoryProfile } from '../../plugins/memory/prompt.js'
import { readMemoryProfile } from './store.js'

/**
 * 把 Profile 塞进插件状态。
 *
 * 插件只拿得到 pluginSettings，所以宿主在组装请求前同步读一次档案挂到 memory.config 上。
 * 不改入参、不打开关：开关没开时原样返回（也不读存储），档案不该成为「隐式启用」。
 * profile 参数只为测试注入，生产调用只传 states。
 */
export const withMemoryProfile = (
  states: Readonly<Record<string, PluginState>>,
  profile?: MemoryProfile
): Readonly<Record<string, PluginState>> => {
  if (states.memory?.enabled !== true) {
    return states
  }
  const current = profile ?? readMemoryProfile()
  // 「现在」也由宿主给：插件不自己取时钟，同样的档案与时刻必须拼出同样的文本
  return { ...states, memory: { ...states.memory, config: { ...current, now: Date.now() } } }
}
