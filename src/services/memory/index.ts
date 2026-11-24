/**
 * 冷路径入口：把未处理的轮次整理成一份新档案。
 *
 * 这是 spec 认可的第二个测试接缝。`send` 由调用方注入，所以这个模块本身不认识 `request()`，
 * 单测不需要网络就能覆盖「坏 JSON / 超限 / 漏便条 → 重试一次 → 仍失败则旧档案不变」。
 *
 * 三条不可动摇的约束：
 * 1. 失败绝不写半成品：档案、水位、便条全部保持原样，只有失败计数 +1。
 * 2. 重试恰好一次，第二次附上「只输出 JSON」。
 * 3. 水位下界守卫：`processedCount` 超过当前可见条数时按 0 重置并全量重建。
 *    编辑消息、切版本、切分支都会改变消息序列，记条数迟早会偏，这条兜住它。
 */
import type { MemoryProfile } from '../../plugins/memory/prompt.js'
import { MEMORY_SECTIONS, UNRESOLVED_TITLE } from '../../plugins/memory/prompt.js'
import type { CreateMessageRequest } from '../api/types.js'
import type { MemoryNote } from './store.js'
import type { MemoryTurn } from './turns.js'
import {
  BATCH_MAX_LENGTH,
  BATCH_MAX_TURNS,
  buildDeriveUserMessage,
  DERIVE_SYSTEM,
  MESSAGE_MAX_LENGTH,
  PROFILE_MAX_LENGTH,
  RETRY_HINT,
  SECTION_LIMITS,
  UNRESOLVED_MAX_ITEMS,
  UNRESOLVED_MAX_LENGTH,
} from './prompt.js'

/** 发一次请求并拿到正文；由调用方注入，单测传假函数即可 */
export type SendDeriveRequest = (request: CreateMessageRequest) => Promise<string>

export interface DeriveOptions {
  readonly profile: MemoryProfile
  readonly notes: readonly MemoryNote[]
  /** 当前可见的全部消息（按顺序），已处理的与未处理的都在里面 */
  readonly messages: readonly MemoryTurn[]
  /** 已纳入整理的条数；超过 messages.length 时按 0 重置 */
  readonly processedCount: number
  readonly failures: number
  /** 宿主给的「现在」，不在这里取时钟，测试才能断言 */
  readonly now: number
  readonly send: SendDeriveRequest
}

export interface DeriveOutcome {
  /** updated：档案已换新；skipped：没有未处理内容；failed：两次都没成 */
  readonly status: 'updated' | 'skipped' | 'failed'
  readonly profile: MemoryProfile
  readonly notes: readonly MemoryNote[]
  readonly processedCount: number
  readonly failures: number
  /** 实际发了几次请求；skipped 时为 0 */
  readonly attempts: number
}

/** 一次请求最多 30 轮（问 + 答），单条截断 2000 字，正文合计 ≤24000 字 */
const MESSAGES_PER_TURN = 2

/** 重试次数：首次之外再来一次，这是上限不是起点 */
const MAX_ATTEMPTS = 2

const JSON_MISSING = 'no-json'

/** 从可能包着代码块的回答里取出 JSON 主体；取不到返回 null */
const extractJson = (text: string): string | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }
  return text.slice(start, end + 1)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readSection = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\n{3,}/g, '\n\n') : ''

/** 字符数按码点算：中文一字一算，emoji 不因代理对翻倍 */
const charCount = (text: string): number => [...text].length

/** 压到上限内：只截，不改写。判超限是调用方的事 */
const fit = (text: string, limit: number): string =>
  charCount(text) <= limit ? text : [...text].slice(0, limit).join('').trim()

interface ParsedAnswer {
  identity: string
  preferences: string
  ongoing: string
  unresolved: string[]
  cites: string[]
  noteReplies: { id: string; reply: string }[]
}

type ParseResult = { ok: true; value: ParsedAnswer } | { ok: false; reason: string }

/**
 * 校验模型输出。
 *
 * 超限不在这里改，而是判为不合格触发重试 —— spec 的「单段超字数上限时由整理环节压缩」
 * 指的是整理这一环（重试让模型自己压），不是读侧静默截断。
 */
