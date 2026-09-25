/**
 * 工作包一验收：对真实论文跑「四维确认逻辑」的批量方法分析。
 *
 * 做三件事：
 *  1. 逐篇调用 /api/analyze（并发 2，与产品内并发池一致）
 *  2. 把每篇的完整结果落盘到 docs/results/analyze-v2/<id>.json
 *  3. 汇总成功 / 失败 / 部分完成、实际覆盖，以及抽查所需的真实例子
 *
 * 用法（需要后端已启动在 PORT，默认 8787）：
 *   node scripts/verify-analyze-v2.mjs                # 全部论文
 *   node scripts/verify-analyze-v2.mjs 2              # 只跑前 2 篇（先探时间）
 *   node scripts/verify-analyze-v2.mjs informer dlinear
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const PORT = process.env.PORT || '8787'
const BASE = `http://127.0.0.1:${PORT}`
const OUT_DIR = path.join(root, 'docs', 'results', 'analyze-v2')

const argv = process.argv.slice(2)
const onlyNumeric = argv.length === 1 && /^\d+$/.test(argv[0])
const limit = onlyNumeric ? Number(argv[0]) : Infinity
const wanted = onlyNumeric ? null : new Set(argv.filter((a) => !/^\d+$/.test(a)))

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public', 'catalog-pages.json'), 'utf8'))
let papers = catalog.papers ?? []
if (wanted && wanted.size > 0) papers = papers.filter((p) => wanted.has(p.id))
papers = papers.slice(0, limit)

fs.mkdirSync(OUT_DIR, { recursive: true })

const titleOf = (p) => {
  const first = (p.pages?.[0]?.text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? p.fileName
  return first.slice(0, 160)
}

async function analyzeOne(p) {
  const started = Date.now()
  const body = {
    fileName: p.fileName,
    title: titleOf(p),
    pages: p.pages.map((x) => ({ page: x.page, text: x.text })),
  }
  try {
    const res = await fetch(`${BASE}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    const elapsed = Date.now() - started
    if (!res.ok || !json?.ok) {
      return { id: p.id, status: 'failed', elapsedMs: elapsed, code: json?.code, message: json?.message }
    }
    fs.writeFileSync(path.join(OUT_DIR, `${p.id}.json`), JSON.stringify({ paperId: p.id, title: body.title, ...json }, null, 2), 'utf8')
    return { id: p.id, status: 'ok', elapsedMs: elapsed, result: json }
  } catch (e) {
    return { id: p.id, status: 'failed', elapsedMs: Date.now() - started, message: e instanceof Error ? e.message : String(e) }
  }
}

const results = []
const queue = [...papers]
const CONCURRENCY = 2
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const p = queue.shift()
      if (!p) break
      process.stdout.write(`[analyze] ${p.id} ...\n`)
      const r = await analyzeOne(p)
      process.stdout.write(`[analyze] ${p.id} -> ${r.status} (${r.elapsedMs}ms)\n`)
      results.push(r)
    }
  }),
)

const ok = results.filter((r) => r.status === 'ok')
const failed = results.filter((r) => r.status !== 'ok')

const countVerdicts = (list) => {
  const out = {}
  for (const it of list ?? []) out[it.verdict ?? 'none'] = (out[it.verdict ?? 'none'] ?? 0) + 1
  return out
}

const perPaper = ok.map((r) => {
  const j = r.result
  return {
    id: r.id,
    title: j.title,
    ownMethod: j.ownMethod,
    elapsedMs: r.elapsedMs,
    semanticReviewRan: j.semanticReviewRan === true,
    pipeline: j.analysisPipeline,
    verdictStats: j.verdictStats ?? {},
    family: countVerdicts(j.family),
    mechanisms: countVerdicts(j.mechanisms),
    tasks: countVerdicts(j.tasks),
    relations: countVerdicts(j.relations),
    relationsTotal: (j.relations ?? []).length,
  }
})

const summary = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  /** 两层统计：请求执行成功 与 身份核对正确且实际完成 必须分开，不能再笼统写「12/12」 */
  requested: papers.length,
  /** 请求执行成功（后端返回 ok） */
  succeeded: ok.length,
  /** 身份核对正确且实际完成分析（排除错配正文的论文） */
  identityCorrectAndCompleted: 0,
  /** 身份错配 / 疑似错配、不参与综合的论文 */
  identityMismatched: [],
  failed: failed.length,
  failedDetail: failed.map((f) => ({ id: f.id, message: f.message ?? f.code })),
  totalElapsedMs: results.reduce((a, r) => a + r.elapsedMs, 0),
  perPaper,
}

// 身份核对：把错配正文的论文从「实际完成」里剔除，两层统计分开报
let identity = {}
try {
  identity = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'results', 'catalog-identity.json'), 'utf8'))
} catch {
  identity = {}
}
const idStatus = {}
for (const e of identity?.entries ?? []) idStatus[e.id] = e.identityStatus
for (const r of ok) {
  const st = idStatus[r.id]
  if (st && st !== 'consistent') {
    summary.identityMismatched.push(r.id)
  } else {
    summary.identityCorrectAndCompleted += 1
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')

const md = []
md.push('# 批量方法分析验收（四维确认逻辑）')
md.push('')
md.push(`- 时间：${summary.generatedAt}`)
md.push(`- 后端：${BASE}`)
md.push(`- 请求 ${summary.requested} 篇：请求执行成功 ${summary.succeeded}，失败 ${summary.failed}`)
md.push(`- 身份核对正确且实际完成分析 ${summary.identityCorrectAndCompleted} 篇；身份错配（不参与综合）${summary.identityMismatched.length ? summary.identityMismatched.join('、') : '无'}`)
md.push('')
md.push('| 论文 | 本文方法 | 家族(原文明示/待确认/未归入) | 机制 | 关系 | 语义复核 | 耗时 |')
md.push('| --- | --- | --- | --- | --- | --- | --- |')
const fmt = (c) => `${c['paper-supported'] ?? 0}/${c.pending ?? 0}/${c.excluded ?? 0}`
for (const p of perPaper) {
  md.push(`| ${p.id} | ${p.ownMethod ?? '—'} | ${fmt(p.family)} | ${fmt(p.mechanisms)} | ${fmt(p.relations)} | ${p.semanticReviewRan ? '已执行' : '未执行'} | ${p.elapsedMs}ms |`)
}
md.push('')
if (failed.length) {
  md.push('## 失败明细')
  for (const f of failed) md.push(`- ${f.id}: ${f.message ?? f.code}`)
  md.push('')
}
fs.writeFileSync(path.join(OUT_DIR, 'SUMMARY.md'), md.join('\n'), 'utf8')

console.log('\n==== done ====')
console.log(`ok=${ok.length} failed=${failed.length}`)
console.log(`output: ${OUT_DIR}`)
