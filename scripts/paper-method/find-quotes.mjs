/**
 * 在提取出的论文正文里定位需要的逐字引用（含页码）
 * 用法： node scripts/paper-method/find-quotes.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\//, '')
const data = JSON.parse(readFileSync(join(ROOT, 'papers', 'DLinear-pages.json'), 'utf8'))
const pages = data.pages

const patterns = [
  /decomposition/i,
  /moving average/i,
  /Trend-?[Ss]easonal/i,
  /we propose/i,
  /ETTm2/i,
  /0\.167|0\.168|0\.26\b|0\.262/,
  /multivariate/i,
]

const hits = {}
for (const p of pages) {
  for (const re of patterns) {
    const key = re.source
    if (!re.test(p.text)) continue
    const idx = p.text.search(re)
    const start = Math.max(0, idx - 160)
    const snippet = p.text.slice(start, Math.min(p.text.length, idx + 260))
    if (!hits[key]) hits[key] = []
    if (hits[key].length < 3) hits[key].push(`  [第 ${p.page} 页] …${snippet}…`)
  }
}

for (const [key, list] of Object.entries(hits)) {
  console.log(`\n### ${key}`)
  list.forEach((l) => console.log(l))
}

// 找表格里的 ETTm2 列
const tablePage = pages.find((p) => /ETTm2/.test(p.text))
if (tablePage) {
  const i = tablePage.text.indexOf('ETTm2')
  console.log(`\n### ETTm2 表格附近（第 ${tablePage.page} 页）`)
  console.log('…' + tablePage.text.slice(Math.max(0, i - 300), i + 700) + '…')
}