const parseAnswer = (
  text: string,
  noteIds: readonly string[],
  requireCites: boolean
): ParseResult => {
  const body = extractJson(text)
  if (!body) {
    return { ok: false, reason: JSON_MISSING }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, reason: JSON_MISSING }
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'not-object' }
  }
  const sections = {} as Record<'identity' | 'preferences' | 'ongoing', string>
  for (const section of MEMORY_SECTIONS) {
    // 缺字段不能当空串收下：模型漏一个词就等于把用户整段档案删了
    if (parsed[section.key] === undefined) {
      return { ok: false, reason: `missing:${section.key}` }
    }
    const value = readSection(parsed[section.key])
    if (charCount(value) > SECTION_LIMITS[section.key]) {
      return { ok: false, reason: `too-long:${section.key}` }
    }
    sections[section.key] = value
  }
  const rawUnresolved = parsed.unresolved
  if (rawUnresolved !== undefined && !Array.isArray(rawUnresolved)) {
    return { ok: false, reason: 'bad-unresolved' }
  }
  const unresolved = (rawUnresolved ?? []).flatMap((item) => {
    const line = readSection(item).replace(/\n+/g, ' ')
    return line ? [line] : []
  })
  if (
    unresolved.length > UNRESOLVED_MAX_ITEMS ||
    charCount(unresolved.join('\n')) > UNRESOLVED_MAX_LENGTH
  ) {
    return { ok: false, reason: 'too-long:unresolved' }
  }
  // 总字数：逐段都没超，加起来仍可能超（400 + 450 + 350 已经把 1200 用尽）
  const total = charCount(
    [sections.identity, sections.preferences, sections.ongoing, ...unresolved].join('')
  )
  if (total > PROFILE_MAX_LENGTH) {
    return { ok: false, reason: 'too-long:profile' }
  }
  const rawCites = parsed.cites
  if (rawCites !== undefined && !Array.isArray(rawCites)) {
    return { ok: false, reason: 'no-cites' }
  }
  const cites = (rawCites ?? []).filter(
    (item): item is string => typeof item === 'string' && !!item
  )
  // 有轮次时必须引用至少一轮；只有便条时没有 turn 可引，允许空数组
  if (requireCites && cites.length === 0) {
    return { ok: false, reason: 'no-cites' }
  }
  const rawReplies = parsed.noteReplies
  if (rawReplies !== undefined && !Array.isArray(rawReplies)) {
    return { ok: false, reason: 'bad-replies' }
  }
  const noteReplies = (rawReplies ?? []).flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.reply !== 'string') {
      return []
    }
    const reply = item.reply.trim()
    return item.id && reply ? [{ id: item.id, reply }] : []
  })
  // 便条必须逐条回应：漏一条就让这次输出作废，重试一次
  const answered = new Set(noteReplies.map((item) => item.id))
  if (noteIds.some((id) => !answered.has(id))) {
    return { ok: false, reason: 'missing-replies' }
  }
  return {
    ok: true,
    value: { ...sections, unresolved, cites, noteReplies },
  }
}

/** 现有档案渲染成请求里的那段文本；与注入文本同标题，模型才认得出 */
const renderExisting = (profile: MemoryProfile): string => {
  const blocks: string[] = []
  for (const section of MEMORY_SECTIONS) {
    const body = profile[section.key]
    if (body) {
      blocks.push(`${section.title}\n${body}`)
    }
  }
  if (profile.unresolved.length > 0) {
    blocks.push(`${UNRESOLVED_TITLE}\n${profile.unresolved.map((line) => `- ${line}`).join('\n')}`)
  }
  return blocks.join('\n\n')
}

/** 只取答疑成对的轮次；单条截断到 2000 字 */
const toRounds = (messages: readonly MemoryTurn[]): [MemoryTurn, MemoryTurn][] => {
  const rounds: [MemoryTurn, MemoryTurn][] = []
  for (let index = 0; index + 1 < messages.length; index += MESSAGES_PER_TURN) {
    const question = messages[index]
    const answer = messages[index + 1]
    if (question.role === 'user' && answer.role === 'assistant') {
      rounds.push([question, answer])
    }
  }
  return rounds
}

