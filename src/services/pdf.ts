import type { PageText } from '@/types'

/**
 * 真实 PDF 解析（浏览器端，pdfjs-dist）
 * ------------------------------------------------------------------
 * 按页提取文字，保留 PDF 页序号 —— 页序号是后面「查看依据」能回到原文的前提。
 *
 * 会明确区分几种失败情况，不会把「读不到」说成「解析成功」：
 *   - 扫描件 / 图片型 PDF：整篇几乎没有可选中的文字 → 提示这是扫描件
 *   - 加密 PDF：需要密码 → 提示先解密
 *   - 文件损坏 / 非 PDF → 提示换文件
 *   - 部分页面无文字（可能是图表页）→ 作为提示返回，不影响其它页
 */

export interface PdfExtractResult {
  pageCount: number
  pages: PageText[]
  totalChars: number
  emptyPages: number[]
  warnings: string[]
}

export class PdfParseError extends Error {
  code: 'SCANNED' | 'ENCRYPTED' | 'CORRUPT' | 'UNSUPPORTED' | 'UNKNOWN'
  detail?: string
  constructor(code: PdfParseError['code'], message: string, detail?: string) {
    super(message)
    this.name = 'PdfParseError'
    this.code = code
    this.detail = detail
  }
}

/** 判断是否是「几乎没有文字」的页 */
const EMPTY_PAGE_CHARS = 20
/** 整篇少于这个字符数，基本可以判定为扫描件 */
const SCANNED_TOTAL_CHARS = 200

/**
 * pdfjs 的辅助资源目录（构建前由 scripts/copy-pdfjs-assets.mjs 复制到 public/pdfjs/）。
 * 用相对当前文档的路径，配合 vite 的 base: './'，无论部署在根路径还是子路径都能取到。
 *  - cmaps：CJK 等 CID 字体的编码映射，缺了会导致中文/日文 PDF 抽不出文字或乱码；
 *  - standard_fonts：未内嵌的标准字体，缺了个别符号会丢，控制台还会报警告。
 */
const PDFJS_ASSET_BASE = './pdfjs/'

let workerReady: Promise<void> | null = null
let pdfLib: typeof import('pdfjs-dist') | null = null

async function loadPdfLib() {
  if (!pdfLib) {
    pdfLib = await import('pdfjs-dist')
  }
  if (!workerReady) {
    workerReady = (async () => {
      // Vite 的 ?worker 会把 worker 打成独立文件，避免 CDN / workerSrc 路径问题
      const mod = await import('pdfjs-dist/build/pdf.worker.min.mjs?worker')
      const WorkerCtor = (mod as unknown as { default: new () => Worker }).default
      pdfLib!.GlobalWorkerOptions.workerPort = new WorkerCtor()
    })()
  }
  await workerReady
  return pdfLib!
}

/** 把一页的文字项拼成可读文本，尽量保留换行 */
function itemsToText(content: { items: unknown[] }): string {
  let out = ''
  let lastY: number | null = null
  for (const raw of content.items) {
    const item = raw as { str?: string; hasEOL?: boolean; transform?: number[] }
    if (typeof item.str !== 'string') continue
    const y = item.transform?.[5]
    if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 2) out += '\n'
    out += item.str
    if (item.hasEOL) out += '\n'
    if (typeof y === 'number') lastY = y
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export async function extractPdfPages(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<PdfExtractResult> {
  const lib = await loadPdfLib()
  const buffer = await file.arrayBuffer()

  let doc: Awaited<ReturnType<typeof lib.getDocument>['promise']> | null = null
  let task: ReturnType<typeof lib.getDocument> | null = null
  try {
    task = lib.getDocument({
      data: new Uint8Array(buffer),
      // 纯文本抽取不需要渲染字体
      disableFontFace: true,
      // CJK 等 CID 字体的编码映射 + 未内嵌标准字体（缺了会乱码/丢符号）
      cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
    })
    doc = await task.promise
  } catch (e) {
    const name = (e as { name?: string })?.name || ''
    const msg = e instanceof Error ? e.message : String(e)
    if (/password/i.test(name) || /password/i.test(msg)) {
      throw new PdfParseError(
        'ENCRYPTED',
        '这个 PDF 有打开口令（加密文件），无法解析。请先用阅读器去掉密码保护，另存一份再上传。',
        msg,
      )
    }
    if (/InvalidPDF|Invalid PDF/i.test(msg)) {
      throw new PdfParseError(
        'CORRUPT',
        '文件不是有效的 PDF，或者已经损坏。请确认上传的是完整的 PDF 文件。',
        msg,
      )
    }
    throw new PdfParseError('UNKNOWN', `解析 PDF 时出错：${msg}`, msg)
  }

  const pages: PageText[] = []
  const emptyPages: number[] = []
  const warnings: string[] = []

  try {
    const total = doc.numPages
    for (let i = 1; i <= total; i += 1) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const text = itemsToText(content as unknown as { items: unknown[] })
      if (text.length < EMPTY_PAGE_CHARS) emptyPages.push(i)
      pages.push({ page: i, text })
      page.cleanup()
      onProgress?.(i, total)
    }
  } finally {
    try {
      await task?.destroy()
    } catch {
      /* ignore */
    }
  }

  const totalChars = pages.reduce((n, p) => n + p.text.length, 0)

  if (totalChars < SCANNED_TOTAL_CHARS) {
    throw new PdfParseError(
      'SCANNED',
      '这份 PDF 里几乎读不到文字，很可能是扫描件（图片版）或纯截图导出的文件。当前版本只能处理文本型 PDF，需要先做 OCR 转成可选文字的 PDF。',
      `共 ${pages.length} 页，提取到 ${totalChars} 个字符`,
    )
  }

  if (emptyPages.length > 0) {
    warnings.push(
      `第 ${emptyPages.slice(0, 12).join('、')}${emptyPages.length > 12 ? ' 等' : ''} 页没有提取到文字（通常是图表页或扫描插图页），这些页面上的信息不会被抽取。`,
    )
  }

  return { pageCount: pages.length, pages, totalChars, emptyPages, warnings }
}

/** 给界面用的简述 */
export function describeExtract(result: PdfExtractResult): string {
  return `已读取 ${result.pageCount} 页，共 ${result.totalChars.toLocaleString('zh-CN')} 个字符`
}
