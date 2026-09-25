/**
 * 把 pdfjs 的 cMaps 与标准字体复制到 public/pdfjs/
 * ------------------------------------------------------------------
 * 为什么需要：
 *  - cMaps：处理 CJK（中日韩）等 CID 字体的编码映射，缺了会导致中文/日文 PDF 抽不出文字或乱码；
 *  - standard_fonts：处理未内嵌的标准字体（Helvetica / Times 等），缺了 pdfjs 会报
 *    "Ensure that the standardFontDataUrl API parameter is provided"，个别符号会丢。
 * 这两个资源都在 pdfjs-dist 包里，构建前复制一次即可，运行时从本站读取（不依赖外网 CDN）。
 *
 * 用法：node scripts/copy-pdfjs-assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const src = path.join(root, 'node_modules', 'pdfjs-dist')
const dest = path.join(root, 'public', 'pdfjs')

const jobs = [
  { from: path.join(src, 'cmaps'), to: path.join(dest, 'cmaps'), label: 'cMaps' },
  { from: path.join(src, 'standard_fonts'), to: path.join(dest, 'standard_fonts'), label: '标准字体' },
]

let copied = 0
let skipped = 0

for (const job of jobs) {
  if (!fs.existsSync(job.from)) {
    console.warn(`[pdfjs-assets] 跳过 ${job.label}：未找到 ${job.from}`)
    skipped += 1
    continue
  }
  fs.mkdirSync(job.to, { recursive: true })
  const files = fs.readdirSync(job.from)
  for (const f of files) {
    const s = path.join(job.from, f)
    const d = path.join(job.to, f)
    if (!fs.statSync(s).isFile()) continue
    // 已存在且大小一致就不重复复制
    if (fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size) continue
    fs.copyFileSync(s, d)
    copied += 1
  }
  console.log(`[pdfjs-assets] ${job.label} → public/pdfjs/${path.basename(job.to)}（共 ${files.length} 个文件）`)
}

if (copied === 0 && skipped === 0) {
  console.log('[pdfjs-assets] 资源已是最新，无需复制')
} else {
  console.log(`[pdfjs-assets] 完成：新复制 ${copied} 个文件，跳过 ${skipped} 项`)
}
