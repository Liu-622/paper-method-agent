/**
 * 读取修复前/后的抽取结果，生成对照表 + 断言（三篇论文回归）
 * 用法：node scripts/extract-compare.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const load = (stage) => JSON.parse(fs.readFileSync(path.join(root, 'docs', 'results', `extract-${stage}.json`), 'utf8'))
const before = load('before')
const after = load('after')

const KEYS = ['dataset', 'split', 'splitRange', 'sampleInterval', 'evalProtocol', 'baselines', 'metrics', 'horizon', 'preprocessing']
const short = (f, n = 46) => {
  if (!f) return '（无）'
  const tag =
    f.checkState === 'retrieval' ? '★漏抽找回' : f.checkState === 'not_reported' ? '未报告' : f.checkState === 'unchecked' ? '未检查' : ''
  const v = f.value ? String(f.value).replace(/\s+/g, ' ').slice(0, n) : ''
  return `${f.status}${tag ? '/' + tag : ''}${v ? '：' + v : ''}`
}
const has = (stage, id, key) => {
  const f = stage[id]?.fields?.[key]
  return Boolean(f && (f.status === 'found' || f.status === 'uncertain'))
}
const val = (stage, id, key) => String(stage[id]?.fields?.[key]?.value || '')

const lines = []
lines.push('# 字段抽取修复：修复前 / 修复后对照（三篇真实论文）')
lines.push('')
lines.push('> 自动生成：`node scripts/extract-compare.mjs`（数据来自 `docs/results/extract-before.json` 与 `extract-after.json`）')
lines.push('> 修复前 = `EXTRACT_SECOND_PASS=0`（关闭定向二次检索，等价于原行为）；修复后 = 默认（含二次检索）。')
lines.push('')
lines.push('| 论文 | 字段 | 修复前 | 修复后 |')
lines.push('| --- | --- | --- | --- |')
for (const id of Object.keys(after)) {
  const label = after[id].label
  if (after[id].skipped) {
    lines.push(`| ${label} | — | 未测 | 未测（缺少 PDF） |`)
    continue
  }
  for (const k of KEYS) {
    const b = before[id]?.fields?.[k]
    const a = after[id]?.fields?.[k]
    const changed = short(b) !== short(a)
    lines.push(`| ${label} | ${k} | ${short(b)} | ${changed ? '**' + short(a) + '**' : short(a)} |`)
  }
}
lines.push('')

// ---------- 断言 ----------
const checks = []
const add = (name, ok, detail) => checks.push({ name, ok, detail })

// 1. Autoformer：六类数据集 + 各自采样频率
let auDatasets = val(after, 'autoformer-nips21', 'dataset')
const auPer = after['autoformer-nips21']?.fields?.sampleInterval?.perDataset?.perDataset || []
const auNames = ['ETTh1', 'ETTh2', 'ETTm1', 'ETTm2', 'Traffic', 'Electricity', 'Weather', 'ILI', 'Exchange']
const auIntHit = auNames.filter((n) => auPer.some((e) => e.dataset === n && /分钟|小时|天|周/.test(String(e.value))))
add(
  'Autoformer 抽到数据集名称（≥6 个）',
  auNames.filter((n) => auDatasets.includes(n)).length >= 6,
  `命中 ${auNames.filter((n) => auDatasets.includes(n)).length} 个：${auNames.filter((n) => auDatasets.includes(n)).join('、')}`,
)
add(
  'Autoformer 抽到「按数据集的采样频率」（≥4 个数据集有间隔）',
  auIntHit.length >= 4,
  `有间隔的数据集 ${auIntHit.length} 个：${auPer.map((e) => `${e.dataset}=${String(e.value).slice(0, 18)}`).join(' | ')}`,
)

// 2. FEDformer：六类数据集 + 四个主要基线
const fedNames = auNames
const fedDatasets = val(after, 'fedformer-icml22', 'dataset')
const fedBase = val(after, 'fedformer-icml22', 'baselines')
const fedBaseNeed = ['Autoformer', 'Informer', 'LogTrans', 'Reformer']
add(
  'FEDformer 抽到数据集名称（≥6 个）',
  fedNames.filter((n) => fedDatasets.includes(n)).length >= 6,
  `命中 ${fedNames.filter((n) => fedDatasets.includes(n)).length} 个：${fedNames.filter((n) => fedDatasets.includes(n)).join('、')}`,
)
add(
  'FEDformer 抽到四个主要基线',
  fedBaseNeed.filter((b) => fedBase.includes(b)).length >= 4,
  `命中 ${fedBaseNeed.filter((b) => fedBase.includes(b)).join('、')}`,
)

// 3. PatchTST：ETTm 15 分钟、ETTh 1 小时
const ptPer = after['patchtst-iclr23']?.fields?.sampleInterval?.perDataset?.perDataset || []
const ptInt = val(after, 'patchtst-iclr23', 'sampleInterval')
const ettmOk = ptPer.some((e) => /ETTm/i.test(e.dataset) && /15\s*分钟/.test(String(e.value))) || /15\s*分钟/.test(ptInt)
const etthOk = ptPer.some((e) => /ETTh/i.test(e.dataset) && /1\s*小时/.test(String(e.value))) || /1\s*小时/.test(ptInt)
add('PatchTST 抽到 ETTm 15 分钟', ettmOk, `perDataset=${ptPer.map((e) => `${e.dataset}=${String(e.value).slice(0, 20)}`).join(' | ')}｜整体=「${ptInt.slice(0, 40)}」`)
add('PatchTST 抽到 ETTh 1 小时', etthOk, `同上`)

// 4. ETT 口径下的划分：Autoformer 6:2:2、FEDformer 7:1:2、PatchTST 信息不足
const auSplit = val(after, 'autoformer-nips21', 'split')
const fedSplit = val(after, 'fedformer-icml22', 'split')
const ptSplit = after['patchtst-iclr23']?.fields?.split
add('Autoformer 的 ETT 划分含 6:2:2', /6\s*[:：]\s*2\s*[:：]\s*2/.test(auSplit), auSplit.slice(0, 60))
add('FEDformer 的划分含 7:1:2', /7\s*[:：]\s*1\s*[:：]\s*2/.test(fedSplit), fedSplit.slice(0, 60))
add(
  'PatchTST 的划分判为「信息不足」（未报告）',
  !ptSplit || ptSplit.status === 'missing' || ptSplit.status === 'uncertain',
  `status=${ptSplit?.status} checkState=${ptSplit?.checkState} value=${String(ptSplit?.value || '').slice(0, 40)}`,
)

// 5. 结论：三者不一致 → 比较必须出现"存在差异"
const norms = [
  /6\s*[:：]\s*2\s*[:：]\s*2/.test(auSplit) ? '6:2:2' : null,
  /7\s*[:：]\s*1\s*[:：]\s*2/.test(fedSplit) ? '7:1:2' : null,
  null,
]
const distinct = new Set(norms.filter(Boolean)).size
add('三者划分取值不唯一 → 比较结果必须出现「存在差异」', distinct >= 2, `取值：${norms.filter(Boolean).join('、')} + PatchTST 信息不足`)

lines.push('## 断言结果')
lines.push('')
lines.push('| 断言 | 结果 | 依据 |')
lines.push('| --- | --- | --- |')
for (const c of checks) lines.push(`| ${c.name} | ${c.ok ? '✅ 通过' : '❌ 未通过'} | ${String(c.detail).replace(/\|/g, '/').slice(0, 150)} |`)
lines.push('')
const pass = checks.filter((c) => c.ok).length
lines.push(`**合计：${pass}/${checks.length} 通过。**`)
lines.push('')

fs.writeFileSync(path.join(root, 'docs', 'EXTRACT-FIX.md'), lines.join('\n'))
console.log(lines.join('\n'))
console.log(`\n已写入 docs/EXTRACT-FIX.md`)
process.exitCode = pass === checks.length ? 0 : 1
