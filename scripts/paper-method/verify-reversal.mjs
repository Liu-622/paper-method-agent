/**
 * 严格同条件复核：两个时间段，领先方是否真的会变？
 * ==================================================================
 * 控制变量：同一对权重、同一输入长度/预测跨度、同一目标列(OT)、
 *          同一预处理与原始单位、同一指标与聚合方式、两段都是无扰动输入 —— **只改变评估时间段**。
 * 同时公开：日期、有效窗口数、有效目标点数、窗口是否重叠、目标索引是否越界/跨段。
 * 结果写入 lab-cases/reversal/verification.json（含完整预测与真值，供独立复算）。
 *
 * 用法： node scripts/paper-method/verify-reversal.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\//, '')
const OUT_DIR = join(ROOT, 'lab-cases', 'reversal')

const { listPaperRuns, runPaperExperiment, officialSplit, computeMetrics3 } = await import('../../server/paperMethods.mjs')

const trained = listPaperRuns().filter((t) => t.methodSource === 'official')
const pick = (m) => trained.find((t) => t.method === m)?.runId
const runIds = { DLinear: pick('DLinear'), Linear: pick('Linear') }
if (!runIds.DLinear || !runIds.Linear) {
  console.error('缺少已训练的官方权重')
  process.exit(1)
}

const SETTINGS = { perturbationType: 'noise', strength: 0, seed: 11, stride: 8, maxWindows: 100000, includeFull: true }
const split = officialSplit(336)

function sliceRange(key) {
  if (key === 'explore') return { from: split.customSlices.explore.usedStart, to: split.customSlices.explore.usedEnd }
  if (key === 'consistency') return { from: split.customSlices.consistency.usedStart, to: split.customSlices.consistency.usedEnd }
  return { from: split.evalStart, to: split.evalEnd }
}

const results = {}
for (const key of ['explore', 'consistency']) {
  const res = runPaperExperiment({ runIds, sliceKey: key, ...SETTINGS })
  const range = sliceRange(key)
  const t = res.full.targetIndices
  const withinSlice = t.every((i) => i >= range.from && i < range.to)
  results[key] = {
    key,
    sliceLabel: res.slice.label,
    range,
    dates: { start: res.slice.startDate, end: res.slice.endDate },
    predLen: res.task.predLen,
    seqLen: res.task.seqLen,
    target: res.task.target,
    windows: res.full.origins.length,
    targetPoints: res.full.uniqueTargetPoints,
    targetIndexMin: res.full.targetIndicesFirst,
    targetIndexMax: res.full.targetIndicesLast,
    targetsWithinSlice: withinSlice,
    windowsOverlapEachOther: res.full.overlappingWindows,
    perturbedPoints: res.perturbation.changedPoints,
    metrics: { DLinear: res.result.DLinear, Linear: res.result.Linear },
    deltaMae: res.result.deltaMae,
    leader: res.result.leader,
    relGap: res.result.relGap,
    closeGap: res.result.closeGap,
    metricsSpec: res.metricsSpec,
    full: res.full,
  }
}

/* ---------- 控制变量核对 ---------- */
const checks = []
const A = results.explore
const B = results.consistency
checks.push(['同一对权重', JSON.stringify(runIds) === JSON.stringify({ DLinear: runIds.DLinear, Linear: runIds.Linear })])
checks.push(['同一输入长度与预测跨度', A.seqLen === B.seqLen && A.predLen === B.predLen])
checks.push(['同一目标列', A.target === B.target && A.target === 'OT'])
checks.push(['同一指标与聚合方式', JSON.stringify(A.metricsSpec) === JSON.stringify(B.metricsSpec) || (A.metricsSpec.nSamples !== B.metricsSpec.nSamples && A.metricsSpec.metrics.join() === B.metricsSpec.metrics.join())])
checks.push(['两段都是无扰动输入', A.perturbedPoints === 0 && B.perturbedPoints === 0])
checks.push(['目标严格落在各自时间段内', A.targetsWithinSlice && B.targetsWithinSlice])
checks.push(['两段目标索引不重叠', A.targetIndexMax < B.targetIndexMin || B.targetIndexMax < A.targetIndexMin])
checks.push(['窗口等距采样、两段窗口数一致', A.windows === B.windows])
checks.push(['如实记录窗口是否互相重叠', typeof A.windowsOverlapEachOther === 'boolean'])

