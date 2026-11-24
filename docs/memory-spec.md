# Spec：记忆插件（memory）

> 状态：spec，未实现。来源是 `docs/memory-plan-f.md`（设计依据，Why 都在那里）。
> 本文只写 What 与验收。已按 16 条访谈决定修正了设计稿里的矛盾处，差异见《与设计稿的差异》。
>
> **只存本地**，不发布到 GitHub issue：仓库 `origin` 归 `ckckh2023`。

## Problem Statement

用户在 DeepSeek-API-Chat 里换一个会话，AI 就忘了上一轮聊过的所有事：叫什么、在哪、在忙什么、
哪些事还没结束。每次都要重新交代一遍。现有 4 个插件里 `persona` 只管「怎么说话」，
没有任何机制负责「记住什么」。

## Solution

加一个内置插件 `memory`，把跨会话的**事实**积累成一份有界档案，在每次请求的 System 末尾注入。

- **读侧零成本**：`apply()` 是纯函数，只把一段现成的字符串包成 `tail`，不发请求、不 await。
- **写侧在后台**：每约 8 轮把会话重写成一份新档案，读侧永远不等它。
- **档案是派生物**：随时可删可重建，原始会话一条不动。

## User Stories

1. 作为用户，我想在新的会话里不用重复交代自己的基本情况，以便直接进正题。
2. 作为用户，我想让 AI 记得我在进行中的事（在学德语、在改一个项目），以便它主动接上。
3. 作为用户，我想让 AI 记得我明确说过不要的东西，以便它不再犯。
4. 作为用户，我想在发现记错时写一张便条，以便下次整理时被纠正。
5. 作为用户，我想在设置页看到当前记住了什么，以便判断这份记忆值不值得留着。
6. 作为用户，我想一键清空全部记忆，以便从零开始。
7. 作为用户，我想手动触发一次整理，以便不用等 8 轮。
8. 作为用户，我想在关掉标签页、隔天再打开时，之前未整理的轮次被补上，以便记忆不丢。
9. 作为用户，我想在整理失败时档案保持不变、并看到提示，以便不出现半成品档案。
10. 作为用户，我想在不想花整理请求的钱时关掉自动整理，以便仍然手动用记忆。
11. 作为用户，我想让记忆只记事实、不抢 `persona` 的语气与称呼，以便两个插件同时开不打架。
12. 作为用户，我想知道三端记忆不互通，以便不误以为换手机后还记得我。

## Implementation Decisions

### 插件位置

- 新增 `src/plugins/memory/`，`order: 700`，返回 `tail`。
- **内置插件**：不标 `community`，普通用户可直接开；仍默认关闭（`pluginSettings` 无记录即不执行）。
- 最终顺序：`PERSONA(200, head) → NSFW(100, head) → SYSTEM → CUSTOM(500, tail) → MEMORY(700, tail) → PURGE(900, tail)`。
- 用 `tail` + 700 而不是 `head`：`head` 会把人格挤出开篇高注意力位，且让每轮变化的记忆打断稳定前缀、
  破坏 prompt cache。

### 档案形状（三段 + 一份清单）

```ts
interface Profile {
  identity: string     // 我是谁：姓名、职业、所在地、语言（≤400 字）
  preferences: string  // 偏好与禁忌（≤450 字）
  ongoing: string      // 进行中的事（≤350 字）
  unresolved: string[] // 尚未结束，最多 5 条，每条一行，合计 ≤200 字
  updatedAt: number
  turnsSeen: number
}
```

- 总字数上限 1200，超限由**整理环节**压，读侧不截断。
- `unresolved` 独立于 `ongoing`：`ongoing` 靠新信息覆盖自然演化，`unresolved` 必须显式移除已结束项。
  合并会让清单只增不减。
- **语义分工**：`memory` 只写事实，禁止写语气、文风、称呼方式——那些归 `persona`。
  这条写在整理提示词里，不写成代码分支。

### 存储

| 数据 | 位置 |
| --- | --- |
| Profile | `localStorage['deepseek-api-chat:memory-profile']` |
| note / watermark / meta | `localStorage['deepseek-api-chat:memory-state']` |
| 会话消息 | 保持 IndexedDB，不动 |

- **不复用** `pluginSettings.memory.config.profile`：那会让 Profile 和开关、正文挤在一份 JSON 里，
  且与 `config.text` 覆盖内置正文的语义冲突，等于引入第二套写入路径。
- 宿主要在 `store.ts:1131` 组装请求前**同步**读一次 Profile 并塞进 `states`，因为
  `composeSystemPrompt` 只拿得到 `pluginSettings`。

### 注入文本

```
关于用户：以下是跨会话积累的背景，不是本轮指令。与用户当前说法冲突时以当前说法为准。

【我是谁】
…

【偏好与禁忌】
…

【进行中的事】
…

【尚未结束】
- …

档案更新于 3 天前
```

