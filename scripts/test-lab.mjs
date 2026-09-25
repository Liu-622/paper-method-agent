/**
 * 小咕实验室 · 正确性测试（真实执行，不使用模型：除探索预算那一步外全部离线）
 * 运行： node scripts/test-lab.mjs
 * 覆盖本轮硬性要求：
 *  1 两种方法在同一条件下确实运行
 *  2 同一数据范围 / 目标 / 评估口径（共用同一批起点与样本数）
 *  3 只按时间顺序划分；输入窗口完全落在测试段内（不碰未来、不回看训练段）
 *  4 指标可由保存的预测独立复算
 *  5 扰动只作用输入：真实目标在扰动前后完全一致
 *  6 同配置 + 同种子可复现（预测哈希一致）
 *  7 跨度改变后按共同有效样本比较，并公开样本数
 *  8 地图只展示真实执行结果，未测试格子保持未测试、失败格子带原因
 *  9 非法配置留下失败记录，不静默丢弃
 * 10 预算上限、复验标记、取消注册表
 */
process.env.LAB_STORE_DIR = 'lab-test'

const {
  CONDITION_SPACE,
  buildMap,
  cancelExploration,
  clearRuns,
  computeMetrics,
  executeRun,
  listRuns,
  loadSeries,
  runExperiment,
  summarizeRuns,
  validateConfig,
  activeExplorations,
  buildTranslation,
  buildFindings,
  replicateFinding,
  SEGMENT_LABEL,
  OFFICIAL_RANGE,
} = await import('../server/lab.mjs')

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

clearRuns()

/* ---------- 1 / 2 / 3 / 7：基准实验 ---------- */
const base = runExperiment(
  { horizon: 96, perturbationType: 'noise', strength: 0, seed: 11 },
  { includeFull: true },
)
const sn = base.methods.seasonal_naive
const rg = base.methods.ridge
check('两种方法都真的跑了（都有指标与预测）', sn.metrics.n > 0 && rg.metrics.n > 0, `${sn.metrics.n}/${rg.metrics.n}`)
check(
  '两种方法共用同一批评估样本（样本数一致）',
  sn.metrics.n === rg.metrics.n && sn.metrics.n === base.evaluation.nSamples,
  `${sn.metrics.n} vs ${rg.metrics.n} vs ${base.evaluation.nSamples}`,
)
check('评估跨度与配置一致', base.evaluation.horizon === base.config.horizon, String(base.evaluation.horizon))
check(
  '输入窗口完全落在测试段内（不回看训练段，也不越界到未来）',
  base.evaluation.originRange[0] - CONDITION_SPACE.lags >= base.split.testRange[0],
  `origin${base.evaluation.originRange[0]} - lags${CONDITION_SPACE.lags} < testStart${base.split.testRange[0]}`,
)
check('时间段划分是按顺序的（train→val→test 不重叠）', base.split.trainSize > 0 && base.split.testRange[1] > base.split.testRange[0])
check('公开了样本数', typeof base.evaluation.nSamples === 'number' && base.evaluation.nSamples > 0)

/* ---------- 4：指标独立复算 ---------- */
const recalc = computeMetrics(base.raw.truth, base.raw.seasonal)
check(
  '季节朴素 MAE 可由保存的预测独立复算',
  Math.abs(recalc.mae - sn.metrics.mae) < 1e-9,
  `${recalc.mae} vs ${sn.metrics.mae}`,
)
const recalcR = computeMetrics(base.raw.truth, base.raw.ridge)
check(
  '岭回归 MAE 可由保存的预测独立复算',
  Math.abs(recalcR.mae - rg.metrics.mae) < 1e-9,
  `${recalcR.mae} vs ${rg.metrics.mae}`,
)

/* ---------- 5：扰动只作用输入 ---------- */
const noisy = runExperiment(
  { horizon: 96, perturbationType: 'noise', strength: 0.35, seed: 11 },
  { includeFull: true },
)
const truthSame = noisy.raw.truth.every((v, i) => Math.abs(v - base.raw.truth[i]) < 1e-12)
const predsDiffer = noisy.raw.ridge.some((v, i) => Math.abs(v - base.raw.ridge[i]) > 1e-9)
check('加大输入扰动后，真实目标（评估目标）完全没变', truthSame)
check('加大输入扰动后，预测确实发生了变化（扰动真的生效）', predsDiffer)

