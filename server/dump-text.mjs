/** 在小工具：把 PDF 文本导出来，用于核对某个信息到底在不在论文里 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const file = process.argv[2]
const patterns = (process.argv[3] || 'learning rate|1e-4|10−4|10 -4|Adam|optimizer|seed').split('|')

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const data = new Uint8Array(fs.readFileSync(file))
const task = pdfjs.getDocument({ data, useSystemFonts: false })
const doc = await task.promise
const out = []
for (let i = 1; i <= doc.numPages; i += 1) {
  const page = await doc.getPage(i)
  const content = await page.getTextContent()
  let text = ''
  let lastY = null
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue
    const y = item.transform?.[5]
    if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 2) text += '\n'
    text += item.str
    if (item.hasEOL) text += '\n'
    if (typeof y === 'number') lastY = y
  }
  out.push({ page: i, text: text.replace(/\s+/g, ' ').trim() })
  page.cleanup()
}
try {
  await task.destroy()
} catch {
  /* ignore */
}

fs.writeFileSync(path.join(root, '_pdftext.json'), JSON.stringify(out, null, 1), 'utf8')

const lines = []
for (const p of out) {
  for (const pat of patterns) {
    const re = new RegExp(pat, 'gi')
    let m
    while ((m = re.exec(p.text)) !== null) {
      const start = Math.max(0, m.index - 90)
      lines.push(`p.${p.page} [${pat}] …${p.text.slice(start, m.index + 120)}…`)
      if (lines.length > 60) break
    }
  }
}
fs.writeFileSync(path.join(root, '_pdfhits.txt'), lines.join('\n'), 'utf8')
console.log(`页数 ${out.length}；命中 ${lines.length} 处，已写入 _pdfhits.txt`)
