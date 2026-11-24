import { describe, expect, it } from 'vitest'
import type { MemoryProfile } from '../../plugins/memory/prompt.js'
import type { CreateMessageRequest } from '../api/types.js'
import { deriveProfile } from './index.js'
import type { MemoryTurn } from './turns.js'
import type { MemoryNote } from './store.js'

/**
 * 只测冷路径这一个 seam：`deriveProfile({ ..., send })`。
 * `send` 由调用方注入，所以这里不需要网络，也不碰 localStorage。
 * 断言的都过了 public interface，不看内部函数。
 */

const emptyProfile = (patch: Partial<MemoryProfile> = {}): MemoryProfile => ({
  identity: '',
  preferences: '',
  ongoing: '',
  unresolved: [],
  updatedAt: 0,
  turnsSeen: 0,
  ...patch,
})

const turn = (role: MemoryTurn['role'], text: string): MemoryTurn => ({ role, text })

const note = (id: string, text: string): MemoryNote => ({ id, text, createdAt: 1 })

/** 一个最小合法回答；spec 里的严格 JSON 契约 */
const answer = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    identity: '后端工程师，在北京',
    preferences: '先给结论',
    ongoing: '在学德语',
    unresolved: [],
    cites: ['t1'],
    noteReplies: [],
    ...patch,
  })

/** send 注入：按顺序回放预置结果，便于数「发了几次」 */
const recorder = (replies: (string | Error)[]) => {
  const requests: CreateMessageRequest[] = []
  let index = 0
  return {
    requests,
    send: async (request: CreateMessageRequest) => {
      requests.push(request)
      const next = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (next instanceof Error) {
        throw next
      }
      return next
    },
  }
}

/** 整理请求里那一条 user 消息的正文：档案、便条、轮次、重试提示都在这里 */
const userContent = (request: CreateMessageRequest): string => {
  const last = request.messages[request.messages.length - 1]
  return last && typeof last.content === 'string' ? last.content : ''
}

/** 取「待处理轮次」那一段正文：24000 字预算只管这一段 */
const turnsSection = (request: CreateMessageRequest): string =>
  userContent(request).split('[待处理轮次]')[1] ?? ''

