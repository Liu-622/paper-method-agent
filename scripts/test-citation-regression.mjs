/**
 * 引文排版归一化的有限回归：不调用模型，只对「上次判定为 unlocated 的引文」
 * 重新用 verifyQuote 定位，看边界归一化后能找回多少、以哪种方式，并抽查归一化不破坏数字/否定。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyQuote, normalizeText } from '../server/llm.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public', 'catalog-pages.json'), 'utf8'))
const pagesBy = {}
for (const p of catalog.papers ?? []) pagesBy[p.id] = p.pages

const resDir = path.join(root, 'docs', 'results', 'analyze-v2')
const lines = []

// 1) 归一化安全性抽查：不能删负号/数字/小数点/否定词/数学符号
const safety = [
  ['10^-4', '10-4', '幂写法'],
  ['3.14', '3.14', '小数点'],
  ['not independent', 'not', '否定词'],
  ['-0.0443', '-0.0443', '负号'],
  ['ε', 'ε', '数学符号保留'],
]
lines.push('=== 归一化安全性（normalizeText 后仍应包含右边的关键子串）===')
for (const [inp, must, label] of safety) {
  const n = normalizeText(inp)
  lines.push(`  ${label}: ${n.includes(must) ? 'OK' : 'FAIL'}  (normalizeText('${inp}') = '${n}')`)
}

// 2) 上次 unlocated 的引文回归
lines.push('')
lines.push('=== unlocated 引文回归 ===')
let totalUnlocated = 0
let recovered = 0
const byMethod = { exact: 0, fragment: 0, loose: 0 }
for (const f of fs.readdirSync(resDir).filter((x) => x.endsWith('.json') && x !== 'summary.json')) {
  const r = JSON.parse(fs.readFileSync(path.join(resDir, f), 'utf8'))
  const pages = pagesBy[r.paperId]
  if (!pages) continue
  for (const key of ['family', 'mechanisms', 'tasks', 'differences', 'limitations', 'futureWork', 'relations']) {
    for (const it of r[key] ?? []) {
      if (it.citationLocated !== false || !it.quote) continue
      totalUnlocated += 1
      const res = verifyQuote(pages, Number(it.page) || null, it.quote)
      if (res.ok) {
        recovered += 1
        byMethod[res.method] += 1
        if (recovered <= 12) {
          lines.push(`  找回 ${r.paperId}/${key}: ${res.method} p.${res.page} :: ${it.quote.slice(0, 70)}`)
        }
      }
    }
  }
}
lines.push(`  合计上次 unlocated ${totalUnlocated} 条，本次找回 ${recovered} 条（exact ${byMethod.exact} / fragment ${byMethod.fragment} / loose ${byMethod.loose}）`)

fs.writeFileSync(path.join(root, 'docs', 'results', 'citation-regression.md'), lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
