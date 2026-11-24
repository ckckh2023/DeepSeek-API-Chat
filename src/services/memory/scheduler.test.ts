import { describe, expect, it } from 'vitest'
import type { MemoryProfile } from '../../plugins/memory/prompt.js'
import type { DeriveResult } from './run.js'
import {
  AUTO_IDLE_MS,
  AUTO_PAUSE_FAILURES,
  AUTO_PENDING_MESSAGES,
  createScheduler,
  decideAuto,
  latestActivitySession,
  pendingCount,
  type SchedulerSnapshot,
} from './scheduler.js'
import type { MemoryState } from './store.js'

/**
 * 只测调度这一个 seam：`decideAuto()`（纯判据）与 `createScheduler()`（单飞锁 + 退避）。
 * 真正的整理由 `derive` 注入，所以这里不需要网络，也不碰 localStorage。
 */

const snapshot = (patch: Partial<SchedulerSnapshot> = {}): SchedulerSnapshot => ({
  pending: 0,
  lastActivityAt: 0,
  memoryEnabled: true,
  failures: 0,
  hasKey: true,
  streaming: false,
  ...patch,
})

const profile = (patch: Partial<MemoryProfile> = {}): MemoryProfile => ({
  identity: '',
  preferences: '',
  ongoing: '',
  unresolved: [],
  updatedAt: 0,
  turnsSeen: 0,
  ...patch,
})

const updated = (processedCount: number): DeriveResult => ({
  outcome: {
    status: 'updated',
    profile: profile({ identity: 'x', updatedAt: 1, turnsSeen: 1 }),
    notes: [],
    processedCount,
    failures: 0,
    attempts: 1,
  },
})

const failed: DeriveResult = {
  outcome: {
    status: 'failed',
    profile: profile(),
    notes: [],
    processedCount: 0,
    failures: 1,
    attempts: 2,
  },
}

/** 整理什么都没做（例如没有成对的轮次）：待处理数不变，属于「没有进展」 */
const skipped: DeriveResult = {
  outcome: {
    status: 'skipped',
    profile: profile(),
    notes: [],
    processedCount: 0,
    failures: 0,
    attempts: 0,
  },
}

const state = (patch: Partial<MemoryState> = {}): MemoryState => ({
  notes: [],
  watermarks: {},
  activity: {},
  autoEnabled: true,
  failures: 0,
  lastDerivedAt: 0,
  ...patch,
})

/** 手动放行的 promise：用来断言「发出的整理没有挡住调用方」 */
const deferred = <T>() => {
  let release: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, fail) => {
    release = resolve
    reject = fail
  })
  return { promise, release, reject }
}

describe('decideAuto · 三个触发条件', () => {
  it('未处理满 8 轮（16 条）自动整理，差一轮不整理', () => {
    expect(AUTO_PENDING_MESSAGES).toBe(16)
    expect(decideAuto('turns', snapshot({ pending: 16 }), 0).run).toBe(true)
    // 条数是 collectTurns 的口径（一问一答两条），差一轮 = 差 2 条
    expect(decideAuto('turns', snapshot({ pending: 14 }), 0)).toStrictEqual({
      run: false,
      skip: 'waiting',
    })
  })

  it('距最后活动 5 分钟且未处理 ≥1 条时整理，不到 5 分钟不动', () => {
    const idle = snapshot({ pending: 2, lastActivityAt: 1000 })
    expect(decideAuto('idle', idle, 1000 + AUTO_IDLE_MS).run).toBe(true)
    expect(decideAuto('idle', idle, 1000 + AUTO_IDLE_MS - 1)).toStrictEqual({
      run: false,
      skip: 'waiting',
    })
    // 没有未处理时闲着也不发请求
    expect(decideAuto('idle', snapshot({ pending: 0 }), 10 * AUTO_IDLE_MS).run).toBe(false)
  })

  it('打开应用或切会话时只要还有未处理就补上', () => {
    expect(decideAuto('opened', snapshot({ pending: 2, lastActivityAt: 999 }), 1000).run).toBe(true)
    expect(decideAuto('opened', snapshot({ pending: 0 }), 1000)).toStrictEqual({
      run: false,
      skip: 'nothing-pending',
    })
  })

  it('正在回答时让这一轮先写完，不插进来整理', () => {
    expect(decideAuto('turns', snapshot({ pending: 40, streaming: true }), 0)).toStrictEqual({
      run: false,
      skip: 'streaming',
    })
  })

  it('连续失败 3 次后暂停自动整理，第 2 次仍然允许', () => {
    expect(AUTO_PAUSE_FAILURES).toBe(3)
    expect(decideAuto('turns', snapshot({ pending: 20, failures: 2 }), 0).run).toBe(true)
    expect(decideAuto('turns', snapshot({ pending: 20, failures: 3 }), 0)).toStrictEqual({
      run: false,
      skip: 'paused',
    })
    expect(decideAuto('opened', snapshot({ pending: 2, failures: 9 }), 0)).toStrictEqual({
      run: false,
      skip: 'paused',
    })
  })

  it('整块插件关掉时自动整理也停：不用记忆的人不该被花整理请求的钱', () => {
    const off = snapshot({ pending: 40, memoryEnabled: false })
    expect(decideAuto('turns', off, 0)).toStrictEqual({ run: false, skip: 'plugin-off' })
    expect(decideAuto('idle', off, 10 * AUTO_IDLE_MS)).toStrictEqual({ run: false, skip: 'plugin-off' })
    expect(decideAuto('opened', off, 0)).toStrictEqual({ run: false, skip: 'plugin-off' })
  })

  it('没有 API Key 时不发请求，只留未处理计数', () => {
    expect(decideAuto('turns', snapshot({ pending: 40, hasKey: false }), 0)).toStrictEqual({
      run: false,
      skip: 'no-key',
    })
  })
})

