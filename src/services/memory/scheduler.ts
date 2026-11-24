/**
 * 自动调度：什么时候该跑整理、同一时刻只跑一个、连续失败就退避、打开就追赶。
 *
 * spec《整理》里的「触发三条件 + 单飞锁 + 失败退避」都落在这个文件里，但这里**不碰网络、
 * 不碰 localStorage**：判定只看一份快照，整理由调用方注入。所以「连点两次不并发」
 * 「暂停期间手动仍可用」「一批吃不完就接着跑」这些时序行为能在 `pnpm test` 里跑，
 * 不需要浏览器。
 *
 * 注册处 `configureMemoryAuto()` 是为了破环：`chat/store.ts` 要在回答收尾与切会话时
 * 触发整理，而 `memory/run.ts` 要读 `chat/store.ts`。让 run 把 runner 注册进来，
 * store 只依赖本文件，环就断在这里（同 `turns.ts` 的理由）。
 */
import type { DeriveOutcome } from './index.js'

/** 未处理 16 条 = 8 轮答疑；spec 的「约每 8 轮整理一次」 */
export const AUTO_PENDING_MESSAGES = 16

/** 距最后一次回答满 5 分钟且还有未处理，就整理：短会话也能被处理 */
export const AUTO_IDLE_MS = 5 * 60 * 1000

/** 连续失败到这个次数就暂停自动整理，等用户手动点一次 */
export const AUTO_PAUSE_FAILURES = 3

/**
 * 是否处于失败退避。
 *
 * 判据只写在这里一处：`decideAuto()` 用它决定跑不跑，设置页用它决定要不要显示提示 ——
 * 两边各写一遍 `failures >= AUTO_PAUSE_FAILURES` 迟早会走岔（改了常量只改一处）。
 */
export const isAutoPaused = (failures: number): boolean => failures >= AUTO_PAUSE_FAILURES

/** 三个触发条件；谁先满足跑谁，判据不同但出口相同 */
export type AutoTrigger = 'turns' | 'idle' | 'opened'

/** 没跑的原因；除了 waiting / nothing-pending，都值得让调用方知道 */
export type AutoSkip =
  /** 用户把「自动整理」开关关掉了 */
  | 'off'
  /** memory 插件整块关着 */
  | 'plugin-off'
  | 'no-key'
  | 'paused'
  | 'streaming'
  | 'nothing-pending'
  | 'waiting'
  | 'busy'

export type AutoDecision = { readonly run: true } | { readonly run: false; readonly skip: AutoSkip }

/** 判定用的世界快照；由宿主现取，判定本身是纯函数 */
export interface SchedulerSnapshot {
  /** 未处理条数，与水位同一把尺子（`collectTurns()` 的条数） */
  readonly pending: number
  /** 该会话最后一次回答收尾的时间；0 表示还没聊完过一轮 */
  readonly lastActivityAt: number
  /** memory 插件本身开着没：整块关掉时连整理请求都不该发 */
  readonly memoryEnabled: boolean
  readonly failures: number
  readonly hasKey: boolean
  /** 正在回答：先让这一轮写完，否则整理进的是半轮 */
  readonly streaming: boolean
}

/**
 * 整理结果。
 *
 * 比 `run.ts` 的 `DeriveResult` 多两个「调度器自己产生」的结局：`busy`（正在跑，不排队）
 * 与 `unexpected`（整理抛了异常，不能把回答的收尾带崩）。别用 `null` 兼表，调用方要分得清。
 */
export type SchedulerResult =
  | { readonly blocked: 'busy' | 'unexpected' | 'no-key' | 'no-session' }
  | { readonly blocked?: undefined; readonly outcome: DeriveOutcome }

/** 水位与活动的最小形状：够算「未处理」，又不用让本文件依赖存储模块 */
interface PendingSource {
  readonly watermarks: Readonly<Record<string, { readonly processedCount: number }>>
  readonly activity: Readonly<
    Record<string, { readonly turnCount: number; readonly at: number }>
  >
}


/**
 * 未处理条数 = 活动条数 − 已处理条数。
 *
 * 两个数都数 `collectTurns()` 过滤后的条数，直接相减才有意义；拿原始可见条数减，
 * 会在有失败回答、有分支时算出负数或虚高的积压。
 */
