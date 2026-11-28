/** 每块攒到 256KB 再跨桥写入：块太大占内存，太小会增加 bridge 调用次数 */
const CHUNK_BYTES = 256 * 1024

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

export type ArchiveWriteResult =
  | { savedToDocuments: true }
  | { savedToDocuments: false; uri: string }

export type ArchiveFileWriter = {
  push: (chunk: Uint8Array) => Promise<void>
  finish: () => Promise<ArchiveWriteResult>
}

/**
 * 移动端流式导出落盘：边生成边写，不把整包 ZIP 或整包 base64 放进内存。
 * 首选公共 Documents（用户可在文件管理器直接看到）；系统不允许写公共目录时，
 * 从第一块起就改写到应用缓存，完成后交给系统分享面板保存。
 */
export const createArchiveFileWriter = async (name: string): Promise<ArchiveFileWriter> => {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  let parts: Uint8Array[] = []
  let size = 0
  let created = false
  let target: 'documents' | 'cache' = 'documents'
  const flush = async () => {
    if (size === 0) {
      return
    }
    const merged = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    parts = []
    size = 0
    const data = bytesToBase64(merged)
    if (created) {
      await Filesystem.appendFile({
        path: name,
        data,
        directory: target === 'documents' ? Directory.Documents : Directory.Cache,
      })
      return
    }
    try {
      // 第一块就写公共目录：大文件也直接落在 Documents，不需要先缓存再复制
      await Filesystem.writeFile({
        path: name,
        data,
        directory: Directory.Documents,
        recursive: true,
      })
      target = 'documents'
    } catch {
      await Filesystem.writeFile({
        path: name,
        data,
        directory: Directory.Cache,
        recursive: true,
      })
      target = 'cache'
    }
    created = true
  }
  return {
    push: async (chunk) => {
      // fflate 的输出块可能被复用，先复制再入队
      parts.push(chunk.slice())
      size += chunk.byteLength
      if (size >= CHUNK_BYTES) {
        await flush()
      }
    },
    finish: async () => {
      await flush()
      if (created && target === 'documents') {
        return { savedToDocuments: true }
      }
      const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache })
      return { savedToDocuments: false, uri }
    },
  }
}