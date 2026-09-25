/**
 * LLM 访问层（服务端专用）
 * ------------------------------------------------------------------
 * - 密钥只从环境变量读取，绝不写入前端或仓库。
 * - 支持两种接口风格：
 *     anthropic（默认）：POST {LLM_BASE_URL}/v1/messages
 *     openai           ：POST {LLM_BASE_URL}/v1/chat/completions
 * - 抽取与问答都要求模型输出严格 JSON，并且在服务端**逐条校验引用**：
 *   引用原文必须能在对应页里逐字找到，否则剔除。这样界面上给出的
 *   「论文名 + 页码 + 原文片段」一定真实存在。
 */

const API_STYLE = (process.env.LLM_API_STYLE || 'anthropic').toLowerCase()
const BASE_URL = (process.env.LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '')
const API_KEY = process.env.LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || ''
const MODEL =
  process.env.LLM_MODEL || process.env.ANTHROPIC_MODEL || 'deepseek-chat'

/** 单次请求允许写入的正文上限（字符） */
export const MAX_PAPER_CHARS = Number(process.env.MAX_PAPER_CHARS || 90000)

export function llmStatus() {
  return {
    apiStyle: API_STYLE,
    model: MODEL,
    baseUrlHost: safeHost(BASE_URL),
    hasCredentials: Boolean(BASE_URL && API_KEY),
  }
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* 文本归一化与引用校验                                                */
/* ------------------------------------------------------------------ */

/**
 * 归一化：去软连字符、合并换行与空白、统一小写，用于宽松比对。
 * 真实论文里同一个数字常有好几种写法，必须都归一化到同一形式，否则会出现
 * "10 −4"（Unicode 减号 + 空格）与 "10^-4" 对不上、把已写明的信息误判为「未找到」的情况。
 */
export function normalizeText(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/\u00ad/g, '')
    .replace(/-\s*\n\s*/g, '')
    // 各种横线 / 减号 / 全角减号统一成 '-'
    .replace(/[\u2010-\u2015\u2212\u2043\ufe63\uff0d]/g, '-')
    // 去掉幂符号：10^-4 与 10-4 视为同一写法
    .replace(/\^/g, '')
    // 数字之间被空格或换行隔开的连字符：10 -4 / 1 - 2 → 10-4 / 1-2
    .replace(/(\d)\s*-\s*(?=\d)/g, '$1-')
    // 标点前的多余空格： "10-4 ." → "10-4."
    .replace(/\s+([.,;:!?)\]])/g, '$1')
    .replace(/[\u2018\u2019`\u00b4\u02b9]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 集合型字段（数据集 / 指标 / 基线）的取值核验。
 * ------------------------------------------------------------------
 * 这类字段的值往往是模型从多处聚合出来的，很难凑出一条完整的逐字引用。
 * 这里换一种同样严格、但不依赖「整句一致」的核验方式：
 *   把 value 拆成若干个名字，逐个回到正文里查找；
 *   只有当绝大多数名字都能在正文中原样找到时，才认可这个取值；
 *   证据直接从正文里截取包含该名字的真实句子（不是模型写的句子）。
 * 这样既能保住集合型字段，也不会让模型凭常识编造名字。
 */
const AGGREGATE_FIELDS = new Set(['dataset', 'metrics', 'baselines', 'params'])

/**
 * 兜底归一化：把连字符当作分隔符。
 * PDF 排版常把单词断成 "Exchange-\nRate"，模型抄写时可能写成 "Exchange-Rate" 或 "Exchange Rate"。
 * 只在严格比对失败后使用，并要求匹配片段足够长，避免放宽成任意匹配。
 */
export function normalizeLoose(input) {
  return normalizeText(input).replace(/-/g, ' ').replace(/\s+/g, ' ').trim()
}

function splitValueTokens(value) {
  return String(value || '')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .split(/[、,，;；/|]+|\s+以及\s+|\s+和\s+|\s+与\s+|\s+及\s+|\s+/)
    .map((s) => s.trim().replace(/^[-–—·•]+|[-–—·•]+$/g, ''))
    .filter((s) => s.length >= 2)
    .filter((s) => !/^(等|其他|其它|以及|和|与|及)$/.test(s))
}

/** 从正文里截取包含某个词的句子（窗口版）；起止都对齐到空白边界，保证片段真实且便于对照 */
function sentenceAround(pages, token, maxLen = 240) {
  const isWs = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'
  // 允许连字符/空白/换行差异：Exchange-Rate 也能匹配到正文里的 "Exchange-\nRate"
  const parts = String(token || '')
    .split(/[-–—\s]+/)
    .filter((p) => p.length >= 3)
  const pattern = parts.length
    ? parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[-\\s]*')
    : ''
  if (!pattern) return null
  let re
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return null
  }

  for (const page of pages) {
    const raw = page.text
    const m = re.exec(raw)
    if (!m) continue
    const idx = m.index

    let start = Math.max(0, idx - Math.floor(maxLen / 3))
    const before = raw.slice(start, idx)
    const cut = Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n'))
    if (cut >= 0) start = start + cut + 1

    // 起点对齐到下一个空白之后（避免片段从词中间开始）
    for (let i = start; i < idx; i += 1) {
      if (isWs(raw[i])) {
        start = i + 1
        break
      }
    }

    let end = Math.min(raw.length, start + maxLen)
    const after = raw.slice(idx, end)
    const stop = after.search(/[.!?]\s|\n/)
    if (stop > 20) end = idx + stop + 1

    // 终点回退到最后一个空白（避免片段把一个词截断）
    for (let i = end - 1; i > idx; i -= 1) {
      if (isWs(raw[i])) {
        end = i
        break
      }
    }

    // 不要把带连字符的词切断（否则片段和原文对不上）
    let guard = 0
    while (end > idx && guard < 5 && /[-–—]$/.test(raw.slice(start, end).trimEnd())) {
      let moved = false
      for (let i = end - 1; i > idx; i -= 1) {
        if (isWs(raw[i])) {
          end = i
          moved = true
          break
        }
      }
      guard += 1
      if (!moved) break
    }

    // 只折叠空格与制表符，**保留换行**：
    // PDF 里常见 "Exchange-\nRate" 这种跨行断词，如果折叠成 "Exchange- Rate"，
    // 归一化后就与原文对不上（归一化会把 "-\n" 直接去掉），片段就不能算逐字引用了。
    const snippet = raw
      .slice(start, end)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (snippet.length >= 15) return { page: page.page, quote: snippet }
  }
  return null
}

/** @returns {{ ok: boolean, evidence: {page:number, quote:string}[], hitRatio: number }} */
/**
 * 集合字段（数据集 / 基线 / 指标 / 参数量）的**实验用途**校验。
 * 光"名字在正文里出现过"不算数：必须找到一句**同时包含该名字和实验用途表述**的话，
 * 例如 "we evaluate on ..."、"experiments are conducted on ..."、"compared with ..."、
 * "used as baselines"、"指标用于评价"。否则只能说"名字出现过"，不能说"这就是实验用的"。
 */
const USAGE_PATTERNS = [
  /evaluat(?:e|ed|ion|ing)\b/i,
  /experiments?\b/i,
  /benchmarks?\b/i,
  /compare[sd]?\b|comparison\b|baselines?\b/i,
  /conduct(?:ed)?\s+(?:on|with)/i,
  /we (?:use|adopt|choose|select|follow)/i,
  /dataset[s]?\s+(?:are|is|used|include)/i,
  /used\s+as\s+(?:the\s+)?baselines?/i,
  /metric[s]?\s+(?:are|is|include|used)/i,
  /在.{0,12}(?:数据集|数据)上/,
  /评价指标|对比(?:的)?基线|实验(?:设置|数据)/,
]

export function usageEvidenceFor(pages, value) {
  const tokens = splitValueTokens(value)
  if (tokens.length === 0) return { ok: false, evidence: [], usedNames: [] }
  const usedNames = []
  const evidence = []
  for (const pg of pages) {
    const text = String(pg?.text || '')
    if (!text) continue
    const parts = text.split(/(?<=[.!?;])\s+|\n+/)
    for (const raw of parts) {
      const s = raw.replace(/\s+/g, ' ').trim()
      if (s.length < 20 || s.length > 400) continue
      const namesHere = tokens.filter((t) => s.toLowerCase().includes(String(t).toLowerCase()))
      if (namesHere.length === 0) continue
      if (!USAGE_PATTERNS.some((re) => re.test(s))) continue
      namesHere.forEach((n) => {
        if (!usedNames.includes(n)) usedNames.push(n)
      })
      if (!evidence.some((e) => e.quote === s)) {
        evidence.push({ page: Number(pg.page) || 0, quote: s })
      }
      if (evidence.length >= 2) break
    }
    if (evidence.length >= 2) break
  }
  return { ok: evidence.length > 0 && usedNames.length >= 2, evidence, usedNames }
}

export function verifyAggregateValue(pages, value) {
  const tokens = splitValueTokens(value)
  if (tokens.length === 0) return { ok: false, evidence: [], hitRatio: 0, usageOk: false, usedNames: [] }

  const haystack = pages.map((p) => normalizeLoose(p.text)).join(' \u0001 ')
  const hits = tokens.filter((t) => haystack.includes(normalizeLoose(t)))
  const ratio = hits.length / tokens.length

  const evidence = []
  for (const t of hits) {
    const found = sentenceAround(pages, t)
    if (found && !evidence.some((e) => e.quote === found.quote)) evidence.push(found)
    if (evidence.length >= 2) break
  }

  // 必须有"实验用途"证据：名字出现 ≠ 用于实验
  const usage = usageEvidenceFor(pages, value)

  // 至少要命中 2 个名字、命中比例不低于 70%、有名字证据、且有实验用途证据
  const ok = hits.length >= 2 && ratio >= 0.7 && evidence.length > 0 && usage.ok
  return { ok, evidence, hitRatio: ratio, usageOk: usage.ok, usedNames: usage.usedNames, usageEvidence: usage.evidence }
}

/**
 * 单字段补查：只针对用户点选的一个字段做「定向全文检索 → 模型复核 → 引用逐字校验」。
 * 与整篇抽取走完全相同的证据标准；找不到就如实返回 missing，**不会编造**。
 */
export async function recheckField({ pages, key, fileName, title }) {
  const spec = EXTRACT_FIELDS.find((f) => f[0] === key)
  if (!spec) throw new Error(`未知字段：${key}`)
  const description = spec[1]
  const candidates = retrieveCandidates(pages, key, 16)
  const base = { key, checkedPages: pages.length, candidateCount: candidates.length }
  if (candidates.length === 0) {
    return {
      ...base,
      status: 'missing',
      value: null,
      evidence: [],
      note: `已在全部 ${pages.length} 页正文里按关键词检索，没有找到与「${key}」相关的片段。这不等于原文一定没有写，可能是措辞不同或写在了表格/图片里。`,
    }
  }

  const judged = await judgeCandidatesForField({
    key,
    description,
    candidates,
    fileName: title || fileName,
  })
  if (!judged) {
    return { ...base, status: 'missing', value: null, evidence: [], note: '模型没有给出可用判断，本次补查没有结果。' }
  }

  const evidence = []
  let status = judged.status || 'missing'
  let note =
    typeof judged.note === 'string' && judged.note.trim() ? judged.note.trim().slice(0, 300) : undefined

  if (status === 'found') {
    if (!judged.value) {
      status = 'missing'
      note = '模型给出了结论但没有取值，已按「未找到」处理。'
    } else if (verifyQuote(pages, judged.page, judged.quote).ok) {
      const v = verifyQuote(pages, judged.page, judged.quote)
      evidence.push({ page: v.page, quote: v.quote })
    } else if (AGGREGATE_FIELDS.has(key)) {
      const agg = verifyAggregateValue(pages, judged.value)
      if (agg.ok) {
        agg.evidence.forEach((e) => evidence.push(e))
        note = `集合型字段：名字已逐个回查正文（命中率 ${(agg.hitRatio * 100).toFixed(0)}%），${
          agg.usageOk ? '并找到了实验用途表述。' : '但没有找到「用于实验」的表述，需要你确认。'
        }`
        if (!agg.usageOk) status = 'uncertain'
      } else {
        status = 'missing'
        note = '模型给出的取值无法在正文里逐字核对，已按「未找到」处理。'
      }
    } else {
      status = 'missing'
      note = '模型声称找到了依据，但引用片段无法在论文里逐字核对，已按「未找到」处理。'
    }
  }

  if (status === 'uncertain') {
    evidence.length = 0
    const v = verifyQuote(pages, judged.page, judged.quote)
    if (v.ok) evidence.push({ page: v.page, quote: v.quote })
  }

  return {
    ...base,
    status,
    value: status === 'missing' ? null : judged.value ?? null,
    evidence,
    note,
    searched: candidates.slice(0, 6).map((c) => ({ page: c.page, text: String(c.text).slice(0, 160) })),
  }
}

export function verifyQuote(pages, claimedPage, quote) {
  const cleaned = String(quote || '').replace(/\s+/g, ' ').trim()
  if (cleaned.length < 15) return { ok: false, page: null, quote: cleaned, corrected: false, method: null }

  const needle = normalizeText(cleaned)
  const candidates = []
  if (claimedPage) candidates.push(claimedPage)
  pages.forEach((p) => {
    if (!candidates.includes(p.page)) candidates.push(p.page)
  })

  for (const pageNo of candidates) {
    const page = pages.find((p) => p.page === pageNo)
    if (!page) continue
    const hay = normalizeText(page.text)
    if (hay.includes(needle)) {
      return {
        ok: true,
        page: pageNo,
        quote: cleaned,
        corrected: Boolean(claimedPage) && pageNo !== claimedPage,
        method: 'exact',
      }
    }
  }

  // 再放宽一次：只取引用里较长的一段连续文本去比对（模型偶尔会拼接两句）
  const fragments = cleaned
    .split(/(?<=[.;:])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30)
    .sort((a, b) => b.length - a.length)

  for (const frag of fragments) {
    const fragNeedle = normalizeText(frag)
    for (const pageNo of candidates) {
      const page = pages.find((p) => p.page === pageNo)
      if (!page) continue
      if (normalizeText(page.text).includes(fragNeedle)) {
        return {
          ok: true,
          page: pageNo,
          quote: frag,
          corrected: Boolean(claimedPage) && pageNo !== claimedPage,
          method: 'fragment',
        }
      }
    }
  }

  // 最后兜底：把连字符差异视为等价（PDF 断词 "Exchange-\nRate" vs 模型写的 "Exchange-Rate"）
  // 要求片段足够长，避免退化成宽松匹配
  const looseNeedle = normalizeLoose(cleaned)
  if (looseNeedle.length >= 40) {
    for (const pageNo of candidates) {
      const page = pages.find((p) => p.page === pageNo)
      if (!page) continue
      if (normalizeLoose(page.text).includes(looseNeedle)) {
        return {
          ok: true,
          page: pageNo,
          quote: cleaned,
          corrected: Boolean(claimedPage) && pageNo !== claimedPage,
          method: 'loose',
        }
      }
    }
  }

  return { ok: false, page: null, quote: cleaned, corrected: false, method: null }
}

/* ------------------------------------------------------------------ */
/* 结论支持校验：原文片段是否真的支持这条说法                          */
/* ------------------------------------------------------------------ */

const SUPPORT_SYSTEM = [
  '你是严格的事实核查员，只根据给出的原文片段做判断，不使用任何外部知识。',
  '你的任务是判断「原文片段是否直接支持这条主张」，而不是判断主张听起来是否合理。',
  '请只输出 JSON，不要输出解释文字，不要使用 markdown 代码块。',
].join('\n')

const SUPPORT_RULES = `判定标准：
- full：片段明确写出了主张里的关键内容（数字、名称、条件、方向），不需要任何额外假设。
  注意：主张是对片段内容的**中文复述或汇总**时，只要片段包含相同的事实，就算 full：
  例如片段写了 "we use MSE and MAE"，主张写"评价指标使用 MSE 和 MAE"，这就是 full。
- partial：片段与主张相关，但只支持其中一部分，或缺少关键限定（例如主张说"9 个数据集"而片段只列出部分名字；
  主张说"某数据集上的设置"而片段没有指明是哪个数据集）。
- none：片段没有提到主张的关键内容，或支持的是别的数据集 / 别的设置 / 别的结论。

务必从严，但也要讲理：只在确实明确满足时给 full；含糊、缺关键字、或需要推断时，给 partial 或 none。
不要因为主张本身正确就判 full —— 只看片段是否支持它。也要避免把"中文汇总了片段中的同一事实"误判成 partial。`

/**
 * 行格式解析：`id|support|e0,e2|理由`
 * 实测中模型返回 JSON 会偶发失败（写出说明文字或截断），
 * 因此两个复核步骤都优先走这个更稳的行格式，JSON 只作兜底。
 */
function parseSupportLines(text, validIds) {
  const out = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    // 模型有时会用全角竖线或 markdown 表格，这里统一成半角竖线再切
    const line = raw
      .trim()
      .replace(/^[-*•\d.、)]+\s*/, '')
      .replace(/｜/g, '|')
      .replace(/^`+|`+$/g, '')
      .replace(/^\|/, '')
      .replace(/\|$/, '')
    if (!line.includes('|')) continue
    const parts = line.split('|').map((s) => s.trim())
    if (parts.length < 2) continue
    const id = parts[0].replace(/[`"'\s:：]/g, '')
    if (!validIds.includes(id)) continue
    const support = /^(full|partial|none)$/i.test(parts[1]) ? parts[1].toLowerCase() : 'partial'
    const evidenceIds = String(parts[2] || '')
      .split(/[,，、\s]+/)
      .map((s) => s.replace(/[`"']/g, '').trim())
      .filter((s) => /^e\d+$/.test(s))
    const reason = (parts[3] || parts[2] || '').slice(0, 200)
    out[id] = { support, reason, evidenceIds }
  }
  return out
}

/**
 * 逐条判定「原文片段是否支持该主张」（字段级用）。
 * @param {{id:string, claim:string, page:number|null, quote:string}[]} items
 */
export async function judgeSupport(items) {
  const usable = (items || []).filter((i) => i && i.claim && i.quote)
  if (usable.length === 0) return {}

  const lines = usable
    .map(
      (i) =>
        `- id: ${i.id}\n主张：${String(i.claim).slice(0, 300)}\n原文片段（第 ${i.page ?? '?'} 页）：${String(
          i.quote,
        ).slice(0, 500)}`,
    )
    .join('\n')

  const lineUser = `下面每一条是一组「取值主张 + 它的原文片段」。请逐条判断原文片段是否支持这条主张。

${SUPPORT_RULES}

请**只输出若干行纯文本**，每行一条，用竖线分隔，不要表头、不要 JSON、不要解释：
id|support|理由

待判定条目：
${lines}`

  try {
    const text = await callLlm({ system: SUPPORT_SYSTEM, user: lineUser, maxTokens: 6000 })
    const byLine = parseSupportLines(
      text,
      usable.map((i) => i.id),
    )
    if (Object.keys(byLine).length > 0) return byLine
  } catch {
    /* 落到下面的 JSON 方案 */
  }

  const user = `下面每一条是一组「主张 + 它的原文片段」。请逐条判断原文片段是否支持这条主张。

${SUPPORT_RULES}

待判定条目：
${lines
  .split('\n')
  .map((l) => l.replace(/^- /, ''))
  .join('\n')}

输出格式（不要输出其它内容）：
{"judgements":[{"id":"原样返回上面的 id","support":"full|partial|none","reason":"一句中文说明，指出片段支持到什么程度、缺什么"}]}`

  try {
    const json = await callForJson({
      system: SUPPORT_SYSTEM,
      user,
      maxTokens: 4000,
      retryHint: 'judgements 每条只保留 id、support、reason 三个字段，reason 不超过 40 个汉字。',
    })
    const out = {}
    const list = Array.isArray(json.judgements) ? json.judgements : []
    for (const j of list) {
      const id = typeof j?.id === 'string' ? j.id : ''
      if (!id) continue
      const support = ['full', 'partial', 'none'].includes(j?.support) ? j.support : 'partial'
      out[id] = {
        support,
        reason: typeof j?.reason === 'string' ? j.reason.trim().slice(0, 200) : '',
      }
    }
    return out
  } catch {
    // 判定失败不阻断主流程：返回空对象，调用方会标成「未复核」而不是假装通过了
    return {}
  }
}

/* ------------------------------------------------------------------ */
/* 结论来源分类（论文事实 / 系统事实 / 规则推导）                      */
/* ------------------------------------------------------------------ */

/**
 * 把一条结论分成三类。这一步是**确定性规则**，不调用模型：
 *  - system 系统事实：讲的是"本次提供了几篇论文 / 有没有正文 / 选了哪个数据集"这类由程序状态决定的事。
 *    这类结论由程序状态当场证明，绝不能因为"论文里没写这句话"就被撤回。
 *  - rule 规则推导：讲的是"因为 A 条件不同，所以不能直接比较"这类由本地规则推出的判断。
 *    这类结论要展示输入字段、使用的规则与结论，同样不要求论文直接写出来。
 *  - paper 论文事实：其余讲论文内容的结论，必须有引用并通过支持度校验。
 */
export function classifyClaim(text, context = {}) {
  const t = String(text || '')
  const paperCount = Number(context.paperCount || 0)

  const systemPatterns = [
    /本次(只|仅)?(提供|给出|包含|使用)/,
    /当前(只|仅)?(选择|提供|有)/,
    /(只|仅)(有|提供了?)一?篇/,
    /没有(其他|其它)论文/,
    /提供的(可选)?论文(只|仅|有)/,
    /正文(只|仅)?(有|包含)/,
    /(上传|选定|选中的)论文/,
  ]
  if (systemPatterns.some((re) => re.test(t))) return 'system'
  const countMatch = t.match(/(\d+)\s*篇/)
  if (countMatch && paperCount > 0 && Number(countMatch[1]) === paperCount) return 'system'
  if (paperCount <= 1 && /无法(进行)?(跨论文|论文间|相互)?(直接)?比较/.test(t)) return 'system'

  const rulePatterns = [
    /(因此|所以|由此|从而|据此)[^。；]{0,30}(不能|无法|不可)(直接)?(比较|对比|排名)/,
    /(不能|无法|不可)(直接)?(比较|对比|排名|横向对照)/,
    /(采样间隔|跨度|划分|测试区间|指标|预处理|基线|预测口径)[^。；]{0,40}(不同|不一致|相同|一致|缺失|未说明)/,
    /(可比性|不在同一起跑线|口径不一致|条件不对齐)/,
  ]
  if (rulePatterns.some((re) => re.test(t))) return 'rule'

  return 'paper'
}

/**
 * 校验系统事实是否与真实程序状态一致。能核对数字就核对数字；
 * 对不上时如实标注"与程序状态不一致"，而不是当成论文事实去撤回。
 */
export function verifySystemClaim(text, context = {}) {
  const t = String(text || '')
  const paperCount = Number(context.paperCount || 0)
  const datasetScope = context.datasetScope ? String(context.datasetScope) : ''
  const m = t.match(/(\d+)\s*篇/)
  if (m) {
    const claimed = Number(m[1])
    if (paperCount > 0 && claimed !== paperCount) {
      return {
        ok: false,
        reason: `与程序状态不一致：本次实际提供了 ${paperCount} 篇论文正文，这条结论写的是 ${claimed} 篇。`,
      }
    }
    return { ok: true, reason: `与程序状态一致：本次共提供 ${paperCount} 篇论文正文。` }
  }
  if (datasetScope && t.includes(datasetScope)) {
    return { ok: true, reason: `与程序状态一致：本次比较口径是「${datasetScope}」。` }
  }
  return {
    ok: true,
    reason: `由程序状态证明（本次提供 ${paperCount} 篇论文正文${
      datasetScope ? `，比较口径 ${datasetScope}` : ''
    }）。`,
  }
}

/**
 * 判定「每条结论是否有提供的原文片段支持」。
 * 输入是一次回答里的全部结论与**已经过逐字校验**的证据池；
 * 输出每条结论的 support 与它实际依赖的证据 id。
 * 判定失败时返回空对象，由调用方标成「未复核」。
 */
async function judgeClaims({ claims, evidence }) {
  const usable = (claims || []).filter((c) => c && c.text)
  if (usable.length === 0) return { judgements: {}, error: '' }
  if (!evidence || evidence.length === 0) {
    const out = {}
    usable.forEach((c) => {
      out[c.id] = { support: 'none', reason: '本次回答没有任何通过校验的原文引用，无法支持结论', evidenceIds: [] }
    })
    return { judgements: out, error: '' }
  }

  const user = `下面有两部分内容：一是待核查的「结论」，二是**已经过逐字校验**的「原文片段池」。

请对每条结论判断：片段池里有没有片段**直接支持**这条结论？

${SUPPORT_RULES}
另外：支持这条结论的片段可能不止一条，请在 evidenceIds 里列出你依据的片段 id（没有就留空数组）。

结论列表：
${usable.map((c) => `- id: ${c.id}\n  结论：${String(c.text).slice(0, 300)}`).join('\n')}

原文片段池：
${evidence
  .map((e) => `- id: ${e.id}（论文 ${e.shortLabel || ''} 第 ${e.page} 页）：${String(e.quote).slice(0, 2400)}`)
  .join('\n')}

输出格式（不要输出其它内容）：
{"judgements":[{"id":"结论 id","support":"full|partial|none","evidenceIds":["e0"],"reason":"一句中文说明：片段支持到什么程度 / 缺什么"}]}`

  // 先尝试**行格式**（比 JSON 稳得多：模型只要逐行输出就能解析），失败再退回 JSON
  const lineUser = `下面每一条是一组「结论 + 已通过逐字校验的原文片段池」。请逐条判断片段池是否支持这条结论。

${SUPPORT_RULES}

请**只输出若干行纯文本**，每行一条结论，用竖线分隔四个字段，不要输出表头、不要 JSON、不要解释：
结论 id|support|支持它的片段 id（多个用逗号，没有就写 -）|一句中文理由

结论列表：
${usable.map((c) => `- id: ${c.id}\n  结论：${String(c.text).slice(0, 300)}`).join('\n')}

原文片段池：
${evidence
  .map((e) => `- id: ${e.id}（论文 ${e.shortLabel || ''} 第 ${e.page} 页）：${String(e.quote).slice(0, 2400)}`)
  .join('\n')}`

  try {
    const first = await callLlm({ system: SUPPORT_SYSTEM, user: lineUser, maxTokens: 6000 })
    const byLine = parseSupportLines(
      first,
      usable.map((c) => c.id),
    )
    if (Object.keys(byLine).length > 0) return { judgements: byLine, error: '' }
  } catch {
    /* 落到下面的 JSON 方案 */
  }

  try {
    const json = await callForJson({
      system: SUPPORT_SYSTEM,
      user,
      maxTokens: 4000,
      retryHint: 'judgements 每条只保留 id、support、evidenceIds、reason 四个字段，reason 不超过 40 个汉字。',
    })
    const out = {}
    const list = Array.isArray(json.judgements) ? json.judgements : []
    for (const j of list) {
      const id = typeof j?.id === 'string' ? j.id : ''
      if (!id) continue
      const support = ['full', 'partial', 'none'].includes(j?.support) ? j.support : 'partial'
      out[id] = {
        support,
        reason: typeof j?.reason === 'string' ? j.reason.trim().slice(0, 200) : '',
        evidenceIds: Array.isArray(j?.evidenceIds) ? j.evidenceIds.filter((x) => typeof x === 'string') : [],
      }
    }
    if (Object.keys(out).length === 0) {
      return { judgements: {}, error: '模型没有返回可用的 judgements 字段' }
    }
    return { judgements: out, error: '' }
  } catch (e) {
    return { judgements: {}, error: e instanceof Error ? e.message : String(e) }
  }
}

export { judgeClaims }

/**
 * 对照实验用：判定一组"裸模型给出的结论"是否被给定的原文片段池支持。
 * 用的是与产品完全相同的判定逻辑与提示词，保证 A/B 两臂的判定口径一致。
 */
export async function judgePlainClaims({ claims, evidence }) {
  const items = (claims || []).map((c, i) => ({ id: `c${i}`, kind: 'paragraph', text: c }))
  const pool = (evidence || []).map((e, i) => ({ id: `e${i}`, ...e }))
  const r = await judgeClaims({ claims: items, evidence: pool })
  return {
    judgements: items.map((item) => {
      const j = r.judgements[item.id]
      return {
        text: item.text,
        support: j ? j.support : 'unchecked',
        reason: j ? j.reason : r.error || '复核未返回结果',
        evidenceIds: j ? j.evidenceIds.map((eid) => pool.find((p) => p.id === eid)?.evidenceId || eid) : [],
      }
    }),
    error: r.error || '',
  }
}

/* ------------------------------------------------------------------ */
/* 正文挑选（控制上下文长度）                                          */
/* ------------------------------------------------------------------ */

const KEY_PATTERNS = [
  /experiment/i,
  /setup|configuration/i,
  /hyper-?parameter|learning rate|batch size|epoch|seed|optimizer/i,
  /normali[sz]|standardiz|min-?max|z-?score|scal/i,
  /split|training set|test set|validation set/i,
  /horizon|prediction length/i,
  /dataset|benchmark/i,
  /MSE|MAE|RMSE|SMAPE|MAPE/,
  /limitation|conclusion|reproducib/i,
]

/**
 * 优先保留：前 3 页（标题/摘要/方法）+ 命中实验关键词的页 + 最后 2 页。
 * 超出上限时按优先级裁剪，并如实返回是否发生了截断。
 */
export function selectPages(pages, limit = MAX_PAPER_CHARS) {
  const total = pages.reduce((n, p) => n + p.text.length, 0)
  if (total <= limit) return { pages, truncated: false, totalChars: total }

  const priority = new Map()
  pages.forEach((p) => {
    let score = 0
    if (p.page <= 3) score += 3
    if (p.page >= pages.length - 1) score += 2
    if (KEY_PATTERNS.some((re) => re.test(p.text))) score += 4
    priority.set(p.page, score)
  })

  const ordered = [...pages].sort((a, b) => {
    const d = (priority.get(b.page) || 0) - (priority.get(a.page) || 0)
    return d !== 0 ? d : a.page - b.page
  })

  const chosen = []
  let used = 0
  for (const p of ordered) {
    if (used + p.text.length > limit) continue
    chosen.push(p)
    used += p.text.length
    if (used > limit * 0.98) break
  }
  chosen.sort((a, b) => a.page - b.page)

  const droppedPages = pages.filter((p) => !chosen.some((c) => c.page === p.page)).map((p) => p.page)
  return { pages: chosen, truncated: true, totalChars: total, droppedPages }
}

/* ------------------------------------------------------------------ */
/* 模型调用                                                            */
/* ------------------------------------------------------------------ */

async function callLlm({ system, user, maxTokens = 8000 }) {
  if (!BASE_URL || !API_KEY) {
    const err = new Error('服务端没有配置模型密钥（LLM_API_KEY / ANTHROPIC_AUTH_TOKEN）')
    err.code = 'NO_CREDENTIALS'
    throw err
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180000)
  try {
    if (API_STYLE === 'openai') {
      const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })
      if (!res.ok) throw httpError(res.status, await res.text())
      const data = await res.json()
      return data?.choices?.[0]?.message?.content ?? ''
    }

    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        authorization: `Bearer ${API_KEY}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!res.ok) throw httpError(res.status, await res.text())
    const data = await res.json()
    const blocks = Array.isArray(data?.content) ? data.content : []
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
    if (!text.trim()) {
      // 实测：模型有时会把预算花在推理块上，最终 content 里没有 text 块。
      // 这种情况必须显式报错，绝不能返回空串让调用方以为"模型答了但没内容"。
      const kinds = blocks.map((b) => b?.type).filter(Boolean).join(',') || '空'
      const err = new Error(
        `模型返回了空内容（content 块类型：${kinds}${data?.stop_reason ? `，stop_reason=${data.stop_reason}` : ''}）`,
      )
      err.code = 'EMPTY_COMPLETION'
      throw err
    }
    return text
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('模型请求超时（180 秒）')
      err.code = 'TIMEOUT'
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function httpError(status, body) {
  const err = new Error(`模型接口返回 ${status}：${String(body).slice(0, 300)}`)
  err.code = 'LLM_HTTP'
  err.status = status
  return err
}

/** 从模型输出里提取 JSON（容忍代码块围栏与前后说明文字） */
export function parseJsonLoose(text) {
  if (!text) return null
  let s = String(text).trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = s.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    // 常见修补：去掉尾随逗号
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'))
    } catch {
      return null
    }
  }
}

/**
 * 要求模型返回 JSON；第一次解析失败时用更紧凑的要求重试一次。
 * 这样既保证结构可用，也不会因为一次截断就把整个流程判死。
 */
async function callForJson({ system, user, maxTokens, retryHint }) {
  const first = await callLlm({ system, user, maxTokens })
  const parsed = parseJsonLoose(first)
  if (parsed) return parsed

  const retryUser = `${user}

【重要】上一次的回复不是完整、可解析的 JSON。这次请务必：只输出一个 JSON 对象，不要任何前后说明文字，
不要使用 markdown 代码块，不要在 JSON 内部换行。${retryHint || ''}`
  const second = await callLlm({ system, user: retryUser, maxTokens })
  const parsed2 = parseJsonLoose(second)
  if (parsed2) return parsed2

  const err = new Error('模型没有返回可解析的 JSON 结构')
  err.code = 'BAD_JSON'
  err.raw = String(second || first).slice(0, 400)
  throw err
}

/* ------------------------------------------------------------------ */
/* 字段抽取                                                            */
/* ------------------------------------------------------------------ */

export const EXTRACT_FIELDS = [
  ['researchProblem', '研究问题（论文要解决什么问题）'],
  ['method', '核心方法（提出的模型/框架与关键设计）'],
  ['dataset', '数据集名称'],
  ['split', '训练/验证/测试划分比例'],
  ['splitRange', '训练集与测试集的时间区间或边界（例如测试集是最后 20%，起止日期是什么）'],
  ['sampleInterval', '数据采样间隔或频率（例如 15 minutes / 1 hour / daily）'],
  ['horizon', '预测跨度（向前预测多少步）'],
  ['metrics', '评价指标'],
  ['baselines', '对比的基线方法'],
  ['evalProtocol', '评估协议：评估时是**一次性直接预测**（single-shot / direct）还是**滚动或自回归多步**（rolling / autoregressive multi-step），以及是否多步累计评估。注意：这不是模型内部的算子（如 Autoformer 的 Roll 操作），也不是损失函数；论文没有明确说明时判 missing'],
  ['preprocessing', '数据预处理（标准化/归一化方式，以及统计量取自训练集还是全量数据）'],
  ['learningRate', '学习率'],
  ['optimizer', '优化器'],
  ['randomSeed', '随机种子是否固定及取值'],
  ['epochs', '训练轮数（含是否早停）'],
  ['batchSize', '批大小'],
  ['params', '模型参数量'],
  ['codeAvailability', '代码/数据是否公开'],
  ['conclusion', '主要结论（含论文报告的关键数字）'],
  ['limitations', '作者承认的局限'],
]

/* ------------------------------------------------------------------ */
/* 定向二次检索：初次抽取未命中时，按关键词/同义词在**全文**里找候选证据   */
/* ------------------------------------------------------------------ */

/**
 * 每个字段的关键词与同义词（中英混合，按"证据句可能长什么样"来写）。
 * 这些词只用于**定位候选片段**，不用于判断——判断仍然交给模型 + 逐字校验。
 */
const FIELD_KEYWORDS = {
  dataset: [
    /datasets?/i,
    /data sets?/i,
    /benchmarks?/i,
    /evaluate[ds]? on/i,
    /experiments? (?:are|were)? ?(?:conducted|performed)/i,
    /\bETTh\d?\b/i,
    /\bETTm\d?\b/i,
    /\bTraffic\b/i,
    /\bElectricity\b/i,
    /\bWeather\b/i,
    /\bILI\b/i,
    /\bExchange(?:-Rate)?\b/i,
    /\bCOVID-19\b/i,
  ],
  split: [
    /training[/\- ]?(?:validation|val)?[/\- ]?test/i,
    /train[/\- :]?val(?:idation)?[/\- :]?test/i,
    /\bsplit(?:ting)?\b/i,
    /\bpartition/i,
    /(?:7|6|8)\s*[:：]\s*1\s*[:：]\s*2/,
    /(?:6|7)\s*[:：]\s*2\s*[:：]\s*2/,
    /last\s+\d{1,2}\s*%/i,
  ],
  sampleInterval: [
    /sampl(?:ing|e)\s*(?:interval|rate|frequency)/i,
    /\bresolution/i, // PatchTST 用 "2 different resolutions (15 minutes and 1 hour)" 表述采样精度
    /\bgranularity\b/i,
    /\bfrequency\b/i,
    /\bhourly\b/i,
    /\bweekly\b/i,
    /\bdaily\b/i,
    /\bminute(?:s)?\b/i,
    /\b\d{1,3}\s*(?:min|minutes|hour|hours|day|days)\b/i,
    /每\s*\d+\s*(?:分钟|小时|天)/,
  ],
  evalProtocol: [
    /single[- ]?step/i,
    /multi[- ]?step/i,
    /\broll(?:ing)?\b/i,
    /auto[- ]?regressive/i,
    /iterat(?:ive|ively)/i,
    /one[- ]?(?:shot|pass)/i,
    /directly (?:predict|forecast)/i,
    /evaluat(?:e|ion) protocol/i,
  ],
  horizon: [/horizon/i, /\bH\s*=/, /prediction length/i, /forecast(?:ing)? (?:length|horizon)/i, /\b96\b/],
  metrics: [/\bMSE\b/, /\bMAE\b/, /\bRMSE\b/, /\bMAPE\b/, /\bSMAPE\b/, /evaluation metrics?/i],
  baselines: [/\bbaselines?\b/i, /compared (?:with|to|against)/i, /\bInformer\b/, /\bAutoformer\b/, /\bFEDformer\b/, /\bTransformer\b/],
  preprocessing: [/normali[sz]/i, /standardi[sz]/i, /z-score/i, /min-?max/i, /\bscaler\b/i],
  splitRange: [/test set/i, /testing (?:set|period|data)/i, /from \d{4}/i, /last \d{1,2}\s*%/i],
  learningRate: [/learning rate/i, /\blr\b/i, /1e-?\d/i, /10\s*[-−]\s*\d/],
  optimizer: [/\bAdam\b/i, /\bAdamW\b/i, /\bSGD\b/i, /optimi[sz]er/i],
  randomSeed: [/random seed/i, /\bseed\b/i, /repeated? .{0,20}times/i],
  epochs: [/\bepochs?\b/i, /early stop/i, /training iterations/i],
  batchSize: [/batch size/i, /\bbatch\b/i],
  codeAvailability: [/github\.com/i, /code (?:is|will be) (?:available|released)/i, /open[- ]source/i],
}

/** 把全文按句子切分（保留页码），用于关键词定位 */
function sentencesWithPages(pages) {
  const out = []
  for (const pg of pages) {
    const text = String(pg?.text || '')
    if (!text.trim()) continue
    const parts = text.split(/(?<=[.!?;])\s+|\n+/)
    for (const raw of parts) {
      const s = raw.replace(/\s+/g, ' ').trim()
      if (s.length >= 20) out.push({ page: Number(pg.page) || 0, text: s })
    }
  }
  return out
}

/**
 * 定向检索：用字段关键词在**全部页面**里找候选片段。
 * 关键点：检索范围是全文，不受"初次抽取时只送了部分页"的限制。
 */
export function retrieveCandidates(pages, key, maxItems = 14) {
  const patterns = FIELD_KEYWORDS[key] || []
  if (patterns.length === 0) return []
  const scored = []
  for (const s of sentencesWithPages(pages)) {
    let score = 0
    for (const re of patterns) if (re.test(s.text)) score += 1
    if (score > 0) scored.push({ ...s, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  const seen = new Set()
  for (const s of scored) {
    const k = s.text.slice(0, 80)
    if (seen.has(k)) continue
    seen.add(k)
    picked.push(s)
    if (picked.length >= maxItems) break
  }
  return picked
}

/**
 * 二次检索后的**模型复核**：把候选片段交给模型判断字段是否有明确依据。
 * 返回 { status, value, page, quote, note }，quote 必须来自候选片段（后续仍会逐字校验）。
 */
async function judgeCandidatesForField({ key, description, candidates, fileName }) {
  if (candidates.length === 0) return null
  const system = [
    '你在做论文信息抽取的**二次核对**。只依据给出的候选片段判断，不要使用常识。',
    '只输出 JSON，不要 markdown 代码块，不要解释。',
  ].join('\n')
  const user = `论文（${fileName}）中，第一次抽取没有找到字段「${key}」（${description}）。
下面是从**全文**里按关键词检索出的候选片段（每行含页码）：

${candidates.map((c, i) => `[${i + 1}] p.${c.page}: ${c.text}`).join('\n')}

请判断：这些片段里是否**明确**给出了该字段的信息？
- 有：status="found"，value 用简洁中文概括（保留数字与专有名词），page 填该片段页码，
  quote 必须从上面片段里**逐字复制**的连续英文原句（40~240 字符），不要改写、不要跨句拼接。
- 只有含糊表述（例如只说"按之前工作的设置"）：status="uncertain"，value 说明"论文只说了什么、还缺什么"。
- 完全没有：status="missing"，value 为 null，quote 为空字符串。

输出格式：{"status":"found|uncertain|missing","value":"...或null","page":1,"quote":"...","note":"可选中文说明"}`
  try {
    const json = await callForJson({ system, user, maxTokens: 6000 })
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

/**
 * 把 dataset / split / sampleInterval 拆成「按数据集分别保存」的结构。
 * 做法是确定性的：先在字段原文里按「数据集名 + 取值」配对，找不到配对的
 * 用逐句检索兜底；仍配不上就保留为 overall（并注明未按数据集区分）。
 */
export function perDatasetBreakdown(pages, fields) {
  const names = String(fields?.dataset?.value || '')
    .split(/[、,，;；/|()（）\[\]【】]+|\s+以及\s+|\s+和\s+|\s+与\s+|\s+及\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && !/^(等|其他|其它|以及|和|与|及)$/.test(s))

  const out = {}
  for (const key of ['split', 'sampleInterval']) {
    const overallValue = typeof fields?.[key]?.value === 'string' ? fields[key].value : null
    const entries = []
    if (overallValue) {
      // 1) 先把整体值按分隔符切成"段"，再看每一段里出现了哪个数据集名。
      //    这样 "ETTm 15分钟、Electricity 1小时" → ETTh*/Traffic 等各自拿到自己那一段，
      //    而不是所有数据集都抄一遍整体值（那等于没按数据集区分）。
      const segments = overallValue
        .split(/[、，,；;。]|\band\b/)
        .map((s) => s.trim())
        .filter(Boolean)
      const usedSegments = new Set()
      for (const name of names) {
        let seg = segments.find((s) => s.includes(name))
        // ETT 家族：原文常写 "ETT 按 6:2:2"（不写 ETTh1/ETTm1），用别名匹配；
        // 同时排除 "其他数据集" 这类默认段，避免把别的比例套到 ETT 上。
        if (!seg && /^ETT[hm]\d?$/i.test(name)) {
          seg = segments.find((s) => /\bETT\b/i.test(s) && !/其他|其余|others?|remaining/i.test(s))
        }
        if (seg) {
          usedSegments.add(seg)
          entries.push({ dataset: name, value: seg, page: fields[key].evidence?.[0]?.page ?? null })
        }
      }
      // 1b) "其他数据集 / 其余数据集 / others / remaining" 这类**默认段**：
      //     它不指名任何数据集，但适用于所有还没被明确指定的数据集。
      //     例：Autoformer "ETT 按 6:2:2、其他数据集按 7:1:2" ——
      //     如果不处理这一句，ETT 的 6:2:2 会被错当成所有数据集的比例。
      const defaultSeg = segments.find((s) => /其他|其余|剩下的|剩余|others?|remaining|the rest/i.test(s))
      if (defaultSeg) {
        for (const name of names) {
          if (entries.some((e) => e.dataset === name)) continue
          entries.push({
            dataset: name,
            value: `${defaultSeg}（原文用"其他数据集"统称，未逐一点名）`,
            page: fields[key].evidence?.[0]?.page ?? null,
          })
        }
      }
      // 整体值里只提到"其余数据集/所有数据集"这类统一表述时，仍保留为整体值（标注清楚）
      if (entries.length === 0 && segments.length > 0) {
        entries.push({ dataset: '（整体）', value: overallValue.slice(0, 160), page: fields[key].evidence?.[0]?.page ?? null })
      }
    }
    // 2) 兜底：只对"还没配到值"的数据集做逐句检索，且要求句子同时满足「数据集名 + 明确的取值特征」，
    //    避免把无关句子（例如"15% (0.733→0.739)"）错配成划分比例 / 采样间隔。
    const need = names.filter((n) => !entries.some((e) => e.dataset === n))
    if (need.length > 0) {
      for (const s of sentencesWithPages(pages)) {
        for (const name of need) {
          if (entries.some((e) => e.dataset === name && e.value.length > 6)) continue
          // ETT 家族特殊处理：PatchTST 等论文写的是 "ETT ... 2 different resolutions (15 minutes and 1 hour)"，
          // 句子里只有 "ETT" 没有 "ETTm1"，靠别名匹配 + m/h → 15 分钟 / 1 小时 的命名惯例补上。
          const isEtt = /^ETT[hm]\d$/i.test(name)
          const nameHit = s.text.includes(name) || (isEtt && /\bETT\b/.test(s.text))
          if (!nameHit) continue
          const twoRes = /(\d{1,3})\s*minutes?\s*and\s*(\d{1,3})\s*hours?/i.exec(s.text)
          if (key === 'sampleInterval' && isEtt && twoRes) {
            entries.push({
              dataset: name,
              value: /m\d$/i.test(name)
                ? `每 ${twoRes[1]} 分钟（原文：${s.text.slice(0, 90)}）`
                : `每 ${twoRes[2]} 小时（原文：${s.text.slice(0, 90)}）`,
              page: s.page,
            })
            continue
          }
          const ok =
            key === 'split'
              ? /\d\s*[:：]\s*\d\s*[:：]\s*\d/.test(s.text) ||
                (/(split|divid|partition|train(?:ing)? set)/i.test(s.text) && /\d{1,2}\s*%/.test(s.text))
              : /\d{1,3}\s*(?:min(?:ute)?s?|h(?:ou)?rs?|days?)\b/i.test(s.text) ||
                /每?\s*\d{1,3}\s*(?:分钟|小时|天)/.test(s.text)
          if (ok) {
            const dup = entries.find((e) => e.dataset === name)
            if (dup && dup.value.length <= 6) entries.splice(entries.indexOf(dup), 1)
            entries.push({ dataset: name, value: s.text.slice(0, 160), page: s.page })
          }
        }
      }
    }
    // 3) ETT 家族最后兜底：论文（如 PatchTST）常写"ETT 有两种分辨率：15 分钟与 1 小时"，
    //    但句子里不会出现 ETTm1/ETTh1。这里按论文给出的两种分辨率 + 数据集命名惯例（m=分钟、h=小时）落位，
    //    并在 note 里说明依据来自哪一句、哪些部分是命名惯例。
    if (key === 'sampleInterval') {
      const overall = String(fields?.sampleInterval?.value || '')
      const evQuote = String(fields?.sampleInterval?.evidence?.[0]?.quote || '')
      const pool = `${overall} ${evQuote}`
      const minM = /(\d{1,3})\s*分钟/.exec(pool) || /(\d{1,3})\s*minutes?/i.exec(pool)
      const hourM = /(\d{1,3})\s*小时/.exec(pool) || /(\d{1,3})\s*hours?/i.exec(pool)
      if (minM && hourM) {
        for (const name of names) {
          if (!/^ETT[hm]\d$/i.test(name)) continue
          if (entries.some((e) => e.dataset === name)) continue
          entries.push({
            dataset: name,
            value: /m\d$/i.test(name) ? `每 ${minM[1]} 分钟（ETTm）` : `每 ${hourM[1]} 小时（ETTh）`,
            page: fields?.sampleInterval?.evidence?.[0]?.page ?? null,
          })
        }
      }
    }

    out[key] = {
      overall: overallValue,
      perDataset: entries,
      scoped: entries.length > 0,
      note:
        entries.length > 0
          ? `已按数据集分别记录 ${entries.length} 条（数据集共 ${names.length} 个）。`
          : overallValue
            ? '正文里没有把该取值与具体数据集配对，只能作为整体值保存（使用时需回原文确认）。'
            : null,
    }
  }
  out.dataset = { overall: fields?.dataset?.value ?? null, perDataset: names.map((n) => ({ dataset: n, value: n })), scoped: names.length > 0, note: null }
  return out
}

export async function extractFields({ pages, fileName, title }) {
  const sel = selectPages(pages)
  const body = sel.pages
    .map((p) => `<<<PAGE ${p.page}>>>\n${p.text}`)
    .join('\n\n')

  const system = [
    '你是严谨的论文信息抽取助手。你的输出会被程序逐条校验，因此不要凭常识补全任何内容。',
    '请只输出 JSON，不要输出解释文字，不要使用 markdown 代码块。',
  ].join('\n')

  const user = `下面是一篇论文（文件名：${fileName}${title ? `，标题：${title}` : ''}）按页切分的正文。
${sel.truncated ? `注意：为控制长度，本次只提供了部分页面（第 ${sel.pages.map((p) => p.page).join(', ')} 页），未提供的页面对应字段请按"未找到"处理。` : ''}

请抽取下列字段：
${EXTRACT_FIELDS.map(([k, d]) => `- ${k}：${d}`).join('\n')}

严格遵守以下规则：
1. 只有当正文里有**明确依据**时，status 才能是 "found"，并且必须给出 1~2 条 evidence。
   evidence.quote 必须从正文中**逐字复制**的英文原句（60~240 个字符），必须来自你标注的那一页，不要改写、不要拼接不相邻的句子。
2. 正文里没有提到的字段：status 必须是 "missing"，value 为 null，evidence 为空数组[]。绝对不要用常识补全或猜测。
3. 正文提到但表述含糊、不足以确定取值：status 为 "uncertain"，value 里说明"论文只说了什么、还缺什么"。
4. value 用简洁中文概括（不超过 120 字），保留关键数字与专有名词（例如 "7:1:2"、"96 步"、"1e-3"、"Adam"、"ETTm1"、"min-max"）。
5. page 必须是页码数字（对应 <<<PAGE n>>> 里的 n）。
6. 对 dataset、metrics、baselines 这类"集合型"字段：只要正文里出现过数据集名 / 指标名 / 基线方法名，
   就必须记为 "found"，并把它们聚合到 value 里（例如 dataset = "ETTh1、ETTh2、ETTm1、ETTm2、Traffic、Electricity、Weather、ILI、Exchange-Rate"）。
   不要因为"名字分散在不同页/不同段落"就判成 missing；这类字段的 evidence 只需引用其中一条能证明名字出现的句子即可。
   baselines 只收论文明确作为对比方法列出的模型，不要把本文自己提出的方法算进去。
   "missing" 只用于正文完全没有提及该信息的字段。
7. sampleInterval 尽量按数据集分别说明（不同数据集采样间隔常常不同，例如"ETTh 1 小时、ETTm 15 分钟、Weather 10 分钟"）。
8. horizon 要写出论文使用的全部预测跨度（例如"T ∈ {96, 192, 336, 720}"），不要只看第一个数字。
9. conclusion 可以从摘要、结论章节或结果表格的文字描述里提取，写成"相对某个基线在某个数据集上提升多少"这类可核查的说法；
   只有当整篇正文都没有任何结果性描述时才判为 missing。
10. splitRange 要写清测试集覆盖的起止时间或"最后百分之多少"；若只有比例没有区间，判为 "uncertain" 并在 note 里说明缺什么。
11. 训练细节（learningRate、optimizer、randomSeed、epochs、batchSize）：论文没有给出具体数值就必须判 "missing"，
    即使论文只说"使用默认超参数""请参考代码"也要判 missing —— 这类缺失正是用户需要知道的信息。
12. split 与 splitRange 必须严格区分：
    split = **划分比例**（例如 "7:1:2"、"ETT 按 6:2:2，其他数据集按 7:1:2"），
    splitRange = **时间区间**（测试集起止日期，或"最后 20%"/"last 12 months"这类时间范围）。
    只有比例、没有任何时间表述时，splitRange 判 "uncertain" 并在 note 说明"只有比例、没有时间区间"；
    反过来，只有时间区间、没有比例时，split 判 "uncertain"。**不要把两者写成同一句话**。
    另外：不同数据集的比例可能不同（例如 ETT 6:2:2、其他 7:1:2），value 里必须把"哪个数据集用什么比例"写清楚。
13. evalProtocol 指的是**评估方式**：一次性直接预测（single-shot）还是滚动/自回归多步（rolling / autoregressive）。
    不要把它写成模型内部的算子（例如 Autoformer 的 Roll）、损失函数或优化器；论文没有明确说明评估方式时判 missing。
14. dataset / baselines / metrics 这类集合字段：名字必须出现在**实验语境**里（例如 "we evaluate on ..."、
    "experiments are conducted on ..."、"compared with ..."、"used as baselines"）。
    只在相关工作或引用列表里出现过的名字不要收进来；如果只找到名字、找不到实验语境，判 "uncertain" 并在 note 里说明。

输出格式（不要输出其它内容）：
{"fields":{"字段名":{"status":"found|missing|uncertain","value":"中文概括或null","evidence":[{"page":1,"quote":"verbatim English sentence"}],"note":"可选的中文说明"}}}

论文正文：
${body}`

  const json = await callForJson({
    system,
    user,
    maxTokens: 32000,
    retryHint:
      '每个字段的 evidence 最多 1 条，quote 长度控制在 60~200 个字符；value 不超过 80 个汉字。',
  })

  const warnings = []
  if (sel.truncated) {
    warnings.push(
      `论文正文较长（约 ${sel.totalChars} 字符），仅把第 ${sel.pages
        .map((p) => p.page)
        .join('、')} 页送给了模型，未包含的页码：${(sel.droppedPages || []).join('、')}。相关字段可能因此显示为"未找到"。`,
    )
  }

  const fields = {}
  let downgraded = 0
  let correctedPages = 0
  let droppedQuotes = 0
  let aggregateRecovered = 0
  let usageFlagged = 0
  const fieldUsageOk = {}

  for (const [key] of EXTRACT_FIELDS) {
    const rawField = json.fields[key]
    if (!rawField || typeof rawField !== 'object') {
      fields[key] = { status: 'missing', value: null, evidence: [], note: undefined }
      continue
    }
    const status = ['found', 'uncertain', 'missing'].includes(rawField.status)
      ? rawField.status
      : 'missing'
    const value =
      typeof rawField.value === 'string' && rawField.value.trim()
        ? rawField.value.trim().slice(0, 400)
        : null

    const evidence = []
    const list = Array.isArray(rawField.evidence) ? rawField.evidence.slice(0, 2) : []
    for (const ev of list) {
      const claimed = Number(ev?.page) || null
      const check = verifyQuote(pages, claimed, ev?.quote)
      if (check.ok) {
        if (check.corrected) correctedPages += 1
        if (!evidence.some((e) => e.quote === check.quote)) {
          evidence.push({ page: check.page, quote: check.quote })
        }
      } else {
        droppedQuotes += 1
      }
    }

    let finalStatus = status
    let note =
      typeof rawField.note === 'string' && rawField.note.trim()
        ? rawField.note.trim().slice(0, 300)
        : undefined

    // 集合型字段：整句引用对不上时，改用「逐个名字回查正文」的方式核验
    if (status === 'found' && evidence.length === 0 && value && AGGREGATE_FIELDS.has(key)) {
      const agg = verifyAggregateValue(pages, value)
      if (agg.ok) {
        agg.evidence.forEach((e) => evidence.push(e))
        aggregateRecovered += 1
        note = `集合型字段：值中的名字已逐个回查正文（命中率 ${(agg.hitRatio * 100).toFixed(0)}%），并找到「实验用途」表述（${
          (agg.usageEvidence || [])[0] ? `如 "${String(agg.usageEvidence[0].quote).slice(0, 70)}…"` : '已找到'
        }），证据取自正文原句。${note ? `（模型说明：${note}）` : ''}`
      }
    }

    // 集合型字段必须有**实验用途证据**：只"名字出现过"不足以说明它真的用于实验。
    // 不把名字作废（名字确实出现了），而是标记 usageOk=false，让界面按「已有线索，需确认」呈现。
    if (finalStatus === 'found' && value && AGGREGATE_FIELDS.has(key)) {
      const usage = usageEvidenceFor(pages, value)
      fieldUsageOk[key] = usage.ok
      if (!usage.ok) {
        usageFlagged += 1
        note = `名字在正文里出现了，但**没有找到"用于实验"的表述**（例如 evaluate on / experiments on / compared with / used as baselines），因此不能仅凭名称断定这些名字就是本文实验使用的对象 —— 判为「已有线索，需确认」。${
          note ? `（${note}）` : ''
        }`
      } else if (usage.evidence.length > 0) {
        usage.evidence.slice(0, 2).forEach((e) => {
          if (!evidence.some((x) => x.quote === e.quote)) evidence.push(e)
        })
      }
    }

    if (status === 'found' && evidence.length === 0) {
      finalStatus = 'missing'
      downgraded += 1
      note = `模型声称找到了取值，但其引用的原文片段无法在论文里逐字核对，已按「未找到」处理。${
        note ? `（模型说明：${note}）` : ''
      }`
    }
    if (status === 'found' && !value) {
      finalStatus = 'missing'
      downgraded += 1
      note = '模型没有给出可用的取值，已按「未找到」处理。'
    }

    fields[key] = {
      status: finalStatus,
      value: finalStatus === 'missing' ? null : value,
      evidence,
      note,
      // 集合型字段：是否找到了"用于实验"的表述（false 时界面显示「已有线索，需确认」）
      usageOk: fieldUsageOk[key],
    }
  }

  if (downgraded > 0) {
    warnings.push(
      `有 ${downgraded} 个字段因为引用的原文片段无法逐字核对，被自动降级为「未找到」而不是直接采信模型的说法。`,
    )
  }
  if (aggregateRecovered > 0) {
    warnings.push(
      `有 ${aggregateRecovered} 个「集合型」字段（数据集/指标/基线等）改用逐名回查正文的方式核验通过，证据取自正文原句。`,
    )
  }
  if (droppedQuotes > 0) {
    warnings.push(`共剔除 ${droppedQuotes} 条无法在论文中定位的引用片段。`)
  }
  if (correctedPages > 0) {
    warnings.push(`有 ${correctedPages} 条引用标注的页码与原文实际所在页不一致，已按实际页码修正。`)
  }

  // ---- 1.5 步：定向二次检索 ----
  // 初次抽取"未命中"有两大原因：① 模型漏看；② 正文被截断（只送了部分页）。
  // 这里按字段关键词/同义词在**全文**里找候选片段，再交给模型判断；
  // 只有这一轮也没找到，才允许标「未找到」。
  // EXTRACT_SECOND_PASS=0 可关掉这一轮（等价于**修复前**的行为），专门用于做前后对照。
  const SECOND_PASS = process.env.EXTRACT_SECOND_PASS !== '0'
  const uncheckedPages = pages.filter((p) => !String(p?.text || '').trim()).map((p) => Number(p.page) || 0)
  const retrievalReport = []
  let recovered = 0
  const missingKeys = SECOND_PASS
    ? EXTRACT_FIELDS.map(([k]) => k).filter((k) => {
        const f = fields[k]
        return !f || f.status === 'missing' || f.status === 'uncertain'
      })
    : []
  for (const key of missingKeys) {
    const desc = (EXTRACT_FIELDS.find(([k]) => k === key) || [, ''])[1]
    const candidates = retrieveCandidates(pages, key)
    if (candidates.length === 0) {
      retrievalReport.push({ key, candidates: 0, recovered: false })
      continue
    }
    const verdict = await judgeCandidatesForField({ key, description: desc, candidates, fileName })
    let ok = false
    if (verdict && verdict.status !== 'missing' && typeof verdict.value === 'string' && verdict.value.trim()) {
      const value = verdict.value.trim().slice(0, 400)
      // 与初次抽取同一把尺子：引用必须能在**全文**里逐字核对
      const check = verifyQuote(pages, Number(verdict.page) || null, verdict.quote)
      if (check.ok) {
        fields[key] = {
          status: verdict.status === 'uncertain' ? 'uncertain' : 'found',
          value,
          evidence: [{ page: check.page, quote: check.quote }],
          note: `初次抽取未命中，定向全文检索（扫过全部 ${pages.length} 页、命中 ${candidates.length} 条候选）后找到依据，已按同一套逐字校验确认。${
            verdict.note ? `（检索说明：${String(verdict.note).slice(0, 120)}）` : ''
          }`,
          recoveredBy: 'retrieval',
        }
        ok = true
        recovered += 1
      } else if (AGGREGATE_FIELDS.has(key)) {
        // 集合型字段（数据集/指标/基线/参数量）允许"整句引用对不上、但名字都能逐字回查"的路径，
        // 与初次抽取里的处理保持一致 —— 否则会因为模型引用了相邻句子而把整项判成漏抽。
        const agg = verifyAggregateValue(pages, value)
        if (agg.ok) {
          fields[key] = {
            status: 'found',
            value,
            evidence: agg.evidence.slice(0, 2),
            note: `初次抽取未命中，定向全文检索后由「逐个名字回查正文」确认（名字命中率 ${(
              agg.hitRatio * 100
            ).toFixed(0)}%），证据取自正文原句。`,
            recoveredBy: 'retrieval',
          }
          ok = true
          recovered += 1
        }
      }
    }
    retrievalReport.push({ key, candidates: candidates.length, recovered: ok })
  }

  // ---- 1.6 步：三态区分 ----
  // 初次漏抽（recoveredBy=retrieval）/ 原文未报告（not_reported）/ 未检查（页面没有可读文本）
  // 关闭二次检索时（EXTRACT_SECOND_PASS=0）不打标，保持与修复前一致，便于前后对照。
  if (SECOND_PASS) {
  for (const [key] of EXTRACT_FIELDS) {
    const f = fields[key]
    if (!f) continue
    if (f.recoveredBy === 'retrieval') {
      f.checkState = 'retrieval'
      continue
    }
    if (f.status === 'found' || f.status === 'uncertain') {
      f.checkState = 'direct'
      continue
    }
    const tried = retrievalReport.find((r) => r.key === key)
    if (uncheckedPages.length > 0) {
      f.checkState = 'unchecked'
      f.note = `第 ${uncheckedPages.join('、')} 页没有可读文本（可能是扫描图或公式页），因此这一项算「未检查」而不是「原文未报告」。`
    } else {
      f.checkState = 'not_reported'
      f.note = `已完成定向全文检索（关键词/同义词扫过全部 ${pages.length} 页${
        tried ? `，命中 ${tried.candidates} 条候选但都不足以确定取值` : ''
      }），仍没有找到明确依据 → 判为「原文未报告」。`
    }
  }

  const recoveredKeys = Object.entries(fields)
    .filter(([, f]) => f.checkState === 'retrieval')
    .map(([k]) => k)
  if (recovered > 0) {
    warnings.push(
      `有 ${recovered} 个字段属于**初次漏抽**：第一次抽取没命中，经过按关键词的定向全文检索 + 模型复核后找回（${recoveredKeys.join('、')}）。`,
    )
  }
  const notReported = Object.entries(fields)
    .filter(([, f]) => f.checkState === 'not_reported')
    .map(([k]) => k)
  if (notReported.length > 0) {
    // 措辞必须诚实：检索没命中 ≠ 原文一定没写（可能是措辞不同、表格/图片里的数字没被抽成文本）
    warnings.push(
      `有 ${notReported.length} 个字段在本次定向检索范围内没有找到明确依据（检索覆盖全部 ${pages.length} 页的正文文本）：${notReported.join('、')}。这是「本次未找到明确说明」，不等于原文一定没有 —— 表格、图片或不同措辞都可能没被检索到。`,
    )
  }
  if (uncheckedPages.length > 0) {
    warnings.push(`第 ${uncheckedPages.join('、')} 页没有可读文本，涉及字段按**未检查**处理（不等同于原文没写）。`)
  }
  if (usageFlagged > 0) {
    warnings.push(
      `有 ${usageFlagged} 个集合型字段（数据集/基线/指标/参数量）只找到名字出现、没找到「用于实验」的表述，已标为「已有线索，需确认」而不是直接采信。`,
    )
  }
  }

  // ---- 1.65 步：划分比例 与 测试时间区间 严格区分 ----
  // 这两件事经常被混在一句话里："ETT 按 6:2:2 划分，测试集为最后 20%"。
  // 比例属于 split；时间区间/起止日期/最后百分之多少属于 splitRange。错位的一律纠正并留下说明。
  {
    const RATIO = /(\d{1,2}\s*[:：]\s*\d{1,2}(?:\s*[:：]\s*\d{1,2})?)/
    const RANGEISH = /(\d{4}[-/年]\d{1,2}|last\s+\d{1,2}\s*%|最后\s*\d{1,2}\s*%|\d{1,2}\s*%|from\s+\d{4}|to\s+\d{4})/i
    const splitV = String(fields.split?.value || '')
    const rangeV = String(fields.splitRange?.value || '')
    // (a) splitRange 里只有比例、没有区间 → 这不是区间
    if (fields.splitRange && fields.splitRange.status !== 'missing' && RATIO.test(rangeV) && !RANGEISH.test(rangeV)) {
      fields.splitRange.status = 'uncertain'
      fields.splitRange.note = `这里看到的是**划分比例**（${RATIO.exec(rangeV)[1]}），不是测试集的时间区间 —— 比例属于「训练/验证/测试划分」，两者不能混为一谈。${
        fields.splitRange.note ? `（${fields.splitRange.note}）` : ''
      }`
    }
    // (b) split 里带出了时间区间 → 把区间部分提示出来（不改数值，只标注）
    if (fields.split && RANGEISH.test(splitV) && RATIO.test(splitV)) {
      fields.split.note = `该项里同时出现了比例与时间表述，已把**比例**作为划分取值；时间区间请看「训练集/测试集时间区间」。${
        fields.split.note ? `（${fields.split.note}）` : ''
      }`
    }
    // (c) split 根本没写比例、只是区间 → 不算划分
    if (fields.split && fields.split.status === 'found' && !RATIO.test(splitV) && RANGEISH.test(splitV)) {
      fields.split.status = 'uncertain'
      fields.split.note = `这里给的是**时间区间**（不是划分比例），已按「需确认」处理。${
        fields.split.note ? `（${fields.split.note}）` : ''
      }`
    }
  }

  // ---- 1.7 步：数据集 / 划分 / 采样间隔按数据集分别保存 ----
  const perDataset = perDatasetBreakdown(pages, fields)
  for (const key of ['split', 'sampleInterval', 'dataset']) {
    if (fields[key]) fields[key].perDataset = perDataset[key]
  }

  // ---- 第二步：逐条判定「原文片段是否真的支持这个取值」----
  // 只对「已找到」的字段做，避免白花时间；判定失败时标为「未复核」而不是假装通过。
  const toJudge = []
  for (const [key] of EXTRACT_FIELDS) {
    const f = fields[key]
    if (!f || f.status !== 'found' || !f.value || f.evidence.length === 0) continue
    toJudge.push({
      id: key,
      claim: `${key} = ${f.value}`,
      page: f.evidence[0].page,
      // 把这个字段的全部证据片段都给它（有的字段需要两条引用才能覆盖完整取值）
      quote: f.evidence.map((e) => `[第 ${e.page} 页] ${e.quote}`).join('\n'),
    })
  }
  const judged = toJudge.length ? await judgeSupport(toJudge) : {}
  let unsupported = 0
  let partialSupported = 0
  for (const item of toJudge) {
    const f = fields[item.id]
    const j = judged[item.id]
    if (!j) {
      // 没判到（模型没返回这条 / 整批失败）：如实标注，不假装已复核
      f.support = 'unchecked'
      f.note = `${f.note ? `${f.note} ` : ''}（这条取值还没有经过「原文是否支持」的复核，请对照引用自行确认。）`
      continue
    }
    f.support = j.support
    f.supportReason = j.reason || undefined
    if (j.support === 'none') {
      unsupported += 1
      f.withdrawnValue = f.value
      f.withdrawnReason = j.reason || '原文片段并不支持这个取值'
      f.status = 'missing'
      f.value = null
      f.note = `模型给出的取值「${f.withdrawnValue}」缺少原文支持（判定：${
        j.reason || '片段与取值不对应'
      }），已按「未找到」处理并撤回该结论。${
        f.note ? `（抽取时的说明：${f.note}）` : ''
      }`
    } else if (j.support === 'partial') {
      partialSupported += 1
      f.note = `${f.note ? `${f.note} ` : ''}原文只部分支持这个取值：${
        j.reason || '片段未覆盖全部要点'
      }，建议回原文确认。`
    }
  }

  const coverage = {
    totalPages: pages.length,
    usedPages: sel.pages.map((p) => p.page),
    skippedPages: sel.droppedPages || [],
    emptyPages: pages.filter((p) => (p.text || '').trim().length < 20).map((p) => p.page),
  }

  if (unsupported > 0) {
    warnings.push(
      `有 ${unsupported} 个字段的取值虽然能查到引用，但原文片段并不支持这个说法，已撤回并按「未找到」处理（原始说法保留在字段说明里）。`,
    )
  }
  if (partialSupported > 0) {
    warnings.push(
      `有 ${partialSupported} 个字段的取值只被原文部分支持（片段没有覆盖全部要点），已在字段说明里标注，建议回原文确认。`,
    )
  }
  if (toJudge.length > 0 && Object.keys(judged).length === 0) {
    warnings.push('「原文是否支持结论」的复核这一步没有成功返回结果，相关字段已标注为未复核。')
  }

  return {
    fields,
    warnings,
    pagesUsed: sel.pages.map((p) => p.page),
    truncated: sel.truncated,
    coverage,
  }
}

/**
 * 对照实验用的**裸模型**问答：不做引用校验、不做结论支持判定、不给规则推导上下文。
 * 目的只是得到"直接把论文丢给模型提问"的基线答案，用于和本工具的流程做对比。
 * 这条路径不参与产品功能，只在 benchmark 里调用。
 */
export async function rawAsk({ question, papers }) {
  const perPaperLimit = Math.max(8000, Math.floor(MAX_PAPER_CHARS / Math.max(1, papers.length)))
  const sections = papers.map((p) => {
    const sel = selectPages(p.pages || [], perPaperLimit)
    const body = sel.pages.map((pg) => `<<<PAGE ${pg.page}>>>\n${pg.text}`).join('\n\n')
    return `===== 论文 ${p.shortLabel}（paperId=${p.id}，标题：${p.title}）=====\n${body}`
  })

  const system = '你是论文阅读助手，请依据用户提供的论文正文回答。'
  const user = `用户的问题：${question}

请回答上面的问题。要求：
1. 用中文回答，尽量具体（写出数据集名、数字、设置）。
2. 给出结论时说明依据来自哪篇论文的哪一页。
3. 如果材料不足，请明确说明。

论文正文：
${sections.join('\n\n')}`

  const text = await callLlm({ system, user, maxTokens: 24000 })
  return { text: String(text || '').trim() }
}

/* ------------------------------------------------------------------ */
/* 问答                                                                */
/* ------------------------------------------------------------------ */

/**
 * 规则结论的断言方向。
 * 只描述、不下方向性结论（unknown）时不拦，避免把"陈述取值"的正当中性句误杀。
 */
/**
 * 通用模型文本调用（供侦探/对撞台等新功能复用同一条调用链）。
 * 与其它调用一致：temperature=0、超时 180s、空内容抛 EMPTY_COMPLETION；
 * 只回传纯文本，**不做引用校验** —— 调用方必须自己对来源做逐字校验。
 */
export async function callModelText({ system, user, maxTokens = 4000 }) {
  return callLlm({ system, user, maxTokens })
}

export function assertionOf(text) {
  if (/不一致|不同|存在差异|并不相同|不一样|不能直接比较|不可直接比较|不可比/.test(text)) return 'different'
  if (/一致|相同|一样|对齐|都用了/.test(text)) return 'consistent'
  return 'unknown'
}

/** 规则的判定方向：一致 / 存在差异 / 信息不足（含未找到、未检查、需要确认） */
export function verdictKindOf(verdictText) {
  const t = String(verdictText || '')
  if (t.includes('一致') && !t.includes('不一致')) return 'consistent'
  if (t.includes('差异') || t.includes('不同')) return 'different'
  return 'insufficient'
}

/**
 * 结论与规则结果是否一致。
 * **命中同一个规则编号还不够**：程序判「信息不足」时，模型不能替它下「一致 / 存在差异」的结论。
 */
export function consistentWithRule(text, verdictText) {
  const assertion = assertionOf(text)
  const kind = verdictKindOf(verdictText)
  if (assertion === 'unknown') return true
  if (kind === 'insufficient') return false
  return assertion === kind
}

/**
 * 实验室：让模型提出**下一组实验条件**（只提条件，不执行代码）。
 * 范围校验、预算控制与实际执行都由 lab.mjs 负责。
 */
export async function planLabExperiment({ claim, history, options, budgetLeft }) {
  const fmt = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '—')
  const system = `你在一个受控实验台里提出下一组实验条件。只能在这些允许值里选择：
horizon（预测跨度）: ${options.horizon.join(' / ')}
perturbationType（扰动类型）: ${options.perturbationType.join(' / ')}
strength（扰动强度）: ${options.strength.join(' / ')}
seed（随机种子）: ${options.seed.join(' / ')}
规则：
- 只输出 JSON，不要 markdown、不要额外解释；
- 必须依据下面给出的真实已执行结果，不要编造数字；
- reason 用一句中文说明为什么选这一组，并且要引用上面出现过的真实数字；
- 不要重复已经跑过的同一组（跨度+类型+强度+种子）；
- 如果继续试探已经没有意义，返回 {"stop": true, "reason": "..."}。`

  const rows = (history || [])
    .slice(-12)
    .map(
      (h) =>
        `horizon=${h.horizon} type=${h.perturbationType} strength=${h.strength} seed=${h.seed} | 季节朴素 MAE=${fmt(h.mae)} 岭回归 MAE=${fmt(h.ridgeMae)} 差距(季节-岭)=${fmt(h.deltaMae)} 样本=${h.nSamples}`,
    )
    .join('\n')

  const user = `要验证的说法：${claim || '（未指定，按"哪种方法在该数据集上误差更低"理解）'}
剩余实验次数：${budgetLeft}
已执行记录（越靠后越新）：
${rows || '（还没有记录）'}

给出下一组条件，JSON 形如：
{"horizon": 96, "perturbationType": "noise", "strength": 0.1, "seed": 11, "reason": "..."}`

  try {
    const text = await callLlm({ system, user, maxTokens: 2000 })
    const parsed = parseJsonLoose(text)
    if (!parsed || typeof parsed !== 'object') return { ok: false, reason: '模型没有返回可解析的 JSON' }
    if (parsed.stop) return { ok: true, stop: true, reason: String(parsed.reason || '').slice(0, 300) }
    return {
      ok: true,
      stop: false,
      proposal: {
        horizon: parsed.horizon,
        perturbationType: parsed.perturbationType,
        strength: parsed.strength,
        seed: parsed.seed,
        reason: String(parsed.reason || '').slice(0, 300),
      },
    }
  } catch (e) {
    const code = e && e.code ? e.code : 'LLM_ERROR'
    return { ok: false, code, reason: e instanceof Error ? e.message : '模型调用失败' }
  }
}

export async function answerQuestion({ question, papers, context }) {
  const budgets = papers.map((p) => ({ id: p.id, label: p.shortLabel }))
  const perPaperLimit = Math.max(8000, Math.floor(MAX_PAPER_CHARS / Math.max(1, papers.length)))
  const checks = Array.isArray(context?.checks) ? context.checks : []
  const datasetScope = context?.datasetScope ? String(context.datasetScope) : null

  const sections = papers.map((p) => {
    const sel = selectPages(p.pages || [], perPaperLimit)
    const body = sel.pages.map((pg) => `<<<PAGE ${pg.page}>>>\n${pg.text}`).join('\n\n')
    return `===== 论文 ${p.shortLabel}（paperId=${p.id}，标题：${p.title}）=====\n${body}`
  })

  const system = [
    '你是论文阅读助手，只依据用户提供的论文正文回答，不允许使用正文之外的知识补充结论。',
    '输出必须是 JSON，不要输出解释文字，不要使用 markdown 代码块。',
  ].join('\n')

  const checkBlock = checks.length
    ? `

【工具已经算出的实验条件对比（本地确定性规则的结果，可直接引用，不需要论文原文再证明一遍）】
${checks
  .map(
    (c) =>
      `- ${c.label || c.id}［${c.verdictText || c.verdict}］：${String(c.reason || '').slice(0, 200)}${
        (c.perPaper || []).length
          ? `\n    输入字段：${(c.perPaper || [])
              .map((p) => `${p.label || p.paperId}=${p.value === null ? '（未读到）' : String(p.value).slice(0, 60)}`)
              .join('；')}`
          : ''
      }`,
  )
  .join('\n')}

说明：上面这些是**工具按规则算出来的**，你可以直接把它当作已知条件写进结论；
但论文内容类的事实（数据集名、数字、设置的具体取值）仍必须来自下面的正文并给出引用。`
    : ''

  const user = `用户的问题：${question}

可选论文：${budgets.map((b) => `${b.label}(paperId=${b.id})`).join('、')}${checkBlock}

请只依据下面的正文作答，并遵守：
1. 每个结论都必须有依据。如果正文里找不到依据，就明确说明"提供的论文正文里没有找到相关内容"，不要编造，也不要用常识补全。
   允许三类结论：(a) 论文事实 —— 必须有引用；(b) 系统事实 —— 例如"本次只提供了 1 篇论文正文"，直接陈述即可；
   (c) 规则推导 —— 例如"采样间隔不同，因此不能直接比较"，依据是上面工具算出的对比结果。
2. citations 里的每条引用必须来自给定正文：给出 paperId、page（数字）和**逐字复制**的英文原句（40~300 字符），必须来自你标注的那一页。
3. 回答用中文：paragraphs 是段落（2~4 段），bullets 是要点（可以包含"某某条件一致/存在差异/信息不足"这类结论）。
4. 如果论文之间的实验条件不同、导致结果无法直接比较，必须明确指出，不要给出排名。
5. 如果资料不足，把 insufficient 设为 true，并在 paragraphs 里说明缺什么。

输出格式（不要输出其它内容）：
{"paragraphs":["..."],"bullets":["..."],"citations":[{"paperId":"...","page":1,"quote":"verbatim English"}],"insufficient":false}

论文正文：
${sections.join('\n\n')}`

  const json = await callForJson({
    system,
    user,
    maxTokens: 24000,
    retryHint: 'paragraphs 最多 2 段、每段不超过 120 字；bullets 最多 6 条；citations 最多 5 条。',
  })

  const paragraphs = (Array.isArray(json.paragraphs) ? json.paragraphs : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 6)
  const bullets = (Array.isArray(json.bullets) ? json.bullets : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 14)

  const warnings = []
  let dropped = 0
  let corrected = 0
  const citations = []
  const list = Array.isArray(json.citations) ? json.citations.slice(0, 20) : []
  for (const c of list) {
    const paper = papers.find((p) => p.id === c?.paperId) || papers.find((p) => p.shortLabel === c?.paperId)
    if (!paper) {
      dropped += 1
      continue
    }
    const check = verifyQuote(paper.pages || [], Number(c.page) || null, c.quote)
    if (!check.ok) {
      dropped += 1
      continue
    }
    if (check.corrected) corrected += 1
    if (citations.some((x) => x.evidenceId === `${paper.id}-${check.page}-${check.quote.slice(0, 24)}`)) continue
    citations.push({
      paperId: paper.id,
      paperTitle: paper.title,
      shortLabel: paper.shortLabel,
      page: check.page,
      quote: check.quote,
      evidenceId: `${paper.id}-${check.page}-${check.quote.slice(0, 24)}`,
    })
  }

  if (dropped > 0) {
    warnings.push(`模型给出的 ${dropped} 条引用无法在论文正文里逐字定位，已从结果中剔除。`)
  }
  if (corrected > 0) {
    warnings.push(`有 ${corrected} 条引用的页码与原文实际所在页不一致，已按实际页码修正。`)
  }

  // ---- 结论来源分类：系统事实 / 规则推导 / 论文事实 ----
  const paperCount = papers.length

  const claimInputs = [
    ...paragraphs.map((t, i) => ({ id: `p${i}`, kind: 'paragraph', text: t })),
    ...bullets.map((t, i) => ({ id: `b${i}`, kind: 'bullet', text: t })),
  ].map((c) => ({ ...c, source: classifyClaim(c.text, { paperCount, datasetScope }) }))

  // 系统事实句里如果混入了**论文事实**（具体数字 / 数据集名 / 指标名），不能因为贴了"系统事实"标签
  // 就绕过论文事实验证：这类句子也送去判定，判不过就按论文事实撤回。
  const hasPaperFact = (text) =>
    /\d/.test(text) || /(ETT\w?|Traffic|Weather|Electricity|Exchange|ILI|COVID|MSE|MAE|RMSE|SMAPE|epoch|GPU)/i.test(
      text,
    )

  // 规则结论的**一致性校验**：命中同一个规则编号还不够 ——
  // 结论的断言方向必须与规则的实际判定一致，否则不算规则推导。
  // 例：程序判「信息不足」，模型却说「条件一致」→ 不能给规则推导标签。
  // （定义在模块级，便于单测与复算）

  // 规则推导类结论：必须能指回一条程序真的执行过的规则（带规则编号），且**断言方向与规则结果一致**。
  // 两条有一条不满足，都说明这是模型自己的推论 → 降级为「建议 / 待验证」。
  const derivationFor = (text) => {
    const hit = checks.find((c) => {
      if (!c || !c.ruleId) return false
      const label = String(c.label || '')
      if (label && text.includes(label)) return true
      const key = String(c.key || '')
      return Boolean(key) && text.includes(key) && /不同|差异|一致|不足|未找到|未说明/.test(text)
    })
    if (!hit) return undefined
    const result = String(hit.verdictText || hit.verdict || '')
    if (!consistentWithRule(text, result)) return undefined
    return {
      ruleId: String(hit.ruleId),
      ruleName: String(hit.ruleName || hit.label || ''),
      scope: hit.scope || null,
      inputs: (hit.perPaper || []).map((p) => ({
        key: hit.key || hit.id || '',
        label: hit.label || '',
        value: p.value === null || p.value === undefined ? '（未读到）' : String(p.value).slice(0, 120),
        paperLabel: p.label || p.paperId || '',
        evidenceIds: Array.isArray(p.evidenceIds) ? p.evidenceIds.slice(0, 3) : [],
      })),
      rule: String(hit.reason || '').slice(0, 300),
      result: result.slice(0, 60),
    }
  }

  // 程序直接生成**规则结论的核心句**（不经过模型，杜绝"模型说了算"）；
  // 模型的角色变成"解释"，它的规则类说法仍要过上面的一致性校验。
  const scopePrefix = datasetScope ? `在共同数据集「${datasetScope}」上，` : ''
  const programRuleClaims = checks
    .filter((c) => c && c.ruleId)
    .filter((c) => {
      const v = String(c.verdictText || c.verdict || '')
      return v.includes('差异') || v.includes('不足') || v.includes('未找到') || v.includes('未检查')
    })
    .slice(0, 4)
    .map((c, i) => {
      const result = String(c.verdictText || c.verdict || '')
      const d = {
        ruleId: String(c.ruleId),
        ruleName: String(c.ruleName || c.label || ''),
        scope: c.scope || null,
        inputs: (c.perPaper || []).map((p) => ({
          key: c.key || c.id || '',
          label: c.label || '',
          value: p.value === null || p.value === undefined ? '（未读到）' : String(p.value).slice(0, 120),
          paperLabel: p.label || p.paperId || '',
          evidenceIds: Array.isArray(p.evidenceIds) ? p.evidenceIds.slice(0, 3) : [],
        })),
        rule: String(c.reason || '').slice(0, 300),
        result: result.slice(0, 60),
      }
      return {
        id: `r${i}`,
        kind: 'paragraph',
        text: `${scopePrefix}${d.ruleName}：${d.result}（${String(c.reason || '').slice(0, 80)}）`,
        source: 'rule',
        program: true,
        derivation: d,
      }
    })

  const evidencePool = citations.map((c, i) => ({ id: `e${i}`, ...c }))
  // 论文事实类要判定；**混有论文事实的系统事实句也要判定**（防止借系统标签绕过验证）
  const paperClaims = claimInputs.filter(
    (c) => c.source === 'paper' || (c.source === 'system' && hasPaperFact(c.text)),
  )
  const judged = paperClaims.length
    ? await judgeClaims({ claims: paperClaims, evidence: evidencePool })
    : { judgements: {}, error: '' }
  const judgement = judged.judgements
  const judgedCount = Object.keys(judgement).length

  // 撤回列表：先建好（混合句在 map 过程中就可能往里写），map 完再补论文事实类的
  const withdrawn = []
  const claims = [
    // 程序直接生成的规则结论（不经模型，按构造即正确）
    ...programRuleClaims.map((c) => ({
      id: c.id,
      kind: c.kind,
      text: c.text,
      source: 'rule',
      support: 'rule',
      reason: `由本地检查规则 ${c.derivation.ruleId}「${c.derivation.ruleName}」推出（程序生成，模型只负责解释）：${c.derivation.rule}`,
      evidenceIds: [],
      derivation: c.derivation,
      programGenerated: true,
    })),
    ...claimInputs.map((c) => {
    // 系统事实：由程序状态证明，不参与论文引用校验，也不会被撤回。
    // 但如果句子里混入了论文事实（数字/数据集/指标名），那部分已送去判定：
    // 判不过 → 整句降级为论文事实并撤回，不能借系统标签绕过验证。
    if (c.source === 'system') {
      const v = verifySystemClaim(c.text, { paperCount, datasetScope })
      if (hasPaperFact(c.text)) {
        const j = judgement[c.id]
        if (j && j.support === 'none') {
          withdrawn.push({
            text: c.text,
            reason: `这句混合了系统事实与论文事实，其中论文事实部分在提供的正文里找不到依据（${j.reason || '未找到'}），整句按论文事实处理并撤回。`,
          })
          return null
        }
        return {
          id: c.id,
          kind: c.kind,
          text: c.text,
          source: 'system',
          support: 'system',
          reason: `${v.reason}（这句里混有论文事实，该部分已一并通过原文支持判定${
            j ? `：${j.support === 'full' ? '支持' : j.support === 'partial' ? '部分支持' : '未复核'}`
              : ''
          }。）`,
          evidenceIds: j ? j.evidenceIds || [] : [],
          systemOk: v.ok,
        }
      }
      return {
        id: c.id,
        kind: c.kind,
        text: c.text,
        source: 'system',
        support: 'system',
        reason: v.reason,
        evidenceIds: [],
        systemOk: v.ok,
      }
    }
    // 规则推导：必须指回**程序真的执行过**的规则（带编号），且**断言方向与规则结果一致**；
    // 有一条不满足 → 降级为「建议 / 待验证」——模型说了不算。
    if (c.source === 'rule') {
      const d = derivationFor(c.text)
      if (d) {
        return {
          id: c.id,
          kind: c.kind,
          text: c.text,
          source: 'rule',
          support: 'rule',
          reason: `由本地检查规则 ${d.ruleId}「${d.ruleName}」推出：${d.rule}`,
          evidenceIds: [],
          derivation: d,
        }
      }
      return {
        id: c.id,
        kind: c.kind,
        text: c.text,
        source: 'suggestion',
        support: 'suggestion',
        reason:
          '这是模型自己提出的推论：没有对应的、程序实际执行过的检查规则，或它与该规则的实际判定方向不一致（例如程序判「信息不足」而它下了「一致/差异」的结论），因此按「建议 / 待验证」处理，请自行核对。',
        evidenceIds: [],
      }
    }
    const j = judgement[c.id]
    if (!j) {
      return {
        id: c.id,
        kind: c.kind,
        text: c.text,
        source: 'paper',
        support: 'unchecked',
        reason: '这一步复核没有成功返回结果，请对照引用自行确认',
        evidenceIds: [],
      }
    }
    const ids = j.evidenceIds
      .map((eid) => evidencePool.find((e) => e.id === eid))
      .filter(Boolean)
      .map((e) => e.evidenceId)
    return {
      id: c.id,
      kind: c.kind,
      text: c.text,
      source: 'paper',
      support: j.support,
      reason: j.reason,
      evidenceIds: ids,
    }
    })
  ].filter(Boolean)

  for (const c of claims) {
    if (c.source === 'paper' && c.support === 'none') {
      withdrawn.push({ text: c.text, reason: c.reason })
    }
  }
  const partial = claims.filter((c) => c.source === 'paper' && c.support === 'partial')
  const kept = claims.filter((c) => !(c.source === 'paper' && c.support === 'none'))

  if (withdrawn.length > 0) {
    warnings.push(
      `有 ${withdrawn.length} 条**论文事实类**结论在提供的正文里找不到依据，已从回答中撤回（列在「已撤回的结论」里）。系统事实与规则推导类结论不受此影响。`,
    )
  }
  if (partial.length > 0) {
    warnings.push(`有 ${partial.length} 条结论只被原文部分支持，已在回答里逐条标注「部分支持」。`)
  }
  if (claims.length > 0 && judgedCount === 0) {
    warnings.push(
      `「结论是否被原文支持」这一步复核没有成功返回结果（${judged.error || '未知原因'}），本次回答已标注为未复核。`,
    )
  }
  if (citations.length === 0 && claims.length > 0) {
    warnings.push('本次回答没有任何引用通过逐字校验，因此所有结论都无法被原文支持，已全部撤回。')
  }

  const noEvidenceLeft = kept.length === 0 && claims.length > 0

  return {
    paragraphs: kept.filter((c) => c.kind === 'paragraph').map((c) => c.text),
    bullets: kept.filter((c) => c.kind === 'bullet').map((c) => c.text),
    claims,
    withdrawn: withdrawn.map((c) => ({ text: c.text, reason: c.reason })),
    citations,
    insufficient:
      Boolean(json.insufficient) || paragraphs.length === 0 || noEvidenceLeft,
    warnings,
  }
}