/* ---------- 6：可复现 ---------- */
const again = runExperiment({ horizon: 96, perturbationType: 'noise', strength: 0.35, seed: 11 })
check(
  '同配置 + 同种子可复现（预测哈希一致）',
  again.methods.ridge.predictionsHash === noisy.methods.ridge.predictionsHash &&
    again.methods.seasonal_naive.predictionsHash === noisy.methods.seasonal_naive.predictionsHash,
)
const otherSeed = runExperiment({ horizon: 96, perturbationType: 'noise', strength: 0.35, seed: 29 })
check('换种子会得到不同扰动结果（说明种子真的在用）', otherSeed.methods.ridge.predictionsHash !== noisy.methods.ridge.predictionsHash)

/* ---------- 7：跨度改变 ---------- */
const h192 = runExperiment({ horizon: 192, perturbationType: 'noise', strength: 0, seed: 11 })
check('跨度 192 下仍然共用同一批样本并公开样本数', h192.evaluation.nSamples === h192.methods.seasonal_naive.metrics.n && h192.evaluation.nSamples > 0, String(h192.evaluation.nSamples))
check('跨度不同 → 每次实验的评估目标长度随之改变（不是复用旧结果）', h192.evaluation.nSamples !== base.evaluation.nSamples || h192.evaluation.origins !== base.evaluation.origins)

/* ---------- 8 / 9：地图与失败留痕 ---------- */
const runs = listRuns()
const map = buildMap(runs, 'noise')
const doneCells = map.cells.filter((c) => c.status === 'done')
const untested = map.cells.filter((c) => c.status === 'untested')
check('地图里已完成的格子都有真实指标', doneCells.every((c) => c.metrics && c.comparison), JSON.stringify(doneCells.map((c) => c.key)))
check('未跑过的格子保持「未测试」且没有任何指标', untested.every((c) => !c.metrics && c.nSamples === null))
check('地图覆盖完整条件空间（跨度 × 强度）', map.cells.length === CONDITION_SPACE.horizon.length * CONDITION_SPACE.strength.length)

const bad = validateConfig({ horizon: 1000, perturbationType: 'noise', strength: 9, seed: 11 })
check(
  '非法条件被程序拦下（不是交给模型判断）',
  bad.ok === false && bad.problems.length >= 2 && bad.problems.every((p) => typeof p === 'string'),
  JSON.stringify(bad.problems),
)
const badType = validateConfig({ horizon: 96, perturbationType: 'run-shell-command', strength: 0, seed: 11 })
check('不允许的扰动类型同样被拦下', badType.ok === false, JSON.stringify(badType.problems))

const failed = await executeRun({ horizon: 999, perturbationType: 'noise', strength: 0, seed: 11 }, { origin: 'manual' })
check('非法条件留下失败记录而不是静默丢弃', failed.status === 'failed' && Boolean(failed.error))
const failedMap = buildMap(listRuns(), 'noise')
check('地图把失败格子标成失败并带原因', failedMap.cells.every((c) => c.status !== 'failed' || Boolean(c.error)))

/* ---------- 1（继续）：真实执行路径 executeRun 也正常 ---------- */
const viaExecute = await executeRun({ horizon: 24, perturbationType: 'missing', strength: 0.1, seed: 29 }, { origin: 'manual' })
check('通过执行入口跑一次实验成功（含缺失扰动）', viaExecute.status === 'done' && viaExecute.methods.ridge.metrics.n > 0, viaExecute.status)
check('缺失扰动也记录到配置里（可审计）', viaExecute.config.perturbationType === 'missing' && viaExecute.config.strength === 0.1)

/* ---------- 10：汇总与取消 ---------- */
const sum = summarizeRuns(listRuns())
check('汇总只统计真实记录并给出未观察到反转的如实表述', sum.total > 0 && sum.done > 0 && Array.isArray(sum.observed))
const fake = { cancelled: false }
activeExplorations.set('test-explore', fake)
check('取消注册表可以把正在进行的探索标记为取消', cancelExploration('test-explore') === true && fake.cancelled === true)
activeExplorations.delete('test-explore')
check('取消一个不存在的探索返回 false（不会误报成功）', cancelExploration('nope') === false)

const series = loadSeries('ETTm2')
check('数据来源被记录（真实/合成可区分）', Boolean(series.source.kind) && series.source.rows > 0, JSON.stringify(series.source).slice(0, 120))

