/**
 * 验证评估链路：证据位于**页面中后部**时，旧链路（层层截断）会不会丢掉它
 * ------------------------------------------------------------------
 * 做法：从 DLinear 论文某一页的中后部取一句真实原文，构造一条与它对应的事实主张，
 * 分别用三套证据池判定：
 *   1) 旧链路等效池：每页只取前 1400 字符（benchmark 旧实现）
 *   2) 新链路全文分块池：每页切成 1600 字符的块，无内容丢失
 * 输出两次判定的支持情况，用来证明链路修复有效。
 *
 * 用法：node scripts/probe-tail-evidence.mjs   （需要后端在 8788）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'

const dl = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cache', 'dlinear.json'), 'utf8'))
const af = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cache', 'autoformer.json'), 'utf8'))

// 找一页足够长的页，取它的**后半段**里的一句英文原句当证据
function pickTailSentence(pages) {
  for (const pg of pages) {
    const text = String(pg.text || '')
    if (text.length < 2600) continue
    const tail = text.slice(Math.floor(text.length * 0.65))
    const sents = tail.split(/(?<=[.!?])\s+/).filter((s) => /[a-z]/i.test(s) && s.trim().length > 60)
    if (sents.length > 0) {
      return { page: pg.page, sentence: sents[0].trim(), offset: Math.floor(text.length * 0.65) }
    }
  }
  return null
}
const pick = pickTailSentence(dl.pages) || pickTailSentence(af.pages)
if (!pick) {
  console.error('没有找到足够长的页面（需要 >2600 字符）')
  process.exit(1)
}
console.log(`选用证据：第 ${pick.page} 页、约 ${(pick.offset / 1000).toFixed(1)}k 字符之后（页面中后部）`)
console.log(`原句：${pick.sentence}`)

const claim = `根据论文正文，存在这样的表述：「${pick.sentence}」`
const paper = pick === (pickTailSentence(dl.pages) || pick) ? dl : af
const paperLabel = paper === dl ? 'U1' : 'U2'

// 旧链路等效池：每页只取前 1400 字符（旧 benchmark.mjs 的做法）
const oldPool = []
for (const p of [dl, af]) {
  for (const pg of p.pages) {
    const text = String(pg.text || '').trim()
    if (text.length < 80) continue
    oldPool.push({
      evidenceId: `old-${p === dl ? 'dlinear' : 'autoformer'}-p${pg.page}`,
      shortLabel: p.id === 'dlinear' ? 'U1' : 'U2',
      page: pg.page,
      quote: text.slice(0, 1400),
    })
  }
}
// 新链路全文分块池：无内容丢失
const CHUNK = 1600
const newPool = []
for (const p of [dl, af]) {
  for (const pg of p.pages) {
    const text = String(pg.text || '').trim()
    if (text.length < 80) continue
    const n = Math.ceil(text.length / CHUNK)
    for (let i = 0; i < n; i += 1) {
      newPool.push({
        evidenceId: `full-${p === dl ? 'dlinear' : 'autoformer'}-p${pg.page}-${i + 1}of${n}`,
        shortLabel: p.id === 'dlinear' ? 'U1' : 'U2',
        page: pg.page,
        quote: text.slice(i * CHUNK, (i + 1) * CHUNK),
      })
    }
  }
}

// 先在本地确认两句：这句话在两个池子里分别能不能被逐字找到（这决定模型有没有机会看到它）
const inOld = oldPool.some((e) => e.quote.includes(pick.sentence))
const inNew = newPool.some((e) => e.quote.includes(pick.sentence))
console.log(`\n本地核对：这句话在旧池（每页前 1400 字）里 ${inOld ? '存在' : '【不存在，会被判无依据】'}；在新池（全文分块）里 ${inNew ? '存在' : '不存在'}`)

const judge = async (pool, label) => {
  const res = await fetch(`${API_BASE}/api/bench/judge-claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ claims: [claim], evidence: pool }),
  })
  const json = await res.json()
  if (!json.ok) {
    console.log(`${label}：判定调用失败 —— ${json.message || '未知'}`)
    return
  }
  const j = json.judgements[0]
  console.log(`${label}：support=${j.support}｜理由：${j.reason}`)
  console.log(`   命中的证据：${(j.evidenceIds || []).join(', ') || '（无）'}`)
}

console.log(`\n证据池规模：旧池 ${oldPool.length} 条；新池 ${newPool.length} 条`)
await judge(oldPool, `旧链路判定（${paperLabel}）`)
await judge(newPool, `新链路判定（${paperLabel}）`)