export const pendingCount = (state: PendingSource, sessionId: string | null): number => {
  if (sessionId === null) {
    return 0
  }
  const turns = state.activity[sessionId]?.turnCount ?? 0
  const processed = state.watermarks[sessionId]?.processedCount ?? 0
  return Math.max(0, turns - processed)
}

/**
 * 没有活动会话时该整理哪个：最近聊过的那个。
 *
 * 应用打开后停在欢迎页，`activeId` 是 `null` —— 如果只看活动会话，
 * 「关掉标签页隔天再打开，未整理的轮次被补上」就永远补不上。所以启动时按活动时间
 * 挑一个（记忆自己的记录，不是猜 UI 状态），用户点开哪个会话不重要，重要的是那段对话没白聊。
 */
export const latestActivitySession = (
  state: PendingSource,
  isAlive: (sessionId: string) => boolean = () => true
): string | null => {
  let best: string | null = null
  let latest = -1
  for (const [id, { at }] of Object.entries(state.activity)) {
    // 已删除的会话不能当目标：整理它只会回 blocked:'no-session'，追赶就此卡死在
    // 一个不存在的会话上，别的会话的积压永远补不上
    if (at > latest && isAlive(id)) {
      latest = at
      best = id
    }
  }
  return best
}

/**
 * 该不该自动跑一次。
 *
 * 先排除「跑也白跑」的四种情况（关掉 / 没 Key / 退避 / 正在回答），再看触发条件：
 * - `turns`：积压到 8 轮；
 * - `idle`：闲着 5 分钟以上且还有一点点没整理；
 * - `opened`：打开应用或切会话，只要还有没整理的就补。
 *
 * 退避用的是「连续失败次数」而不是时间窗：失败原因多半是用户自己的 Key 或网络，
 * 时间到了也不一定好，让人手动点一次比自动重试更省事。
 */
export const decideAuto = (
  trigger: AutoTrigger,
  snapshot: SchedulerSnapshot,
  now: number
): AutoDecision => {
  // spec《整理》之外的常识：插件关着就不该在后台花用户的钱整理一份用不上的档案，
  // 也不该在用户明确关掉之后还继续写 localStorage
  if (!snapshot.memoryEnabled) {
    return { run: false, skip: 'plugin-off' }
  }
  if (!snapshot.hasKey) {
    return { run: false, skip: 'no-key' }
  }
  if (isAutoPaused(snapshot.failures)) {
    return { run: false, skip: 'paused' }
  }
  if (snapshot.streaming) {
    return { run: false, skip: 'streaming' }
  }
  if (snapshot.pending <= 0) {
    return { run: false, skip: 'nothing-pending' }
  }
  if (trigger === 'turns') {
    return snapshot.pending >= AUTO_PENDING_MESSAGES
      ? { run: true }
      : { run: false, skip: 'waiting' }
  }
  if (trigger === 'idle') {
    // 「距最后活动多久」要看得到最后活动：没有记录（打开应用从没聊完过一轮）就没有依据，
    // 拿 0 去减会算成「刚活动过」，看起来节省，实际会把短会话的整理无限推迟
    if (snapshot.lastActivityAt <= 0) {
      return { run: false, skip: 'waiting' }
    }
    return now - snapshot.lastActivityAt >= AUTO_IDLE_MS
      ? { run: true }
      : { run: false, skip: 'waiting' }
  }
  return { run: true }
}

export interface SchedulerDeps {
  /**
   * 这一次要整理哪个会话：判定时取一次，整段追赶期间不再变。
   *
   * 若每轮都重取，「一批吃不完继续追」的过程中用户切了会话，
   * `after < before` 比的会是两个会话的积压 —— 一个会话的进展被当成另一个会话的进展。
   */
  readonly target: () => string | null
  /** 该会话当前的世界状态；`sessionId` 是本次锁定的目标 */
  readonly snapshot: (sessionId: string | null) => SchedulerSnapshot
  /** 真去整理一次；由宿主注入，测试传假函数 */
  readonly derive: (sessionId: string | null) => Promise<SchedulerResult>
  /**
   * 自动整理的总开关，判定前现取。
   *
   * 不放进 `SchedulerSnapshot` 是因为它可能抛错：`decideAuto()` 只接纯数据，
   * 而这个来源是 localStorage。独立注入的好处是「读不出配置」这条路径也能被测到 ——
   * 读不出时按「关」处理，宁可不整理，也不要失控地发请求。
   */
  readonly autoEnabled: () => boolean
  /** 「现在」；不传就取系统时钟。判定函数本身不接受时钟之外的隐式输入 */
  readonly now?: () => number
}

