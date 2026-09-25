/**
 * 独立复算：只读 lab-cases/reversal/verification.json，**不引用实验引擎**，
 * 用纯函数重新计算 MAE / MSE / RMSE 与有方向的 ΔMAE，并与记录值比对。
 * 用法： node scripts/paper-method/recompute-metrics.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\//, '')
const FILE = join(ROOT, 'lab-cases', 'reversal', 'verification.json')

/* ---- 独立实现的指标（与项目代码无共享） ---- */
const abs = (x) => (x < 0 ? -x : x)
function metrics(truth, pred) {
  if (truth.length !== pred.length) throw new Error('长度不一致')
  let sae = 0
  let sse = 0
  for (let i = 0; i < truth.length; i += 1) {
    const e = pred[i] - truth[i]
    sae += abs(e)
    sse += e * e
  }
  const mse = sse / truth.length
  return { n: truth.length, mae: sae / truth.length, mse, rmse: Math.sqrt(mse) }
}
const f = (v) => (typeof v === 'number' ? v.toFixed(6) : '—')

const data = JSON.parse(readFileSync(FILE, 'utf8'))
const lines = []
let fail = 0
const check = (name, ok, detail = '') => {
  if (!ok) fail += 1
  lines.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

lines.push('# 独立复算（不依赖实验引擎）')
lines.push('')
lines.push(`数据文件：lab-cases/reversal/verification.json（生成于 ${data.generatedAt}）`)
lines.push(`权重版本：DLinear=${data.weightVersions.DLinear}｜Linear=${data.weightVersions.Linear}`)
lines.push('')

for (const key of ['explore', 'consistency']) {
  const s = data.slices[key]
  const mD = metrics(s.full.truth, s.full.DLinear)
  const mL = metrics(s.full.truth, s.full.Linear)
  const delta = mL.mae - mD.mae
  const leader = Math.abs(delta) < 1e-12 ? 'tie' : delta > 0 ? 'DLinear' : 'Linear'
  lines.push(`## ${key === 'explore' ? '探索切片' : '另一时间段'}（第 ${s.range.from}–${s.range.to} 点，${s.dates.start} → ${s.dates.end}）`)
  lines.push(`- 复算样本数：${mD.n}（记录值 ${s.metrics.DLinear.n}）`)
  lines.push(`- DLinear  MAE=${f(mD.mae)} MSE=${f(mD.mse)} RMSE=${f(mD.rmse)}｜记录 MAE=${f(s.metrics.DLinear.mae)}`)
  lines.push(`- Linear   MAE=${f(mL.mae)} MSE=${f(mL.mse)} RMSE=${f(mL.rmse)}｜记录 MAE=${f(s.metrics.Linear.mae)}`)
  lines.push(`- 有方向 ΔMAE(Linear−DLinear)=${f(delta)}｜记录 ${f(s.deltaMae)}｜领先方 ${leader}（记录 ${s.leader}）`)
  lines.push('')
  check(`${key}：MAE 复算一致（DLinear）`, Math.abs(mD.mae - s.metrics.DLinear.mae) < 1e-9, `${mD.mae} vs ${s.metrics.DLinear.mae}`)
  check(`${key}：MAE 复算一致（Linear）`, Math.abs(mL.mae - s.metrics.Linear.mae) < 1e-9)
  check(`${key}：MSE 复算一致`, Math.abs(mL.mse - s.metrics.Linear.mse) < 1e-9 && Math.abs(mD.mse - s.metrics.DLinear.mse) < 1e-9)
  check(`${key}：ΔMAE 与领先方复算一致`, Math.abs(delta - s.deltaMae) < 1e-9 && leader === s.leader)
  check(`${key}：样本数与记录一致`, mD.n === s.metrics.DLinear.n)
}

const A = data.slices.explore
const B = data.slices.consistency
lines.push('## 案例结论（独立复算后）')
lines.push(
  `- 探索切片领先方 **${A.leader}**（ΔMAE ${f(A.deltaMae)}），另一时间段领先方 **${B.leader}**（ΔMAE ${f(B.deltaMae)}）。`,
)
lines.push(`- 反转${data.reversalPersists ? '仍然存在' : '不成立'}；两段窗口数各 ${A.windows} 个，目标点各 ${A.targetPoints} 个，窗口之间存在重叠，不作为独立样本。`)
check('控制变量核对全部通过', data.checks.every((c) => c.ok))
check('两段目标索引不重叠', A.targetIndexMax < B.targetIndexMin || B.targetIndexMax < A.targetIndexMin)
check('两段均为无扰动的完整采样', A.perturbedPoints === 0 && B.perturbedPoints === 0 && A.windows === B.windows)

lines.push('')
lines.push(`结果：${fail === 0 ? '全部复算一致 ✅' : `有 ${fail} 项不一致 ❌`}`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
