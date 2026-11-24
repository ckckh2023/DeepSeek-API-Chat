# 记忆插件 · 方案 F：后台整理

> 状态：设计稿，未实现。
> 本文只描述"怎么做"与"为什么这么定"，不含代码。所有关于现有代码的判断都带 `file:line`；
> 无法从代码验证的写在《未验证项》里。
>
> 本文档尚未提交。仓库 `origin` 归 `ckckh2023`，按提交纪律默认只改工作区。

---

## 一、一句话

**把记忆从"每轮提取一串事实"改成"每隔若干轮在后台把会话重写成一份有界档案"，读取侧只做一次字符串拼接。**

Honcho 的三段是 store → reason → query。本项目第一段免费（会话本来就落 IndexedDB），
第二段缺失，第三段不需要检索只需要读取。方案 F 就是补上第二段。

---

## 二、为什么不选方案 A（每轮提取）

方案 A 是"每轮回答结束 → 调一次 flash 提取事实 → 追加进扁平列表"。它可行，但有三个结构性问题：

| 问题 | 说明 |
|---|---|
| 调用次数 | 每轮 1 次，一天 100 轮就是 100 次 |
| 无法处理跨轮矛盾 | 只能拿本轮新事实跟扁平列表比，看不到"用户先说去北京、三轮后说改成上海"这种演化 |
| 容量硬顶 | 40 条上限，第 41 条永远进不去，除非前一条被合并掉 |

方案 F 对应解决：调用次数降一个数量级（每 ~8 轮 1 次）、一次看到 N 轮因而能处理演化、输出是**重写**因而有界（没有 40 条天花板，多了就压）。

**诚实修正**：延迟不是方案 F 的收益。方案 A 的提取也是 `finally` 里发出后不等待，不阻塞回答。两者对首字延迟的影响相同。

---

## 三、与 Honcho 的对应关系

| Honcho | 方案 F | 本项目现状 |
| --- | --- | --- |
| 把消息存进 session | 会话消息 | 已有，`src/services/chat/db.ts`（IndexedDB） |
| 队列 + 后台 worker 推理，更新 peer representation | deriver + scheduler，更新 Profile | **缺，本文要补的** |
| 取 representation / chat 端点 | 读一份 ≤1200 字的 Profile 全量注入 | **缺** |

差别：Honcho 的 representation 是服务端长期演化的实体；方案 F 的 Profile 是一个 localStorage 字段。
共同点：**读侧不推理**。这是关键——请求路径上不能有网络等待。

---

## 四、架构：冷热两条路径

### 热路径（每轮请求，零新增成本）

```
store.ts:1131  composeSystemPrompt(...)
    └─ memory 插件 apply({ config })  →  返回 { tail: config.profile }
    └─ settings.pluginSettings.memory.config.profile  ← localStorage 读，无 await
```

插件**保持纯函数**：`apply()` 只把 `config.profile` 包一层标题返回 `tail`。
所有副作用都在 `src/services/memory/`，插件只是格式化器。`src/plugins/README.md`
的三条铁律（单向依赖、纯计算、只回补丁）一条不破。

### 冷路径（整理，可延迟、可中断、可失败）

```
persist(sessionId) 之后（store.ts:214 / finally 在 store.ts:1215）
    └─ 记水位（同步写，必然执行）
    └─ 交给 scheduler 判断要不要整理
         └─ deriver：读未处理轮次 → 一次 flash 请求 → 校验 JSON → 双缓冲替换 Profile
```

热路径永远不会因为冷路径失败而失败。

---

## 五、数据模型：源 / 派生 / 控制

这是整个方案最重要的一条约束。

```
源数据（不可删，真值来源）
  会话消息 + 附件              src/services/chat/db.ts（已有，IndexedDB）

派生数据（可删、可重建）
  Profile 档案                 ≤1200 字，四段结构

控制数据（小、必须持久）
  watermark    每会话处理到第几条
  notes        用户便条（下次整理必须遵守）
  queue        待整理会话 + 未处理轮数
  meta         最后整理时间、连续失败次数、上次整理消耗
```

