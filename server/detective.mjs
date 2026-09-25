/**
 * 小咕侦探：主动为"待核对"的字段寻找复现线索
 * ==================================================================
 * 定位：字段抽取是"这篇论文里写了什么"，侦探是"为了复现，这个缺失的值还能从哪儿找到"。
 *
 * 来源顺序（严格按此顺序，且每一步都记录来源）：
 *   论文正文 → 论文附录 → 官方仓库说明 → 官方实验脚本与配置
 *
 * 硬性约束（本轮重点，防止张冠李戴）：
 *  1) 只读**允许的公开来源**：本机里固定提交的官方仓库副本，或 raw.githubusercontent.com 上
 *     同一仓库、同一提交的原始文件；不读密钥文件、不抓取本地/内网地址、不执行下载的脚本。
 *  2) 按字段 + 当前数据集 + 模型家族**选择相关文件**，不把整个仓库丢给模型（有文件数/字节数上限）。
 *  3) 代码线索必须能**逐字回查**到文件里的那一行；回查不到一律剔除。
 *  4) **数据集归属校验**：给 ETTm2 找线索时，ettm1/etth1/etth2 脚本里的值只能作为
 *     "别的数据集的值"标出来，不能被当成当前数据集的设置。
 *  5) 取值必须带**适用范围**（方法/数据集/任务/预测跨度），单跨度脚本（如 *_96.sh 段）的值
 *     标注为"仅该跨度成立"，不当作全部实验的统一设置。
 *  6) 仓库当前默认值（如 run_longExp.py 的 argparse 默认值）只能标为
 *     "仓库当前默认值（不能证明论文发表时使用）"。
 *  7) 代码证据**不是**论文原文：sourceType 只能是 paper / official-code，不得混称。
 *  8) 绝不自动覆盖字段或人工修改；采用动作由用户点击"用于当前复现配置"后写入派生配置层。
 *  9) 找不到就说找不到：明确列出实际查过的来源清单，并给出下一步。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeText } from './llm.mjs'

// fileURLToPath 会正确解码 Windows 路径里的中文和空格；直接使用 URL.pathname
// 会留下 %E8%AE%BA... 这类转义，导致便携版找不到随包附带的官方仓库。
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 允许的官方仓库（当前只支持项目已关联的这一条） */
export const ALLOWED_REPOS = [
  {
    key: 'ltsf-linear',
    name: 'cure-lab/LTSF-Linear',
    url: 'https://github.com/cure-lab/LTSF-Linear',
    sha: '0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6',
    license: 'MIT',
    localDir: join(ROOT, 'third_party', 'LTSF-Linear-0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6'),
    models: ['DLinear', 'Linear', 'NLinear'],
  },
]

/** 侦探支持的字段（第一版聚焦这些） */
export const DETECTIVE_FIELDS = [
  { key: 'learningRate', label: '学习率', keywords: ['learning_rate', 'lr', 'learning rate'], kind: 'hyper' },
  { key: 'batchSize', label: '批大小', keywords: ['batch_size', 'batch size', 'batch'], kind: 'hyper' },
  { key: 'epochs', label: '训练轮数', keywords: ['train_epochs', 'epochs', 'epoch'], kind: 'hyper' },
  { key: 'seqLen', label: '输入长度', keywords: ['seq_len', 'look-back window', 'lookback', 'input length'], kind: 'hyper' },
  { key: 'horizon', label: '预测跨度', keywords: ['pred_len', 'horizon', 'forecasting horizon', 'prediction length'], kind: 'hyper' },
  { key: 'split', label: '数据划分', keywords: ['border', '0.6', '0.2', 'train', 'val', 'test', 'split'], kind: 'data' },
  { key: 'preprocessing', label: '预处理 / 归一化', keywords: ['scaler', 'StandardScaler', 'normaliz', 'scale'], kind: 'data' },
]

