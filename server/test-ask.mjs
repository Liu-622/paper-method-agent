/**
 * 只测问答链路（抽取很贵，这里跳过）
 * 用法：node server/test-ask.mjs <pdf> ["问题"]
 * 会把 PDF 文本提取出来直接 POST /api/ask，打印：
 *   - 每条结论的原文支持判定（full/partial/none）与撤回情况
 *   - 引用校验结果
 * 便于单独调试「结论是否被原文支持」这一步。
 */
import fs from 'node:fs'
import path from 'node:path'

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const pdfPath = process.argv[2]
const question = process.argv[3] || '这几篇论文的实验结果能直接比较吗？'
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('用法：node server/test-ask.mjs <pdf> ["问题"]')
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

const name = path.basename(pdfPath)
console.log(`PDF：${name}（${pages.length} 页）`)
console.log(`问题：${question}`)
console.log('')

const t0 = Date.now()
const res = await fetch(`${API_BASE}/api/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    question,
    papers: [{ id: 'p1', shortLabel: 'P1', title: name, pages }],
  }),
})
const json = await res.json()
if (!json.ok) {
  console.error('请求失败：', JSON.stringify(json).slice(0, 500))
  process.exit(1)
}

console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，引用 ${json.citations.length} 条`)
console.log('警告：')
;(json.warnings || []).forEach((w) => console.log(`  - ${w}`))
console.log('')
console.log(`结论 ${json.claims?.length ?? 0} 条（撤回 ${json.withdrawn?.length ?? 0} 条）：`)
;(json.claims || []).forEach((c) => {
  console.log(`  [${c.support}] ${c.kind}｜${c.text.slice(0, 80)}`)
  if (c.reason) console.log(`        理由：${c.reason}`)
})
;(json.withdrawn || []).forEach((w) => console.log(`  已撤回：${w.text.slice(0, 80)}  ← ${w.reason}`))