**Profile 是派生物，不是真值。** 任何时候都能从会话历史重建：删掉 Profile 重跑整理，
原始对话一条不少。这来自 tigerless-labs/agent-memory 的做法（"SQLite 索引是可随时删的缓存"）。

好处：模型整理出错不会导致数据丢失，最坏是记住的东西不对，重跑即可。

### 存放位置：localStorage，不是 IndexedDB

| 数据 | 位置 | 理由 |
| --- | --- | --- |
| Profile | `localStorage['deepseek-api-chat:memory-profile']` | 必须能在 `composeSystemPrompt` 同步取到；`PluginContext.config` 本来就来自 `settings.pluginSettings`（`src/services/settings.ts:48`），保持单一路径 |
| notes / watermark / meta | `localStorage['deepseek-api-chat:memory-state']` | 体积极小（<8KB），随读随写 |
| 会话消息 | 保持 IndexedDB | 不动 |

三端（Web / Tauri / Capacitor）localStorage 都可用，与现有设置同一套读写封装（含 try/catch 降级）。
代价写进 README：**三端各自独立，不同步**。跨端同步属于后端需求，不在本方案范围内。

---

## 六、数据契约

```ts
/** 派生物。四段结构，每段有字数上限，超限由整理环节压，不在读侧截断。 */
interface Profile {
  identity: string        // 我是谁：姓名、职业、所在地、主要语言（≤300 字）
  preferences: string     // 偏好与禁忌（≤350 字）
  relation: string        // 与 AI 的关系、称呼、相处方式（≤250 字）
  ongoing: string         // 进行中的事（≤300 字）
  updatedAt: number
  turnsSeen: number       // 累计处理过多少轮，用于判断档案成熟度
}

/** 用户便条：输入而非输出，用户写，整理必须逐条回应 */
interface MemoryNote {
  id: string
  text: string            // 单行，禁止换行
  createdAt: number
  resolvedAt?: number     // 整理回应后置位
  reply?: string          // 整理的回应："已改" / "没改，因为…"
}

/** 每会话水位 */
interface Watermark {
  sessionId: string
  /** 已纳入整理的消息条数（不是消息 id，见 §八 关于分支会话的说明） */
  processedCount: number
  /** 最近一次纳入整理的时间 */
  at: number
}
```

**为什么水位记条数而不是消息 id**：`editMessage` / `selectMessageVersion` / `branchSession`
（`src/services/chat/store.ts:770 / 802 / 537`）都会改变消息序列。记条数在序列变短时会
显得"已处理太多"，安全性由 §十一 的"水位守卫"兜住。

---

## 七、触发与调度

三个条件取或，谁先满足跑谁：

| 触发 | 判据 | 作用 |
| --- | --- | --- |
| 水位差 | 未处理轮数 ≥ 8 | 主路径，正常聊天时约每 8 轮一次 |
| 空闲 | 距上次用户活动 > 2 分钟，且未处理 ≥ 1 | 短会话也能被处理 |
| 启动追赶 | 应用打开或切换会话时未处理 ≥ 1 | **兜底主路径**（见 §九） |

约束：

- **单飞锁**：同一时刻只跑一个整理。
- **不中止**：新一轮 `sendMessage` 到达时，让正在跑的整理跑完再合并。整理只读会话、只写 Profile，与回答互不干扰。
- **失败退避**：连续失败 3 次后暂停自动整理，设置页提示，用户手动点「立即整理」可解除。

---

## 八、整理请求

### 输入

```
[现有档案全文]           —— ≤1200 字，没有则空
[用户便条]               —— 逐条编号，没有则省略整段
[待处理轮次]
  turn 1
  用户：……
  助手：……
  turn 2
  ……
```

限制：单次最多 30 轮；单条消息正文截断到 2000 字；总计不超过 24000 字。
超出则本批只处理前面的，剩余留到下一批（队列本来就支持）。

### 输出（严格 JSON）

```json
{
  "identity": "...",
  "preferences": "...",
  "relation": "...",
  "ongoing": "...",
  "unresolved": ["一行一条，已结束的不要写"],
  "cites": ["t1", "t3", "t7"],
  "noteReplies": [{ "id": "…", "reply": "已改 / 没改，因为…" }]
}
```

