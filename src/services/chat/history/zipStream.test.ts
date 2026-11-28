import { describe, expect, it } from 'vitest'
import { INDEX_PATH, MANIFEST_PATH, imagePath, sessionPath } from './paths.js'
import { readArchive } from './zipReader.js'
import { writeArchiveStream } from './zipWriter.js'

const buildArchive = async (entries: { name: string; blob: Blob }[]) => {
  const chunks: Uint8Array[] = []
  await writeArchiveStream(entries, async (chunk) => {
    chunks.push(chunk)
  })
  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { file: new File([bytes], 'stream.zip', { type: 'application/zip' }), chunkCount: chunks.length }
}

describe('writeArchiveStream', () => {
  it('writes an archive readable with sessions and images interleaved', async () => {
    const session = sessionPath('s1')
    const image = imagePath('s1', 'f1', 'image.png')
    const { file, chunkCount } = await buildArchive([
      { name: MANIFEST_PATH, blob: new Blob(['{"export_format_version":1}']) },
      { name: session, blob: new Blob(['{"id":"s1"}']) },
      { name: image, blob: new Blob([new Uint8Array([1, 2, 3])]) },
      { name: INDEX_PATH, blob: new Blob(['[]']) },
    ])

    // 数据必须分块产出，不能攒到最后一次性输出
    expect(chunkCount).toBeGreaterThan(1)

    const paths: string[] = []
    for await (const entry of readArchive(file)) {
      paths.push(entry.path)
      // readArchive 要求消费完当前条目再取下一条
      for await (const chunk of entry.stream) {
        void chunk
      }
    }
    expect(paths).toEqual([MANIFEST_PATH, session, image, INDEX_PATH])
  })

  it('rejects duplicate entry names', async () => {
    await expect(
      buildArchive([
        { name: 'a.json', blob: new Blob(['1']) },
        { name: 'a.json', blob: new Blob(['2']) },
      ])
    ).rejects.toThrow()
  })
})