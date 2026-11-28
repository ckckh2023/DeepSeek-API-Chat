import { Capacitor } from '@capacitor/core'

export type PickedDocument = {
  name: string
  mime: string
  size: number
  path: string
}

export type NativePickResult =
  | { kind: 'picked'; items: PickedDocument[] }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }

export type NativeSaveResult = 'saved' | 'cancelled' | 'failed' | 'unavailable'

let pending: ((result: NativePickResult) => void) | null = null
let pendingSave: ((result: NativeSaveResult) => void) | null = null

declare global {
  interface Window {
    __nativeDocumentsPicked?: (items: PickedDocument[]) => void
    __nativeDocumentsUnavailable?: () => void
    __nativeDocumentSaved?: () => void
    __nativeDocumentSaveCancelled?: () => void
    __nativeDocumentSaveFailed?: () => void
    __nativeDocumentSaveUnavailable?: () => void
  }
}

/** App 启动时调用一次：原生把选中的文件复制完，或导出保存结束，回传结果 */
export const setupNativeDocuments = () => {
  window.__nativeDocumentsPicked = (items) => {
    const settle = pending
    pending = null
    settle?.({ kind: 'picked', items: Array.isArray(items) ? items : [] })
  }
  window.__nativeDocumentsUnavailable = () => {
    const settle = pending
    pending = null
    settle?.({ kind: 'unavailable' })
  }
  const settleSave = (result: NativeSaveResult) => {
    const settle = pendingSave
    pendingSave = null
    settle?.(result)
  }
  window.__nativeDocumentSaved = () => settleSave('saved')
  window.__nativeDocumentSaveCancelled = () => settleSave('cancelled')
  window.__nativeDocumentSaveFailed = () => settleSave('failed')
  window.__nativeDocumentSaveUnavailable = () => settleSave('unavailable')
}

/** 只有安卓原生桥支持 SAF；iOS 与网页端继续走原来的 <input> */
export const canPickNativeDocuments = () =>
  Capacitor.getPlatform() === 'android' && typeof window.SystemBars?.pickDocuments === 'function'

/** 打开系统文档选择器。原生没有可用选择器时返回 unavailable，由调用方回退 */
export const pickNativeDocuments = (): Promise<NativePickResult> => {
  if (!window.SystemBars?.pickDocuments) {
    return Promise.resolve({ kind: 'unavailable' })
  }
  if (pending) {
    // 上一次选择器还没返回，避免重复打开
    return Promise.resolve({ kind: 'cancelled' })
  }
  return new Promise((resolve) => {
    pending = resolve
    try {
      // 必须带着桥接对象调用，不能把方法单独拆出来
      window.SystemBars?.pickDocuments?.()
    } catch {
      pending = null
      resolve({ kind: 'unavailable' })
    }
  })
}

/**
 * 读取原生缓存副本并立刻删除：用 convertFileSrc + fetch 拿 Blob，
 * 不走 base64，避免大文件在 JS 里多留一份字符串。
 */
export const readPickedDocument = async (picked: PickedDocument): Promise<File> => {
  try {
    const response = await fetch(Capacitor.convertFileSrc(picked.path))
    if (!response.ok) {
      throw new Error(`read attachment failed: ${String(response.status)}`)
    }
    const blob = await response.blob()
    return new File([blob], picked.name, {
      type: picked.mime || blob.type || 'application/octet-stream',
      lastModified: Date.now(),
    })
  } finally {
    window.SystemBars?.deleteCachedDocument?.(picked.path)
  }
}
/** 只有安卓原生桥支持系统「保存到」对话框 */
export const canSaveNativeDocument = () =>
  Capacitor.getPlatform() === 'android' && typeof window.SystemBars?.saveDocument === 'function'

/**
 * 让用户在系统「保存到」对话框里选位置（可选 Documents / 下载 / 网盘），
 * 原生把缓存 ZIP 复制过去；返回 unavailable 时由调用方回退到分享面板。
 */
export const saveNativeDocument = (
  sourcePath: string,
  name: string
): Promise<NativeSaveResult> => {
  if (!canSaveNativeDocument()) {
    return Promise.resolve('unavailable')
  }
  if (pendingSave) {
    return Promise.resolve('failed')
  }
  return new Promise((resolve) => {
    pendingSave = resolve
    try {
      // 必须带着桥接对象调用，不能把方法单独拆出来
      window.SystemBars?.saveDocument?.(sourcePath, name)
    } catch {
      pendingSave = null
      resolve('unavailable')
    }
  })
}