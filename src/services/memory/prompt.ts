/**
 * 整理提示词正文（与插件目录下各个 prompt.ts 的惯例一致：正文用 .ts 存）。
 *
 * 三处写死的东西：
 * 1. 分工：只写事实，禁止写语气、文风、称呼方式 —— 那些归 persona。两个插件同时开不能打架。
 * 2. 输出严格 JSON，字段名与档案形状一一对应，多的不要。
 * 3. 每段字数上限在这里执行：读侧不截断，超限由整理环节压。
 *
 * 档案的四个段标题不在这里重写，直接从注入模板里取，保证两边一致。
 */
import { MEMORY_SECTIONS, UNRESOLVED_TITLE } from '../../plugins/memory/prompt.js'

/** 各段字数上限；与 spec 的三段 shape 一致 */
export const SECTION_LIMITS = {
  identity: 400,
  preferences: 450,
  ongoing: 350,
} as const

/** 档案整体上限（三段 + 未解决清单）；超了由整理环节压，读侧不截断 */
export const PROFILE_MAX_LENGTH = 1200

/** 未解决清单：最多 5 条，合计不超过 200 字 */
export const UNRESOLVED_MAX_ITEMS = 5
export const UNRESOLVED_MAX_LENGTH = 200

/** 单批最多几轮、单条消息截断到多少字、轮次正文总计上限 */
export const BATCH_MAX_TURNS = 30
export const MESSAGE_MAX_LENGTH = 2000
export const BATCH_MAX_LENGTH = 24000

/**
 * 第二次尝试的提醒。
 *
 * 第一次的输入已经写了「只输出 JSON」，所以这里必须多给一条信息，否则重试等于把同一句话
 * 再问一遍。这里点明哪里不合格，模型才有机会改。
 */
export const RETRY_HINT =
  '上一次输出不合格：可能是非法 JSON、缺字段、超出字数上限，或有便条没回应。只输出 JSON，不要代码块、不要解释、不要 Markdown。'

/** 段标题在 prompt 里只出现一次，去掉注入用的方括号 */
const bareTitle = (title: string): string => title.replace(/[【】]/g, '')

const sectionLine = (section: (typeof MEMORY_SECTIONS)[number]): string =>
  `- ${bareTitle(section.title)}（${section.key}）：不超过 ${SECTION_LIMITS[section.key]} 字`

const sectionLines = MEMORY_SECTIONS.map(sectionLine).join('\n')

/** 整理指令，放 system */
export const DERIVE_SYSTEM = `你负责维护一份关于用户的长期档案。你的输出会成为下一次对话的背景资料。

只写事实：身份、偏好、进行中的事。禁止写语气、文风、称呼方式、说话习惯 —— 那些由另一个人格设置负责，你写进去就会打架。

输出严格 JSON，不要代码块，不要解释。字段：

{
  "identity": "我是谁：姓名、职业、所在地、语言",
  "preferences": "偏好与禁忌",
  "ongoing": "进行中的事",
  "unresolved": ["一行一条，已结束的不要写"],
  "cites": ["t1", "t3"],
  "noteReplies": [{ "id": "便条 id", "reply": "已改 / 没改，因为…" }]
}

各段字数上限（超了会被判为不合格，必须自己压缩）：
${sectionLines}
- ${bareTitle(UNRESOLVED_TITLE)}（unresolved）：最多 ${UNRESOLVED_MAX_ITEMS} 条，合计不超过 ${UNRESOLVED_MAX_LENGTH} 字

规则：
1. 新信息覆盖旧信息；用户改口时以更晚的说法为准，不要同时保留两种说法。
2. 不要编造。没在输入里出现的事实一律不写。
3. cites 列出你实际用到的 turn 编号；没有待处理轮次时可以写空数组。
4. 每条用户便条都必须在 noteReplies 里回应一次，id 原样带回；不接受就先改，改不了要说清为什么。
5. 用户便条优先级最高，与档案冲突时以便条为准。
6. 档案整体（三段 + 未解决清单）不超过 ${PROFILE_MAX_LENGTH} 字：宁可少写，不要注水。
7. 寒暄、玩笑、一次性的闲聊不写进档案。
8. 没有待处理轮次时，保留现有档案中仍然成立的内容；不要因为本轮没有新对话就清空档案。`

export interface DeriveInput {
  /** 现有档案全文；空档案时为空串 */
  readonly profileText: string
  /** 编号便条；没有则整段省略 */
  readonly notes: readonly { readonly id: string; readonly text: string }[]
  /** 已按上限裁剪、编号好的轮次正文 */
  readonly turnsText: string
  /** 第二次尝试时附上的提醒；第一次为 undefined */
  readonly retryHint?: string
}

/** 组装整理请求里那一条 user 消息 */
export const buildDeriveUserMessage = (input: DeriveInput): string => {
  const parts: string[] = ['[现有档案]', input.profileText || '（空）']
  if (input.notes.length > 0) {
    parts.push('[用户便条]', input.notes.map((note) => `${note.id}｜${note.text}`).join('\n'))
  }
  parts.push('[待处理轮次]', input.turnsText || '（没有新的对话轮次，只需处理上述便条并更新档案）')
  parts.push('[输出要求]', input.retryHint ?? '只输出 JSON。')
  return parts.join('\n\n')
}