- `unresolved` 顺手产出，边际成本接近零。这是 Latent 四层里最值得抄的一层（"未解决清单"），
  解决"换会话就像换了个人"的核心。
- `cites` 是溯源护栏：要求输出的事实都能对应到某个输入 turn。模型编造而未 cite 的内容，
  无法自动识别，只能靠"档案可重建 + 原始对话不删"兜底，不声称能防住。
- `noteReplies` 让便条闭环。

### 校验与失败处理

| 失败形态 | 处理 |
| --- | --- |
| JSON 不合法 | 重试 1 次，附"只输出 JSON，不要代码块" |
| 缺字段 / 类型错 | 同上 |
| 单段超字数上限 | 重试 1 次，附"identity 压到 300 字内" |
| 重试仍失败 | **保留旧 Profile，水位回退，记录失败**。绝不写半成品 |
| 请求超时（30s） | 同上，计入失败次数 |

用 `request()`（`src/services/api/client.ts:69`）直接 POST，不走流式。不复用 `streamMessage`。
请求体参考 `CreateMessageRequest`（`src/services/api/types.ts:178`）：
`model: 'deepseek-flash'`、`thinking: { type: 'disabled' }`、`tools: []`、`safety_check: { level: 'low' }`、
不传 `title`。

> 待确认：`system` 是必填字段（`types.ts:180`），整理请求把指令放 `system` 还是首条 user 消息，
> 需要在实现时用最小样例验证一次。

---

## 九、浏览器没有可靠后台（真问题）

- **Web**：标签页一关就结束。
- **Android WebView**：系统可随时回收，`pagehide` 不可靠。
- **Tauri**：窗口关闭后进程是否存活，本文不假设（见《未验证项》）。

所以**不能依赖"进程活着"**，必须把队列做成持久的、可恢复的。分工：

1. `finally`（`store.ts:1215`）里同步写一次水位"本会话又多了 N 条未处理"。这一步必然执行，**轮次永不丢失**。
2. 整理开始时不动水位；整理**成功后**才推进水位并写 Profile（同一笔操作，要么都成要么都不成）。
3. 最坏情况：用户连聊 50 轮就关掉、从未空闲 —— 下次打开一次性追赶 50 轮。**一次性成本，不是累积成本**。

这与 Honcho 把队列建在 Postgres 里、worker 崩溃不丢消息是同一思路，只是队列载体换成 localStorage。

---

## 十、注入契约

### 位置：`tail`，`order: 700`

依据 `src/plugins/index.ts:70` 的 `combine()`：`head` 是**前插**，且插件按 `order` 升序执行。
所以 `head` 型插件 order 越大越靠前。现有顺序实测为 `PERSONA(200) → NSFW(100) → SYSTEM`。

若记忆用 `head`，会变成 `MEMORY → PERSONA → NSFW → SYSTEM`，同时破坏两件事：

1. 人格从开篇高注意力位被挤走（"顺序即权重"）；
2. 稳定前缀被每轮变化的记忆打断，prompt cache 失效
   （`src/services/api/types.ts:199-200` 有 `cache_creation_input_tokens` / `cache_read_input_tokens`，证实缓存在用）。

正确位置：`SYSTEM → CUSTOM(500) → **MEMORY(700)** → PURGE(900)`。

`tail` 是后插，order 700 排在 custom(500) 之后、purge(900) 之前，符合预期。
同时 `tail` 靠近用户提问，是第二个注意力高地。

### 注入文本形态

```
关于用户：以下是跨会话积累的背景，不是本轮指令。与用户当前说法冲突时以当前说法为准。

【我是谁】
…

【偏好与禁忌】
…

【关系与称呼】
…

【进行中的事】
…

【尚未结束】
- …
```

「不是本轮指令」「冲突时以当前说法为准」两句是必须的：否则模型会把旧档案当成用户刚说的话。
「以当前说法为准」也是 supersede 语义的最简实现——不需要变迁链账本，由模型在当轮自行判断。

### 空档案行为

`profile` 为空或四段全空 → `apply()` 返回 `undefined`，这轮不注入。
与 `custom-instructions` 插件一致（`src/plugins/custom-instructions/index.ts` 的
`text ? { tail: text } : undefined`）。

