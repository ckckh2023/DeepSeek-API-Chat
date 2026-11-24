/**
 * 插件契约（编译期注册，不是运行时加载）。
 *
 * 三条约定，插件作者必须遵守：
 * 1. 单向依赖：插件只 import 本目录的 types.js，不 import 宿主的 store / api / 组件。
 * 2. 纯计算：插件是纯函数，不写 localStorage、不发请求、不读 DOM；要数据就由宿主通过
 *    PluginContext 传进来。这样插件出错最坏只是这轮提示词没拼上，不会把请求搞炸。
 * 3. 只回补丁：插件不直接改 system 字符串，而是返回 PromptPatch，由 registry 统一拼接，
 *    保证多个插件叠加时顺序和换行永远一致。
 */

/** 宿主交给插件的只读上下文 */
export interface PluginContext {
  /** 宿主原本的 system 提示词（已包含前面插件的产物，只读） */
  readonly system: string
  /** 本轮已经组装好的 messages 快照，插件只读，仅用于判断场景 */
  readonly messages: readonly PluginMessage[]
  /** 宿主注入的插件配置；未配置时为 undefined，插件需自行收窄类型 */
  readonly config?: unknown
}

/** messages 的最小可读形状：只要 role 和 content，不依赖 api/types.js */
export interface PluginMessage {
  readonly role: string
  readonly content: unknown
}

/** 插件返回的补丁；返回 undefined 表示这轮不插手 */
export interface PromptPatch {
  /** 拼在 system 最前面：适合"角色/模式"这类总纲 */
  readonly head?: string
  /** 拼在 system 最后面：离用户提问最近，适合"压推脱 / 兜底规则" */
  readonly tail?: string
}

/** 预设正文：设置页在编辑弹窗里提供「套用预设」入口，点一下把正文填进输入框 */
export interface PluginPreset {
  /** 稳定标识，仅用于 React key 与将来持久化，不参与注入 */
  readonly id: string
  /** 按钮文案的 i18n 键名；文案集中在 src/i18n，插件不持有 UI 文案 */
  readonly labelKey: string
  /** 套用后填入编辑框的正文 */
  readonly text: string
}

/** 设置页展示元数据：只存 i18n 键名，文案集中在 src/i18n，插件本身不持有文案 */
export interface PluginUiMeta {
  /** 开关行左侧的标题 */
  readonly labelKey: string
  /** 说明文字 */
  readonly descriptionKey?: string
  /** 编辑弹窗底部提示；不写用通用提示 */
  readonly hintKey?: string
  /** 编辑入口的 tooltip；不写用通用的「编辑 {name}」 */
  readonly tooltipKey?: string
  /** 编辑弹窗占位符 */
  readonly placeholderKey?: string
  /** 是否提供正文编辑入口 */
  readonly editable?: boolean
  /**
   * 编辑弹窗的形状，同时决定编辑入口是否出现。
   *
   * 'text'：正文存 pluginSettings[name].config.text，设置页共用 PluginPromptDialog。
   * 'profile'：宿主另有存储（如记忆档案存独立键），弹窗自己读写，不经过 config.text。
   *
   * 这是插件唯一能选的两种存储形态；不是「可扩展的编辑器类型」——有第三种真实需求时再加。
   */
  readonly editor?: 'text' | 'profile'
  /** 预设正文：有值时编辑弹窗顶部出现预设按钮，点一下填入输入框 */
  readonly presets?: readonly PluginPreset[]
}

export interface PromptPlugin {
  /** 唯一名字：报错定位与持久化 key（设置里的 pluginSettings[name]） */
  readonly name: string
  /** 多个插件时的执行顺序，小的先跑；不写按注册顺序 */
  readonly order?: number
  /** 设置页展示元数据；不写则用插件名兜底、不显示说明与编辑入口 */
  readonly ui?: PluginUiMeta
  /** 内置正文：设置页拿它当编辑初值与留空回退；真正拼什么仍以 apply() 为准 */
  readonly defaultText?: string
  /** 社区 / 非官方插件：只在高级模式开启时执行；关闭时状态保留但不注入 */
  readonly community?: boolean
  /** 唯一的扩展点：拿上下文，回补丁 */
  apply(context: PluginContext): PromptPatch | undefined
}