describe('pendingCount · 活动与水位用同一把尺子', () => {
  it('未处理 = 活动条数 − 已处理条数', () => {
    const memory = state({
      watermarks: { s1: { processedCount: 4, at: 1 } },
      activity: { s1: { turnCount: 10, at: 2 } },
    })
    expect(pendingCount(memory, 's1')).toBe(6)
  })

  it('没有活动记录（还没聊完过）时为 0，不把空会话当成待整理', () => {
    expect(pendingCount(state(), 's1')).toBe(0)
    expect(pendingCount(state(), null)).toBe(0)
  })

  it('停在欢迎页时挑最近聊过的那个会话，否则隔天重开补不上', () => {
    const memory = state({
      activity: {
        old: { turnCount: 4, at: 100 },
        recent: { turnCount: 30, at: 900 },
      },
    })
    expect(latestActivitySession(memory)).toBe('recent')
    expect(latestActivitySession(state())).toBeNull()
  })

  it('水位比活动还多时按 0 算，不给负数', () => {
    const memory = state({
      watermarks: { s1: { processedCount: 99, at: 1 } },
      activity: { s1: { turnCount: 10, at: 2 } },
    })
    expect(pendingCount(memory, 's1')).toBe(0)
  })
})

describe('createScheduler · 单飞锁', () => {
  it('连点两次手动整理只跑一次，第二次直接回 busy', async () => {
    const gate = deferred<DeriveResult>()
    let calls = 0
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: 2 }),
      derive: () => {
        calls += 1
        return gate.promise
      },
      autoEnabled: () => true,
    })
    const first = scheduler.requestManual()
    const second = scheduler.requestManual()
    expect(scheduler.busy()).toBe(true)
    await expect(second).resolves.toStrictEqual({ blocked: 'busy' })
    gate.release(updated(2))
    await expect(first).resolves.toStrictEqual(updated(2))
    expect(calls).toBe(1)
    expect(scheduler.busy()).toBe(false)
  })

  it('自动触发正在跑时，又一次自动触发被跳过而不是并发', async () => {
    const gate = deferred<DeriveResult>()
    let calls = 0
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: 20 }),
      derive: () => {
        calls += 1
        return gate.promise
      },
      autoEnabled: () => true,
      now: () => 0,
    })
    expect(scheduler.requestAuto('turns')).toStrictEqual({ run: true })
    expect(scheduler.requestAuto('turns')).toStrictEqual({ run: false, skip: 'busy' })
    expect(scheduler.requestAuto('opened')).toStrictEqual({ run: false, skip: 'busy' })
    gate.release(failed)
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(scheduler.busy()).toBe(false)
  })

  it('整理进行中不中止：新一轮回答开始后它也跑完，结果照常落地', async () => {
    const gate = deferred<DeriveResult>()
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: 20 }),
      derive: () => gate.promise,
      autoEnabled: () => true,
      now: () => 0,
    })
    const running = scheduler.requestManual()
    // 这期间用户又发了一条（streaming 变 true），调度器不打断在跑的那次
    expect(scheduler.requestAuto('turns')).toStrictEqual({ run: false, skip: 'busy' })
    gate.release(updated(20))
    await expect(running).resolves.toStrictEqual(updated(20))
  })
})