const LIMITS = { maxFiles: 6, maxExcerpts: 28, maxBytesPerFile: 220 * 1024, maxTotalBytes: 480 * 1024, maxClues: 12, timeoutMs: 12000 }

/** 运行中的侦探任务（支持取消、防重复） */
export const detectiveTasks = new Map()

export function cancelDetective(taskId) {
  const t = detectiveTasks.get(taskId)
  if (!t) return false
  t.cancelled = true
  return true
}

function repoById(key) {
  return ALLOWED_REPOS.find((r) => r.key === key) || ALLOWED_REPOS[0]
}

/** 读官方仓库文件：优先本机固定提交副本，其次 GitHub raw（同一提交） */
async function readRepoFile(repo, relPath, lim = LIMITS) {
  const local = join(repo.localDir, relPath)
  if (existsSync(local)) {
    const text = readFileSync(local, 'utf8').slice(0, lim.maxBytesPerFile)
    return { ok: true, text, source: 'local-pinned-copy', path: relPath, sha: repo.sha, url: `${repo.url}/blob/${repo.sha}/${relPath}` }
  }
  // 网络兜底：只允许这一个仓库、这一个提交的原始文件
  const allowedPrefix = `https://raw.githubusercontent.com/cure-lab/LTSF-Linear/${repo.sha}/`
  const url = `${allowedPrefix}${relPath}`
  if (!url.startsWith(allowedPrefix)) return { ok: false, reason: 'not-allowed' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), lim.timeoutMs)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }
    const text = (await res.text()).slice(0, lim.maxBytesPerFile)
    return { ok: true, text, source: 'github-raw', path: relPath, sha: repo.sha, url }
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network-error' }
  }
}

/** 按数据集 + 模型选择相关脚本（不下载整仓库） */
function planFiles(dataset, model) {
  const ds = String(dataset || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const fam = String(model || '').toLowerCase().includes('linear') ? 'Linear' : 'Linear'
  const files = []
  if (ds) files.push({ path: `scripts/EXP-LongForecasting/${fam}/${ds}.sh`, label: `${dataset} 的官方实验脚本`, priority: 1, dataset })
  files.push({ path: `scripts/EXP-LongForecasting/${fam}/${ds}.sh`, label: '', priority: 1, dataset, skipIfDuplicate: true })
  files.push({ path: 'run_longExp.py', label: '官方入口脚本（含 argparse 默认值）', priority: 2, dataset: null })
  files.push({ path: 'data_provider/data_loader.py', label: '官方数据加载与划分（border 公式、StandardScaler）', priority: 2, dataset: null })
  files.push({ path: 'models/DLinear.py', label: '官方 DLinear 模型定义（移动平均核）', priority: 3, dataset: null })
  files.push({ path: 'README.md', label: '官方仓库说明', priority: 3, dataset: null })
  const seen = new Set()
  return files.filter((f) => {
    if (!f.path || seen.has(f.path)) return false
    seen.add(f.path)
    return true
  })
}

/** 文本里提取与字段关键词相关的片段（带行号） */
function excerptsFor(text, keywords, path) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line || line.length > 400) continue
    const low = line.toLowerCase()
    if (!keywords.some((k) => low.includes(k.toLowerCase()))) continue
    const from = Math.max(0, i - 1)
    const to = Math.min(lines.length - 1, i + 1)
    out.push({ path, line: i + 1, text: lines.slice(from, to + 1).join('\n'), focusLine: line.trim() })
    if (out.length >= 8) break
  }
  return out
}

const KNOWN_DATASETS = ['ettm1', 'ettm2', 'etth1', 'etth2', 'electricity', 'traffic', 'weather', 'exchange', 'ili']

