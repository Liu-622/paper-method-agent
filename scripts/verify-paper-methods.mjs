/**
 * 论文方法（DLinear/Linear）压力测试 + 探索 + 一致性检查的真实流程验证
 * 用法： node scripts/verify-paper-methods.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8902'
const post = (p, b) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json())
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json())
const f = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—')
const out = []

const meta = await get('/api/lab/paper/methods')
out.push(`方法版本：${meta.trained.map((t) => `${t.method}(${t.hyper.epochs}轮, ${t.timing.trainSeconds}s训练)`).join('，')}`)
out.push(`官方 SHA：${meta.paper.sha.slice(0, 8)}｜许可证：${meta.paper.license}｜正文可用：${meta.paper.textAvailable}`)
out.push(`官方划分：train [${meta.split.train.usedStart},${meta.split.train.usedEnd})｜val [${meta.split.val.usedStart},${meta.split.val.usedEnd})｜test [${meta.split.test.usedStart},${meta.split.test.usedEnd})`)
out.push(`评估区间：${meta.split.evalStart}–${meta.split.evalEnd}（${meta.split.customSlices.explore.startDate} → ${meta.split.customSlices.consistency.endDate}）`)
out.push(`超出官方基准：${meta.split.outOfBenchmark.from}–${meta.split.outOfBenchmark.to}（${meta.split.outOfBenchmark.len} 点，${meta.split.outOfBenchmark.startDate} → ${meta.split.outOfBenchmark.endDate}）`)

out.push('')
out.push('【无扰动基准（手动运行）】')
const base = await post('/api/lab/paper/run', { perturbationType: 'noise', strength: 0, seed: 11 })
const b = base.record
out.push(`状态=${b.status}｜DLinear MAE=${f(b.methods.DLinear.metrics.mae)} MSE=${f(b.methods.DLinear.metrics.mse)} RMSE=${f(b.methods.DLinear.metrics.rmse)}`)
out.push(`           Linear  MAE=${f(b.methods.Linear.metrics.mae)} MSE=${f(b.methods.Linear.metrics.mse)} RMSE=${f(b.methods.Linear.metrics.rmse)}`)
out.push(`ΔMAE(Linear−DLinear)=${f(b.comparison.deltaMae)} 领先方=${b.comparison.leader} 样本=${b.evaluation.nSamples}（${b.evaluation.nWindows} 窗口 × ${b.evaluation.horizon} 步）`)
out.push(`数据切片：${b.slice.label}`)

out.push('')
out.push('【压力测试：输入噪声 0.2】')
const noisy = await post('/api/lab/paper/run', { perturbationType: 'noise', strength: 0.2, seed: 11 })
const n = noisy.record
out.push(`DLinear MAE=${f(n.methods.DLinear.metrics.mae)}｜Linear MAE=${f(n.methods.Linear.metrics.mae)}｜ΔMAE=${f(n.comparison.deltaMae)} 领先方=${n.comparison.leader}`)
out.push(`扰动点数=${n.perturbation.changedPoints}，作用范围=${n.perturbation.scope}`)
out.push(`复现检查（同配置同种子预测哈希）：${n.methods.DLinear.predictionsHash}`)

out.push('')
out.push('【让小咕用 3 次预算探索】')
const exp = await post('/api/lab/paper/explore', { budget: 3, perturbationType: 'noise', explorationId: `verify-${Date.now()}` })
out.push(`预算=${exp.budget} 使用=${exp.used} 模式=${exp.mode} 停止=${exp.stopCode}（${exp.stoppedReason}）`)
exp.trace.forEach((t) => {
  out.push(`  ${t.step}. [${t.planner}] 扰动${t.config.perturbationType}:${t.config.strength} 种子${t.config.seed} 状态=${t.status}`)
  out.push(`     观察到：${t.observation}`)
  out.push(`     为什么：${t.reason}`)
  out.push(`     结果：${t.result}`)
  if (t.judgmentChange) out.push(`     改变判断：${t.judgmentChange}`)
})
;(exp.findings || []).forEach((fd) => {
  out.push('')
  out.push(`【发现卡】${fd.title}`)
  out.push(`  条件：${fd.conditions.map((c) => `扰动${c.strength}:Δ=${f(c.deltaMae)}`).join('，')}`)
  out.push(`  领先方稳定=${fd.leaderStable} 单调=${fd.monotonic} 方向=${fd.trendDirection}`)
  out.push(`  最小结论：${fd.minConclusion}`)
  out.push(`  不能外推到：${fd.notExtrapolateTo.slice(0, 2).join('；')}`)
})

out.push('')
out.push('【另一时间段一致性检查】')
const cons = await post('/api/lab/paper/consistency', { perturbationType: 'noise', strengths: [0, 0.1, 0.2], seed: 11 })
out.push(`切片：${cons.sliceLabel}`)
out.push(`结果：${(cons.rows || []).map((r) => `${r.strength}:Δ=${f(r.deltaMae)}(${r.leader})`).join('，')}`)
out.push(`方向=${cons.direction} 领先方稳定=${cons.leaderStable}`)
out.push(`说明：${cons.note}`)

console.log(out.join('\n'))
