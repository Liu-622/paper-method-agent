/**
 * 验证「规则推导」的可信度门禁（真实调用一次问答）
 * - 带 ruleId 的检查项 → 结论应为 rule，并带 ruleId / 输入字段 / 结果
 * - 没有对应规则的模型推论 → 结论应为 suggestion（建议 / 待验证）
 * 用法：node scripts/probe-rule-claim.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const out = path.join(root, 'node_modules', '.cache', 'bench-entry.mjs')
await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'bench-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})
const { analyze } = await import(new URL(`file://${out.replace(/\\/g, '/')}`).href)
const { ruleMetaOf } = await import(
  new URL(`file://${path.join(root, 'node_modules', '.cache', 'rules.mjs').replace(/\\/g, '/')}`).href
).catch(() => ({ ruleMetaOf: () => null }))
void ruleMetaOf

const load = (n, short) => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cache', `${n}.json`), 'utf8'))
  return { id: n, shortLabel: short, fileName: j.fileName, title: j.fileName, pages: j.pages, fields: j.extract.fields, coverage: j.extract.coverage }
}
const dlinear = load('dlinear', 'U1')
const autoformer = load('autoformer', 'U2')
const scope = 'Traffic'
const tool = analyze([dlinear, autoformer], [scope])

const checks = tool.fairnessByScope[scope]
  .filter((f) => f.key !== 'method')
  .map((f) => ({
    id: f.id,
    key: String(f.key),
    label: f.label,
    ruleId: f.ruleId,
    scope: f.scope ?? null,
    verdict: f.verdict,
    verdictText: f.verdict === 'consistent' ? '条件一致' : f.verdict === 'different' ? '存在差异' : '信息不足',
    reason: f.reason,
    perPaper: f.perPaper.map((p) => ({
      paperId: p.paperId,
      label: p.paperId === 'dlinear' ? 'U1' : 'U2',
      value: p.value,
      evidenceIds: p.evidenceIds,
    })),
  }))

const res = await fetch(`${API_BASE}/api/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    question: '在 Traffic 这个数据集上，两篇论文的实验条件可以直接比较吗？',
    papers: [dlinear, autoformer].map((p) => ({ id: p.id, shortLabel: p.shortLabel, title: p.title, pages: p.pages })),
    context: { paperCount: 2, datasetScope: scope, checks },
  }),
})
const json = await res.json()
console.log('ok =', json.ok, '｜耗时', json.elapsedMs, 'ms')
if (!json.ok) {
  console.log(JSON.stringify(json).slice(0, 300))
  process.exit(1)
}
console.log('\n结论（来源 / 支持 / 规则编号）：')
for (const c of json.claims || []) {
  console.log(`  [${c.source}/${c.support}]${c.derivation ? ' 规则=' + c.derivation.ruleId : ''} ${String(c.text).slice(0, 60)}`)
  if (c.derivation) {
    console.log(`      输入字段：${c.derivation.inputs.map((x) => `${x.paperLabel} ${x.label}=${x.value}`).join('；').slice(0, 120)}`)
    console.log(`      结果：${c.derivation.result}`)
  }
}
console.log('\n撤回的结论：', (json.withdrawn || []).length)
;(json.withdrawn || []).forEach((w) => console.log('  - ' + String(w.text).slice(0, 70)))
console.log('警告：', (json.warnings || []).join(' | '))
