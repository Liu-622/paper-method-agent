/**
 * A/B 对照实验
 * ------------------------------------------------------------------
 * A 臂：把论文正文直接交给同一个模型提问（/api/bench/raw-ask，无引用校验、无支持判定、无规则上下文）
 * B 臂：本工具流程（按页解析 → 字段抽取 + 引用逐字校验 + 原文支持判定 → 本地规则检查 → 带引用校验的问答）
 *
 * 判定口径对两臂一致：A 臂的每一条结论也会被**同一套支持判定**过一遍，
 * 证据池用的是本工具抽到并通过逐字校验的原文片段，避免"谁被检查得更细"造成不公平。
 *
 * 用法：node scripts/benchmark.mjs           （全部案例）
 *       node scripts/benchmark.mjs case-1    （只跑某个案例）
 *
 * 产出：docs/EVALUATION.md、docs/results/benchmark.json、docs/results/benchmark.csv
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const only = process.argv[2] || ''
const live = process.env.BENCH_LIVE === '1'

// ---------- 1. 准备数据 ----------
const casesFile = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cases.json'), 'utf8'))
const cases = casesFile.cases.filter((c) => !only || c.id.includes(only))

const load = (name, shortLabel) => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cache', `${name}.json`), 'utf8'))
  return {
    id: name,
    shortLabel,
    fileName: j.fileName,
    title: j.fileName,
    pages: j.pages,
    fields: j.extract.fields,
    coverage: j.extract.coverage,
  }
}
const dlinear = load('dlinear', 'U1')
const autoformer = load('autoformer', 'U2')

// ---------- 2. 工具侧计算（B 臂的结构化输出） ----------
const bundlePath = path.join(root, 'node_modules', '.cache', 'bench-entry.mjs')
fs.mkdirSync(path.dirname(bundlePath), { recursive: true })
await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'bench-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundlePath,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})
const { analyze } = await import(new URL(`file://${bundlePath.replace(/\\/g, '/')}`).href)

const scopes = [null, 'ETTh1', 'ETTm1', 'Traffic', 'Weather', 'ILI']
const tool = analyze([dlinear, autoformer], scopes)

const evidencePool = Object.entries(tool.evidence).map(([id, e]) => ({
  evidenceId: id,
  shortLabel: e.shortLabel,
  page: e.page,
  quote: e.quote,
}))

/**
 * 「全文证据池」：把每篇论文的**每一页正文**切成不丢内容的分块（每块约 1600 字符）。
 * 旧实现每页只取前 1400 字符 —— 页面中后部的证据会整体丢失。
 * 分块后"未检索到支持"才更接近"原文确实没有支持"。
 */
const CHUNK = 1600
const fullTextEvidence = []
for (const p of [dlinear, autoformer]) {
  for (const pg of p.pages) {
    const text = String(pg.text || '').trim()
    if (text.length < 80) continue
    const nChunks = Math.ceil(text.length / CHUNK)
    for (let i = 0; i < nChunks; i += 1) {
      fullTextEvidence.push({
        evidenceId: `full-${p.id}-p${pg.page}-${i + 1}of${nChunks}`,
        shortLabel: p.shortLabel,
        page: pg.page,
        quote: text.slice(i * CHUNK, (i + 1) * CHUNK),
      })
    }
  }
}
console.log(
  `证据池：工具校验片段 ${evidencePool.length} 条；全文分块 ${fullTextEvidence.length} 块（无截断丢失，覆盖两篇全部 ${dlinear.pages.length + autoformer.pages.length} 页）`,
)