describe('createScheduler · 不阻塞调用方', () => {
  it('自动整理发出就返回，不等请求回来', () => {
    const gate = deferred<DeriveResult>()
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: 20 }),
      derive: () => gate.promise,
      autoEnabled: () => true,
      now: () => 0,
    })
    // 整理还挂着，requestAuto 已经同步返回：调用方（回答收尾处）不被挡住
    expect(scheduler.requestAuto('turns')).toStrictEqual({ run: true })
    expect(scheduler.busy()).toBe(true)
    gate.release(updated(20))
  })

  it('自动整理开关关着时 requestAuto 一律不动，即便快照说条件全满足', () => {
    const gate = deferred<DeriveResult>()
    let calls = 0
    const scheduler = createScheduler({
      // 快照故意不老实：只要闸门说关，条件全满足也不该跑
      target: () => 's1',
      snapshot: () => snapshot({ pending: 40 }),
      derive: () => {
        calls += 1
        return gate.promise
      },
      autoEnabled: () => false,
      now: () => 0,
    })
    expect(scheduler.requestAuto('turns')).toStrictEqual({ run: false, skip: 'off' })
    expect(scheduler.requestAuto('idle')).toStrictEqual({ run: false, skip: 'off' })
    expect(calls).toBe(0)
    // 手动不受影响
    const manual = scheduler.requestManual()
    expect(calls).toBe(1)
    gate.release(updated(40))
    return manual
  })

  it('开关抛出异常时按「关」处理：宁可不自动整理，也不要失控发请求', () => {
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: 40 }),
      derive: () => Promise.resolve(updated(40)),
      autoEnabled: () => {
        throw new Error('localStorage 不可用')
      },
      now: () => 0,
    })
    expect(scheduler.requestAuto('turns')).toStrictEqual({ run: false, skip: 'off' })
  })

  it('手动整理把积压清完时，待处理数按真实落盘结果减少（不靠内存里的假进度）', async () => {
    // 每次 derive 模拟落盘：水位推进到 16、32，第二遍就追上了
    let processed = 0
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: Math.max(0, 32 - processed) }),
      derive: () => {
        processed = Math.min(32, processed + 16)
        return Promise.resolve(updated(processed))
      },
      autoEnabled: () => true,
      now: () => 0,
    })
    const result = await scheduler.requestManual()
    expect(processed).toBe(32)
    expect(result).toStrictEqual(updated(32))
  })

  it('整理抛异常时不把调用方带崩，回一个和「缺 Key」不同的结果', async () => {
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: 2 }),
      derive: () => Promise.reject(new Error('IndexedDB down')),
      autoEnabled: () => true,
    })
    await expect(scheduler.requestManual()).resolves.toStrictEqual({ blocked: 'unexpected' })
    expect(scheduler.busy()).toBe(false)
  })
})

describe('createScheduler · 追赶与退避', () => {
  it('一批跑的过程中切了会话：目标整段锁定，不拿两个会话的积压互相比较', async () => {
    // 切过去的会话积压更少：若每轮重取目标，`after < before` 会把「另一个会话没那么多待办」
    // 误判成「这一批有进展」，于是一直追下去，追的还不是同一个会话
    let active = 'a'
    const pendingOf: Record<string, number> = { a: 40, b: 4 }
    const asked: (string | null)[] = []
    let calls = 0
    const scheduler = createScheduler({
      target: () => active,
      snapshot: (sessionId) => snapshot({ pending: pendingOf[sessionId ?? 'a'] }),
      derive: (sessionId) => {
        calls += 1
        asked.push(sessionId)
        // 第一轮整理完 A 的一批，然后用户切到了 B
        pendingOf.a = 24
        active = 'b'
        return Promise.resolve(updated(16))
      },
      autoEnabled: () => true,
      now: () => 0,
    })
    await scheduler.requestManual()
    // 整段追赶都对着最初锁定的 A：切到 B 之后既不追 B，也不拿 B 的积压当 A 的进展
    expect(asked.every((id) => id === 'a')).toBe(true)
    expect(asked).toHaveLength(calls)
    expect(pendingOf.b).toBe(4)
  })

  it('积压超过一批时接着跑，直到追上进度', async () => {
    const pending = [50, 20, 0]
    const seen: number[] = []
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: pending[Math.min(seen.length, pending.length - 1)] }),
      derive: () => {
        const processed = 30 * (seen.length + 1)
        seen.push(processed)
        return Promise.resolve(updated(processed))
      },
      autoEnabled: () => true,
      now: () => 0,
    })
    const result = await scheduler.requestManual()
    expect(seen).toHaveLength(2)
    expect(result).toStrictEqual(updated(60))
  })

  it('追一批失败就停，不反复重试烧额度', async () => {
    let processed = 0
    let calls = 0
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: Math.max(0, 40 - processed) }),
      derive: () => {
        calls += 1
        if (calls === 1) {
          processed = 16
          return Promise.resolve(updated(16))
        }
        return Promise.resolve(failed)
      },
      autoEnabled: () => true,
      now: () => 0,
    })
    await scheduler.requestManual()
    // 第一次成功、第二次失败：不继续第三、第四次
    expect(calls).toBe(2)
  })

  it('一次跑完没有进展就停下，不空转', async () => {
    let calls = 0
    const scheduler = createScheduler({
      // 水位没动的局面：整理返回 skipped，待处理数不变
      target: () => 's1',
      snapshot: () => snapshot({ pending: 20 }),
      derive: () => {
        calls += 1
        return Promise.resolve(skipped)
      },
      autoEnabled: () => true,
      now: () => 0,
    })
    await scheduler.requestManual()
    expect(calls).toBe(1)
  })

  it('手动整理不看退避：暂停期间点一次仍然照跑', async () => {
    const scheduler = createScheduler({
      target: () => 's1',
      snapshot: () => snapshot({ pending: 20, failures: 9 }),
      derive: () => Promise.resolve(updated(20)),
      autoEnabled: () => true,
      now: () => 0,
    })
    await expect(scheduler.requestManual()).resolves.toStrictEqual(updated(20))
    // 自动仍被退避挡着（失败计数要等下一次读取才知道清了没有）
    expect(scheduler.requestAuto('turns')).toStrictEqual({ run: false, skip: 'paused' })
  })
})
