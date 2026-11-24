# src/plugins —— 编译期内置插件目录

这个目录不是"运行时加载的插件系统"，而是**编译期注册的扩展点**：插件随前端一起打包，
写进注册表即存在，没有安装、没有动态 import。是否参与某次请求由设置里的插件开关决定，
默认关闭。

## 目录约定

```text
src/plugins/
  index.ts             注册表 + composeSystemPrompt()：宿主唯一入口
  types.ts             插件契约（PromptPlugin / PluginContext / PromptPatch）
  custom-instructions/ 插件：自定义指令（tail，正文来自设置）
    index.ts
  memory/             插件：记忆（tail，档案由宿主读出后传入）
    index.ts
    prompt.ts          注入模板、段标题、相对时间
  nsfw/                插件：NSFW 创作模式注入（head）
    index.ts
    prompt.ts          正文（用 .ts 存，避免动构建配置加 raw loader）
  persona/             插件：人格 / 文风注入（head）
    index.ts
    prompt.ts          内置骨架正文，用户可在设置里改写
  purge/               插件：拒答兜底（tail）
    index.ts
    prompt.ts
```

## 现有插件

| 插件                  | order | 位置 | 分区                        |
| --------------------- | ----- | ---- | --------------------------- |
| `nsfw`                | 100   | head | 非官方（`community: true`） |
| `persona`             | 200   | head | 内置                        |
| `custom-instructions` | 500   | tail | 内置                        |
| `memory`              | 700   | tail | 内置                        |
| `purge`               | 900   | tail | 非官方（`community: true`） |

全开时的拼接顺序：`PERSONA → NSFW → SYSTEM → CUSTOM → MEMORY → PURGE`。

### memory 的额外约定

- **档案不在 `config` 里**：`memory` 的档案单独存在
  `localStorage['deepseek-api-chat:memory-profile']`，控制数据（便条 / 水位 / 失败计数 /
  自动整理开关）另存 `localStorage['deepseek-api-chat:memory-state']`。设置页只读展示它，
  不走 `config.text`，避免一份 JSON 里挤出第二套写入路径。
- **用户不直接改档案**：设置页只有「复制档案 / 立即整理 / 清空全部记忆」三个动作。发现记错时
  写一张**便条**（输入而非输出），下次整理必须逐条回应。直接让用户编辑档案会和下次重写打架：
  用户改掉的一句，模型重写时可能又丢回去。
- **档案只有整理环节能写**：`src/services/memory/index.ts` 的 `deriveProfile()` 是唯一写入者，
  `send` 由调用方注入，因此它不需要网络就能测。失败一律「旧档案不变、水位不推进、失败计数 +1」。
- **宿主注入时机**：`src/services/chat/store.ts` 组装请求前用
  `withMemoryProfile(settings.pluginSettings)` 同步读一次档案挂到 `memory.config` 上，
  插件本身仍然不碰 localStorage。每轮回答结束的收尾处（`streamReply` 的 `finally`）另记一次
  会话活动，**不挂 `persist()`** —— 那是「任何变更都存盘」的通用出口，编辑、切版本、切分支都会走它。
- **自动整理**：`src/services/memory/scheduler.ts` 只有判据、单飞锁与退避，不碰网络与存储。
  三个触发点由宿主投喂：回答收尾（`turns`，未处理 ≥ 8 轮）、空闲定时器（`idle`，停聊 5 分钟
  且未处理 ≥ 1）、打开应用或切会话（`opened`，未处理 ≥ 1 就补）。定时器只活在本次页面打开
  期间，隔天重开靠 `opened` 追赶，因此目标会话取「当前会话，欢迎页则取最近聊过的那个」；
  已删除的会话不算目标（删会话时 `forgetSession()` 一并清掉它的水位与活动记录），
  否则追赶会打在一个不存在的会话上、每次都被 `no-session` 挡回来。
  连续失败 3 次暂停自动整理（手动「立即整理」成功即解除），失败期间读侧照常注入旧档案。
- **记忆不跨端**：Web / Tauri / Capacitor 各存一份 localStorage，换端后记忆为空。
- **记忆不抢人格**：档案只写事实，语气、文风、称呼归 `persona`。两个插件同时开时
  `memory` 只能出现在 `CUSTOM` 之后，不参与开篇的角色设定。