describe('deriveProfile · 成功路径', () => {
  it('解析出三段档案、推进水位、清零失败计数', async () => {
    const { send } = recorder([answer()])
    const outcome = await deriveProfile({
      profile: emptyProfile(),
      notes: [],
      messages: [turn('user', '我是后端工程师'), turn('assistant', '记住了')],
      processedCount: 0,
      failures: 2,
      now: 1000,
      send,
    })
    expect(outcome.status).toBe('updated')
    expect(outcome.profile.identity).toBe('后端工程师，在北京')
    expect(outcome.processedCount).toBe(2)
    expect(outcome.failures).toBe(0)
    expect(outcome.attempts).toBe(1)
    // 档案新鲜度与轮数是本次整理写的，不是模型编的
    expect(outcome.profile.updatedAt).toBe(1000)
    expect(outcome.profile.turnsSeen).toBe(1)
  })

  it('请求形状固定：flash、无思考、无工具、非流式语义、不带标题', async () => {
    const { requests, send } = recorder([answer()])
    await deriveProfile({
      profile: emptyProfile(),
      notes: [],
      messages: [turn('user', '你好'), turn('assistant', '在')],
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    const request = requests[0]
    expect(request.model).toBe('deepseek-flash')
    expect(request.thinking).toStrictEqual({ type: 'disabled' })
    expect(request.tools).toStrictEqual([])
    expect(request.safety_check).toStrictEqual({ level: 'low' })
    expect(request.title).toBeUndefined()
    // 分工写死在提示词里：只写事实，语气与称呼归 persona
    expect(request.system).toContain('只写事实')
    expect(request.system).toContain('语气')
    expect(request.system).toContain('称呼')
  })

  it('输入含现有档案全文与编号轮次，便条按编号回应后置为已处理', async () => {
    const { requests, send } = recorder([
      answer({ noteReplies: [{ id: 'n1', reply: '已改' }] }),
    ])
    const outcome = await deriveProfile({
      profile: emptyProfile({ identity: '上海的产品经理' }),
      notes: [note('n1', '我搬到杭州了')],
      messages: [turn('user', '我在杭州'), turn('assistant', '好')],
      processedCount: 0,
      failures: 0,
      now: 2000,
      send,
    })
    const content = userContent(requests[0])
    expect(content).toContain('我在杭州')
    expect(content).toContain('turn 1')
    expect(content).toContain('[用户便条]')
    expect(content).toContain('我搬到杭州了')
    expect(content).toContain('上海的产品经理')
    expect(outcome.notes[0]).toStrictEqual({
      id: 'n1',
      text: '我搬到杭州了',
      createdAt: 1,
      resolvedAt: 2000,
      reply: '已改',
    })
  })
})

describe('deriveProfile · 输入上限', () => {
  it('单条消息截断到 2000 字，超出部分不进请求', async () => {
    const { requests, send } = recorder([answer()])
    const long = `${'a'.repeat(2000)}TAIL`
    await deriveProfile({
      profile: emptyProfile(),
      notes: [],
      messages: [turn('user', long), turn('assistant', 'ok')],
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    const content = turnsSection(requests[0])
    expect(content).toContain('a'.repeat(2000))
    expect(content).not.toContain('TAIL')
  })

  it('单批最多 30 轮，剩下的留到下一批，水位只推进到本批末尾', async () => {
    const { requests, send } = recorder([answer()])
    const messages: MemoryTurn[] = []
    for (let index = 1; index <= 40; index += 1) {
      messages.push(turn('user', `问题 ${index}`), turn('assistant', `回答 ${index}`))
    }
    const outcome = await deriveProfile({
      profile: emptyProfile(),
      notes: [],
      messages,
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    const content = turnsSection(requests[0])
    expect(content).toContain('turn 30')
    expect(content).not.toContain('turn 31')
    expect(outcome.processedCount).toBe(60)
  })

  it('轮次正文总计不超过 24000 字，超了只取前面的', async () => {
    const { requests, send } = recorder([answer()])
    const messages: MemoryTurn[] = []
    for (let index = 1; index <= 30; index += 1) {
      messages.push(turn('user', 'x'.repeat(1000)), turn('assistant', 'y'.repeat(1000)))
    }
    const outcome = await deriveProfile({
      profile: emptyProfile(),
      notes: [],
      messages,
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    expect(turnsSection(requests[0]).length).toBeLessThanOrEqual(24000)
    expect(outcome.processedCount).toBeLessThan(60)
    expect(outcome.processedCount).toBeGreaterThan(0)
  })
})

describe('deriveProfile · 失败处理', () => {
  it('坏 JSON 重试恰好一次，仍失败则旧档案不变、水位不动、失败计数 +1', async () => {
    const previous = emptyProfile({ identity: '旧档案', updatedAt: 5, turnsSeen: 3 })
    const { requests, send } = recorder(['不是 JSON', '还是不 JSON'])
    const outcome = await deriveProfile({
      profile: previous,
      notes: [],
      messages: [turn('user', '你好'), turn('assistant', '好')],
      processedCount: 0,
      failures: 2,
      now: 9,
      send,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.attempts).toBe(2)
    expect(outcome.profile).toStrictEqual(previous)
    expect(outcome.processedCount).toBe(0)
    expect(outcome.failures).toBe(3)
    // 重试的那一次必须比第一次多说一条信息，否则等于把同一句话再问一遍
    expect(turnsSection(requests[1])).toContain('不合格')
    expect(turnsSection(requests[0])).not.toContain('不合格')
  })

  it('三段都合法但加起来超过 1200 字也算校验失败', async () => {
    const previous = emptyProfile({ identity: '旧档案' })
    const bloated = answer({
      identity: 'a'.repeat(400),
      preferences: 'b'.repeat(450),
      ongoing: 'c'.repeat(350),
      unresolved: ['d'.repeat(100)],
    })
    const { send } = recorder([bloated, bloated])
    const outcome = await deriveProfile({
      profile: previous,
      notes: [],
      messages: [turn('user', '你好'), turn('assistant', '在')],
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.profile).toStrictEqual(previous)
  })

  it('缺字段算校验失败：重试后仍缺就保留旧档案', async () => {
    const previous = emptyProfile({ identity: '旧档案' })
    const missing = JSON.stringify({ preferences: 'x', ongoing: 'y', cites: ['t1'] })
    const { send } = recorder([missing, missing])
    const outcome = await deriveProfile({
      profile: previous,
      notes: [],
      messages: [turn('user', '你好'), turn('assistant', '在')],
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.attempts).toBe(2)
    expect(outcome.profile).toStrictEqual(previous)
  })

  it('单段超长算校验失败，重试压到上限内就成功', async () => {
    const { send } = recorder([
      answer({ identity: 'a'.repeat(500) }),
      answer({ identity: '杭州的产品经理' }),
    ])
    const outcome = await deriveProfile({
      profile: emptyProfile(),
      notes: [],
      messages: [turn('user', '我在杭州'), turn('assistant', '好')],
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    expect(outcome.status).toBe('updated')
    expect(outcome.attempts).toBe(2)
    expect(outcome.profile.identity).toBe('杭州的产品经理')
  })

  it('便条必须逐条回应：漏一条就重试', async () => {
    const notes = [note('n1', '我搬到杭州了'), note('n2', '别再叫我小张')]
    const { send } = recorder([
      answer({ noteReplies: [{ id: 'n1', reply: '已改' }] }),
      answer({
        noteReplies: [
          { id: 'n1', reply: '已改' },
          { id: 'n2', reply: '已改，改成你的名字' },
        ],
      }),
    ])
    const outcome = await deriveProfile({
      profile: emptyProfile(),
      notes,
      messages: [turn('user', '叫我 insel'), turn('assistant', '好')],
      processedCount: 0,
      failures: 0,
      now: 3,
      send,
    })
    expect(outcome.attempts).toBe(2)
    expect(outcome.notes.map((item) => item.reply)).toStrictEqual(['已改', '已改，改成你的名字'])
  })

  it('回了「没改」的便条仍进下一次整理，不能被吞掉', async () => {
    const { send } = recorder([
      answer({ noteReplies: [{ id: 'n1', reply: '没改，因为你没说改成什么' }] }),
    ])
    const outcome = await deriveProfile({
      profile: emptyProfile(),
      notes: [note('n1', '别再叫我小张')],
      messages: [turn('user', '叫我 insel'), turn('assistant', '好')],
      processedCount: 0,
      failures: 0,
      now: 7,
      send,
    })
    expect(outcome.status).toBe('updated')
    expect(outcome.notes[0].reply).toBe('没改，因为你没说改成什么')
    // 未关闭：下次整理还会再问一次
    expect(outcome.notes[0].resolvedAt).toBeUndefined()
  })

  it('两次都漏便条回应也按失败处理，档案与水位都不动', async () => {
    const previous = emptyProfile({ identity: '旧档案' })
    const { send } = recorder([answer(), answer()])
    const outcome = await deriveProfile({
      profile: previous,
      notes: [note('n1', '我搬到杭州了')],
      messages: [turn('user', '我在杭州'), turn('assistant', '好')],
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.profile).toStrictEqual(previous)
    expect(outcome.notes[0].reply).toBeUndefined()
  })

  it('请求本身失败（超时/网络）也算一次失败，重试一次后放弃', async () => {
    const previous = emptyProfile({ identity: '旧档案' })
    const { send } = recorder([new Error('timeout'), new Error('timeout')])
    const outcome = await deriveProfile({
      profile: previous,
      notes: [],
      messages: [turn('user', '你好'), turn('assistant', '在')],
      processedCount: 0,
      failures: 0,
      now: 1,
      send,
    })
    expect(outcome.status).toBe('failed')
    expect(outcome.attempts).toBe(2)
    expect(outcome.profile).toStrictEqual(previous)
    expect(outcome.failures).toBe(1)
  })
})

describe('deriveProfile · 水位守卫与空批', () => {
  it('水位超出当前可见条数时按 0 重置，全量重建', async () => {
    const { requests, send } = recorder([answer()])
    const messages = [
      turn('user', '第一条'),
      turn('assistant', '好'),
      turn('user', '第三条'),
      turn('assistant', '好'),
    ]
    const outcome = await deriveProfile({
      profile: emptyProfile(),
      notes: [],
      messages,
      processedCount: 99,
      failures: 0,
      now: 1,
      send,
    })
    expect(turnsSection(requests[0])).toContain('第一条')
    expect(outcome.status).toBe('updated')
    expect(outcome.processedCount).toBe(4)
  })

  it('没有未处理的条数时不发请求，什么都不改', async () => {
    const previous = emptyProfile({ identity: '旧档案' })
    const { requests, send } = recorder([answer()])
    const outcome = await deriveProfile({
      profile: previous,
      notes: [],
      messages: [turn('user', '你好'), turn('assistant', '好')],
      processedCount: 2,
      failures: 1,
      now: 1,
      send,
    })
    expect(outcome.status).toBe('skipped')
    expect(outcome.attempts).toBe(0)
    expect(requests).toHaveLength(0)
    expect(outcome.profile).toStrictEqual(previous)
    expect(outcome.failures).toBe(1)
    expect(outcome.processedCount).toBe(2)
  })

  it('没有轮次但还有未回应的便条时，仍发一次请求并处理便条', async () => {
    const previous = emptyProfile({ identity: '旧档案' })
    const openNote = note('n1', '我不在上海了，搬到杭州了')
    const { requests, send } = recorder([
      answer({ cites: [], noteReplies: [{ id: 'n1', reply: '已改' }] }),
    ])
    const outcome = await deriveProfile({
      profile: previous,
      notes: [openNote],
      messages: [],
      processedCount: 0,
      failures: 0,
      now: 5,
      send,
    })
    expect(outcome.status).toBe('updated')
    expect(requests).toHaveLength(1)
    expect(userContent(requests[0])).toContain('用户便条')
    expect(outcome.notes[0]?.resolvedAt).toBe(5)
    expect(outcome.processedCount).toBe(0)
  })
})
