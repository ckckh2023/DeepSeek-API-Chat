import { Capacitor } from '@capacitor/core'

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

export type ArchiveWriteResult = {
  uri: string
  /** iOS 直接写进应用 Documents，可在「文件」App 里看到 */
  savedToDocuments: boolean
}

export type ArchiveFileWriter = {
  push: (chunk: Uint8Array) => Promise<void>
  finish: () => Promise<ArchiveWriteResult>
}

/**
 * 移动端流式导出：边生成边分块写，内存里只有当前块。
 * iOS 直接写应用 Documents（配合 Info.plist 文件共享，用户能在「文件」App 里找到）；
 * 安卓写缓存后再交给原生 SAF「保存到」对话框，因为公共 Documents 在 Android 10+ 不能直接写。
 */
export const createArchiveFileWriter = async (name: string): Promise<ArchiveFileWriter> => {
  const { Filesystem, Directory } = await import('@capacitor/filesystem')
  const target = Capacitor.getPlatform() === 'ios' ? Directory.Documents : Directory.Cache
  const savedToDocuments = target === Directory.Documents
  // 覆盖上一次中断留下的同名文件
  await Filesystem.deleteFile({ path: name, directory: target }).catch(() => {})
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
      await Filesystem.appendFile({ path: name, data, directory: target })
    } else {
      await Filesystem.writeFile({
        path: name,
        data,
        directory: target,
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
    finish: async () => {
      await flush()
      const { uri } = await Filesystem.getUri({ path: name, directory: target })
      return { uri, savedToDocuments }
    },
  }
}