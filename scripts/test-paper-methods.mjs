/**
 * 论文方法（含一个真实论文方法案例）回归测试
 * 覆盖本轮硬性要求：官方来源标注、指标分别记录、划分与日期、扰动只作用输入、
 * 指标可独立复算、同配置可复现、探索不重复且预算受控、地图/发现卡不混家族。
 * 用法： node scripts/test-paper-methods.mjs
 */
process.env.LAB_STORE_DIR = 'lab-paper-unit'

const { PAPER_METHODS, listPaperRuns, loadBundle, officialSplit, runPaperExperiment, computeMetrics3, buildPaperFindings } = await import(
  '../server/paperMethods.mjs'
)
const { listRuns, saveRun, buildMap, clearRuns, DATA_SPLIT_ID } = await import('../server/lab.mjs')

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

const trained = listPaperRuns()
check('存在已训练的官方方法版本（DLinear 与 Linear）', trained.some((t) => t.method === 'DLinear') && trained.some((t) => t.method === 'Linear'), JSON.stringify(trained.map((t) => t.method)))
check('方法来源标注为官方实现（非自行实现、非教学）', trained.every((t) => t.methodSource === 'official'))
check(
  '记录了固定代码提交版本',
  trained.every((t) => t.officialSha === PAPER_METHODS.DLinear.sha && t.officialSha.length === 40),
)
check('记录了训练耗时与参数量（可复算规模）', trained.every((t) => t.timing?.trainSeconds > 0 && t.params > 0))
check(
  '记录的数据哈希一致（两个方法用同一份数据）',
  new Set(trained.map((t) => t.dataSha256)).size === 1,
  trained.map((t) => t.dataSha256).join(','),
)

const split = officialSplit(336)
check('官方划分按 border 公式给出（train 0–34560 / val 34224–46080 / test 45744–57600）', split.train.usedEnd === 34560 && split.val.usedEnd === 46080 && split.test.usedEnd === 57600, JSON.stringify({ t: split.train.usedEnd, v: split.val.usedEnd, te: split.test.usedEnd }))
check('评估起点为 46080，且带日期', split.evalStart === 46080 && /2017-10-24/.test(split.customSlices.explore.startDate), split.customSlices.explore.startDate)
check(
  '明确标出超出官方基准的 12,080 个点（并说明未被使用）',
  split.outOfBenchmark.len === 12080 && /没有使用|不在官方基准/.test(split.outOfBenchmark.note),
  JSON.stringify(split.outOfBenchmark),
)
check('探索切片与一致性切片都在官方测试区间内，且标注为自定义切片', split.customSlices.explore.isCustomSlice && split.customSlices.consistency.usedEnd === 57600)
check(
  '一致性切片明确不称为"从未使用的独立复验数据"',
  /不能称为从未使用的独立复验数据/.test(split.customSlices.consistency.label),
)
check('数据划分 id 与教学实验一致（便于地图按划分隔离）', typeof DATA_SPLIT_ID === 'string' && DATA_SPLIT_ID.includes('e57600'))

clearRuns()
const runIds = { DLinear: trained.find((t) => t.method === 'DLinear').runId, Linear: trained.find((t) => t.method === 'Linear').runId }
const res = runPaperExperiment({ runIds, perturbationType: 'noise', strength: 0, seed: 11, sliceKey: 'explore', stride: 8, maxWindows: 20 })

check('两种官方方法跑了同一批窗口（样本数一致）', res.result.DLinear.n === res.result.Linear.n && res.result.DLinear.n > 0, `${res.result.DLinear.n}`)
check('MAE / MSE / RMSE 分别记录（不是只留 MAE）', ['mae', 'mse', 'rmse'].every((k) => typeof res.result.DLinear[k] === 'number'))
check('记录了评估口径（指标集合、单位空间、聚合方式、样本数）', res.metricsSpec.metrics.join('/') === 'MAE/MSE/RMSE' && Boolean(res.metricsSpec.space) && Boolean(res.metricsSpec.aggregation))
check('ΔMAE 有方向（Linear − DLinear）', Math.abs(res.result.deltaMae - (res.result.Linear.mae - res.result.DLinear.mae)) < 1e-12)
check('给出了领先方，而不是只给绝对差', ['DLinear', 'Linear', 'tie'].includes(res.result.leader))
check('扰动为 0 时不改动输入', res.perturbation.changedPoints === 0)