---

## 十一、便条机制

用户发现记错时，**不直接改档案**，而是写一张便条（「我不在上海了，搬到杭州」）。

- 便条进 `notes`，下次整理作为最高优先级输入；
- 整理必须逐条回应（`noteReplies`），改了就改，不改要给理由；
- 档案只有整理能写，设置页没有绕过它的编辑按钮。

**理由**：直接让用户编辑档案会和下次重写打架——用户改掉的一句，模型重写时可能又丢回去，
而且用户会以为自己改成功了。便条是**输入**不是**输出**，不会丢。这是 Latent「小锁信 + 只有 TA 能改」的分工。

例外：设置页保留「查看完整档案」只读视图 + 「清空全部记忆」+「立即整理」三个动作。

---

## 十二、三端兼容约束

构建目标来自 `rspack.config.ts`：标准档 `chrome >= 105 / safari >= 16 / firefox >= 110`（第 10 行），
`legacy` 档 `chrome >= 69`（第 13 行，面向 Android 9 出厂 WebView）。

`tsconfig.json` 的 `target: ESNext` 只影响类型检查，**运行时真约束是浏览器目标**。因此整理模块里禁用：

- `crypto.randomUUID()`（chrome 92+）
- `structuredClone()`（chrome 98+）
- `AbortSignal.timeout()`（chrome 103+）
- `Array.prototype.findLast()`（chrome 97+）
- `Object.groupBy()`（chrome 117+）

id 生成沿用项目现有写法。超时用 `setTimeout` + `AbortController` 手写。

---

## 十三、分三步落地（每步可独立收尾）

### 第一步：只做读侧（约 30–40 分钟）

新增 `src/plugins/memory/index.ts` + `prompt.ts`，注册表加一行，i18n 加中英各 2 条。
档案来源：设置页文本框手动粘贴。

**验收**：开关打开后，请求体里出现记忆块，位置在 custom 之后、purge 之前；
`MessageUsage.cache_read_input_tokens` 不为 0（说明稳定前缀仍命中缓存）。

**如果这一步效果不好，后面两步不用写，损失 40 分钟。** 反过来先写 deriver 再发现注入位置不对，570 行白写。

### 第二步：接 deriver，手动触发

`store.ts` 两处挂钩（收尾写水位、注入传 profile）+ 整理请求 + JSON 校验 + 双缓冲替换。
此时先只做「用户点立即整理才跑」，不接自动触发。

**验收**：点一次，档案从旧值被替换为新值；故意让接口返回坏 JSON，档案保持不变且失败计数 +1。

### 第三步：自动触发

水位差 + 空闲 + 启动追赶三条件 + 单飞锁 + 失败退避。

**验收**：正常聊 8 轮后档案自动更新；关掉标签页再打开，未处理的轮次会被追赶处理；
连点两次不会并发两个整理。

---

## 十四、文件清单与改动量（估算，未实现）

| 文件 | 内容 | 估算行数 |
| --- | --- | --- |
| `src/services/memory/store.ts` | Profile / 水位 / 便条 / meta 的读写与校验 | 120 |
| `src/services/memory/deriver.ts` | 组装输入、发请求、JSON 校验、重试、双缓冲替换 | 150 |
| `src/services/memory/scheduler.ts` | 触发判据、单飞锁、启动追赶、失败退避 | 90 |
| `src/services/memory/prompt.ts` | 整理提示词正文（同 `plugins/*/prompt.ts` 惯例） | 80 |
| `src/plugins/memory/index.ts` | 纯格式化，回 `tail` | 40 |
| `src/services/chat/store.ts` | 挂钩 2 处 | 30 |
| `src/components/settings/` | 只读档案 + 立即整理 + 清空 + 便条 | 60 |
| `src/i18n/{zh,en}.ts` | 文案 | 各 ~12 条 |
| `src/plugins/README.md` | 插件表格加一行 + 决策记录 | 20 |

合计约 **570 行**。这些是估算，不是实测。

---

## 十五、失败模式与降级