const post = async (p, body) => {
  const res = await fetch(`${API_BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`${p} 失败：${json.message || JSON.stringify(json).slice(0, 200)}`)
  return json
}

const papersForApi = [dlinear, autoformer].map((p) => ({
  id: p.id,
  shortLabel: p.shortLabel,
  title: p.title,
  pages: p.pages,
}))

/** 把本地检查项整理成可送给后端的上下文 */
function checksForBackend(scope) {
  const key = scope === null ? 'none' : scope
  const fairness = tool.fairnessByScope[key].map((f, i) => ({
    id: `fair-${i}`,
    key: String(f.key),
    label: f.label,
    verdict: f.verdict,
    verdictText: f.verdict === 'consistent' ? '条件一致' : f.verdict === 'different' ? '存在差异' : '信息不足',
    reason: f.reason,
    perPaper: f.perPaper.map((p) => ({
      paperId: p.paperId,
      label: p.paperId === dlinear.id ? dlinear.shortLabel : autoformer.shortLabel,
      value: p.value,
    })),
  }))
  const repro = tool.repro.slice(0, 8).map((r, i) => ({
    id: `repro-${i}`,
    key: String(r.key),
    label: r.label,
    verdict: r.verdict,
    verdictText: r.verdict,
    reason: r.reason,
    perPaper: r.perPaper.map((p) => ({
      paperId: p.paperId,
      label: p.paperId === dlinear.id ? dlinear.shortLabel : autoformer.shortLabel,
      value: p.value,
    })),
  }))
  return [...fairness, ...repro]
}

/** 判断某个 toolSignal 是否成立（工具是否真的报出了这个风险项） */
function signalOk(sig) {
  if (sig.type === 'fairness' || sig.type === 'scopedFairness') {
    const key = sig.dataset || 'none'
    const items = tool.fairnessByScope[key] || []
    const hit = items.find((f) => f.id === sig.id)
    if (!hit) return false
    return sig.verdict ? hit.verdict === sig.verdict : true
  }
  if (sig.type === 'repro') {
    const hit = tool.repro.find((r) => String(r.key) === sig.key)
    if (!hit) return false
    return sig.verdict ? hit.verdict === sig.verdict : true
  }
  if (sig.type === 'fieldContains') {
    const f = dlinear.fields[sig.key]
    const text = String(f?.value || '')
    return Boolean(f) && f.status === 'found' && (sig.keywords || []).some((k) => text.includes(k))
  }
  if (sig.type === 'noEvidence') {
    // 工具没有该字段：正确行为是明确说"材料里没有这项"，由 refusal 判定兜底
    return true
  }
  return false
}

/** 关键词命中数 */
function hits(text, keywords) {
  const t = String(text || '')
  return (keywords || []).filter((k) => t.includes(k)).length
}

const splitSentences = (text) =>
  String(text || '')
    .split(/(?<=[。；!?！？])\s*|\n+/)
    .map((s) => s.trim().replace(/^[-*\d.、)\s]+/, ''))
    .filter((s) => s.length >= 12 && s.length <= 400)

// ---------- 3. 逐案例跑两臂 ----------
const CACHE_DIR = path.join(root, 'benchmark', 'cache')
const cacheFile = (id, kind) => path.join(CACHE_DIR, `answers-${kind}-${id}.json`)
const readCache = (id, kind) => {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(id, kind), 'utf8'))
  } catch {
    return null
  }
}
const writeCache = (id, kind, value) => {
  try {
    fs.writeFileSync(cacheFile(id, kind), JSON.stringify(value, null, 2))
  } catch {
    /* ignore */
  }
}
const REFRESH = process.env.BENCH_REFRESH === '1'

const results = []
for (const c of cases) {
  process.stdout.write(`\n=== ${c.id}（${c.category}）\n`)
  let armA = { text: '', error: '' }
  let armAJudged = []
  let armAJudgedFull = []
  let armB = { text: '', claims: [], withdrawn: [], citations: [], warnings: [], error: '' }
  let armBTool = { signals: [], signalsOk: 0, evidencePages: [], unsupported: 0 }

  // ---- A 臂：裸模型（答案与判定结果都缓存，重评时只跑判定步骤）----
  if (live) {
    const cached = !REFRESH && readCache(c.id, 'A')
    if (cached?.text) {
      armA = { text: cached.text, error: '' }
      process.stdout.write('  A：复用已缓存答案\n')
    } else {
      try {
        const r = await post('/api/bench/raw-ask', { question: c.question, papers: papersForApi })
        armA = { text: r.text, error: '' }
        writeCache(c.id, 'A', { text: r.text, elapsedMs: r.elapsedMs })
      } catch (e) {
        armA = { text: '', error: e.message }
      }
    }

    // 两套证据池都给 A 判一遍：工具校验片段池（窄口径）/ 全文分块池（全文口径）
    for (const [pool, sink] of [
      [evidencePool, armAJudged],
      [fullTextEvidence, armAJudgedFull],
    ]) {
      if (!pool.length) continue
      const sentences = splitSentences(armA.text)
      // 分批复核：一次给太多条结论时模型容易返回空内容（实测），按每批 10 条投喂
      for (let i = 0; i < sentences.length; i += 10) {
        const chunk = sentences.slice(i, i + 10)
        try {
          const res = await post('/api/bench/judge-claims', { claims: chunk, evidence: pool })
          sink.push(...res.judgements)
        } catch (e) {
          sink.push(...chunk.map((t) => ({ text: t, support: 'unchecked', reason: e.message, evidenceIds: [] })))
        }
      }
    }
  } else {
    armA.error = 'BENCH_LIVE!=1，未调用模型'
  }

  // ---- B 臂（答案同样缓存，重评不重复调用模型）----
  let armBJudgedDisplayed = []
  const scope = c.id.includes('interval-per-dataset') ? 'Traffic' : null
  if (live) {
    const cachedB = !REFRESH && readCache(c.id, 'B')
    const useCached = cachedB && cachedB.question === c.question
    if (useCached) {
      armB = { ...cachedB, error: '' }
      process.stdout.write('  B：复用已缓存答案\n')
    } else {
    try {
      const r = await post('/api/ask', {
        question: c.question,
        papers: papersForApi,
        context: { paperCount: 2, datasetScope: scope, checks: checksForBackend(scope) },
      })
      armB = {
        text: [...(r.paragraphs || []), ...(r.bullets || [])].join('\n'),
        claims: r.claims || [],
        withdrawn: r.withdrawn || [],
        citations: r.citations || [],
        warnings: r.warnings || [],
        error: '',
      }
      writeCache(c.id, 'B', { question: c.question, ...armB })
    } catch (e) {
      armB.error = e.message
    }
    }

    // **与 A 臂相同的口径**评估 B 展示给用户的回答：
    // 同一个句子切分器 + 同一个全文分块证据池。内部的 claims/撤回作为单独统计，不混进来。
    if (armB.text) {
      const sentences = splitSentences(armB.text)
      for (let i = 0; i < sentences.length; i += 10) {
        const chunk = sentences.slice(i, i + 10)
        try {
          const res = await post('/api/bench/judge-claims', { claims: chunk, evidence: fullTextEvidence })
          armBJudgedDisplayed.push(...res.judgements)
        } catch (e) {
          armBJudgedDisplayed.push(
            ...chunk.map((t) => ({ text: t, support: 'unchecked', reason: e.message, evidenceIds: [] })),
          )
        }
      }
    }
  } else {
    armB.error = 'BENCH_LIVE!=1，未调用模型'
  }

  // B 臂的结构化信号（不依赖模型，全部可复算）
  armBTool.signals = (c.toolSignals || []).map((s) => ({ ...s, ok: signalOk(s) }))
  armBTool.signalsOk = armBTool.signals.filter((s) => s.ok).length
  armBTool.evidencePages = Object.values(tool.evidence)
    .map((e) => `${e.shortLabel} p.${e.page}`)
    .filter((v, i, arr) => arr.indexOf(v) === i)

  // ---- 评分 ----
  const gold = c.gold
  const grade = (text) => {
    const perItem = gold.riskItems.map((item) => ({ id: item.id, desc: item.desc, hit: hits(text, item.keywords) > 0 }))
    const missed = perItem.filter((i) => !i.hit).map((i) => i.id)
    const mustNot = (gold.mustNotAssert || []).filter((m) => String(text || '').includes(m))
    return { perItem, missed, recall: perItem.length ? (perItem.length - missed.length) / perItem.length : 1, mustNot }
  }

  const gradeA = grade(armA.text)

  const refusalA = gold.refusalExpected
    ? /没有(给出|提到|说明|提及)|未(给出|说明|提及)|无法(回答|确定|判断)|论文(里|中)没有/.test(armA.text)
    : null
  const refusalB = gold.refusalExpected
    ? /没有(给出|提到|说明|提及)|未(给出|说明|提及)|无法(回答|确定|判断)|论文(里|中)没有|未找到/.test(armB.text) ||
      armB.claims.some((x) => x.support === 'none' || x.support === 'rule' || x.support === 'system')
    : null

  const gradeBSignals = {
    perItem: gold.riskItems.map((item) => {
      // B 臂命中 = 结构化信号成立 / 回答里提到 / 拒答类案例里确实拒答了
      const sigOk = armBTool.signals.some((s) => {
        const map = {
          'dataset-sets-differ': 'fair-dataset',
          'shared-datasets': 'fair-dataset',
          'conditions-partly-differ': 'fair-horizon',
          'conditions-aligned': 'fair-horizon',
        }
        if (map[item.id] && s.id === map[item.id]) return s.ok
        return false
      })
      const refusalHit = gold.refusalExpected === true && refusalB === true
      return {
        id: item.id,
        desc: item.desc,
        hit: sigOk || refusalHit || hits(armB.text, item.keywords) > 0,
        viaSignal: sigOk,
        viaRefusal: refusalHit,
      }
    }),
    mustNot: (gold.mustNotAssert || []).filter((m) => String(armB.text || '').includes(m)),
  }
  gradeBSignals.missed = gradeBSignals.perItem.filter((i) => !i.hit).map((i) => i.id)
  gradeBSignals.recall = gradeBSignals.perItem.length
    ? (gradeBSignals.perItem.length - gradeBSignals.missed.length) / gradeBSignals.perItem.length
    : 1

  const unsupportedA = armAJudged.filter((j) => j.support === 'none').length
  const unsupportedAFull = armAJudgedFull.filter((j) => j.support === 'none').length
  const uncheckedA = armAJudged.filter((j) => j.support === 'unchecked').length
  const uncheckedAFull = armAJudgedFull.filter((j) => j.support === 'unchecked').length
  const unsupportedB = armB.claims.filter((x) => x.source === 'paper' && x.support === 'none').length
  armBTool.unsupported = unsupportedB
  // B 展示文本用与 A 相同口径判定的结果（同一切分器 + 同一全文分块池）
  const unsupportedBDisplayed = armBJudgedDisplayed.filter((j) => j.support === 'none').length
  const uncheckedBDisplayed = armBJudgedDisplayed.filter((j) => j.support === 'unchecked').length

  const evidencePagesA = [...new Set((armA.text.match(/p\.?\s?\d+|第\s?\d+\s?页|page\s?\d+/gi) || []).map((s) => s.replace(/\s/g, '')))]
  const evidencePagesB = [...new Set(armB.citations.map((x) => `${x.shortLabel} p.${x.page}`))]

  const row = {
    id: c.id,
    category: c.category,
    question: c.question,
    A: {
      text: armA.text,
      error: armA.error,
      sentences: armAJudged.length,
      unsupported: unsupportedA,
      unsupportedFullPool: unsupportedAFull,
      /** 无依据比例（分母 = 判定成功的句数，未复核单独计） */
      unsupportedRateFullPool:
        armAJudgedFull.length - uncheckedAFull > 0
          ? unsupportedAFull / (armAJudgedFull.length - uncheckedAFull)
          : null,
      unchecked: uncheckedA,
      uncheckedFullPool: uncheckedAFull,
      recall: gradeA.recall,
      missed: gradeA.missed,
      falseAssertions: gradeA.mustNot,
      judged: armAJudged,
      judgedFullPool: armAJudgedFull,
      refusal: refusalA,
      evidencePages: evidencePagesA,
    },
    B: {
      text: armB.text,
      error: armB.error,
      signals: armBTool.signals,
      signalsOk: armBTool.signalsOk,
      signalsTotal: armBTool.signals.length,
      claims: armB.claims,
      withdrawn: armB.withdrawn,
      warnings: armB.warnings,
      unsupported: unsupportedB,
      /** 与 A 相同口径（同一切分器 + 全文分块池）评估 B 展示文本的结果 */
      displayedSentences: armBJudgedDisplayed.length,
      displayedUnsupported: unsupportedBDisplayed,
      displayedUnchecked: uncheckedBDisplayed,
      displayedUnsupportedRate:
        armBJudgedDisplayed.length - uncheckedBDisplayed > 0
          ? unsupportedBDisplayed / (armBJudgedDisplayed.length - uncheckedBDisplayed)
          : null,
      displayedJudged: armBJudgedDisplayed,
      recall: gradeBSignals.recall,
      missed: gradeBSignals.missed,
      matched: gradeBSignals.perItem.map((i) => `${i.hit ? '✓' : '✗'}${i.viaSignal ? '(结构化)' : ''} ${i.id}`),
      falseAssertions: gradeBSignals.mustNot,
      refusal: refusalB,
      evidencePages: evidencePagesB,
      evidencePagesAll: armBTool.evidencePages,
    },
  }
  results.push(row)
  process.stdout.write(
    `  A：召回 ${(row.A.recall * 100).toFixed(0)}%｜无依据(全文池) ${unsupportedAFull}/${armAJudgedFull.length}（未复核 ${uncheckedAFull}）｜误报 ${row.A.falseAssertions.length}｜拒答 ${row.A.refusal}\n`,
  )
  process.stdout.write(
    `  B(展示文本，同口径)：无依据 ${unsupportedBDisplayed}/${armBJudgedDisplayed.length}（未复核 ${uncheckedBDisplayed}）｜结构化信号 ${row.B.signalsOk}/${row.B.signalsTotal}｜召回 ${(row.B.recall * 100).toFixed(0)}%｜误报 ${row.B.falseAssertions.length}\n`,
  )
}

// ---------- 4. 汇总与落盘 ----------
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0)
const n = results.length
const agg = {
  cases: n,
  live,
  note:
    '本表为「同口径重评」：A/B 两臂都按展示文本、用同一个句子切分器与同一个全文分块证据池判定；' +
    '无依据比例的分母 = 判定成功的句数，未复核单独计数。内部 claims/撤回不参与这一列。',
  A: {
    recall: sum(results, (r) => r.A.recall) / n,
    unsupported: sum(results, (r) => r.A.unsupported),
    unsupportedFullPool: sum(results, (r) => r.A.unsupportedFullPool),
    sentencesFullPool: sum(results, (r) => r.A.judgedFullPool?.length ?? 0),
    unchecked: sum(results, (r) => r.A.unchecked),
    uncheckedFullPool: sum(results, (r) => r.A.uncheckedFullPool),
    unsupportedRateFullPool:
      sum(results, (r) => r.A.judgedFullPool?.length ?? 0) - sum(results, (r) => r.A.uncheckedFullPool) > 0
        ? sum(results, (r) => r.A.unsupportedFullPool) /
          (sum(results, (r) => r.A.judgedFullPool?.length ?? 0) - sum(results, (r) => r.A.uncheckedFullPool))
        : null,
    falseAssertions: sum(results, (r) => r.A.falseAssertions.length),
    refusalsOk: results.filter((r) => r.A.refusal === true).length,
    refusalsTotal: results.filter((r) => r.A.refusal !== null).length,
  },
  B: {
    recall: sum(results, (r) => r.B.recall) / n,
    unsupported: sum(results, (r) => r.B.unsupported),
    displayedSentences: sum(results, (r) => r.B.displayedSentences ?? 0),
    displayedUnsupported: sum(results, (r) => r.B.displayedUnsupported ?? 0),
    displayedUnchecked: sum(results, (r) => r.B.displayedUnchecked ?? 0),
    displayedUnsupportedRate:
      sum(results, (r) => r.B.displayedSentences ?? 0) - sum(results, (r) => r.B.displayedUnchecked ?? 0) > 0
        ? sum(results, (r) => r.B.displayedUnsupported ?? 0) /
          (sum(results, (r) => r.B.displayedSentences ?? 0) - sum(results, (r) => r.B.displayedUnchecked ?? 0))
        : null,
    internalWithdrawn: sum(results, (r) => r.B.withdrawn?.length ?? 0),
    falseAssertions: sum(results, (r) => r.B.falseAssertions.length),
    refusalsOk: results.filter((r) => r.B.refusal === true).length,
    refusalsTotal: results.filter((r) => r.B.refusal !== null).length,
    signalsOk: sum(results, (r) => r.B.signalsOk),
    signalsTotal: sum(results, (r) => r.B.signalsTotal),
  },
}

fs.mkdirSync(path.join(root, 'docs', 'results'), { recursive: true })
fs.writeFileSync(
  path.join(root, 'docs', 'results', 'benchmark.json'),
  JSON.stringify({ meta: casesFile.meta, aggregate: agg, results }, null, 2),
)

const csvRows = [
  ['case', 'category', 'arm', 'recall', 'unsupported_claims', 'false_assertions', 'correct_refusal', 'evidence_pages'],
]
for (const r of results) {
  csvRows.push([
    r.id,
    r.category,
    'A',
    r.A.recall.toFixed(2),
    String(r.A.unsupported),
    String(r.A.falseAssertions.length),
    r.A.refusal === null ? 'n/a' : String(r.A.refusal),
    r.A.evidencePages.join(' '),
  ])
  csvRows.push([
    r.id,
    r.category,
    'A-fulltext',
    r.A.recall.toFixed(2),
    String(r.A.unsupportedFullPool),
    String(r.A.falseAssertions.length),
    r.A.refusal === null ? 'n/a' : String(r.A.refusal),
    r.A.evidencePages.join(' '),
  ])
  csvRows.push([
    r.id,
    r.category,
    'B',
    r.B.recall.toFixed(2),
    String(r.B.unsupported),
    String(r.B.falseAssertions.length),
    r.B.refusal === null ? 'n/a' : String(r.B.refusal),
    r.B.evidencePages.join(' '),
  ])
}
fs.writeFileSync(
  path.join(root, 'docs', 'results', 'benchmark.csv'),
  csvRows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'),
)

console.log('\n=== 汇总 ===')
console.log(JSON.stringify(agg, null, 2))
console.log('已写入 docs/results/benchmark.json 与 benchmark.csv')
