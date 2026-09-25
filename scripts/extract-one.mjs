/**
 * 抽取一篇 PDF 的字段并缓存成 JSON（benchmark 与人工核对用）
 * 用法：node scripts/extract-one.mjs testpapers/xxx.pdf benchmark/cache/xxx.json
 */
import fs from 'node:fs'
import path from 'node:path'

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const [, , pdfPath, outPath] = process.argv
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('用法：node scripts/extract-one.mjs <pdf> <out.json>')
  process.exit(1)
}
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'

const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)) }).promise
const pages = []
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
  pages.push({ page: i, text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() })
}

const fileName = path.basename(pdfPath)
console.log(`PDF ${fileName}：${pages.length} 页`)
const t0 = Date.now()
const res = await fetch(`${API_BASE}/api/extract`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fileName, title: fileName, pages }),
})
const json = await res.json()
if (!json.ok) {
  console.error('抽取失败：', JSON.stringify(json).slice(0, 400))
  process.exit(1)
}

const out = { fileName, pages, extract: json, extractedAt: new Date().toISOString() }
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`已写入 ${outPath}`)
}

console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s；覆盖：已送模型第 ${json.coverage.usedPages.join(',')} 页，未送 ${json.coverage.skippedPages.join(',') || '（无）'}，无文字页 ${json.coverage.emptyPages.join(',') || '（无）'}`)
console.log('字段：')
for (const [k, f] of Object.entries(json.fields || {})) {
  console.log(`  ${k.padEnd(16)} ${String(f.status).padEnd(9)} support=${f.support || '-'}  ${f.value ? String(f.value).slice(0, 90) : ''}`)
}
