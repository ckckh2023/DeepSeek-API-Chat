# DeepSeek API Chat

[简体中文](README.md) | English

A chat app powered by the DeepSeek API, modified and improved from [Chat Demo](https://github.com/deepseek-ai/chat-demo/). The web, desktop, and Android builds share one frontend; no application backend is required, and the browser or WebView connects directly to the configured API service.

## Getting the app

- Client apps: download an installer from [Releases](https://github.com/ckckh2023/DeepSeek-API-Chat/releases).
- Web: run `pnpm build` and deploy `dist/` to a static server.

> [!TIP]
> Enter your API key in Settings before your first chat. Without a key, open the API key guide in Settings to see how to obtain one.

## Running and building

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/ckckh2023/DeepSeek-API-Chat.git
cd DeepSeek-API-Chat
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly.

## Packaging desktop, Android, and iOS builds

Builds run in GitHub Actions:

- [desktop.yml](.github/workflows/desktop.yml): Windows and Linux installers.
- [macos.yml](.github/workflows/macos.yml): a macOS universal dmg.
- [android.yml](.github/workflows/android.yml): debug and release APKs; release APKs are signed when the four signing secrets are configured.
- [ios.yml](.github/workflows/ios.yml): an unsigned IPA; sign it locally before installing.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm test`   | Run unit tests               |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default and `deepseek-v4-pro` in Expert mode, both through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  plugins/             Plugin registry, prompt composition, and built-in plugins
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
  vendor/              Third-party runtime bundled in the repo (marked)
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.