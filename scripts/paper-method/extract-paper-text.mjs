/**
 * 提取论文 PDF 的逐页正文（用于核对逐字引用与页码）
 * 用法： node scripts/paper-method/extract-paper-text.mjs [pdfPath] [outJson]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\//, '')
const pdfPath = process.argv[2] || join(ROOT, 'testpapers', 'DLinear-Are-Transformers-Effective.pdf')
const outPath = process.argv[3] || join(ROOT, 'papers', 'DLinear-pages.json')

if (!existsSync(pdfPath)) {
  console.error(`找不到 PDF：${pdfPath}`)
  process.exit(1)
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const data = new Uint8Array(readFileSync(pdfPath))
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
const pages = []
for (let i = 1; i <= doc.numPages; i += 1) {
  const page = await doc.getPage(i)
  const content = await page.getTextContent()
  const text = content.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim()
  pages.push({ page: i, text })
}
writeFileSync(outPath, JSON.stringify({ pdfPath, numPages: doc.numPages, pages }, null, 0), 'utf8')
console.log(`已提取 ${doc.numPages} 页 → ${outPath}`)
for (const p of pages.slice(0, 1)) console.log(`第 1 页开头：${p.text.slice(0, 220)}`)
