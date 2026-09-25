/**
 * 原文件本地存储（IndexedDB）
 * ------------------------------------------------------------------
 * localStorage 只能存文本，放不下 PDF 二进制；IndexedDB 可以。
 * 于是：解析出的正文文本、字段与证据仍放 localStorage（读取快、便于调试），
 *       上传的 PDF 原文件放 IndexedDB，用于「刷新后直接重新解析，不用再选一次文件」。
 *
 * 设计约束：
 *  - 全部操作都可能失败（隐私模式、配额不足、浏览器禁用），失败时**不抛异常打断流程**，
 *    只返回 false/null，由上层如实告知用户「原文件没有保存」。
 *  - 删除论文 / 重置数据时必须一起清理，避免用户以为删掉了但文件还在。
 */

const DB_NAME = 'paper-repro-guard-files'
const DB_VERSION = 1
const STORE = 'pdf'

function canUseIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('无法打开本地文件库'))
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error || new Error('本地文件库操作失败'))
      }),
  )
}

export interface StoredFileMeta {
  name: string
  size: number
  savedAt: string
  type: string
}

/** 保存原文件；成功返回 true，失败（隐私模式/配额不足）返回 false */
export async function saveOriginalFile(paperId: string, file: File): Promise<boolean> {
  if (!canUseIndexedDb()) return false
  try {
    const buffer = await file.arrayBuffer()
    await tx('readwrite', (store) =>
      store.put(
        { buffer, meta: { name: file.name, size: file.size, savedAt: new Date().toISOString(), type: file.type } },
        paperId,
      ),
    )
    return true
  } catch {
    dbPromise = null
    return false
  }
}

/** 取回原文件（还原成 File，便于复用同一套解析流程） */
export async function loadOriginalFile(paperId: string): Promise<File | null> {
  if (!canUseIndexedDb()) return null
  try {
    const rec = await tx<{ buffer: ArrayBuffer; meta: StoredFileMeta } | undefined>('readonly', (store) =>
      store.get(paperId),
    )
    if (!rec || !rec.buffer) return null
    return new File([rec.buffer], rec.meta?.name || `${paperId}.pdf`, {
      type: rec.meta?.type || 'application/pdf',
      lastModified: rec.meta?.savedAt ? new Date(rec.meta.savedAt).getTime() : Date.now(),
    })
  } catch {
    return null
  }
}

export async function removeOriginalFile(paperId: string): Promise<void> {
  if (!canUseIndexedDb()) return
  try {
    await tx('readwrite', (store) => store.delete(paperId))
  } catch {
    /* 忽略：清理失败不影响主流程，但用户重置时会重新尝试 */
  }
}

export async function clearOriginalFiles(): Promise<void> {
  if (!canUseIndexedDb()) return
  try {
    await tx('readwrite', (store) => store.clear())
  } catch {
    /* 忽略 */
  }
}

export async function hasOriginalFile(paperId: string): Promise<boolean> {
  if (!canUseIndexedDb()) return false
  try {
    const key = await tx<IDBValidKey | undefined>('readonly', (store) => store.getKey(paperId))
    return key !== undefined
  } catch {
    return false
  }
}

/** 本地占用的估算值（不精确，用于在设置里如实展示） */
export async function estimateLocalUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null
    const est = await navigator.storage.estimate()
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 }
  } catch {
    return null
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