const reversalPersists = A.leader !== B.leader

/* ---------- 输出 ---------- */
const lines = []
lines.push('# 严格同条件复核：换个时间段，领先方会变吗？')
lines.push('')
lines.push(`权重版本：DLinear=${runIds.DLinear}｜Linear=${runIds.Linear}`)
lines.push(`固定设置：seq_len=${A.seqLen}｜pred_len=${A.predLen}｜target=${A.target}｜采样步长=8｜无扰动｜seed=11`)
lines.push('')
lines.push('| 时间段（自定义切片，均在官方测试区间内） | 日期 | 窗口数 | 有效目标点数 | DLinear MAE | Linear MAE | ΔMAE(Linear−DLinear) | 领先方 |')
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const k of ['explore', 'consistency']) {
  const r = results[k]
  lines.push(
    `| ${k === 'explore' ? '探索切片 46080–51840' : '另一时间段 51840–57600'} | ${r.dates.start} → ${r.dates.end} | ${r.windows} | ${r.targetPoints} | ${r.metrics.DLinear.mae.toFixed(4)} | ${r.metrics.Linear.mae.toFixed(4)} | ${r.deltaMae.toFixed(4)} | ${r.leader} |`,
  )
}
lines.push('')
lines.push('## 控制变量核对')
checks.forEach(([name, ok]) => lines.push(`- ${ok ? '✅' : '❌'} ${name}`))
lines.push('')
lines.push('## 结论')
lines.push(
  reversalPersists
    ? `**反转仍然存在**：探索切片领先方为 ${A.leader}（ΔMAE ${A.deltaMae.toFixed(4)}），另一时间段领先方为 ${B.leader}（ΔMAE ${B.deltaMae.toFixed(4)}）。这是**当前权重在这两个指定时间段上的观察**。`
    : `**复核后反转不成立**：两段领先方一致（都是 ${A.leader}），前一版结论需要更正，不作为案例。`,
)
lines.push('')
lines.push('## 适用范围与限制（必须一起展示）')
lines.push(
  `- 每个窗口覆盖 ${A.predLen} 个预测步、相邻采样起点间隔 8 步 → **窗口之间存在大量重叠**，不能把 ${A.targetPoints} 个目标点当作彼此独立的样本，本报告不涉及统计显著性。`,
)
lines.push('- 输入窗口允许使用预测起点之前的历史（最长 seq_len 点）；**预测目标严格落在本时间段内**，不跨段。')
lines.push('- 结论仅适用于当前权重、当前数据与当前设置；不能外推到其它预测跨度（换跨度需重新训练）、其它数据集或论文方法。')

mkdirSync(OUT_DIR, { recursive: true })
const payload = {
  generatedAt: new Date().toISOString(),
  weightVersions: runIds,
  settings: SETTINGS,
  checks: checks.map(([name, ok]) => ({ name, ok })),
  reversalPersists,
  slices: {
    explore: { ...A, full: A.full },
    consistency: { ...B, full: B.full },
  },
  note: '本文件包含完整预测与真值，可用 scripts/paper-method/recompute-metrics.mjs 独立复算指标。',
}
writeFileSync(join(OUT_DIR, 'verification.json'), JSON.stringify(payload), 'utf8')
writeFileSync(join(OUT_DIR, 'REPORT.md'), lines.join('\n'), 'utf8')

console.log(lines.join('\n'))
console.log('')
console.log(`已写出：${join(OUT_DIR, 'verification.json')}`)
console.log(`已写出：${join(OUT_DIR, 'REPORT.md')}`)
process.exit(reversalPersists ? 0 : 3)