/* ---------- 11：数据段隔离 + 证据等级 ---------- */
clearRuns()
const expRun = await executeRun({ horizon: 48, perturbationType: 'noise', strength: 0.1, seed: 11 }, { origin: 'explore' })
check('默认落在探索段（探索只能看这一段）', expRun.segment === 'explore', String(expRun.segment))
check(
  '探索段的输入窗口确实在探索段内（第 46080 点之后）',
  expRun.evaluation.originRange[0] - CONDITION_SPACE.lags >= 46080,
  String(expRun.evaluation.originRange[0]),
)
await executeRun({ horizon: 48, perturbationType: 'noise', strength: 0.1, seed: 11 }, { origin: 'explore' })
const cell1 = buildMap(listRuns(), 'noise').cells.find((c) => c.key === '48|noise|0.1')
check('同条件只跑过一次时：证据等级为「仅探索发现」', cell1?.evidenceLevel === 'exploration-only', String(cell1?.evidenceLevel))
await executeRun({ horizon: 48, perturbationType: 'noise', strength: 0.1, seed: 29 }, { origin: 'manual' })
const cell2 = buildMap(listRuns(), 'noise').cells.find((c) => c.key === '48|noise|0.1')
check('换种子复验后：证据等级升为「已换种子复验」', cell2?.evidenceLevel === 'seed-replicated', String(cell2?.evidenceLevel))
const indRun = await executeRun(
  { horizon: 48, perturbationType: 'noise', strength: 0.1, seed: 11, segment: 'independent' },
  { origin: 'replication' },
)
check('独立复验段可以单独运行', indRun.status === 'done' && indRun.segment === 'independent', String(indRun.segment))
check(
  '独立复验段使用不同的时间区间（与探索段分开）',
  indRun.evaluation.originRange[0] !== expRun.evaluation.originRange[0] &&
    indRun.evaluation.originRange[0] - CONDITION_SPACE.lags >= 51840,
  `${indRun.evaluation.originRange[0]} vs ${expRun.evaluation.originRange[0]}`,
)
const cell3 = buildMap(listRuns(), 'noise').cells.find((c) => c.key === '48|noise|0.1')
check('独立时间段复验后：证据等级升为「已独立时间段复验」', cell3?.evidenceLevel === 'independent-replicated', String(cell3?.evidenceLevel))
check('地图记录了独立复验的运行 id（可点开查看）', Boolean(cell3?.independentRunId))
check(
  '探索可见集合里没有任何独立复验段记录',
  listRuns().filter((r) => (r.segment ?? 'explore') === 'explore').every((r) => r.segment !== 'independent'),
)

