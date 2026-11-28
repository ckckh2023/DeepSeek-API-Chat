import { translate } from '../../i18n/index.js'
import { isCapacitor, isTauri, isWebApp } from '../../app/platform.js'
import { getFileExt } from '../../services/attachments.js'
import { loadFile } from '../../services/chat/db.js'
import { showToast } from '../base/toastState.js'
import { openFileViewer } from './fileViewerState.js'

/** 文本超过这个大小不再应用内渲染，交给系统应用或下载 */
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mkd', 'mkdn', 'mkdown'])

const TEXT_EXTS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'mkd',
  'mkdn',
  'mkdown',
  'csv',
  'tsv',
  'log',
  'json',
  'json5',
  'jsonld',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'properties',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'vue',
  'py',
  'go',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cxx',
  'java',
  'kt',
  'cs',
  'php',
  'rb',
  'rs',
  'sh',
  'bash',
  'zsh',
  'bat',
  'cmd',
  'sql',
  'gitignore',
  'gitmodules',
  'diff',
  'patch',
  'srt',
  'vtt',
])

/** 系统默认应用最常处理的类型；blob.type 缺失时兜底 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
}

/** 去掉 Windows / Android 文件名的非法字符，保留扩展名 */
const safeFileName = (name: string) =>
  Array.from(name)
    .map((char) => (/[\\/:*?"<>|]/.test(char) || char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .slice(-120) || 'file'

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment'))
    reader.readAsDataURL(blob)
  })

const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const openFailed = () => showToast(translate('fileOpenFailed'))

/** 桌面写临时文件后交给系统默认软件（Word、Edge 等） */
const openWithTauri = async (name: string, blob: Blob) => {
  const [{ tempDir, join }, fs, opener] = await Promise.all([
    import('@tauri-apps/api/path'),
    import('@tauri-apps/plugin-fs'),
    import('@tauri-apps/plugin-opener'),
  ])
  const dir = await join(await tempDir(), 'deepseek-api-chat')
  await fs.mkdir(dir, { recursive: true })
  const path = await join(dir, `${Date.now()}-${safeFileName(name)}`)
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()))
  await opener.openPath(path)
}

/** 安卓写入缓存后通过原生桥交给系统默认应用 */
const openWithCapacitor = async (name: string, blob: Blob, mimeType: string) => {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const { uri } = await Filesystem.writeFile({
    path: `attachments/${Date.now()}-${safeFileName(name)}`,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
    recursive: true,
  })
  if (window.SystemBars?.openFile) {
    window.SystemBars.openFile(uri, mimeType)
    return
  }
  // 旧版 App 没有原生打开桥，退回系统分享面板
  const { Share } = await import('@capacitor/share')
  await Share.share({
    title: name,
    files: [uri.startsWith('file:') ? uri : `file://${uri}`],
  })
}

const openWithSystem = async (name: string, blob: Blob, ext: string) => {
  const mimeType = blob.type || MIME_BY_EXT[ext] || 'application/octet-stream'
  try {
    if (isTauri()) {
      await openWithTauri(name, blob)
      return
    }
    if (isCapacitor()) {
      await openWithCapacitor(name, blob, mimeType)
      return
    }
    // 网页版：PDF 交给浏览器内置阅读器，其余类型只能下载
    if (ext === 'pdf' || mimeType === 'application/pdf') {
      const url = URL.createObjectURL(blob)
      if (window.open(url, '_blank', 'noreferrer')) {
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      } else {
        URL.revokeObjectURL(url)
        download(blob, name)
      }
      return
    }
    download(blob, name)
  } catch (error) {
    // 用户在分享面板里主动取消不算打开失败
    if (/cancel/i.test(String((error as Error | undefined)?.message ?? error))) {
      return
    }
    openFailed()
  }
}

/**
 * 消息附件打开入口：txt/md 等文本直接在应用内预览；
 * PDF、Word 等交给系统默认软件；网页版能看 PDF，其余类型下载。
 */
export const openAttachment = async ({
  id,
  name,
  objectUrl,
  blob: provided,
}: {
  id?: string
  name: string
  /** 网页版已生成的 blob 地址，用于 PDF 同步开新标签，避免被当成弹窗拦截 */
  objectUrl?: string | null
  /** 输入框草稿还没写入 IndexedDB 时直接传本地原件 */
  blob?: Blob
}) => {
  const ext = getFileExt(name)
  if (isWebApp() && ext === 'pdf' && objectUrl) {
    window.open(objectUrl, '_blank', 'noreferrer')
    return
  }
  let blob: Blob | undefined = provided
  if (!blob && id) {
    try {
      blob = await loadFile(id)
    } catch {
      blob = undefined
    }
  }
  if (!blob) {
    return
  }
  if (TEXT_EXTS.has(ext) && blob.size <= TEXT_PREVIEW_LIMIT) {
    const text = await blob.text()
    openFileViewer({ name, text, markdown: MARKDOWN_EXTS.has(ext) })
    return
  }
  await openWithSystem(name, blob, ext)
}
