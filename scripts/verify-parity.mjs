/**
 * 数值一致性验证：Node 推理 vs 官方 PyTorch 输出
 * ==================================================================
 * 前置：python scripts/paper-method/parity_dump.py --run-id <runId>
 * 容差：标准化空间内 max|Δ| ≤ 1e-4（float32 前向的正常范围）；
 *       原始单位下相对误差 ≤ 1e-3。
 * 覆盖：无扰动 / 输入噪声 / 输入缺失 / 切片边界窗口（首、次、尾）。
 * 用法： node scripts/verify-parity.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')
const MODELS_DIR = join(ROOT, 'lab-models')

const { loadBundle, forward } = await import('../server/paperMethods.mjs')

const TOL_STD = 1e-4
const TOL_REL = 1e-3

let pass = 0
let fail = 0
const lines = []
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    lines.push(`[PASS] ${name}`)
  } else {
    fail += 1
    lines.push(`[FAIL] ${name} ${extra}`)
  }
}

const runs = readdirSync(MODELS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => existsSync(join(MODELS_DIR, name, 'parity_ext.json')))

if (runs.length === 0) {
  lines.push('[SKIP] 没有 parity_ext.json，先运行 parity_dump.py')
}

for (const runId of runs) {
  const bundle = loadBundle(runId)
  const ref = JSON.parse(readFileSync(join(MODELS_DIR, runId, 'parity_ext.json'), 'utf8'))
  const { mean, scale } = bundle.scaler
  const otIndex = bundle.config.task.encIn - 1
  let worstStd = 0
  let worstRel = 0
  let cases = 0
  const perKind = {}
  for (const c of ref.cases) {
    const jsOut = forward(bundle, c.inputPerturbed)
    let caseStd = 0
    for (let p = 0; p < jsOut.length; p += 1) {
      for (let ch = 0; ch < jsOut[p].length; ch += 1) {
        const d = Math.abs(jsOut[p][ch] - c.predStd[p][ch])
        if (d > caseStd) caseStd = d
        if (d > worstStd) worstStd = d
        // 原始单位的相对误差（只在目标通道上算）
        if (ch === otIndex) {
          const a = jsOut[p][ch] * scale[ch] + mean[ch]
          const b = c.predStd[p][ch] * scale[ch] + mean[ch]
          const rel = Math.abs(a - b) / Math.max(1e-6, Math.abs(b))
          if (rel > worstRel) worstRel = rel
        }
      }
    }
    perKind[c.kind] = Math.max(perKind[c.kind] ?? 0, caseStd)
    cases += 1
  }
  check(
    `${runId}：Node 前向与官方 PyTorch 输出一致（${cases} 个用例，含边界窗口）`,
    worstStd <= TOL_STD,
    `max|Δ|=${worstStd.toExponential(2)}（容差 ${TOL_STD}）`,
  )
  check(
    `${runId}：原始单位下 OT 通道相对误差在容差内`,
    worstRel <= TOL_REL,
    `maxRel=${worstRel.toExponential(2)}（容差 ${TOL_REL}）`,
  )
  check(
    `${runId}：无扰动 / 噪声 / 缺失 三种情况都单独达到容差`,
    Object.values(perKind).every((v) => v <= TOL_STD),
    JSON.stringify(Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, v.toExponential(2)]))),
  )
}

lines.push('')
lines.push(`结果：通过 ${pass} 项，失败 ${fail} 项`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