## 开关与配置

`composeSystemPrompt(system, messages, states)` 的第三个参数是宿主从设置里读出的插件状态：

```ts
interface PluginState {
  enabled?: boolean
  config?: unknown
}
```

- **默认关闭**：`states[name].enabled !== true` 的插件不执行，避免升级后静默改变请求。
- **配置由宿主注入**：插件不读 localStorage，配置通过 `PluginContext.config` 传入；
  具体形状由插件自己收窄。
- **正文可编辑**：插件导出 `defaultText`（内置正文）时，设置页的「编辑」弹窗以
  `config.text || defaultText` 为初值；保存值与内置正文一致时写空串，让插件继续回退到
  内置正文，避免把旧版本正文固化到本机设置里。
- **社区插件门禁**：标记 `community: true` 的插件只在高级模式开启时执行。关闭高级模式只是
  跳过注入，不改动 `pluginSettings` —— 原先的开关、正文都原样保留，重新进入高级模式即恢复。
- **UI 由插件元数据驱动**：设置页按 `community` 分区、按 `ui.labelKey / descriptionKey` 渲染，
  新增插件不需要改设置页组件；`ui.editable` / `ui.editor` 决定「编辑」入口与弹窗形态。
- **插件不持有 UI 文案**：`ui.*Key` 只放 i18n 键名，文案集中在 `src/i18n`。
  例外只有注入正文本身（`prompt.ts`），它不是 UI 文案。
- 开关只影响之后的新请求，不改历史消息和已经生成的内容。

## 三条铁律

1. **单向依赖**：插件只 import 本目录的 `types.js`，不 import 宿主的 store / api / 组件。
2. **纯计算**：插件是纯函数，不写 localStorage、不发请求、不读 DOM，也不自己取时钟
   （`Date.now()` / `new Date()`）。要数据和时间戳都由宿主通过 `PluginContext.config` 传，
   这样同样入参一定出同样结果。
3. **只回补丁**：插件返回 `PromptPatch`（`head` / `tail`），由注册表统一拼接；插件抛错只记录，
   绝不中断请求。

## 加一个插件

1. 新建 `src/plugins/<名字>/index.ts`，导出 `<名字>Plugin`；有内置正文时可另建 `prompt.ts`。
   非官方 / 社区插件在插件对象上加 `community: true`，由高级模式门禁控制是否注入。
2. 在 `src/plugins/index.ts` 的 `plugins` 数组里加一行。
3. 在设置页的插件列表里加对应文案与开关；需要持久化配置时，在 `src/services/settings.ts`
   的插件状态结构里使用该插件的 `name`；存储另有专属键时，在 `ui` 里标 `editor: 'profile'`，
   由设置页换成自带读写的弹窗，而不是复用 `config.text` 那一个。
4. 跑 `pnpm type` 与 `pnpm lint`。

## 宿主挂钩点

**注入**只有一处：`src/services/chat/store.ts` 组装请求时调用

```ts
const pluginStates = withMemoryProfile(settings.pluginSettings)
composeSystemPrompt(SYSTEM_PROMPT, messages, pluginStates, {
  advanced: useAdvancedMode.getState().enabled,
})
```

**调度**另有三处触发（都不是第二套注入，也不改请求体）：
回答收尾的 `finally`（`turns`）、`initChat` 读完列表后与 `selectSession` 切换会话后
（都是 `opened`）、`run.ts` 里的空闲定时器（`idle`）。三处都调 `requestAutoMemory()`，
调度器没接线时是空操作，所以插件关掉、或测试环境里没有 DOM，都不会影响回答流程。

`withMemoryProfile` 只做一件事：`memory` 开关打开时，把宿主读到的档案（加上寄存给的
「现在」）挂到 `memory.config` 上；其它插件的状态原样透传。它属于同一处挂钩，不是第二处。

除这处之外，宿主还会改三处为插件服务的通用设施，全部与具体插件无关：
`src/plugins/types.ts`（契约）、`src/components/settings/SettingsDialog.tsx`（按元数据渲染的
设置页）、`src/i18n`（文案）。新增插件不需要改设置页组件——只改插件定义与注册表。
