/**
 * 便携版 v5 实机验证：挑战案例（离线重算）+ 侦探（离线可用）+ 对撞台
 * 用法： node scripts/verify-portable-v5.mjs [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8905'
const get = (p) => fetch(`${BASE}${p}`).then((r) => r.json())
const post = (p, b) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json())

const steps = []
const record = (name, ok, detail = '') => {
  steps.push({ name, ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const health = await get('/api/health')
record('便携版可访问（无 Key）', health.ok === true && health.hasCredentials === false, `creds=${health.hasCredentials}`)

const setup = await get('/api/lab/case/reversal/setup')
record(
  '挑战条件接口只给条件、不给结果',
  setup.ok === true && !JSON.stringify(setup).includes('deltaMae') && setup.slices.explore.dates.start.length > 0,
  `${setup.slices.explore.dates.start} → ${setup.slices.consistency.dates.end}`,
)

const fresh = await get('/api/lab/case/reversal?cached=0')
record(
  '挑战案例在便携版上可离线重算（与原机一致）',
  fresh.ok === true && fresh.case.reversal === true,
  `${fresh.case.slices.explore.leader} ${fresh.case.slices.explore.deltaMae.toFixed(4)} / ${fresh.case.slices.consistency.leader} ${fresh.case.slices.consistency.deltaMae.toFixed(4)}`,
)
record(
  '样本口径写清（预测记录数 vs 去重目标时间点）',
  fresh.case.slices.explore.windows * (fresh.case.slices.explore.metricsSpec.predLen ?? 96) === 68064 &&
    fresh.case.slices.explore.targetPoints === 5760,
  `${fresh.case.slices.explore.windows} 窗口 × 96 步 = ${fresh.case.slices.explore.windows * 96} 条记录；去重 ${fresh.case.slices.explore.targetPoints} 个目标时间点`,
)

const det = await post('/api/detective/run', { fieldKey: 'learningRate', dataset: 'ETTm2', model: 'DLinear', pages: [], taskId: 'v5-det' })
record(
  '侦探在便携版上离线可跑（用包内官方仓库文件）',
  det.ok === true && det.clues.length > 0 && det.sourcesChecked.some((s) => s.kind === 'repo' && !s.failed),
  `${det.mode}｜${det.summary}｜查过 ${det.sourcesChecked.length} 个来源`,
)
const boundClue = det.clues.find((c) => c.binding?.method)
record(
  '侦探线索绑定「仓库版本/方法/数据集/任务/跨度/脚本」',
  Boolean(boundClue) && boundClue.binding.sha.length === 40 && Boolean(boundClue.binding.script) && typeof boundClue.binding.line === 'number' && Boolean(boundClue.binding.method),
  boundClue ? `${boundClue.binding.script}:${boundClue.binding.line} → ${boundClue.binding.method}｜跨度 ${boundClue.binding.horizon ?? '多跨度'}｜${boundClue.binding.statusLabel}` : '无绑定线索',
)
const codeClue = det.clues.find((c) => c.sourceType === 'official-code')
record('侦探线索带文件路径、行号与提交版本', Boolean(codeClue?.evidence?.path && codeClue?.evidence?.line > 0 && codeClue?.evidence?.sha?.length === 40), codeClue ? `${codeClue.evidence.path}:${codeClue.evidence.line}` : '无')

const clash = await post('/api/clash/build', {
  papers: [
    { id: 'A', shortLabel: 'A', fields: { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE,MSE' }, horizon: { value: '96' }, conclusion: { value: 'MAE 0.260 on ETTm2' } }, evidence: [{ id: 'e1', page: 5, text: 'MAE 0.260 on ETTm2' }] },
    { id: 'B', shortLabel: 'B', fields: { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE,MSE' }, horizon: { value: '96' }, conclusion: { value: 'MAE 0.32 on ETTm2' } }, evidence: [{ id: 'e2', page: 7, text: 'MAE 0.32 on ETTm2' }] },
  ],
})
record('对撞台在便携版上可用', clash.ok === true && clash.cards.length >= 1, `${clash.cards.length} 张卡｜${clash.cards[0]?.relation?.label}`)

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length > 0 ? 1 : 0)