/**
 * 归属解析：给代码线索绑定「仓库版本 / 方法 / 数据集 / 任务 / 预测跨度 / 对应脚本」
 * ------------------------------------------------------------------
 * 规则（按行向上找最近的声明，不用目录名猜方法）：
 *   · 方法：最近的 `model_name=X` 或 `--model X`（官方 ettm2.sh 里写的就是 `model_name=DLinear`，
 *     所以不能因为它放在 `Linear/` 目录下，就把设置算成 Linear 的）；
 *   · 预测跨度：最近的 `--pred_len N`（同一脚本里 96/192/336/720 是不同实验块）；
 *   · 数据集：最近的 `--data_path X.csv` 或 `--data X`；任务：`--features M/U/S`。
 */
const FLAG_DEFS = [
  { key: 'method', re: /(?:--model\s+|\bmodel_name=)\s*"?([A-Za-z0-9_]+)"?/ },
  { key: 'horizon', re: /--pred_len\s+(\d+)/ },
  { key: 'seqLen', re: /(?:--seq_len\s+|\bseq_len=)\s*(\d+)/ },
  { key: 'dataset', re: /--data(?:_path)?\s+"?([A-Za-z0-9_]+)(?:\.csv)?"?/ },
  { key: 'features', re: /--features\s+([A-Z])/ },
  { key: 'batchSize', re: /--batch_size\s+(\d+)/ },
  { key: 'learningRate', re: /--learning_rate\s+([0-9.eE-]+)/ },
  { key: 'epochs', re: /--train_epochs\s+(\d+)/ },
]

function attributionOf(text, line1based, path) {
  const lines = String(text).split(/\r?\n/)
  const idx = Math.max(0, Math.min(lines.length - 1, line1based - 1))
  const found = {}
  for (let i = idx; i >= 0; i -= 1) {
    const line = lines[i]
    for (const def of FLAG_DEFS) {
      if (found[def.key]) continue
      const m = line.match(def.re)
      if (m) found[def.key] = { value: m[1], line: i + 1, declaration: line.trim().slice(0, 120) }
    }
  }
  const isScript = /\.sh$/.test(path)
  const isEntry = /run_longExp\.py$/.test(path)
  return {
    script: path,
    method: found.method?.value ?? null,
    methodFrom: found.method ? { line: found.method.line, declaration: found.method.declaration } : null,
    horizon: found.horizon ? Number(found.horizon.value) : null,
    seqLen: found.seqLen ? Number(found.seqLen.value) : null,
    dataset: found.dataset?.value ?? null,
    features: found.features?.value ?? null,
    task: found.features
      ? `${found.features.value === 'M' ? 'multivariate' : found.features.value === 'U' ? 'univariate' : 'multivariate-single'} long-term forecasting`
      : 'long-term forecasting（未读到 features）',
    status: isScript && found.method ? 'script-explicit' : isEntry ? 'repo-default' : 'file-level',
    scopeNote: isScript
      ? '来自官方实验脚本的具体实验块（方法/跨度以最近的声明为准）'
      : isEntry
        ? '来自官方入口脚本的 argparse 默认值 —— **不能证明论文发表时使用的就是该值**'
        : '来自官方模型/数据代码文件，属于实现细节，不是某次实验的运行设置',
  }
}

/** 找实验脚本里对同一字段的显式覆盖（同方法 + 同跨度块） */
function findOverride(scriptText, path, flagName, method, horizon) {
  if (!scriptText) return null
  const def = FLAG_DEFS.find((d) => d.key === flagName)
  if (!def) return null
  const lines = String(scriptText).split(/\r?\n/)
  let blockMethod = null
  let blockHorizon = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const mm = line.match(FLAG_DEFS[0].re)
    if (mm) blockMethod = mm[1]
    const mh = line.match(FLAG_DEFS[1].re)
    if (mh) blockHorizon = Number(mh[1])
    const mv = line.match(def.re)
    if (mv && def.key !== 'method' && def.key !== 'horizon') {
      const sameMethod = !method || !blockMethod || blockMethod.toLowerCase() === String(method).toLowerCase()
      const sameHorizon = !horizon || !blockHorizon || blockHorizon === horizon
      if (sameMethod && sameHorizon) {
        return { script: path, line: i + 1, value: mv[1], method: blockMethod, horizon: blockHorizon, declaration: line.trim().slice(0, 120) }
      }
    }
  }
  return null
}

