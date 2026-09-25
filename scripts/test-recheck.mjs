/**
 * 单字段补查的无模型测试（不消耗模型调用）：
 *  1) 未知字段必须直接报错
 *  2) 正文里没有相关内容时 → 如实返回 missing，并说明"本次未找到"（不是编造）
 *  3) 空正文 → 不抛异常，返回 missing
 * 运行： node scripts/test-recheck.mjs
 */
import { recheckField, retrieveCandidates } from '../server/llm.mjs'

let pass = 0
let fail = 0
const lines = []
const check = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    lines.push(`[PASS] ${name}`)
  } else {
    fail += 1
    lines.push(`[FAIL] ${name} ${extra}`)
  }
}

const unrelated = [
  { page: 1, text: 'This paper studies bird migration patterns in the northern hemisphere over three decades.' },
  { page: 2, text: 'We thank our reviewers for their constructive feedback and the anonymous volunteers.' },
]

let threw = false
try {
  await recheckField({ pages: unrelated, key: 'notAField', fileName: 'x.pdf' })
} catch {
  threw = true
}
check('未知字段直接报错（不会静默返回空结果）', threw)

const noCandidates = await recheckField({ pages: unrelated, key: 'learningRate', fileName: 'x.pdf' })
check('正文无相关内容 → status=missing', noCandidates.status === 'missing', JSON.stringify(noCandidates.status))
check('未命中时明确说明"本次未找到"且不等于原文没写', /不等于原文|没有找到/.test(noCandidates.note || ''), noCandidates.note)
check('未命中时不返回任何取值', noCandidates.value === null, String(noCandidates.value))
check('未命中时不返回证据（不编造引用）', Array.isArray(noCandidates.evidence) && noCandidates.evidence.length === 0)

const noPages = await recheckField({ pages: [], key: 'split', fileName: 'x.pdf' })
check('空正文不抛异常，返回 missing', noPages.status === 'missing', String(noPages.status))

const cands = retrieveCandidates(
  [{ page: 1, text: 'Experiments are conducted on ETTm2 with a learning rate of 0.0001 for all models.' }],
  'learningRate',
  16,
)
check('定向检索能在正文里找到候选片段（有候选才会走模型复核）', cands.length > 0, `candidates=${cands.length}`)

lines.push('')
lines.push(`结果：通过 ${pass} 项，失败 ${fail} 项`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
