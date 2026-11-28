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

export type ArchiveFileWriter = {
  push: (chunk: Uint8Array) => Promise<void>
  finish: () => Promise<void>
}

/**
 * 移动端流式导出落盘：先把 ZIP 分块写进应用缓存，
 * 全程不生成完整 Blob，也不把整包转成一整串 base64。
 */
export const createArchiveFileWriter = async (name: string): Promise<ArchiveFileWriter> => {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  // 覆盖上一次中断留下的同名缓存
  await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {})
  let parts: Uint8Array[] = []
  let size = 0
  let created = false
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
      await Filesystem.appendFile({ path: name, data, directory: Directory.Cache })
    } else {
      await Filesystem.writeFile({
        path: name,
        data,
        directory: Directory.Cache,
        recursive: true,
      })
      created = true
    }
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
    finish: flush,
  }
}

export type ArchiveCommitResult =
  | { savedToDocuments: true }
  | { savedToDocuments: false; uri: string }

/** 缓存文件写完后尝试复制到 Documents；失败时返回缓存 uri 交给系统分享面板 */
export const commitArchiveFile = async (name: string): Promise<ArchiveCommitResult> => {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  try {
    // 覆盖同名旧文件；不存在时 deleteFile 会抛错，忽略即可
    await Filesystem.deleteFile({ path: name, directory: Directory.Documents }).catch(() => {})
    await Filesystem.copy({
      from: name,
      to: name,
      directory: Directory.Cache,
      toDirectory: Directory.Documents,
    })
    await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {})
    return { savedToDocuments: true }
  } catch {
    const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache })
    return { savedToDocuments: false, uri }
  }
}