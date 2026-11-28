import * as db from '../db.js'
import type { Session } from '../types.js'
import { EXPORT_FORMAT_VERSION, type Manifest, type SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, imagePath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/** 导出进度：先按会话收集，再按 ZIP 字节打包 */
export type ExportArchiveProgress =
  | { phase: 'collecting'; done: number; total: number }
  | { phase: 'writing'; percent: number }

/**
 * 按导出格式生成 ZIP：manifest → 全部会话 JSON → index → 全部图片。没有账号信息，不写 user.json。
 * 只写出本地有原件的图片，每个会话目录各写一份；其他附件只有元数据。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  options?: {
    total?: number
    onProgress?: (progress: ExportArchiveProgress) => void
  }
): Promise<Blob> => {
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const imageEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  const total = options?.total ?? 0
  let done = 0
  for await (const session of sessions) {
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (file.isImage && !originals.has(file.id)) {
            originals.set(file.id, await db.loadFile(file.id))
          }
        }
      }
    }
    const images = new Map<string, Blob>()
    const data = toSessionFile(session, ({ id, name, isImage }) => {
      const blob = originals.get(id)
      if (!blob || !isImage) {
        return null
      }
      const path = imagePath(session.id, id, name)
      images.set(path, blob)
      return path
    })
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of images) {
      imageEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
    done += 1
    // 每 3 个会话上报一次，避免长列表每一条都触发渲染
    if (done === total || done % 3 === 0) {
      options?.onProgress?.({ phase: 'collecting', done, total })
    }
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(imageEntries), (ratio) => {
    options?.onProgress?.({ phase: 'writing', percent: Math.round(ratio * 100) })
  })
}
/**
 * 流式导出：每个会话处理完立刻写出并释放，内存里只保留当前会话的 JSON 与图片。
 * 条目顺序为 manifest → 会话 → 该会话图片 → … → index，导入端支持这种交错顺序。
 * 进度按已完成会话数上报，避免大归档写出前先在内存里堆满。
 */
export const exportArchiveStream = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  options: {
    total?: number
    onProgress?: (progress: ExportArchiveProgress) => void
    onChunk: (chunk: Uint8Array) => Promise<void>
  }
): Promise<number> => {
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const index: SessionIndexEntry[] = []
  const total = options.total ?? 0
  let done = 0

  async function* entries(): AsyncGenerator<{ name: string; blob: Blob }> {
    yield { name: MANIFEST_PATH, blob: json(manifest) }
    for await (const session of sessions) {
      // 只预读当前会话的图片，写完后随本轮循环结束释放
      const originals = new Map<string, Blob | undefined>()
      for (const message of session.messages) {
        if (message.role === 'user') {
          for (const file of message.files) {
            if (file.isImage && !originals.has(file.id)) {
              originals.set(file.id, await db.loadFile(file.id))
            }
          }
        }
      }
      const images: { name: string; blob: Blob }[] = []
      const data = toSessionFile(session, ({ id, name, isImage }) => {
        const blob = originals.get(id)
        if (!blob || !isImage) {
          return null
        }
        const path = imagePath(session.id, id, name)
        images.push({ name: path, blob })
        return path
      })
      yield { name: sessionPath(session.id), blob: json(data) }
      for (const image of images) {
        yield image
      }
      index.push(toIndexEntry(data))
      done += 1
      options.onProgress?.({
        phase: 'writing',
        percent: Math.round((done / Math.max(1, total)) * 100),
      })
    }
    yield { name: INDEX_PATH, blob: json(index) }
  }

  await writeArchiveStream(entries(), options.onChunk)
  return done
}