/** 按 30 轮 / 24000 字裁出这一批，返回正文与这一批吃掉的条数 */
const buildBatch = (messages: readonly MemoryTurn[]) => {
  const rounds = toRounds(messages).slice(0, BATCH_MAX_TURNS)
  const blocks: string[] = []
  let length = 0
  let consumed = 0
  for (const [index, [question, answer]] of rounds.entries()) {
    const block = `turn ${index + 1}\n用户：${fit(question.text, MESSAGE_MAX_LENGTH)}\n助手：${fit(answer.text, MESSAGE_MAX_LENGTH)}`
    // 预算算的是轮次正文；分隔符与段标题不占额度
    if (length + block.length > BATCH_MAX_LENGTH) {
      break
    }
    blocks.push(block)
    length += block.length
    consumed += MESSAGES_PER_TURN
  }
  return { text: blocks.join('\n\n'), consumed }
}

const request = (input: string): CreateMessageRequest => ({
  model: 'deepseek-flash',
  system: DERIVE_SYSTEM,
  messages: [{ role: 'user', content: input }],
  thinking: { type: 'disabled' },
  tools: [],
  safety_check: { level: 'low' },
})

/**
 * 整理一次。
 *
 * 不读 localStorage、不取 Date.now()：入参给什么就用什么，出参把新状态交回去由宿主落盘。
 * 这样同一个入参跑两次结果一致，测试也不必搭存储。
 */
export const deriveProfile = async (options: DeriveOptions): Promise<DeriveOutcome> => {
  const { messages, notes } = options
  // 水位下界守卫：序列被编辑、切版本、切分支改短后，旧水位会「显得已处理太多」
  const base = options.processedCount > messages.length ? 0 : Math.max(0, options.processedCount)
  const pending = messages.slice(base)
  const batch = buildBatch(pending)
  const unchanged = {
    profile: options.profile,
    notes,
    processedCount: base,
    failures: options.failures,
  }
  const openNotes = notes.filter((note) => note.resolvedAt === undefined)
  // 没有新轮次也没有便条才算没事可做；只剩未回应便条时仍要发一次请求
  if (!batch.text && openNotes.length === 0) {
    return { status: 'skipped', ...unchanged, attempts: 0 }
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const input = buildDeriveUserMessage({
      profileText: renderExisting(options.profile),
      notes: openNotes.map((note) => ({ id: note.id, text: note.text })),
      turnsText: batch.text,
      retryHint: attempt === 0 ? undefined : RETRY_HINT,
    })
    let answer = ''
    try {
      answer = await options.send(request(input))
    } catch {
      // 网络 / 超时 / HTTP 错误都算这一轮失败，交给下一次尝试
      continue
    }
    const parsed = parseAnswer(answer, openNotes.map((note) => note.id), batch.text.length > 0)
    if (!parsed.ok) {
      continue
    }
    // 没有新轮次时，模型回空段视为「这次不修改」，沿用旧档案：
    // 否则它很容易把「只处理便条」理解成「档案应为空」，一次整理就把档案清掉
    const keepSection = (next: string, previous: string): string =>
      batch.text ? next : next || previous
    return {
      status: 'updated',
      profile: {
        identity: keepSection(parsed.value.identity, options.profile.identity),
        preferences: keepSection(parsed.value.preferences, options.profile.preferences),
        ongoing: keepSection(parsed.value.ongoing, options.profile.ongoing),
        unresolved: parsed.value.unresolved,
        // 新鲜度与累计轮数由宿主写，不信模型自报
        updatedAt: options.now,
        turnsSeen: options.profile.turnsSeen + 1,
      },
      notes: notes.map((note) => {
        const reply = parsed.value.noteReplies.find((item) => item.id === note.id)
        if (!reply) {
          return note
        }
        // 回了「没改，因为…」的便条继续留着：用户看到没被采纳，还能再提一次。
        // 只有确实已采纳（回话以「已」开头）才关掉，否则投诉被永久吞掉就再也没机会说了。
        return reply.reply.startsWith('已')
          ? { ...note, resolvedAt: options.now, reply: reply.reply }
          : { ...note, reply: reply.reply }
      }),
      processedCount: base + batch.consumed,
      failures: 0,
      attempts: attempt + 1,
    }
  }
  return { status: 'failed', ...unchanged, failures: options.failures + 1, attempts: MAX_ATTEMPTS }
}
