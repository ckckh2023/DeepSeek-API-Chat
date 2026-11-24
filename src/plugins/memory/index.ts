/**
 * 插件：记忆（memory）。
 *
 * 拼在 system 末尾（tail），order 取 700：排在 custom-instructions（500）之后、purge（900）之前。
 * 为什么不用 head：head 会把人格挤出开篇高注意力位，且记忆每轮都在变，放在稳定前缀里
 * 会把 prompt cache 打断。
 *
 * 内置插件（不标 community）：记忆不涉及内容策略，普通用户就能开。
 *
 * 铁律二是这里的重点：插件不读 localStorage。Profile 由宿主在组装请求前同步读出、
 * 塞进 pluginSettings.memory.config 传进来，连「现在几点」也一并算好传在 updatedAt 上——
 * 插件自己取 Date.now() 就会让同样入参两次结果不同，那是纯函数的反例。
 */
import type { PromptPatch, PromptPlugin } from '../types.js'
import { readNow, readProfile, renderMemoryBlock } from './prompt.js'

export const memoryPlugin: PromptPlugin = {
  name: 'memory',
  order: 700,
  ui: {
    labelKey: 'pluginMemoryLabel',
    descriptionKey: 'pluginMemoryDescription',
    hintKey: 'pluginMemoryHint',
    tooltipKey: 'pluginMemoryEdit',
    // 档案不住在 config.text 里，所以不是 editable：那个字段专指「正文可从设置页改写」
    editor: 'profile',
  },
  apply({ config }): PromptPatch | undefined {
    const block = renderMemoryBlock(readProfile(config), readNow(config))
    return block ? { tail: block } : undefined
  },
}
