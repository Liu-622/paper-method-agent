import type { Paper, UploadIssue } from '@/types'
import { UPLOAD_RULES } from '@/config'

/**
 * 论文解析接口（本轮为「接入中」状态）
 * ------------------------------------------------------------------
 * 现在这里做两件真实的事：
 *  1. 上传校验：文件类型、大小、重复、数量上限 —— 这些提示都是真实可用的；
 *  2. 生成论文条目：保留真实文件名、大小、修改时间，状态置为「待解析」。
 *
 * 还没有做的事（后续替换本文件即可，页面不用改）：
 *  - 读取 PDF 文本（pdf.js / 服务端解析）
 *  - 切分章节、抽取字段、记录 PDF 页码
 *  - 把字段写入 paper.fields
 */

export interface UploadMeta {
  fileName: string
  fileSize: number
  fileLastModified: number | null
}

export interface ValidationResult {
  accepted: UploadMeta[]
  issues: UploadIssue[]
}

function extOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx >= 0 ? name.slice(idx).toLowerCase() : ''
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 上传校验：格式 / 大小 / 空文件 / 数量上限。重复判定不在这里做（见 uploadFiles 的字节指纹去重）。 */
export function validateFiles(files: File[], existing: Paper[]): ValidationResult {
  const accepted: UploadMeta[] = []
  const issues: UploadIssue[] = []
  let batchCount = 0

  for (const file of files) {
    const meta: UploadMeta = {
      fileName: file.name,
      fileSize: file.size,
      fileLastModified: file.lastModified ?? null,
    }

    if (file.size === 0) {
      issues.push({
        fileName: file.name,
        type: 'empty',
        message: '文件内容为空（0 字节），无法上传。',
      })
      continue
    }

    if (!UPLOAD_RULES.allowedExtensions.includes(extOf(file.name))) {
      issues.push({
        fileName: file.name,
        type: 'rejected-format',
        message: `格式不支持：目前只接受 ${UPLOAD_RULES.allowedExtensions.join('、')} 文件，请把 Word / 图片 / 网页另存为 PDF 后再上传。`,
      })
      continue
    }

    if (file.size > UPLOAD_RULES.maxFileSize) {
      issues.push({
        fileName: file.name,
        type: 'rejected-size',
        message: `文件过大：${formatFileSize(file.size)}，超过单文件上限 ${UPLOAD_RULES.maxFileSizeLabel}。可以先压缩图片或只截取需要的章节。`,
      })
      continue
    }

    if (batchCount >= UPLOAD_RULES.maxFilesPerBatch) {
      issues.push({
        fileName: file.name,
        type: 'rejected-size',
        message: `单次最多上传 ${UPLOAD_RULES.maxFilesPerBatch} 个文件，本批次后续文件已跳过。`,
      })
      continue
    }

    batchCount += 1
    accepted.push(meta)
  }

  return { accepted, issues }
}

/** 由文件名猜一个可读标题，避免列表里全是下划线文件名 */
export function guessTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '')
  return base.replace(/[_-]+/g, ' ').trim() || fileName
}

/** 创建「排队中」的论文条目（紧接着会进入真实解析） */
export function createPendingPaper(meta: UploadMeta, seq: number, uploadedAt: string): Paper {
  return {
    id: `user-${Date.now()}-${seq}`,
    source: 'user',
    shortLabel: `U${seq}`,
    fileName: meta.fileName,
    fileSize: meta.fileSize,
    fileLastModified: meta.fileLastModified,
    title: guessTitle(meta.fileName),
    authors: '—',
    year: null,
    venue: '—',
    status: 'pending',
    uploadedAt,
    parseMessage: '排队中，马上开始读取正文…',
    fields: {},
  }
}

/** 上传完成后的统一提示 */
export function requestParseNote(): { title: string; detail: string } {
  return {
    title: '解析流程已结束',
    detail:
      '正文文本、字段与原文片段保存在本地；上传的原文件也保存在本地（IndexedDB），刷新后可以点「用原文件重跑」直接重新解析，不必再选文件。若保存原文件时浏览器配额不足，界面会明确提示。',
  }
}

/** 文件内容是否已经可以读取 */
export function canReadFileContent(paper: Paper): boolean {
  return paper.status === 'parsed' || paper.status === 'text-only'
}

/**
 * 论文是否需要用户重新选择文件：
 * 本地既没有正文文本，也没有保存下来的原文件（换机器、清了站点数据、配额不足）。
 */
export function needsFileReselection(paper: Paper): boolean {
  return paper.source === 'user' && !paper.textStored && !paper.fileStored
}

/** 当前解析能力说明，展示在论文库顶部 */
export const PARSER_CAPABILITY_NOTE =
  '上传后会在浏览器里真实读取 PDF 正文（按页保留页码），再交给模型抽取字段与证据。字段旁边的「查看依据」给出的都是这份 PDF 里的真实原文片段与页序号。'
