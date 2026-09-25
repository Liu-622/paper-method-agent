/**
 * 便携包实机验证：对指定地址（默认便携版 8899）逐项检查
 * 用法： node scripts/verify-portable.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8899'
const steps = []
const record = (name, ok, detail = '') => {
  steps.push({ name, ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json())
const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json())

try {
  const health = await get('/api/health')
  record('便携版后端可访问', health.ok === true, `model=${health.model} creds=${health.hasCredentials}`)

  const idx = await fetch(`${BASE}/`)
  record('首页可访问（dist 已就位）', idx.status === 200, `HTTP ${idx.status}`)

  const meta = await get('/api/lab/meta')
  record(
    'ETTm2 被识别为真实数据',
    meta.ok === true && meta.source?.kind === 'real' && meta.source.rows > 60000,
    `${meta.source?.name}，${meta.source?.rows} 点，kind=${meta.source?.kind}`,
  )

  const run = await post('/api/lab/run', {
    config: { horizon: 48, perturbationType: 'noise', strength: 0.1, seed: 11 },
    origin: 'manual',
  })
  record(
    '未填 Key 也能执行手动实验（真实计算）',
    run.ok === true && run.record?.status === 'done',
    `样本 ${run.record?.evaluation?.nSamples}，岭回归 MAE ${run.record?.methods?.ridge?.metrics?.mae?.toFixed(4)}`,
  )

  const card = await post('/api/lab/translate', {
    papers: [{ shortLabel: 'Autoformer', method: 'Autoformer', datasets: ['ETTm2'], metrics: ['MAE'], horizons: [96], evidence: [] }],
    claim: { text: '跨度变化时差距是否稳定', source: '用户提出' },
    config: { horizon: 48, perturbationType: 'noise', strength: 0.1, seed: 11 },
  })
  record('转译卡与矩阵可用', card.ok === true && card.card?.matrix?.length === 6, `等级 ${card.card?.level}`)

  /* ---------- 官方论文方法（便携版只做推理，不需要训练环境） ---------- */
  const pm = await get('/api/lab/paper/methods')
  record(
    '便携版带已训练权重（DLinear + Linear，官方实现）',
    pm.ok === true && pm.trained?.length >= 2 && pm.trained.every((t) => t.methodSource === 'official'),
    (pm.trained ?? []).map((t) => `${t.method}(${t.hyper?.epochs}轮)`).join('，'),
  )
  record('便携版标注官方提交版本与许可证', pm.paper?.sha?.length === 40 && pm.paper?.license === 'MIT', `${pm.paper?.sha?.slice(0, 8)} / ${pm.paper?.license}`)
  const pr = await post('/api/lab/paper/run', { perturbationType: 'noise', strength: 0.1, seed: 11 })
  const rec = pr.record
  record(
    '便携版可运行官方论文方法压力测试（真实推理）',
    pr.ok === true &&
      rec?.status === 'done' &&
      typeof rec?.methods?.DLinear?.metrics?.mae === 'number' &&
      typeof rec?.methods?.Linear?.metrics?.mae === 'number',
    `DLinear MAE ${rec?.methods?.DLinear?.metrics?.mae?.toFixed(4)}｜Linear MAE ${rec?.methods?.Linear?.metrics?.mae?.toFixed(4)}｜ΔMAE ${rec?.comparison?.deltaMae?.toFixed(4)}`,
  )
  record(
    '便携版结果带权重版本与数据划分 id（可追溯）',
    Boolean(rec?.weights?.DLinear) && Boolean(rec?.dataSplitId) && Boolean(rec?.metricsSpec?.metrics?.length),
    `${rec?.weights?.DLinear ?? '—'} @ ${rec?.dataSplitId ?? '—'}`,
  )

  if (health.hasCredentials) {
    const exp = await post('/api/lab/explore', { budget: 2, perturbationType: 'noise', explorationId: `portable-key-${Date.now()}` })
    record('填了 Key → 模型探索可用', exp.mode === 'model', `mode=${exp.mode}`)
  } else {
    const exp = await post('/api/lab/explore', { budget: 2, perturbationType: 'noise', explorationId: `portable-nokey-${Date.now()}` })
    record(
      '未填 Key → 探索降级为规则探索并如实标注',
      exp.ok === true && exp.mode === 'rule' && exp.used >= 1,
      `mode=${exp.mode}，${exp.used}/${exp.budget}，停止原因 ${exp.stopCode}`,
    )
  }
} catch (e) {
  record('便携版验证执行', false, e instanceof Error ? e.message : String(e))
}

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length > 0 ? 1 : 0)