/** 方法归属核对：这条脚本块的默认方法是不是当前要找的方法 */
function methodMatchOf(requested, clueMethod) {
  if (!requested) return { ok: true, requested: null, clueMethod, note: '这次没有指定方法，采用前请自行确认归属' }
  if (!clueMethod) {
    return { ok: false, requested, clueMethod: null, note: '这个片段里没有方法声明（可能来自入口脚本或模型代码），不能直接当成某个方法的实验配置' }
  }
  const same = String(requested).toLowerCase() === String(clueMethod).toLowerCase()
  return {
    ok: same,
    requested,
    clueMethod,
    note: same
      ? `该片段所在实验块的默认方法就是 ${clueMethod}`
      : `该片段所在实验块的默认方法是 ${clueMethod}，不是 ${requested}；要用在 ${requested} 上需要确认脚本是否显式切换了 --model，否则只能算"用户选择的新设置"`,
  }
}

function datasetKnown(ds) {
  return Boolean(ds) && KNOWN_DATASETS.includes(String(ds).toLowerCase().replace(/[^a-z0-9]/g, ''))
}

function findDatasetMentions(text) {
  const low = text.toLowerCase()
  return KNOWN_DATASETS.filter((d) => low.includes(d))
}

/** 从论文页文本里找字段相关的句子（带页码/章节） */
function paperSentencesForKey(pages, fieldDef, dataset) {
  const out = []
  const kws = fieldDef.keywords.map((k) => k.toLowerCase())
  for (const p of pages || []) {
    const text = String(p.text || '')
    const parts = text.split(/(?<=[.!?;])\s+/)
    for (const s of parts) {
      const low = s.toLowerCase()
      if (!kws.some((k) => low.includes(k))) continue
      if (s.length < 24 || s.length > 400) continue
      out.push({ page: p.page, section: p.section || null, text: s.trim(), hasDataset: dataset ? low.includes(String(dataset).toLowerCase()) : false })
      if (out.length >= 10) break
    }
    if (out.length >= 10) break
  }
  return out
}

const CLUE_LINE_RE = /^([^|]+)\|([^|]+)\|([^|]+)\|([^|]*)$/

function parseClueLines(text) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*\d.\s]+/, '')
    if (!line || line.startsWith('#')) continue
    const m = line.match(CLUE_LINE_RE)
    if (!m) continue
    const [, field, value, srcKind, note] = m
    out.push({
      field: normalizeText(field).replace(/\s+/g, ''),
      value: value.trim(),
      srcKind: normalizeText(srcKind).toLowerCase().includes('code') ? 'official-code' : 'paper',
      note: (note || '').trim(),
    })
    if (out.length >= LIMITS.maxClues) break
  }
  return out
}

/** 程序校验一条代码线索：片段必须能在文件里逐字找到 */
function verifyCodeClue(clue, fileCache, dataset, model) {
  const path = clue.path
  const cached = fileCache.get(path)
  if (!cached || !cached.ok) return { ok: false, reason: '文件没有读到' }
  const hay = normalizeText(cached.text)
  const needle = normalizeText(clue.snippet || '')
  if (!needle || needle.length < 6) return { ok: false, reason: '片段太短，无法核对' }
  const found = hay.includes(needle)
  if (!found) return { ok: false, reason: '该片段在文件里找不到（逐字回查失败）' }
  const mentions = findDatasetMentions(cached.text)
  const ds = String(dataset || '').toLowerCase()
  const foreign = mentions.filter((m) => m !== ds && !cached.text.toLowerCase().includes(`--data_path ${ds}.csv`))
  const crossDataset = ds && mentions.length > 0 && !mentions.includes(ds)
  return { ok: true, crossDataset, foreignMentions: foreign, mentions, model, dataset }
}