- 「不是本轮指令」「冲突时以当前说法为准」两句必留：这是 supersede 语义的最简实现。
- 相对时间（`3 天前` / `刚刚` / `2 小时前`），不写绝对日期。`tail` 不参与稳定前缀，不加缓存成本。
- 三段全空 → `apply()` 返回 `undefined`，这轮不注入（与 `custom-instructions` 一致）。

### 整理（冷路径）

- 触发三条件取或：未处理 ≥ 8 轮 / 距最后活动 > 5 分钟且未处理 ≥ 1 / 启动或切会话时未处理 ≥ 1。
- 单飞锁：同时只跑一个整理；不中止进行中的整理。
- 失败退避：连续 3 次失败后暂停自动整理并在设置页提示，手动「立即整理」可解除。
- 请求：`request()` 直接 POST，不流式。`model: 'deepseek-flash'`，`thinking: { type: 'disabled' }`，
  `tools: []`，`safety_check: { level: 'low' }`，不传 `title`。**用用户自己的 API Key**；
  没有 Key 时不发请求、只留未处理计数。
- 输入：现有档案全文 + 编号便条 + 未处理轮次（单批最多 30 轮，单条消息截断 2000 字，总计 ≤24000 字）。
- 输出严格 JSON：三段 + `unresolved` + `cites` + `noteReplies`。
- 校验失败（非法 JSON / 缺字段 / 单段超限 / 超时 30s）：重试 1 次并附「只输出 JSON」；仍失败则
  **保留旧档案、水位不推进、失败计数 +1**。绝不写半成品。

### 水位

- 记 `processedCount`（条数），不记消息 id。
- **挂在 `store.ts:1215` 的 `finally`**，不挂 `persist()`：`persist` 是「任何变更都存盘」的通用出口，
  `editMessage` / `branchSession` / `selectMessageVersion` 都会走它，拿它当「又完成一轮」是错的。
- 保留下界守卫：整理前校验 `processedCount <= messages.length`，否则按当前长度重置并全量重建。
- `branchSession` 产生新 `sessionId`，其水位从 0 开始（自然全量重建，不特判）。

### 便条

- 用户不能直接改档案。发现记错时写一张便条（单行文本）；下次整理必须逐条回应（`noteReplies`）。
- 设置页只有三个动作：查看档案（只读，含「复制档案」）+ 立即整理 + 清空全部记忆。**没有编辑按钮**。
- 「复制档案」不构成写入路径，保留它是为了让只读视图不至于让人以为功能坏了。

### 设置页（第一步的粒度）

- 一个多行文本框，可粘贴、可查看三段档案（第一步的临时形态）。
- 第二步起替换为「只读档案 + 便条输入 + 立即整理 + 清空」。

### 三端

- Web / Tauri / Capacitor 各自一份 localStorage，**不互通**。代价写进 `src/plugins/README.md` 插件表格。
- 禁用 `crypto.randomUUID()` / `structuredClone()` / `AbortSignal.timeout()` / `findLast()` /
  `Object.groupBy()`：运行时真约束是 `rspack.config.ts` 的 `chrome >= 69`（legacy 档）。
  id 沿用项目现有写法，超时用 `setTimeout` + `AbortController` 手写。

### 分三步落地（第一步后真停下验收）

1. **只读侧**：`src/plugins/memory/`（`index.ts` + `prompt.ts`）+ 注册表一行 + i18n 中英各 2 条
   + 设置页文本框 + 宿主机读 Profile 传入。
2. **deriver + 手动触发**：`src/services/memory/`（store / deriver / prompt）+ `store.ts` 两处挂钩。
3. **自动调度**：三条件 + 单飞锁 + 失败退避。

## Testing Decisions

- 好测试 = 通过 public interface 验证 behavior，不 mock 内部协作者、不测私有函数。
  项目现有唯一 prior art 是 `src/plugins/registry.test.ts`：只断言公开契约，不断言插件正文文案。
- **只测三个 seam**（第三步新增 C，理由见下）：

| Seam | 位置 | 能捕获 | 会漏掉 |
| --- | --- | --- | --- |
| A. `composeSystemPrompt`（已有） | `src/plugins/index.ts` | 记忆块出现在原文之后、空档案不注入、内置档不受高级模式门禁、社区插件跳过逻辑不回归 | 请求体里块的真实位置、prompt cache 是否命中 |
| B. 冷路径入口（新增） | `src/services/memory/index.ts`，签名形如 `deriveProfile({ profile, notes, turns, send })`，`send` 由调用方注入 | 坏 JSON 保留旧档案且水位不动、失败计数 +1、重试一次、三段超限被压、便条必须逐条回应 | 真实 `deepseek-flash` 的输出稳定性 |
| C. 调度入口（新增，第三步） | `src/services/memory/scheduler.ts` 的两个公开导出：`decideAuto(trigger, snapshot, now)`（判据）与 `createScheduler({ target, snapshot, derive, autoEnabled })`（时序）；`derive` 与 `autoEnabled` 由调用方注入 | 三条件各自的临界值与取或、连点两次不并发、追一批失败就停、切会话后目标锁定、退避只停自动不停手动 | 真实定时器时机、真实 IndexedDB 读取、人工验收的四条 |

