/**
 * 论文复现避坑助手 · 后端服务（零依赖，仅用 Node 内置模块）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 托管前端构建产物 dist/（单进程即可完整运行）
 *   2. POST /api/extract  真实字段抽取（模型 + 服务端引用校验）
 *   3. POST /api/ask      真实问答（模型 + 服务端引用校验）
 *   4. GET  /api/health   给前端探测后端与模型是否可用
 *
 * 密钥只从环境变量读取，不会写入前端、不会写进仓库、不会打进日志。
 *
 * 启动： node server/index.mjs            （默认 8787 端口，同时托管 dist）
 *        PORT=9000 node server/index.mjs
 *
 * 必要环境变量（二选一，缺省会直接读平台已有的 ANTHROPIC_* ）：
 *   LLM_API_KEY   / ANTHROPIC_AUTH_TOKEN   模型密钥
 *   LLM_BASE_URL  / ANTHROPIC_BASE_URL     接口地址
 *   LLM_MODEL                              模型名（可选）
 *   LLM_API_STYLE  anthropic | openai      （默认 anthropic）
 * 可选：
 *   API_ACCESS_TOKEN   给 /api/* 加一个访问口令（前端在设置里填写）
 *   ALLOW_ORIGIN       允许跨域的来源（默认 *，部署上线时建议收紧）
 *   MAX_PAPER_CHARS    单次送入模型的正文上限，默认 90000
 */
import { envReport } from './loadenv.mjs'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { answerQuestion, callModelText, extractFields, judgePlainClaims, llmStatus, planLabExperiment, rawAsk, recheckField } from './llm.mjs'
import { analyzeMethod } from './analyze.mjs'
import { synthesizeDirections } from './directions.mjs'
import { cancelDetective, runDetective } from './detective.mjs'
import { buildClashCards, labSupportFor } from './clash.mjs'
import {
  DATA_SPLIT_ID as PM_DATA_SPLIT_ID,
  PAPER_METHODS as PM_PAPER_METHODS,
  PAPER_SEEDS as PM_SEEDS,
  PAPER_SOURCE as PM_PAPER_SOURCE,
  PAPER_STRENGTHS as PM_STRENGTHS,
  executePaperRun as pmExecutePaperRun,
  explorePaper as pmExplorePaper,
  listPaperRuns as pmListPaperRuns,
  buildPaperFindings as pmBuildPaperFindings,
  buildPaperComparison as pmBuildPaperComparison,
  caseToConfig as pmCaseToConfig,
  caseToMarkdown as pmCaseToMarkdown,
  readCachedCase as pmReadCachedCase,
  runReversalCase as pmRunReversalCase,
  officialSplit as pmOfficialSplit,
  paperConsistencyCheck as pmConsistencyCheck,
} from './paperMethods.mjs'
import {
  CONDITION_SPACE as LAB_CONDITION_SPACE,
  CLOSE_GAP_THRESHOLD as LAB_CLOSE_GAP,
  LAB_VERSION,
  SEGMENT_LABEL as LAB_SEGMENT_LABEL,
  REPRO_REQUIREMENTS as LAB_REPRO_REQUIREMENTS,
  buildFindings as labBuildFindings,
  buildMap as labBuildMap,
  buildTranslation as labBuildTranslation,
  cancelExploration as labCancelExploration,
  clearRuns as labClearRuns,
  executeRun as labExecuteRun,
  exploreBudget as labExploreBudget,
  listRuns as labListRuns,
  replicateFinding as labReplicateFinding,
  saveRun as labSaveRun,
  seriesMeta as labSeriesMeta,
  summarizeRuns as labSummarizeRuns,
} from './lab.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '..', 'dist')
const PORT = Number(process.env.PORT || 8787)
// 云端由平台代理转发；本地默认仍只监听回环，避免意外暴露开发服务。
const HOST = process.env.HOST || (process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1')
const ACCESS_TOKEN = process.env.API_ACCESS_TOKEN || ''
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*'
/** 请求体上限：正文 + 字段，给足余量 */
const MAX_BODY = 8 * 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-headers': 'content-type,authorization,x-access-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_BODY' }))
      }
    })
    req.on('error', reject)
  })
}