/** 统一的代码线索构造：把归属、方法核对、默认值覆盖信息一起带上 */
function buildCodeClue({ id, fieldKey, value, snippet, path, line, attr, methodMatch, override, repo, requestedDataset, note }) {
  const mentions = findDatasetMentions(snippet)
  const ds = String(requestedDataset || '').toLowerCase()
  const cross = ds && mentions.length > 0 && !mentions.includes(ds)
  const scriptDataset = attr.dataset ? attr.dataset.toLowerCase() : null
  const datasetMismatch = ds && scriptDataset && scriptDataset !== ds
  const confirmed = attr.status === 'script-explicit' && methodMatch.ok && !cross && !datasetMismatch && !override
  const scopeBits = []
  if (cross) scopeBits.push(`⚠️ 这段属于 ${mentions[0]}，不是当前数据集 ${requestedDataset}`)
  else if (datasetMismatch) scopeBits.push(`⚠️ 这段脚本对应数据集 ${attr.dataset}，不是当前数据集 ${requestedDataset}`)
  if (!datasetKnown(requestedDataset) && !cross) scopeBits.push('当前未确认数据集')
  scopeBits.push(attr.scopeNote)
  if (!methodMatch.ok) scopeBits.push(methodMatch.note)
  if (override) scopeBits.push(`该值被实验脚本覆盖：${override.script}:${override.line} 使用 ${override.value}（方法 ${override.method ?? '—'}，跨度 ${override.horizon ?? '—'}）`)

  return {
    id,
    field: fieldKey,
    value,
    appliesTo: {
      method: attr.method ?? null,
      dataset: cross ? mentions[0] : attr.dataset ?? requestedDataset ?? null,
      task: attr.task,
      horizon: attr.horizon ?? null,
    },
    sourceType: 'official-code',
    evidence: { kind: 'code', path, line, snippet, sha: repo.sha, url: `${repo.url}/blob/${repo.sha}/${path}#L${line}` },
    // 归属绑定：仓库版本 / 方法 / 数据集 / 任务 / 预测跨度 / 对应脚本
    binding: {
      repo: repo.name,
      repoUrl: repo.url,
      sha: repo.sha,
      license: repo.license,
      script: path,
      line,
      method: attr.method,
      methodDeclaredAt: attr.methodFrom,
      dataset: cross ? mentions[0] : attr.dataset ?? requestedDataset ?? null,
      task: attr.task,
      horizon: attr.horizon,
      seqLen: attr.seqLen,
      status: attr.status,
      confirmed,
      statusLabel: confirmed
        ? '脚本内确认（含方法声明 + 数据集一致 + 无默认值覆盖）'
        : attr.status === 'repo-default'
          ? '仓库默认值（未经脚本确认）'
          : attr.status === 'file-level'
            ? '实现细节（不是某次实验的运行设置）'
            : '待确认',
    },
    methodMatch,
    override,
    scope: scopeBits.join('；'),
    inconsistent: null,
    confidence: cross || datasetMismatch ? 'cross-dataset' : confirmed ? 'confirmed' : 'candidate',
    adoptable: true,
    adoptionNote: methodMatch.ok
      ? null
      : `默认归属为 ${methodMatch.clueMethod ?? '未知'}；若采用，将记为「用户选择的新设置」，不算该论文/该方法的设置`,
    note,
  }
}

/**
 * 运行一次侦探任务。
 * 返回：阶段记录 / 线索 / 查过的来源 / 下一步；没有模型时降级为"候选片段（未经模型筛选）"。
 */
