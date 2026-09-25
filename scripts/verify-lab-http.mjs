/**
 * 通过 HTTP 走一遍实验室真实流程（服务端真实计算）：
 *  1) 手动实验一次：打印两种方法的指标、共同样本数、结论
 *  2) 让小咕探索 3 次：打印每一步的 planner、理由、结果
 *  3) 复现检查：同配置同种子再跑一次，比对预测哈希
 *  4) 地图：确认只有真实跑过的格子是 done
 * 用法： node scripts/verify-lab-http.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const j = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init)
  return res.json()
}
const post = (path, body) =>
  j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const fmt = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—')
const out = []

const health = await j('/api/health')
out.push(`后端：ok=${health.ok} 模型=${health.model} 凭据=${health.hasCredentials}`)

const meta = await j('/api/lab/meta')
out.push(
  `数据：${meta.source.name}（${meta.source.kind === 'real' ? '真实公开数据' : '合成数据'}）｜${meta.source.rows} 点｜${meta.source.start} → ${meta.source.end}`,
)
out.push(`划分：训练 0-${meta.split.train[1]}｜验证 ${meta.split.val[0]}-${meta.split.val[1]}｜测试 ${meta.split.test[0]}-${meta.split.test[1]}`)

/* ---------------- 1) 手动实验 ---------------- */
const cfg = { horizon: 96, perturbationType: 'noise', strength: 0.1, seed: 11 }
const run1 = (await post('/api/lab/run', { config: cfg, origin: 'manual', claim: { text: '跨度 96 时两种方法谁更稳？', source: '教学假设' } })).record
out.push('')
out.push('【手动实验】')
out.push(
  `状态=${run1.status}｜跨度=${run1.config.horizon}｜扰动=${run1.config.perturbationType} ${run1.config.strength}｜种子=${run1.config.seed}｜样本=${run1.evaluation?.nSamples}｜扰动点=${run1.perturbationPoints}`,
)
out.push(
  `季节朴素 MAE=${fmt(run1.methods?.seasonal_naive?.metrics?.mae)} RMSE=${fmt(run1.methods?.seasonal_naive?.metrics?.rmse)}｜岭回归 MAE=${fmt(run1.methods?.ridge?.metrics?.mae)} RMSE=${fmt(run1.methods?.ridge?.metrics?.rmse)}`,
)
out.push(`结论：ΔMAE=${fmt(run1.comparison?.deltaMae)} 领先=${run1.comparison?.leader}${run1.comparison?.closeGap ? '（差距较小）' : ''}`)
out.push(`校验：同批样本=${run1.checks?.sameEvaluationSamples} 目标未被扰动=${run1.checks?.targetUntouchedByPerturbation} 只用训练段拟合=${run1.checks?.fitOnTrainOnly}`)

/* ---------------- 3) 复现检查 ---------------- */
const run1b = (await post('/api/lab/run', { config: cfg, origin: 'manual' })).record
out.push('')
out.push('【复现检查】同配置 + 同种子：')
out.push(`  岭回归预测哈希 ${run1.methods?.ridge?.predictionsHash} vs ${run1b.methods?.ridge?.predictionsHash} → ${run1.methods?.ridge?.predictionsHash === run1b.methods?.ridge?.predictionsHash ? '一致 ✓' : '不一致 ✗'}`)
out.push(`  季节朴素预测哈希 ${run1.methods?.seasonal_naive?.predictionsHash} vs ${run1b.methods?.seasonal_naive?.predictionsHash} → ${run1.methods?.seasonal_naive?.predictionsHash === run1b.methods?.seasonal_naive?.predictionsHash ? '一致 ✓' : '不一致 ✗'}`)

/* ---------------- 2) 探索 ---------------- */
out.push('')
out.push('【让小咕探索 3 次】')
const started = Date.now()
const exp = await post('/api/lab/explore', {
  budget: 3,
  perturbationType: 'noise',
  explorationId: `verify-${Date.now()}`,
  claim: { text: 'ETTm2 上跨度变大时，两种方法的差距会不会缩小？', source: '用户提出' },
})
out.push(`预算=${exp.budget} 实际使用=${exp.used} 模式=${exp.mode === 'model' ? '模型探索' : '规则探索'} 停止原因=${exp.stoppedReason}`)
exp.trace.forEach((t) => {
  out.push(`  ${t.step}. [${t.planner}${t.replicatedOf ? '/复验' : ''}] 跨度${t.config?.horizon} 扰动${t.config?.perturbationType}:${t.config?.strength} 种子${t.config?.seed} 状态=${t.status}`)
  out.push(`     理由：${t.reason}`)
  if (t.plannerNote) out.push(`     备注：${t.plannerNote}`)
  if (t.comparison) out.push(`     结果：ΔMAE=${fmt(t.comparison.deltaMae)} 领先=${t.comparison.leader} 样本=${t.nSamples}${t.comparison.closeGap ? '（差距较小）' : ''}`)
})
out.push(`探索耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`)

/* ---------------- 4) 地图 ---------------- */
const payload = await j('/api/lab/runs?perturbationType=noise')
const done = payload.map.cells.filter((c) => c.status === 'done')
const untested = payload.map.cells.filter((c) => c.status === 'untested')
const failed = payload.map.cells.filter((c) => c.status === 'failed')
out.push('')
out.push('【结论适用地图】')
out.push(`  已完成 ${done.length} 格｜未测试 ${untested.length} 格｜失败 ${failed.length} 格`)
out.push(`  已完成格子都带真实指标：${done.every((c) => c.metrics && c.comparison) ? '是 ✓' : '否 ✗'}`)
out.push(`  未测试格子没有指标：${untested.every((c) => !c.metrics && c.nSamples === null) ? '是 ✓' : '否 ✗'}`)
out.push(`  失败格子带原因：${failed.every((c) => Boolean(c.error)) ? '是 ✓' : '（本次没有失败格子）'}`)
out.push(`  汇总：共 ${payload.summary.total} 条记录，完成 ${payload.summary.done}，失败 ${payload.summary.failed}`)
payload.summary.observed.forEach((o) => out.push(`  · ${o}`))

console.log(out.join('\n'))
