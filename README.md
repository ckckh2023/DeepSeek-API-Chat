# DeepSeek API Chat

简体中文 | [English](README.en.md)

基于 DeepSeek API 的聊天应用，由 [Chat Demo](https://github.com/deepseek-ai/chat-demo/) 进行修改优化而来，网页、桌面与 Android 共用一套前端代码。无需自建后端，浏览器或 WebView 直接请求配置的 API 服务。

## 获取与使用

- 客户端：前往 [Releases](https://github.com/ckckh2023/DeepSeek-API-Chat/releases) 下载安装包即可。
- 网页版：执行 `pnpm build` 后把 `dist/` 部署到静态服务器即可使用。

> [!TIP]
> 首次使用时在设置中填写 API Key，没有 Key 可以通过设置里的 `API 获取指引` 查看申请步骤。

## 运行与构建

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/ckckh2023/DeepSeek-API-Chat.git
cd DeepSeek-API-Chat
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。

## 打包桌面端、Android 与 iOS

构建在 GitHub Actions 中完成：

- [desktop.yml](.github/workflows/desktop.yml)：Windows 与 Linux 安装包。
- [macos.yml](.github/workflows/macos.yml)：macOS 通用 dmg。
- [android.yml](.github/workflows/android.yml)：debug 与 release APK，配置四个签名 secret 后即可生成签名包。
- [ios.yml](.github/workflows/ios.yml)：未签名 IPA，需自行用爱思助手等工具签名后安装。

## 数据与存储

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm test`   | 运行单元测试        |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，切换到专家模式后使用 `deepseek-v4-pro`，均通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  plugins/             插件注册、提示词组合与内置插件
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
  vendor/              打包进仓库的第三方运行时（marked）
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。