/**
 * 未配置模型密钥时，本地实验能力仍可用（本轮验收第 12 项）
 * 做法：用空密钥启动一个独立端口的后端实例，验证：
 *  - /api/lab/meta 正常（数据可读，与模型无关）
 *  - /api/lab/translate 正常（转译卡由程序计算，不依赖模型）
 *  - /api/lab/run 手动实验可以真实执行
 *  - /api/lab/explore 会降级为「规则探索」并明确标注
 * 用法： node scripts/verify-lab-nokey.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`

const steps = []
const record = (name, ok, detail = '') => {
  steps.push({ name, ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const node = process.execPath
const child = spawn(node, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    LLM_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    LLM_BASE_URL: '',
    ANTHROPIC_BASE_URL: '',
    LAB_STORE_DIR: 'lab-nokey',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', () => {})

const waitHealthy = async (tries = 25) => {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      const j = await res.json()
      if (j.ok) return j
    } catch {
      /* 继续等 */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

const post = (path, body) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json())

try {
  const health = await waitHealthy()
  record('空密钥实例可以启动', Boolean(health))
  if (health) {
    record('健康检查如实报告没有凭据', health.hasCredentials === false, `hasCredentials=${health.hasCredentials}`)

    const meta = await fetch(`${BASE}/api/lab/meta`).then((r) => r.json())
    record('无密钥也能读到实验数据（ETTm2）', meta.ok === true && meta.source?.rows > 0, `${meta.source?.rows} 点`)

    const tr = await post('/api/lab/translate', {
      papers: [{ shortLabel: 'Autoformer', method: 'Autoformer', datasets: ['ETTm2'], metrics: ['MAE'], horizons: [96], evidence: [] }],
      claim: { text: '跨度变化时差距是否稳定', source: '用户提出' },
      config: { horizon: 96, perturbationType: 'noise', strength: 0.1, seed: 11 },
    })
    record('无密钥也能生成结论转译卡（程序计算）', tr.ok === true && tr.card?.matrix?.length === 6, `等级 ${tr.card?.level}`)

    const run = await post('/api/lab/run', { config: { horizon: 48, perturbationType: 'noise', strength: 0.1, seed: 11 }, origin: 'manual' })
    record(
      '无密钥也能执行手动实验（真实计算）',
      run.ok === true && run.record?.status === 'done' && run.record?.methods?.ridge?.metrics?.n > 0,
      `样本 ${run.record?.evaluation?.nSamples}，岭回归 MAE ${run.record?.methods?.ridge?.metrics?.mae?.toFixed(4)}`,
    )

    const exp = await post('/api/lab/explore', { budget: 2, perturbationType: 'noise', explorationId: `nokey-${Date.now()}` })
    record(
      '无密钥时探索降级为「规则探索」并且如实标注',
      exp.ok === true && exp.mode === 'rule' && exp.used >= 1,
      `mode=${exp.mode}，使用 ${exp.used}/${exp.budget}，停止原因 ${exp.stopCode}`,
    )
    record(
      '规则探索的每一步仍然有可审计理由',
      exp.trace?.every(
        (t) =>
          typeof t.reason === 'string' &&
          t.reason.length > 0 &&
          Boolean(t.observation) &&
          Boolean(t.choice) &&
          Boolean(t.result),
      ),
      `${exp.trace?.length} 步`,
    )
  }
} catch (e) {
  record('未配置密钥场景验证', false, e instanceof Error ? e.message : String(e))
} finally {
  child.kill()
  if (existsSync(join(ROOT, 'lab-nokey'))) {
    // 只提示，不删除（避免仓库级删除操作）
    console.log('（提示：lab-nokey/ 是本次隔离的测试记录目录，可手动清理）')
  }
}

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length > 0 ? 1 : 0)