/** 开关读不出来时按「关」处理：自动整理是可选的省钱行为，不该因为读不出配置就开跑 */
const isAutoAllowed = (deps: SchedulerDeps): boolean => {
  try {
    return deps.autoEnabled() === true
  } catch {
    return false
  }
}

export interface SchedulerRunner {
  /** 手动「立即整理」：把积压跑完；已经在跑就不排队，直接回 busy */
  readonly requestManual: () => Promise<SchedulerResult>
  /** 自动触发：条件不满足就立刻返回，满足了发出请求就返回，不等结果 */
  readonly requestAuto: (trigger: AutoTrigger) => AutoDecision
  readonly busy: () => boolean
}

/**
 * 建一个调度器。整个应用只有一个实例，手动与自动共用同一把锁：
 * 设置页连点两次「立即整理」、或整理跑着的时候聊到第 8 轮，都不会并发两个整理。
 */
export const createScheduler = (deps: SchedulerDeps): SchedulerRunner => {
  const now = deps.now ?? Date.now
  let running: Promise<SchedulerResult> | null = null

  /**
   * 一批最多 30 轮，积压 40 轮会剩一半；一直跑到追上进度为止。
   * 没有进展就停：`skipped`（没有成对的轮次）或失败都不该空转。
   */
  const drain = async (): Promise<SchedulerResult> => {
    // 目标在这里锁定：整段追赶都对着同一个会话，中途切会话不影响这一轮
    const sessionId = deps.target()
    let result: SchedulerResult = { blocked: 'no-session' }
    for (;;) {
      const before = deps.snapshot(sessionId).pending
      result = await deps.derive(sessionId)
      if (result.blocked !== undefined) {
        break
      }
      // 失败就停：剩下的轮次留在水位后面，等下一次触发（或用户手动点），
      // 接着追只会把额度和失败计数一起烧掉
      if (result.outcome.status === 'failed') {
        break
      }
      const after = deps.snapshot(sessionId).pending
      if (after <= 0 || after >= before) {
        break
      }
    }
    return result
  }

  const start = (): Promise<SchedulerResult> => {
    // 单飞：已经在跑就返回 busy，不排第二份工作进去
    running = (async () => {
      try {
        return await drain()
      } catch {
        // 整理出错不能把调用方带崩：回答的收尾处也在调它
        return { blocked: 'unexpected' }
      } finally {
        running = null
      }
    })()
    return running
  }

  const busy = (): boolean => running !== null

  return {
    busy,
    requestManual: () => (busy() ? Promise.resolve({ blocked: 'busy' }) : start()),
    requestAuto: (trigger) => {
      const decision: AutoDecision = busy()
        ? { run: false, skip: 'busy' }
        : isAutoAllowed(deps)
          ? decideAuto(trigger, deps.snapshot(deps.target()), now())
          : { run: false, skip: 'off' }
      if (decision.run) {
        // 发出就返回：整理不挡首字，也不挡回答的收尾
        void start()
      }
      return decision
    },
  }
}

let runner: SchedulerRunner | null = null

/** 由 `memory/run.ts` 在接线时注册；传 null 撤销（解绑用） */
export const configureMemoryAuto = (next: SchedulerRunner | null): void => {
  runner = next
}

/**
 * 宿主在三个地方调它：回答收尾（`turns`）、切换/载入会话（`opened`）、空闲定时器（`idle`）。
 * 没接线时什么都不做，绝不因为调度没起来就把回答流程弄坏。
 */
export const requestAutoMemory = (trigger: AutoTrigger): AutoDecision =>
  runner ? runner.requestAuto(trigger) : { run: false, skip: 'off' }