export async function runDetective({ paper, fieldKey, dataset, model, horizon, pages, taskId, llmCall }) {
  const t0 = Date.now()
  const id = taskId || `det-${Date.now()}`
  const state = { cancelled: false }
  detectiveTasks.set(id, state)
  const stages = []
  const push = (label, detail) => {
    stages.push({ at: Date.now() - t0, label, detail: detail || '' })
  }

  const fieldDef = DETECTIVE_FIELDS.find((f) => f.key === fieldKey)
  if (!fieldDef) {
    detectiveTasks.delete(id)
    return { ok: false, reason: `暂不支持为「${fieldKey}」找线索`, supported: DETECTIVE_FIELDS.map((f) => f.key) }
  }

  const repo = repoById('ltsf-linear')
  const sourcesChecked = []
  const clues = []
  const rejected = []
  const fileCache = new Map()
  let bytesRead = 0
  let mode = 'program'

  try {
    /* ---- 阶段 1：论文正文 / 附录 ---- */
    push('正在检查论文正文与附录', `字段：${fieldDef.label}｜数据集：${dataset || '未指定'}｜跨度：${horizon ?? '未指定'}`)
    const paperHits = paperSentencesForKey(pages, fieldDef, dataset)
    if (paperHits.length > 0) {
      paperHits.forEach((h) =>
        clues.push({
          id: `paper-${h.page}-${clues.length}`,
          field: fieldKey,
          value: h.text.slice(0, 220),
          appliesTo: { method: model || null, dataset: h.hasDataset ? dataset : null, task: 'long-term forecasting', horizon: null },
          sourceType: 'paper',
          evidence: { kind: 'paper', page: h.page, section: h.section, quote: h.text },
          scope: '论文正文/附录中的相关句（是否就是当前实验的设置需要人工判断）',
          inconsistent: null,
          confidence: 'candidate',
        }),
      )
      push('在正文/附录里找到相关句子', `${paperHits.length} 句，已作为候选线索列出（含页码）`)
    } else {
      push('正文/附录里没有直接写到这一项', '继续去官方仓库里找')
    }
    sourcesChecked.push({ kind: 'paper', label: '论文正文与附录', detail: `${(pages || []).length} 页已检索`, hit: paperHits.length })

    if (state.cancelled) {
      push('用户取消', '已保留上面找到的内容')
      return finish()
    }

    /* ---- 阶段 2：选择官方仓库文件（按数据集/模型，不下载整仓库） ---- */
    const plan = planFiles(dataset, model)
    push('正在挑选相关的官方仓库文件', plan.map((p) => p.path).join('、'))
    for (const f of plan.slice(0, LIMITS.maxFiles)) {
      if (state.cancelled) break
      if (bytesRead > LIMITS.maxTotalBytes) break
      const res = await readRepoFile(repo, f.path)
      fileCache.set(f.path, res)
      if (res.ok) {
        bytesRead += res.text.length
        sourcesChecked.push({
          kind: 'repo',
          label: f.label || f.path,
          path: f.path,
          sha: repo.sha,
          url: res.url,
          source: res.source,
          detail: `${Math.round(res.text.length / 1024)} KB`,
          hit: 0,
        })
      } else {
        sourcesChecked.push({ kind: 'repo', label: f.path, path: f.path, detail: `未读到（${res.reason}）`, hit: 0, failed: true })
      }
    }
    const okFiles = [...fileCache.entries()].filter(([, v]) => v.ok).map(([k]) => k)
    push('文件挑选完成', `读到 ${okFiles.length} 个文件；共 ${Math.round(bytesRead / 1024)} KB，只把相关片段交给模型`)
    if (okFiles.length === 0) {
      push('官方仓库读不到', '本机固定提交副本不存在，且网络不可用 —— 已保留论文侧线索，未做任何推测')
      return finish()
    }

    /* ---- 阶段 3：程序提取相关片段（带路径 + 行号） ---- */
    const excerpts = []
    for (const path of okFiles) {
      const snippet = excerptsFor(fileCache.get(path).text, fieldDef.keywords, path)
      excerpts.push(...snippet)
      if (excerpts.length >= LIMITS.maxExcerpts) break
    }
    push('已定位相关代码片段', `${excerpts.length} 段（含文件路径与行号）；例如：${excerpts[0] ? `${excerpts[0].path}:${excerpts[0].line}` : '无'}`)

    // 该数据集对应的官方实验脚本（用于核对"默认值是否被覆盖"）
    const dsLower = String(dataset || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const dsScriptPath = okFiles.find((p) => dsLower && p.toLowerCase().endsWith(`${dsLower}.sh`)) ?? null
    const dsScriptText = dsScriptPath ? fileCache.get(dsScriptPath).text : null

    /* ---- 阶段 4：模型识别候选线索（可选） ---- */

    if (llmCall && excerpts.length > 0 && !state.cancelled) {
      const dsHint = dataset ? `当前数据集是 ${dataset}` : '数据集未指定'
      const system =
        '你在帮一个论文复现工具定位"缺失的复现线索"。只输出线索行，每行格式：字段|取值|来源(code/paper)|一句话说明。' +
        '要求：① 只使用给定的片段，不得凭记忆补值；② 片段属于别的数据集（例如 ettm1/etth1）时，必须在说明里写明它属于哪个数据集，且取值不能当成当前数据集的设置；' +
        '③ 只能说明该片段限定的实验条件（例如只对应某个预测跨度）；④ 说明里不得把仓库默认值说成论文发表时的设置。最多 8 行。'
      const user = [
        `目标字段：${fieldDef.label}（${fieldKey}）`,
        `${dsHint}；方法：${model || '未指定'}；预测跨度：${horizon ?? '未指定'}`,
        '',
        '以下是已挑选的片段（前面是 文件:行号）：',
        ...excerpts.map((e) => `【${e.path}:${e.line}】${e.focusLine}`),
      ].join('\n')
      try {
        const raw = await llmCall({ system, user, maxTokens: 1500 })
        const parsed = parseClueLines(raw)
        mode = 'model'
        push('模型识别候选线索', `返回 ${parsed.length} 条候选，接下来由程序逐条回查来源`)
        // 程序回查：把模型给的候选值回到片段里找它的来源文件，并解析归属
        for (const c of parsed) {
          if (state.cancelled) break
          const hitEx = excerpts.find((e) => normalizeText(e.focusLine).includes(normalizeText(c.value)) || normalizeText(c.value).includes(normalizeText(e.focusLine).slice(0, 24)))
          if (!hitEx) {
            rejected.push({ ...c, reason: '在已挑选的片段里找不到这个值的出处' })
            continue
          }
          const attr = attributionOf(fileCache.get(hitEx.path).text, hitEx.line, hitEx.path)
          const mm = methodMatchOf(model, attr.method)
          const override =
            attr.status === 'repo-default' ? findOverride(dsScriptText, dsScriptPath, fieldKey, model, horizon ?? attr.horizon) : null
          clues.push(
            buildCodeClue({
              id: `code-${hitEx.path}-${hitEx.line}-${clues.length}`,
              fieldKey,
              value: c.value,
              snippet: hitEx.focusLine,
              path: hitEx.path,
              line: hitEx.line,
              attr,
              methodMatch: mm,
              override,
              repo,
              requestedDataset: dataset,
              note: c.note,
            }),
          )
        }
      } catch (e) {
        mode = 'program'
        push('模型这一步没走通，改为程序线索', e?.code === 'EMPTY_COMPLETION' ? '模型返回空内容' : String(e?.message || e).slice(0, 80))
      }
    } else if (!llmCall) {
      push('没有可用的模型，只给出程序找到的候选片段', '每个片段都带文件路径、行号与提交版本，人工可直接核对')
    }

    /* ---- 阶段 5：把程序片段本身也作为候选（模型不可用时的兜底，始终提供） ---- */
    for (const e of excerpts.slice(0, LIMITS.maxClues)) {
      if (clues.length >= LIMITS.maxClues * 2) break
      if (clues.some((c) => c.evidence?.kind === 'code' && c.evidence.path === e.path && c.evidence.line === e.line)) continue
      const attr = attributionOf(fileCache.get(e.path).text, e.line, e.path)
      const mm = methodMatchOf(model, attr.method)
      const override = attr.status === 'repo-default' ? findOverride(dsScriptText, dsScriptPath, fieldKey, model, horizon ?? attr.horizon) : null
      clues.push(
        buildCodeClue({
          id: `raw-${e.path}-${e.line}`,
          fieldKey,
          value: e.focusLine.slice(0, 200),
          snippet: e.focusLine,
          path: e.path,
          line: e.line,
          attr,
          methodMatch: mm,
          override,
          repo,
          requestedDataset: dataset,
          note: '程序直接给出的片段（未经过模型归纳），可直接核对原文',
        }),
      )
    }

    /* ---- 阶段 6：与已有值比对 ---- */
    const existing = paper?.fields?.[fieldKey]?.value ? String(paper.fields[fieldKey].value) : null
    if (existing) {
      for (const c of clues) {
        const same = normalizeText(String(c.value)).includes(normalizeText(existing).split('\n')[0].slice(0, 12))
        c.inconsistent = same ? false : true
        c.existingValue = existing
      }
    }
    push('与当前字段值比对完成', existing ? `当前字段值：${existing}` : '当前字段还没有值')

    return finish()
  } finally {
    detectiveTasks.delete(id)
  }

  function finish() {
    const codeClues = clues.filter((c) => c.sourceType === 'official-code')
    const paperClues = clues.filter((c) => c.sourceType === 'paper')
    const bound = codeClues.filter((c) => c.binding?.method)
    const methodMismatch = codeClues.filter((c) => c.methodMatch && c.methodMatch.ok === false && c.methodMatch.clueMethod)
    const overridden = codeClues.filter((c) => c.override)
    const summary =
      codeClues.length + paperClues.length > 0
        ? `找到 ${clues.length} 项线索（代码 ${codeClues.length} 项、论文 ${paperClues.length} 项）` +
          (clues.some((c) => c.confidence === 'cross-dataset') ? `，其中 ${clues.filter((c) => c.confidence === 'cross-dataset').length} 项属于其它数据集（已标注）` : '') +
          (bound.length > 0 ? `，${bound.length} 项已绑定方法归属` : '') +
          (methodMismatch.length > 0 ? `，${methodMismatch.length} 项的方法归属与当前目标不一致（已说明）` : '') +
          (overridden.length > 0 ? `，${overridden.length} 项的仓库默认值被实验脚本覆盖` : '')
        : '没有找到可用线索'
    const nextStep =
      clues.length === 0
        ? '已查过的来源都在下面列出。下一步建议：把论文附录页补进正文（上传含附录的版本），或人工打开官方脚本目录确认对应数据集的文件是否存在。'
        : '先看每条线索的「归属」：脚本块默认属于哪个方法、哪个跨度；默认值若被脚本覆盖会单独标出。确认后再决定是否采用 —— 采用只写入"派生配置层"，论文抽取结果与人工修改不会被覆盖。'
    return {
      ok: true,
      taskId: id,
      field: fieldKey,
      fieldLabel: fieldDef.label,
      mode,
      dataset: dataset || null,
      model: model || null,
      horizon: horizon ?? null,
      summary,
      clues,
      rejected,
      stages,
      sourcesChecked,
      nextStep,
      limits: LIMITS,
      bytesRead,
      note:
        mode === 'model'
          ? '线索由模型识别候选、由程序回查来源；代码片段与论文句子都保留原文出处。'
          : '没有模型参与，这里展示的是程序在允许来源里找到的原始片段（未经归纳），每条都能直接核对。',
    }
  }
}