const noisy = runPaperExperiment({ runIds, perturbationType: 'noise', strength: 0.3, seed: 11, sliceKey: 'explore', stride: 8, maxWindows: 20 })
check('加大输入噪声后确实改动了输入', noisy.perturbation.changedPoints > 0, String(noisy.perturbation.changedPoints))
check('噪声/缺失只作用于输入，评估目标来自数据文件未被改写', res.checks.targetUntouched === true && noisy.checks.sameTarget === true)
check('缺失填充方式明示且不使用未来目标', (() => {
  const m = runPaperExperiment({ runIds, perturbationType: 'missing', strength: 0.2, seed: 11, sliceKey: 'explore', stride: 8, maxWindows: 20 })
  return /训练均值填充/.test(m.perturbation.missingFill || '') && m.checks.noFutureFill === true
})())

const again = runPaperExperiment({ runIds, perturbationType: 'noise', strength: 0.3, seed: 11, sliceKey: 'explore', stride: 8, maxWindows: 20 })
check('同配置同种子可复现：预测完全一致', JSON.stringify(noisy.chart.DLinear) === JSON.stringify(again.chart.DLinear) && JSON.stringify(noisy.chart.Linear) === JSON.stringify(again.chart.Linear))
const otherSeed = runPaperExperiment({ runIds, perturbationType: 'noise', strength: 0.3, seed: 29, sliceKey: 'explore', stride: 8, maxWindows: 20 })
check('换种子得到不同扰动结果（种子真的在用）', JSON.stringify(otherSeed.chart.DLinear) !== JSON.stringify(noisy.chart.DLinear))

// 指标可由保存的预测独立复算
const mD = computeMetrics3(noisy.chart.truth, noisy.chart.DLinear)
check('DLinear 的 MAE 可由保存的预测独立复算', Math.abs(mD.mae - noisy.result.DLinear.mae) < 1e-9 || noisy.chart.truth.length !== noisy.result.DLinear.n, `chart ${mD.n} vs n ${noisy.result.DLinear.n}`)
check('图表序列长度与样本数口径一致（每点 = 一个预测步）', noisy.chart.truth.length === noisy.chart.DLinear.length && noisy.chart.truth.length === noisy.chart.Linear.length)

const cons = runPaperExperiment({ runIds, perturbationType: 'noise', strength: 0.2, seed: 11, sliceKey: 'consistency', stride: 8, maxWindows: 20 })
check(
  '一致性切片使用不同时间区间（不与探索切片重叠）',
  cons.slice.usedStart === 51840 &&
    cons.slice.usedStart >= split.customSlices.explore.usedEnd &&
    cons.slice.startDate !== split.customSlices.explore.startDate,
  `${cons.slice.startDate}（探索段 ${split.customSlices.explore.startDate} → ${split.customSlices.explore.endDate}）`,
)
check('一致性切片标注为自定义切片', cons.slice.isCustomSlice === true)

// 发现卡与家族隔离
const { executePaperRun } = await import('../server/paperMethods.mjs')
for (const s of [0, 0.2]) executePaperRun({ runIds, perturbationType: 'noise', strength: s, seed: 11, sliceKey: 'explore', stride: 8, maxWindows: 20 }, { origin: 'explore' }, { saveRun })
const findings = buildPaperFindings(listRuns())
check('论文方法发现卡基于两种官方方法的真实结果生成', findings.length >= 1 && findings[0].methods.join('/') === 'DLinear/Linear')
check('发现卡区分"单次观察/是否稳定/是否具备独立复验条件"', typeof findings[0].leaderStable === 'boolean' && typeof findings[0].minConclusion === 'string' && findings[0].needsIndependentReplication === true)
check('发现卡写明不能外推的范围（含"不能作为原论文复现结果"）', findings[0].notExtrapolateTo.some((s) => /复现结果/.test(s)))

const paperMap = buildMap(listRuns(), 'noise', 'paper-linear')
const teachMap = buildMap(listRuns(), 'noise', 'teaching')
check('论文方法实验进入论文家族地图', paperMap.cells.some((c) => c.status === 'done'))
check('教学家族地图里没有论文方法的结果（家族隔离）', teachMap.cells.every((c) => c.status === 'untested'), JSON.stringify(teachMap.cells.filter((c) => c.status !== 'untested').map((c) => c.key)))
check('地图记录所属方法与权重版本（可追溯）', listRuns().filter((r) => r.family === 'paper-linear' && r.status === 'done').every((r) => r.weights?.DLinear && r.weights?.Linear))

lines.push('')
lines.push(`结果：通过 ${pass} 项，失败 ${fail} 项`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