/** 把 pages 参数规范化，并做基本校验 */
function sanitizePages(input, { maxPages = 400 } = {}) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const p of input.slice(0, maxPages)) {
    const page = Number(p?.page)
    const text = typeof p?.text === 'string' ? p.text : ''
    if (!Number.isFinite(page) || !text.trim()) continue
    out.push({ page, text })
  }
  out.sort((a, b) => a.page - b.page)
  return out
}

function describeError(e) {
  if (e?.code === 'NO_CREDENTIALS') {
    return {
      status: 503,
      code: 'NO_CREDENTIALS',
      message:
        '后端没有配置模型密钥。请在启动后端时设置 LLM_API_KEY（或 ANTHROPIC_AUTH_TOKEN）与 LLM_BASE_URL，然后重启。',
    }
  }
  if (e?.code === 'TIMEOUT') {
    return { status: 504, code: 'TIMEOUT', message: '模型响应超时，可以稍后重试。' }
  }
  if (e?.code === 'BAD_JSON') {
    return {
      status: 502,
      code: 'BAD_JSON',
      message: '模型没有返回可解析的结构化结果，可以点重试再试一次（这通常是偶发问题）。',
      detail: e.raw,
    }
  }
  if (e?.code === 'LLM_HTTP') {
    return {
      status: 502,
      code: 'LLM_HTTP',
      message: `模型接口报错（HTTP ${e.status}）。请检查密钥、接口地址与模型名是否正确。`,
      detail: String(e.message).slice(0, 300),
    }
  }
  if (e?.code === 'TOO_LARGE') {
    return { status: 413, code: 'TOO_LARGE', message: '请求体过大，请减少同时送入的论文数量。' }
  }
  if (e?.code === 'BAD_BODY') {
    return { status: 400, code: 'BAD_BODY', message: '请求体格式不正确。' }
  }
  return { status: 500, code: 'INTERNAL', message: e?.message || '服务端未知错误' }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ALLOW_ORIGIN,
      'access-control-allow-headers': 'content-type,authorization,x-access-token',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    })
    return res.end()
  }

  if (ACCESS_TOKEN) {
    const token = req.headers['x-access-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (token !== ACCESS_TOKEN) {
      return sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问口令不正确。' })
    }
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    const s = llmStatus()
    return sendJson(res, 200, {
      ok: true,
      backend: 'paper-repro-guard',
      model: s.model,
      apiStyle: s.apiStyle,
      baseUrlHost: s.baseUrlHost,
      hasCredentials: s.hasCredentials,
      requiresAccessToken: Boolean(ACCESS_TOKEN),
      capabilities: { realPdfParsing: true, realLlmExtract: s.hasCredentials, realLlmQa: s.hasCredentials },
      /** 启动配置来源与优先级（只含键名与来源文件名，绝不回传密钥取值） */
      env: envReport(),
    })
  }

  if (url.pathname === '/api/extract' && req.method === 'POST') {
    const body = await readBody(req)
    const pages = sanitizePages(body?.pages)
    if (pages.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        code: 'NO_TEXT',
        message: '没有收到可用的论文正文。请确认 PDF 是文本型（可选中文字），不是扫描图片。',
      })
    }
    const started = Date.now()
    const result = await extractFields({
      pages,
      fileName: String(body?.fileName || 'paper.pdf').slice(0, 200),
      title: body?.title ? String(body.title).slice(0, 300) : undefined,
    })
    return sendJson(res, 200, {
      ok: true,
      ...result,
      elapsedMs: Date.now() - started,
      pagesReceived: pages.length,
    })
  }

  /* ---------------- 方法分析（分类/演进/方向共用） ---------------- */
  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    const body = await readBody(req)
    const pages = sanitizePages(body?.pages)
    if (pages.length === 0) {
      return sendJson(res, 400, { ok: false, code: 'NO_TEXT', message: '没有收到可用的论文正文。' })
    }
    const started = Date.now()
    try {
      const result = await analyzeMethod({
        pages,
        fileName: String(body?.fileName || 'paper.pdf').slice(0, 200),
        title: body?.title ? String(body.title).slice(0, 300) : undefined,
        hint: body?.hint ? String(body.hint).slice(0, 200) : undefined,
      })
      return sendJson(res, 200, { ok: true, ...result, elapsedMs: Date.now() - started })
    } catch (e) {
      return sendJson(res, 200, { ok: false, code: 'ANALYZE_FAILED', message: e instanceof Error ? e.message : '方法分析失败。' })
    }
  }

  /* ---------------- 研究方向综合（模型建议 + 前端程序复核） ---------------- */
  if (url.pathname === '/api/directions/synthesize' && req.method === 'POST') {
    const body = await readBody(req)
    const directions = Array.isArray(body?.directions) ? body.directions.slice(0, 6) : []
    if (directions.length === 0) {
      return sendJson(res, 400, { ok: false, code: 'NO_DIRECTIONS', message: '没有可供综合的候选研究方向。' })
    }
    try {
      const result = await synthesizeDirections({
        domain: body?.domain,
        papers: Array.isArray(body?.papers) ? body.papers.slice(0, 20) : [],
        directions,
      })
      return sendJson(res, 200, { ok: true, ...result })
    } catch (e) {
      const info = describeError(e)
      return sendJson(res, info.status, { ok: false, code: info.code, message: info.message, detail: info.detail })
    }
  }

  if (url.pathname === '/api/recheck-field' && req.method === 'POST') {
    const body = await readBody(req)
    const pages = sanitizePages(body?.pages)
    const key = String(body?.key || '').trim()
    if (pages.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        code: 'NO_TEXT',
        message: '这篇论文的正文不在本地（可能已被清理）。可以先在详情页点「重新解析」恢复正文，再补查这一项。',
      })
    }
    if (!key) {
      return sendJson(res, 400, { ok: false, code: 'NO_FIELD', message: '没有指定要补查的字段。' })
    }
    const started = Date.now()
    try {
      const result = await recheckField({
        pages,
        key,
        fileName: String(body?.fileName || 'paper.pdf').slice(0, 200),
        title: body?.title ? String(body.title).slice(0, 300) : undefined,
      })
      return sendJson(res, 200, { ok: true, ...result, elapsedMs: Date.now() - started })
    } catch (e) {
      return sendJson(res, 200, {
        ok: false,
        code: 'RECHECK_FAILED',
        message: e instanceof Error ? e.message : '补查失败。已保留原有取值与证据。',
      })
    }
  }

  /* ---------------- 小咕实验室 ---------------- */
  if (url.pathname === '/api/lab/meta' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, ...labSeriesMeta() })
  }

  if (url.pathname === '/api/lab/runs' && req.method === 'GET') {
    const allRuns = labListRuns()
    const type = String(url.searchParams.get('perturbationType') || 'noise')
    const family = url.searchParams.get('family') === 'paper-linear' ? 'paper-linear' : 'teaching'
    const runs = allRuns.filter((r) => (r.family ?? 'teaching') === family)
    return sendJson(res, 200, {
      ok: true,
      family,
      runs,
      map: labBuildMap(allRuns, type, family),
      findings: family === 'paper-linear' ? pmBuildPaperFindings(allRuns) : labBuildFindings(allRuns),
      summary: labSummarizeRuns(runs),
      conditionSpace: LAB_CONDITION_SPACE,
      closeGapThreshold: LAB_CLOSE_GAP,
      labVersion: LAB_VERSION,
      segments: LAB_SEGMENT_LABEL,
      reproRequirements: LAB_REPRO_REQUIREMENTS,
    })
  }

  /** 结论转译器：论文结论 → 可执行代理实验 → 适用边界（等级由程序判定） */
  if (url.pathname === '/api/lab/translate' && req.method === 'POST') {
    const body = await readBody(req)
    const runs = labListRuns()
    const card = labBuildTranslation({
      papers: Array.isArray(body?.papers) ? body.papers.slice(0, 3) : [],
      claim: body?.claim ? { text: String(body.claim.text || '').slice(0, 400), source: String(body.claim.source || 'user') } : null,
      config: body?.config ?? null,
      dataSource: body?.dataSource ?? null,
      runs,
    })
    return sendJson(res, 200, { ok: true, card, reproRequirements: LAB_REPRO_REQUIREMENTS })
  }

  /** 在独立时间段复验某个发现 */
  if (url.pathname === '/api/lab/replicate' && req.method === 'POST') {
    const body = await readBody(req)
    const runs = labListRuns()
    const findings = labBuildFindings(runs)
    const finding = body?.findingId ? findings.find((f) => f.id === body.findingId) : findings[0]
    if (!finding) {
      return sendJson(res, 200, { ok: false, error: '当前没有可复验的发现（需要探索段上至少两个跨度的结果）。' })
    }
    const result = await labReplicateFinding({
      finding,
      claim: body?.claim ? { text: String(body.claim.text || '').slice(0, 300), source: String(body.claim.source || 'user') } : null,
    })
    return sendJson(res, 200, { ...result, finding })
  }

  if (url.pathname === '/api/lab/run' && req.method === 'POST') {
    const body = await readBody(req)
    const record = await labExecuteRun(body?.config ?? {}, {
      origin: body?.origin === 'explore' ? 'explore' : 'manual',
      claim: body?.claim
        ? { text: String(body.claim.text || '').slice(0, 300), source: String(body.claim.source || 'user') }
        : null,
    })
    return sendJson(res, 200, { ok: record.status === 'done', record })
  }

  if (url.pathname === '/api/lab/explore' && req.method === 'POST') {
    const body = await readBody(req)
    const result = await labExploreBudget({
      claim: body?.claim ? String(body.claim.text || '').slice(0, 300) : null,
      budget: body?.budget,
      perturbationType: body?.perturbationType === 'missing' ? 'missing' : 'noise',
      explorationId: body?.explorationId ? String(body.explorationId).slice(0, 60) : undefined,
    })
    return sendJson(res, 200, { ok: true, ...result })
  }

  /* ---------------- 官方论文方法（DLinear / Linear） ---------------- */
  if (url.pathname === '/api/lab/paper/methods' && req.method === 'GET') {
    const trained = pmListPaperRuns()
    const latest = {}
    for (const r of trained) if (!latest[r.method]) latest[r.method] = r.runId
    return sendJson(res, 200, {
      ok: true,
      methods: PM_PAPER_METHODS,
      trained,
      latestRunIds: latest,
      comparison: pmBuildPaperComparison(trained),
      paperSource: PM_PAPER_SOURCE,
      split: pmOfficialSplit(336),
      strengths: PM_STRENGTHS,
      seeds: PM_SEEDS,
      dataSplitId: PM_DATA_SPLIT_ID,
      paper: {
        title: 'Are Transformers Effective for Time Series Forecasting?',
        venue: 'AAAI 2023',
        repo: 'https://github.com/cure-lab/LTSF-Linear',
        sha: PM_PAPER_METHODS.DLinear.sha,
        license: 'MIT',
        textAvailable: false,
        note: '本作品未上传该论文正文，因此不显示逐字引用与页码；方法说明来自论文元信息与官方仓库实现。',
      },
    })
  }

  if (url.pathname === '/api/lab/paper/run' && req.method === 'POST') {
    const body = await readBody(req)
    const trained = pmListPaperRuns()
    const latest = {}
    for (const r of trained) if (!latest[r.method]) latest[r.method] = r.runId
    const record = pmExecutePaperRun(
      {
        runIds: { DLinear: body?.runIds?.DLinear || latest.DLinear, Linear: body?.runIds?.Linear || latest.Linear },
        perturbationType: body?.perturbationType === 'missing' ? 'missing' : 'noise',
        strength: Number(body?.strength ?? 0),
        seed: Number(body?.seed ?? 11),
        sliceKey: body?.sliceKey === 'consistency' ? 'consistency' : body?.sliceKey === 'all' ? 'all' : 'explore',
        stride: 8,
        maxWindows: 40,
      },
      {
        origin: 'manual',
        claim: body?.claim ? { text: String(body.claim.text || '').slice(0, 300), source: String(body.claim.source || 'user') } : null,
      },
      { saveRun: labSaveRun },
    )
    return sendJson(res, 200, { ok: record.status === 'done', record })
  }

  if (url.pathname === '/api/lab/paper/explore' && req.method === 'POST') {
    const body = await readBody(req)
    const trained = pmListPaperRuns()
    const latest = {}
    for (const r of trained) if (!latest[r.method]) latest[r.method] = r.runId
    const result = await pmExplorePaper({
      budget: body?.budget,
      claim: body?.claim ? { text: String(body.claim.text || '').slice(0, 300), source: String(body.claim.source || 'user') } : null,
      runIds: { DLinear: latest.DLinear, Linear: latest.Linear },
      perturbationType: body?.perturbationType === 'missing' ? 'missing' : 'noise',
      explorationId: body?.explorationId ? String(body.explorationId).slice(0, 60) : undefined,
      deps: { listRuns: labListRuns, saveRun: labSaveRun },
      planLabExperiment: (payload) => planLabExperiment(payload),
    })
    return sendJson(res, 200, result)
  }

  if (url.pathname === '/api/lab/paper/consistency' && req.method === 'POST') {
    const body = await readBody(req)
    const trained = pmListPaperRuns()
    const latest = {}
    for (const r of trained) if (!latest[r.method]) latest[r.method] = r.runId
    const result = pmConsistencyCheck({
      runIds: { DLinear: latest.DLinear, Linear: latest.Linear },
      perturbationType: body?.perturbationType === 'missing' ? 'missing' : 'noise',
      strengths: Array.isArray(body?.strengths) && body.strengths.length ? body.strengths.map(Number).slice(0, 5) : [0, 0.1, 0.2],
      seed: Number(body?.seed ?? 11),
      saveRun: labSaveRun,
      claim: body?.claim ? { text: String(body.claim.text || '').slice(0, 300), source: String(body.claim.source || 'user') } : null,
    })
    return sendJson(res, 200, result)
  }

  /* ---------------- 核心案例：换个时间段，领先者会变吗？ ---------------- */
  if (url.pathname === '/api/lab/case/reversal' && req.method === 'GET') {
    const cachedOnly = url.searchParams.get('cached') === '1'
    const trained = pmListPaperRuns()
    const latest = {}
    for (const r of trained) if (!latest[r.method]) latest[r.method] = r.runId
    const runIds = { DLinear: latest.DLinear, Linear: latest.Linear }
    if (!runIds.DLinear || !runIds.Linear) {
      return sendJson(res, 200, { ok: false, code: 'NO_WEIGHTS', message: '还没有训练好的官方权重，先在开发环境运行训练脚本。' })
    }
    if (cachedOnly) {
      const cached = pmReadCachedCase()
      if (cached) return sendJson(res, 200, { ok: true, source: 'cached', case: cached })
      return sendJson(res, 200, { ok: false, code: 'NO_CACHE', message: '还没有实测结果，请点「重新运行两个时间段」。' })
    }
    const fresh = pmRunReversalCase({ runIds })
    return sendJson(res, 200, { ok: true, source: 'fresh', case: fresh })
  }

  if (url.pathname === '/api/lab/case/reversal/export' && req.method === 'GET') {
    const format = String(url.searchParams.get('format') || 'md')
    const trained = pmListPaperRuns()
    const latest = {}
    for (const r of trained) if (!latest[r.method]) latest[r.method] = r.runId
    const caseData = pmReadCachedCase() || pmRunReversalCase({ runIds: { DLinear: latest.DLinear, Linear: latest.Linear } })
    if (format === 'json') {
      const body = JSON.stringify({ case: caseData, config: JSON.parse(pmCaseToConfig(caseData)) }, null, 2)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="reversal-case.json"' })
      res.end(body)
      return true
    }
    const md = pmCaseToMarkdown(caseData)
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="reversal-case.md"' })
    res.end(md)
    return true
  }

  /* ---------------- 小咕侦探：为缺失字段主动找复现线索 ---------------- */
  if (url.pathname === '/api/detective/run' && req.method === 'POST') {
    const body = await readBody(req)
    const pages = Array.isArray(body?.pages)
      ? body.pages
          .slice(0, 400)
          .map((p) => ({ page: Number(p?.page) || 0, section: p?.section ? String(p.section).slice(0, 60) : null, text: String(p?.text || '').slice(0, 40000) }))
      : []
    try {
      const result = await runDetective({
        paper: { fields: body?.fields && typeof body.fields === 'object' ? body.fields : {} },
        fieldKey: String(body?.fieldKey || ''),
        dataset: body?.dataset ? String(body.dataset).slice(0, 40) : null,
        model: body?.model ? String(body.model).slice(0, 40) : null,
        horizon: body?.horizon != null && body.horizon !== '' ? Number(body.horizon) : null,
        pages,
        taskId: body?.taskId ? String(body.taskId).slice(0, 60) : undefined,
        llmCall: llmStatus().hasCredentials ? (payload) => callModelText(payload) : null,
      })
      return sendJson(res, 200, result)
    } catch (e) {
      return sendJson(res, 200, { ok: false, reason: describeError(e), code: e?.code || 'DETECTIVE_FAILED' })
    }
  }

  if (url.pathname === '/api/detective/cancel' && req.method === 'POST') {
    const body = await readBody(req)
    const ok = cancelDetective(String(body?.taskId || ''))
    return sendJson(res, 200, { ok, cancelled: ok, note: ok ? '已请求取消，已经找到的线索会保留。' : '这个任务已经结束。' })
  }

  /* ---------------- 论文对撞台：把差异组织成研究问题 ---------------- */
  if (url.pathname === '/api/clash/build' && req.method === 'POST') {
    const body = await readBody(req)
    const papers = Array.isArray(body?.papers) ? body.papers.slice(0, 3) : []
    const result = buildClashCards({ papers, maxCards: Number(body?.maxCards) || 3 })
    const methods = papers
      .flatMap((p) => String(p?.fields?.method?.value || '').split(/[、,，;；/|]/))
      .map((s) => s.trim())
      .filter(Boolean)
    return sendJson(res, 200, { ...result, labSupport: labSupportFor(methods) })
  }

  if (url.pathname === '/api/lab/case/reversal/setup' && req.method === 'GET') {
    const trainedRuns = pmListPaperRuns()
    const latestOf = {}
    for (const r of trainedRuns) if (!latestOf[r.method]) latestOf[r.method] = r.runId
    const splitInfo = pmOfficialSplit(336)
    return sendJson(res, 200, {
      ok: true,
      caseId: 'reversal',
      title: '换个时间段，领先者会变吗？',
      question: '同一对 DLinear 与 Linear 权重、同样的设置，只改变测试时间段，领先方会不会变？',
      weights: { DLinear: latestOf.DLinear ?? null, Linear: latestOf.Linear ?? null },
      settings: { dataset: 'ETTm2', target: 'OT', seqLen: 336, predLen: 96, perturbation: '无扰动（strength 0）', seed: 11, samplingStride: 8 },
      slices: {
        explore: {
          range: [splitInfo.customSlices.explore.usedStart, splitInfo.customSlices.explore.usedEnd],
          dates: { start: splitInfo.customSlices.explore.startDate, end: splitInfo.customSlices.explore.endDate },
          label: '探索段',
        },
        consistency: {
          range: [splitInfo.customSlices.consistency.usedStart, splitInfo.customSlices.consistency.usedEnd],
          dates: { start: splitInfo.customSlices.consistency.startDate, end: splitInfo.customSlices.consistency.endDate },
          label: '另一时间段',
        },
      },
      note: '这里只给出条件，不含任何结果；结果只有在你点击「运行并揭晓」或「查看历史结果」时才会出现。',
    })
  }

  if (url.pathname === '/api/lab/cancel' && req.method === 'POST') {
    const body = await readBody(req)
    const id = String(body?.explorationId || '')
    return sendJson(res, 200, { ok: true, cancelled: labCancelExploration(id), explorationId: id })
  }

  if (url.pathname === '/api/lab/clear' && req.method === 'POST') {
    labClearRuns()
    return sendJson(res, 200, { ok: true })
  }

  if (url.pathname === '/api/ask' && req.method === 'POST') {
    const body = await readBody(req)
    const question = String(body?.question || '').trim()
    if (!question) {
      return sendJson(res, 400, { ok: false, code: 'NO_QUESTION', message: '问题不能为空。' })
    }
    const papers = Array.isArray(body?.papers)
      ? body.papers
          .map((p) => ({
            id: String(p?.id || ''),
            shortLabel: String(p?.shortLabel || 'P'),
            title: String(p?.title || ''),
            pages: sanitizePages(p?.pages),
          }))
          .filter((p) => p.id && p.pages.length > 0)
      : []
    if (papers.length === 0) {
      return sendJson(res, 400, {
        ok: false,
        code: 'NO_TEXT',
        message: '所选论文没有可用的正文文本。请先上传文本型 PDF 并完成解析。',
      })
    }
    const started = Date.now()
    const result = await answerQuestion({ question: question.slice(0, 500), papers, context: body?.context })
    return sendJson(res, 200, {
      ok: true,
      ...result,
      elapsedMs: Date.now() - started,
      papersUsed: papers.map((p) => ({ id: p.id, shortLabel: p.shortLabel, pages: p.pages.length })),
    })
  }

  /**
   * 对照实验专用：裸模型问答（无引用校验、无结论支持判定）。
   * 用于 benchmark 里「直接把论文丢给模型提问」的基线，不属于产品功能。
   */
  if (url.pathname === '/api/bench/raw-ask' && req.method === 'POST') {
    const body = await readBody(req)
    const question = String(body?.question || '').trim()
    if (!question) {
      return sendJson(res, 400, { ok: false, code: 'NO_QUESTION', message: '问题不能为空。' })
    }
    const papers = Array.isArray(body?.papers)
      ? body.papers
          .map((p) => ({
            id: String(p?.id || ''),
            shortLabel: String(p?.shortLabel || 'P'),
            title: String(p?.title || ''),
            pages: sanitizePages(p?.pages),
          }))
          .filter((p) => p.id && p.pages.length > 0)
      : []
    if (papers.length === 0) {
      return sendJson(res, 400, { ok: false, code: 'NO_TEXT', message: '没有可用正文。' })
    }
    const started = Date.now()
    const result = await rawAsk({ question: question.slice(0, 500), papers })
    return sendJson(res, 200, { ok: true, ...result, elapsedMs: Date.now() - started })
  }

  /** 对照实验专用：用与产品相同的判定逻辑复核"裸模型结论"是否被原文支持 */
  if (url.pathname === '/api/bench/judge-claims' && req.method === 'POST') {
    const body = await readBody(req)
    const claims = Array.isArray(body?.claims) ? body.claims.filter((c) => typeof c === 'string') : []
    const evidence = Array.isArray(body?.evidence)
      ? body.evidence
          .map((e) => ({
            evidenceId: String(e?.evidenceId || ''),
            shortLabel: String(e?.shortLabel || ''),
            page: Number(e?.page) || 0,
            // 评估链路曾经把每条证据截到 400 字符、最多 30 条 —— "全文证据"其实被削掉了大半。
            // 现在按 4000 字符 / 200 条收，保证"未检索到支持"更接近"原文确实没有"。
            quote: String(e?.quote || '').slice(0, 4000),
          }))
          .filter((e) => e.quote)
      : []
    if (claims.length === 0) {
      return sendJson(res, 400, { ok: false, code: 'NO_CLAIMS', message: '没有待复核的结论。' })
    }
    const result = await judgePlainClaims({ claims: claims.slice(0, 20), evidence: evidence.slice(0, 200) })
    return sendJson(res, 200, { ok: true, ...result })
  }

  return sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `未知接口 ${url.pathname}` })
}

function handleStatic(req, res, url) {
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end(
      '后端已启动，但还没有前端构建产物。\n请先执行 npm run build，然后重新打开本页面。\n（接口仍可用：GET /api/health）',
    )
  }
  const urlPath = decodeURIComponent(url.pathname)
  let filePath = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath)
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html')
  }
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  })
  fs.createReadStream(filePath).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    handleStatic(req, res, url)
  } catch (e) {
    const info = describeError(e)
    // 只记录错误码与消息，不记录密钥与正文
    console.error(`[api] ${info.code}: ${info.message}`)
    if (!res.headersSent) sendJson(res, info.status, { ok: false, ...info })
    else res.end()
  }
})

server.listen(PORT, HOST, () => {
  const s = llmStatus()
  console.log(`[paper-repro-guard] 服务已启动： http://${HOST}:${PORT}/`)
  console.log(`[paper-repro-guard] 前端产物： ${fs.existsSync(DIST) ? DIST : '（尚未构建，请先 npm run build）'}`)
  console.log(
    `[paper-repro-guard] 模型：${s.model}（${s.apiStyle}，${s.baseUrlHost || '未配置地址'}），密钥：${
      s.hasCredentials ? '已配置' : '未配置'
    }`,
  )
})