| 风险 | 处理 |
| --- | --- |
| 模型编造事实 | `cites` 强制溯源 + 档案可重建 + 原始对话永不删；**不声称能防住编造** |
| 档案越写越空洞 | 四段固定 + 每段字数上限 + 便条必须逐条回应 |
| 水位与消息序列错位（编辑/分支/删消息） | **水位守卫**：整理前校验 `processedCount <= messages.length`，否则按当前长度重置并发一次全量重建 |
| 整理请求打爆额度 | 每批最多 30 轮；用户可在设置里关掉自动整理 |
| 连续失败 | 3 次后退避，只注入不整理，并提示 |
| localStorage 被清理（Android WebView） | 档案丢失 → 源码（会话）还在 → 重新整理即可恢复。这就是"派生物"设计的价值 |
| 整理与用户手动改档案冲突 | 用户没有编辑入口，只有便条，从根上避免 |

---

## 十六、未验证项

以下都是本文档没有实测或未查证的部分，实现前必须补：

1. `deepseek-flash` 对严格 JSON 输出的稳定性 —— 未测。
2. 整理请求该把指令放 `system` 还是首条 user 消息 —— 未测。
3. Tauri 窗口关闭后进程是否仍可执行定时任务 —— 未查。
4. Capacitor Android WebView 在系统内存压力下 localStorage 的持久性 —— 未查。
5. 570 行这个估算 —— 未实现。
6. `unresolved` 与 `ongoing` 两段的语义边界是否真能被模型稳定区分 —— 需要在真实输出上调。
7. prompt cache 在加入 700 号记忆块后是否仍命中 —— 需在第一步验收时用 `cache_read_input_tokens` 实测确认。

---

## 十七、需要人决定的开放项

1. **档案分四段是否合适**：「身份 / 偏好 / 关系 / 进行中」是照 Latent 人格骨架缩的，可能过细。
2. **每 8 轮一次的频率**：取决于真实聊天轮数与额度敏感度。
3. **`unresolved` 是否也进注入文本**：本文默认进（放在最后一段）。它比偏好更该影响当前回话，但也更容易过期。
4. **是否给记忆块加「最后更新于 X」**：加则模型知道档案新旧，但也是每轮变化的内容——放在 `tail` 里不影响缓存，可以加。
5. **降级档 A 是否保留**：本方案不需要，但如果某些用户不想付整理请求的钱，A 可作为"仅手动"模式存在。本文建议不保留，避免两套写入路径（方案 D 的坑）。

---

## 十八、参考与不借鉴的部分

| 来源 | License | 借鉴了什么 | 为什么不借鉴其余 |
| --- | --- | --- | --- |
| plastic-labs/honcho | **AGPL-3.0** | 三段式（store / reason / query）、队列持久化、读侧不推理、peer representation 概念 | 不能搬任何代码；不接它的服务（破坏纯前端架构、三端网络问题） |
| oliscatt/Latent-memory | **AGPL-3.0** | 注入契约（逐字、每轮、重读、整块、易变内容靠后）、四层记忆、supersede/correct 分开、便条分工、顺序即权重 | 不借鉴 BM25/RRF/图谱三路检索（其自身承认零依赖档只有两路有效）、fastembed、Passive Recall hook、山屋 UI |
| mem0ai/mem0 | Apache-2.0 | 四操作思路（ADD/UPDATE/DELETE/NONE）演化为五操作（SUPERSEDE / RETRACT 分开） | 不做每轮提取（即方案 A） |
| tigerless-labs/agent-memory | MIT | "索引是可随时删的缓存" → 派生物设计 | 不做 Markdown 文件树（浏览器无文件系统） |

---

## 附：与现有插件的关系

全开时最终拼接顺序：

```
PERSONA(200, head) → NSFW(100, head) → SYSTEM → CUSTOM(500, tail) → MEMORY(700, tail) → PURGE(900, tail)
```

`persona` 插件已经承担了"人格/文风"，与记忆的「关系与称呼」段有语义重叠。
需要在实现时二选一或明确分工：**persona 管"怎么说话"，memory 管"记住什么"**。
若两者都开且都写了关系描述，可能出现重复。这一步要在第一步验收时肉眼看输出确认。