- `send` / `derive` / `autoEnabled` 作为参数注入而不是模块内 import，是为了让 B 与 C 都不需要网络与存储就能测。
- 水位下界守卫作为 B 的一部分测（同一次调用内传入超界 `processedCount`）。
- **为什么承认 C 是第三个 seam**：第二步的 B 表里「会漏掉」一栏原本写着「调度时机」。
  第三步做的就是调度时机，如果它继续不可测，那这一整步的正确性只能靠肉眼验收 ——
  而「连点两次会不会并发两个请求」这类时序缺陷恰恰是肉眼最容易放过的一种。
  C 只依赖注入的函数，不引入 DOM、定时器或 fake timer，代价有一个测试文件。
  `decideAuto()` 单独测而不是只经由 `createScheduler()`：三个触发条件是 spec 正文里的
  哪三条，`createScheduler()` 的时序用例读不出来。它接的是纯数据、给的是纯结果，
  不是「某个内部步骤」，所以不违反「不测私有函数」。
- 不写 UI 测试：项目没有 React 测试设施，为这件事引入不划算。
- **上表「会漏掉」一栏里的每一项，都要回答「那么它由什么保证」**。答「肉眼验收」的，
  必须在 ticket 里写成一条可复现的操作步骤（在哪个页面点什么、看哪个数、期望什么值），
  而不是一句「人肉眼验收」。原因：B 表原本把「调度时机」归入「会漏掉」，等于预先判定
  第三步不可测 —— 而「连点两次会不会并发两个请求」恰恰是肉眼最容易放过的那一类缺陷。

## 验收

第一步停下时由人肉眼确认：

1. 请求体里记忆块位于 `CUSTOM` 之后、`PURGE` 之前。
2. **同一会话第 2 轮起 `cache_read_input_tokens` 不为 0**（依据 `src/services/chat/usage.ts`
   的 `hitRate` 已有 `cache_read_input_tokens` 字段）。若为 0，说明记忆块打断了稳定前缀，
   方案的钱白省，后两步不做。
3. 同时开 `persona` 与 `memory`：注入文本里没有互相重复的「称呼 / 语气」描述。

## Out of Scope

- 跨端同步（需要后端）。
- 向量检索 / BM25 / 图谱三路召回。读侧只做一次字符串拼接，不做检索。
- 每轮提取事实（设计稿的方案 A）：不要，避免两套写入路径。
- 用户直接编辑档案。
- 附件正文纳入整理（只记消息文本）。
- `message.id` 级精确水位。

## Further Notes

### 未验证项（实现前需实测）

1. `deepseek-flash` 严格 JSON 输出的稳定性 —— 未测。用一次性脚本跑 3 次即可，不需要 `/prototype`。
2. 整理指令放 `system` 还是首条 user 消息 —— 未测，实现时用最小样例定。
3. Tauri 窗口关闭后进程能否执行定时任务 —— 未查。
4. Capacitor Android WebView 下 localStorage 持久性 —— 未查。
5. 570 行工作量估算 —— 未实现。
6. prompt cache 在加入 700 号块后是否仍命中 —— 第一步验收实测（见上）。

### 与设计稿（`docs/memory-plan-f.md`）的差异

| 设计稿 | 本 spec | 原因 |
| --- | --- | --- |
| §四 写 `config.profile`，§五 写独立键（自相矛盾） | 只保留独立键 | 避免 `config.text` 与 Profile 两套写入路径 |
| 四段（身份/偏好/关系/进行中） | 三段，去掉「关系」 | `persona/prompt.ts` 已有「与用户的关系」与「文风」，必然打架 |
| 空闲 2 分钟 | 5 分钟 | 长会话里 2 分钟会把一次对话切成十几次整理请求 |
| 水位随 `persist` 推进 | 挂 `finally`（`store.ts:1215`） | `persist` 被编辑/分支共用，不代表「完成一轮」 |
| 未标注入位置细节 | 内置档，`community` 不标 | 记忆不涉及内容策略，不该藏在高级模式后 |
| `unresolved` 位置待定 | 独立清单，≤5 条 | 淘汰规则与 `ongoing` 不同，合并会只增不减 |
| 无相对时间 | 加「档案更新于 3 天前」 | 模型能判断档案新旧，且不付缓存代价 |