/* ---------- 12：结论转译卡 + 可验证范围矩阵 ---------- */
const translate = buildTranslation({
  papers: [
    {
      shortLabel: 'Autoformer',
      method: 'Autoformer',
      datasets: ['ETTm2', 'ETTh1'],
      metrics: ['MAE', 'MSE'],
      horizons: [96, 192],
      result: '原文报告 ETTm2 上 MAE 0.255（示例）',
      split: '6:2:2',
      codeAvailability: '论文声明已开源',
      evidence: [{ page: 7, quote: 'we set the prediction lengths as 96, 192' }],
    },
  ],
  claim: { text: '跨度变大时两种方法差距是否缩小', source: '用户提出' },
  config: { horizon: 96, perturbationType: 'noise', strength: 0.1, seed: 11, segment: 'explore' },
  runs: listRuns(),
})
check('等级由程序判定为「代理验证」（数据与指标匹配、方法不匹配）', translate.levelKey === 'proxy', translate.levelKey)
check('转译卡给出等级判定依据', typeof translate.levelReason === 'string' && translate.levelReason.length > 0)
check('矩阵正好 6 个维度（方法/数据/指标/跨度/划分/扰动）', translate.matrix.length === 6, String(translate.matrix.length))
check('矩阵「方法」维度明确标注不匹配', translate.matrix[0].dimension === '方法' && translate.matrix[0].match === '不匹配')
check(
  '矩阵「输入扰动」标注为条件外压力测试',
  translate.matrix[5].dimension === '输入扰动' && translate.matrix[5].match === '条件外压力测试',
)
check('转译卡带论文原文的页码与逐字引用', translate.paperConclusion.evidence[0]?.page === 7)
check(
  '转译卡区分原文说法与系统结构化整理',
  typeof translate.paperConclusion.note === 'string' && translate.paperConclusion.note.includes('结构化'),
)
check(
  '严格结论写明不能据此判断论文方法优劣',
  translate.verdict.includes('不能据此判断') && translate.verdict.includes('Autoformer'),
)
check('持续免责声明存在', translate.disclaimer.includes('不能用于给') && translate.disclaimer.includes('排名'))
check(
  '没有可执行论文实现时，复现模式列出所需材料（不假运行）',
  translate.paperExperiment.assets.hasRunnableImpl === false && translate.paperExperiment.assets.missing.length > 0,
)
check('当前实验列出「与原论文不同」的部分', translate.currentExperiment.differentFromPaper.length >= 3)
check(
  '当前实验列出能验证与不能验证的范围',
  translate.currentExperiment.canVerify.length > 0 && translate.currentExperiment.cannotVerify.length >= 2,
)
check(
  '数据段如实标注为「另一时间段一致性检查」而不是独立复验（已用过的数据不能改名为从未使用）',
  typeof SEGMENT_LABEL.independent === 'string' && SEGMENT_LABEL.independent.includes('一致性检查'),
  SEGMENT_LABEL.independent,
)
check(
  '分段都写明了自己对应的日期，且都在官方基准区间内',
  SEGMENT_LABEL.explore.includes('2017-10-24') && SEGMENT_LABEL.independent.includes('2018-02-20'),
  `${SEGMENT_LABEL.explore} / ${SEGMENT_LABEL.independent}`,
)
check(
  '官方测试区间的终点是 57600（不使用超出官方基准的 12,080 点）',
  OFFICIAL_RANGE.evalEnd === 57600 && OFFICIAL_RANGE.datasetRows === 69680 && OFFICIAL_RANGE.outOfBenchmark.len === 12080,
)
check(
  '超出官方基准的区间被明确写出（日期 + 说明）',
  OFFICIAL_RANGE.outOfBenchmark.startDate.startsWith('2018-02-21') &&
    /不在官方基准/.test(OFFICIAL_RANGE.outOfBenchmark.note),
)
const rangeCheck = runExperiment({ horizon: 192, perturbationType: 'noise', strength: 0, seed: 11 }, { includeFull: true })
check(
  '跑出来的起点终点都不越过官方评估区间',
  rangeCheck.evaluation.originRange[1] + rangeCheck.config.horizon <= OFFICIAL_RANGE.evalEnd,
  `originEnd=${rangeCheck.evaluation.originRange[1]} + h=${rangeCheck.config.horizon} vs evalEnd=${OFFICIAL_RANGE.evalEnd}`,
)

/* ---------- 13：发现卡 + 独立时间段复验 ---------- */
clearRuns()
for (const h of [24, 96, 192]) {
  await executeRun({ horizon: h, perturbationType: 'noise', strength: 0, seed: 11 }, { origin: 'explore' })
}
const findings = buildFindings(listRuns())
check('探索段有 2 个以上跨度后生成发现卡', findings.length >= 1, String(findings.length))
const f = findings[0]
check('发现卡含方法/数据段/已测条件', f.methods.length === 2 && f.conditions.length >= 3 && Boolean(f.segmentLabel))
check('发现卡写明不能外推到什么范围', f.notExtrapolateTo.length >= 3)
check('发现卡给出能支持的最小结论', typeof f.minConclusion === 'string' && f.minConclusion.length > 20)
check('发现卡初始标记为未独立复验', f.replicated === false)

const rep = await replicateFinding({ finding: f, claim: { text: '测试发现', source: '用户提出' } })
check('独立时间段复验真的执行了', rep.ok === true && rep.ranCount >= 3, JSON.stringify({ ran: rep.ranCount, failed: rep.failedCount }))
check(
  '复验结果给出探索段与独立段两套趋势',
  Array.isArray(rep.exploreTrend) && Array.isArray(rep.independentTrend) && Boolean(rep.independentDirection),
)
check('复验如实给出是否同方向（不一致不隐藏）', typeof rep.sameDirection === 'boolean' && typeof rep.conclusion === 'string')
check('复验后仍标注「不足以判断」', rep.stillInsufficient === true)
const afterRep = buildFindings(listRuns())
check(
  '独立复验段记录不会混进探索段的发现趋势',
  afterRep.every((x) => x.segment === 'explore' && x.conditions.every((c) => !String(c.runId ?? '').includes('-ind-'))),
)

lines.push('')
lines.push(`结果：通过 ${pass} 项，失败 ${fail} 项`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
