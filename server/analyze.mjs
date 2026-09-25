/**
 * 论文方法分析：分类 / 地图 / 技术演进 / 研究方向共用的模型分析服务。
 *
 * 流程（四步，程序与模型的职责严格分开）：
 *  1. 模型分析：从正文候选段落给出结论候选（标签 / 关系），每条必须带逐字原文与页码。
 *  2. 引文定位（程序）：核对原句是否真的出现在对应页 —— 只回答「这句话在不在」。
 *  3. 语义复核（模型，每篇论文一次批量调用）：判断「这句话是否支持这个标签/关系」，并给出归属。
 *  4. 结构校验与合并（程序）：把两个独立判断合成一个结论。
 *
 * 四个必须分开保存的判断，不能压成一个布尔量：
 *  - 引文定位 citationLocated：原句能否在对应论文、对应页找到。
 *  - 归属 attribution：原句描述的是本文方法 / 相关工作 / 基线 / 未来设想。
 *  - 语义支持 semanticSupport：原句是否支持当前标签、主张或关系。
 *  - 人工状态 manualStatus：只能由用户操作置位，程序与模型都不得写入。
 *
 * 合成规则：
 *  - 未定位成功 → 绝不能标成「有原文依据」（verdict = unlocated / pending）。
 *  - 定位成功但归属是相关工作 / 基线 / 未来设想 → 不归入本文方法（verdict = excluded）。
 *  - 本文方法采用某机制，只有「归属=used」且「语义支持=supported」且「引文已定位」
 *    三者同时成立，才显示为「原文明示 / 原文支持」。
 *  - 语义复核没跑或跑失败 → semanticSupport = unchecked，一律降级为待确认，绝不冒充原文支持。
 *  - 存在歧义时给出具体原因（semanticReason），不把所有情况统一说成「待确认」。
 *
 * 技术关系额外要求：原句必须支持「主体（本文）→对象（目标方法）」以及关系类型（引用/改进/基线）。
 * 只出现两个方法名，不足以确认引用、改进或继承。
 *
 * 条目分三类，判定路径不同（不能一刀切）：
 *  - tag      家族 / 机制 / 任务 / 与前作的区别 —— 走归属门禁，非「本文采用」一律 excluded
 *  - note     局限 / 未来工作 —— 作者自述，没有归属维度，不下「未归入本文方法」的判断
 *  - relation 技术关系 —— 走主体/对象/关系类型的结构校验
 *
 * 归属救回（程序，字面证据）：原句是第一人称自述（we propose/design/…）且无未来语气时，
 * 归属一律按「本文采用」处理，避免模型把本文方法误判成未来工作而把论文自己的家族排除掉。
 */
import { callModelText, parseJsonLoose, verifyQuote, selectPages } from './llm.mjs'

const SYSTEM = `你是时间序列预测论文的方法分析器。你只依据给定的正文片段判断，不调用外部知识，不因为标题是知名方法就输出预设标签。

对每个结论，你必须给出：
1. 一句逐字引用自正文的原文（quote），并注明页码（page）。
2. 该原文的"归属"：used（本文方法采用）/ discussed（本文讨论或批评）/ baseline（本文拿它作对比基线）/ future（本文设想以后尝试）。
3. 只有 used 才能作为"本文方法的技术机制/家族/任务"的依据。

输出严格 JSON（不要 markdown 代码块），结构如下：
{
  "ownMethod": "本文提出或主要研究的方法名（若无法判断填 null）",
  "researchProblem": "本文研究什么问题（一句话）",
  "authorClaim": "作者声称解决了什么问题",
  "family": [{"label":"模型家族名","quote":"...","page":1,"attribution":"used"}],
  "mechanisms": [{"label":"技术机制","quote":"...","page":1,"attribution":"used|discussed|baseline|future"}],
  "tasks": [{"label":"长时预测|短时预测|单变量|多变量","quote":"...","page":1,"attribution":"used"}],
  "differences": [{"target":"相对哪个前作/基线","change":"本文具体改变了什么","quote":"...","page":1,"attribution":"used|discussed|baseline"}],
  "limitations": [{"text":"作者报告的局限","quote":"...","page":1}],
  "futureWork": [{"text":"作者提出的未来工作","quote":"...","page":1}],
  "relations": [{"target":"被引用/被改进/被作基线的方法名","type":"cites|improves|baseline","quote":"...","page":1}]
}

若正文没有支持某项的证据，该数组留空，不要编造。机制只标真实出现的；任务维度没有依据就留空，不要给所有时间序列论文贴统一标签。`

/* ------------------------------------------------------------------ */
/* 第二步：引文定位（程序，纯字符串核对，不调用模型）                  */
/* ------------------------------------------------------------------ */

/** 正则转义 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 目标方法名是否在引文中被提到。
 * 容忍大小写与常见排版标记（N-BEATS / NBEATS / N-BEAT†），但**不把不同方法合并**：
 *  - 单 token 目标（Linear / Informer / SCINet）按「词边界」匹配，避免 Linear 误命中 NLinear、
 *    Informer 误命中 iTransformer；
 *  - 多词目标（Sparse Transformer）才退化为「去空白后整体子串」匹配。
 */
function mentionsMethod(quote, target) {
  const q = String(quote || '')
  const t = String(target || '').trim()
  if (!t) return false
  const strip = (x) => x.normalize('NFKC').toLowerCase().replace(/[†‡*∗]/g, '')
  const ql = strip(q)
  const tl = strip(t)
  if (tl.length < 3) return false
  const multi = /\s/.test(tl) || /[-_/·]/.test(tl)
  if (!multi) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(tl)}([^a-z0-9]|$)`, 'i')
    return re.test(ql)
  }
  const squash = (x) => x.replace(/[\s\u2010-\u2015\u2212\-_/·（）()]+/g, '')
  const tt = squash(tl)
  return tt.length >= 3 && squash(ql).includes(tt)
}

/* ------------------------------------------------------------------ */
/* 归属的确定性兜底（程序）                                            */
/* ------------------------------------------------------------------ */

/**
 * 这三组语气词是程序能稳定判断的**字面证据**，用来兜住模型在批量复核里
 * 把「本文方法」误判成「未来工作 / 相关工作」的情况。
 * 这是纯字符串判断，不调用模型，可复现、可测试。
 */
// 第一人称「我们在做本文的事」：构造 / 采用 / 把输入变成特征的动词都算。
// 刻意**不含** compare / benchmark / select —— 那些是基线语境，不能当成「本文采用」。
const SELF_CLAIM_RE =
  /\b(we\s+(propose|design|introduce|present|develop|construct|build|adopt|employ|utilize|leverage|incorporate|choose|process|apply|feed|map|stack|split|train|model|compute|reshape|fold|transform|extract|aggregate|normalize|project|evaluate|reformulate)|our\s+(proposed|method|model|approach|architecture|framework|network|design|work)|this\s+(paper|work)\s+(proposes|presents|introduces)|in\s+this\s+(paper|work),?\s+we)\b/i

/**
 * 被动语态 / 第三人称的自我描述 —— 论文里同样说明「这是本文方法」：
 *   "The proposed SCINet is also constructed based on temporal convolution."
 *   "SCINet adopts an encoder-decoder architecture."
 * 这里要求同时命中「本文方法名」才成立，避免把别人的方法也救回来。
 */
const SELF_DESCRIBE_RE =
  /\b(adopts?|uses?|employs?|consists?\s+of|is\s+(constructed|built|based|composed|designed|trained|trained)|holds?|contains?|comprises?|relies?\s+on|leverages?|processes?|maps?|projects?)\b/i
const FUTURE_CUE_RE = /\b(future\s+work|in\s+the\s+future|future\s+research|we\s+(will|plan\s+to|intend\s+to)|remains?\s+(for|to|as)\s+future|leave\s+.{0,24}for\s+future)\b/i
const BASELINE_CUE_RE = /\b(compar(e|ed|ison|ing)|baseline|benchmark|against|versus|vs\.?)\b/i

/**
 * 救回被误降级的归属。
 *
 * 规则：如果原句本身是「我们提出/设计/采用…」这类**第一人称自述**，
 * 且句子里没有未来语气（will / future work / plan to），
 * 那么它描述的必然是本文方法 —— 模型在批量复核里判成 future / discussed / baseline 都不作数。
 *
 * 反向不做覆盖：模型判 used 时不强行降级，避免把真正的相关工作说成本文方法。
 */
function rescueAttribution(quote, attribution, ownMethod) {
  const q = String(quote || '')
  if (attribution === 'used') return { attribution, rescued: false }
  const futureCue = FUTURE_CUE_RE.test(q)
  if (futureCue) return { attribution, rescued: false }
  // a) 第一人称自述：「我们提出/设计/采用…」
  if (SELF_CLAIM_RE.test(q)) return { attribution: 'used', rescued: true }
  // b) 被动/第三人称描述本文方法：原句提到本文方法名，且用了「采用/基于/由…构成」这类描述动词
  const name = String(ownMethod || '').trim()
  if (name.length >= 2 && mentionsMethod(q, name) && SELF_DESCRIBE_RE.test(q)) {
    return { attribution: 'used', rescued: true }
  }
  return { attribution, rescued: false }
}

/**
 * 对单条候选做引文定位。只回答「原句在不在对应页」，不判断语义。
 * @returns {{citationLocated:boolean, locatedPage:number|null, citationReason:string}}
 */
function locateCitation(pages, item) {
  const q = typeof item?.quote === 'string' ? item.quote.trim() : ''
  const claimedPage = Number(item?.page) || null
  if (!q) {
    return { citationLocated: false, locatedPage: null, matchMethod: null, citationReason: '模型没有提供原文引用' }
  }
  const r = verifyQuote(pages, claimedPage, q)
  if (r?.ok) {
    const methodLabel =
      r.method === 'exact' ? '精确匹配' : r.method === 'fragment' ? '片段匹配（排版归一化后）' : r.method === 'loose' ? '连字符宽松匹配（排版归一化后）' : '已匹配'
    const pageNote = claimedPage && r.page !== claimedPage ? `（模型标注第 ${claimedPage} 页，已按实际命中页修正）` : ''
    return {
      citationLocated: true,
      locatedPage: r.page,
      matchMethod: r.method,
      citationReason: `原句${methodLabel}第 ${r.page} 页${pageNote}`,
    }
  }
  return {
    citationLocated: false,
    locatedPage: null,
    matchMethod: null,
    citationReason: '引用未定位到正文（页码不符或原句与正文不一致，含无法可靠处理的符号时保留待核对）——不能作为原文依据',
  }
}

/* ------------------------------------------------------------------ */
/* 第三步：语义复核（模型，一篇论文一次批量调用）                      */
/* ------------------------------------------------------------------ */

/**
 * 行格式解析：`id|attribution|support|理由`
 * 与 judgeSupport 一致，优先走行格式（比 JSON 稳），JSON 只作兜底。
 */
function parseReviewLines(text, validIds) {
  const out = {}
  const ATTR = new Set(['used', 'discussed', 'baseline', 'future', 'na'])
  const SUP = new Set(['yes', 'no', 'ambiguous'])
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^[-*•\d.、)]+\s*/, '')
      .replace(/｜/g, '|')
      .replace(/^`+|`+$/g, '')
      .replace(/^\|/, '')
      .replace(/\|$/, '')
    if (!line.includes('|')) continue
    const parts = line.split('|').map((s) => s.trim())
    if (parts.length < 3) continue
    const id = parts[0].replace(/[`"'\s:：]/g, '')
    if (!validIds.includes(id)) continue
    const attribution = ATTR.has(parts[1].toLowerCase()) ? parts[1].toLowerCase() : 'na'
    const support = SUP.has(parts[2].toLowerCase()) ? parts[2].toLowerCase() : 'ambiguous'
    const reason = (parts[3] || '').slice(0, 160)
    out[id] = { attribution, support, reason }
  }
  return out
}

const REVIEW_SYSTEM = [
  '你是严格的事实核查员。你只根据给定的「候选标签/关系 + 它的原文引用」做判断，不使用任何外部知识。',
  '你要回答两个互相独立的问题，不要把它们混在一起：',
  '  (A) 归属：这段原文讲的是「本文方法采用」(used)、「本文讨论或批评」(discussed)、',
  '      「本文拿它当对比基线」(baseline)、还是「本文设想以后尝试」(future)？',
  '  (B) 语义支持：这段原文是否真的支持所给的标签/关系？',
  '      yes=原句明确写出，不需要任何推断；ambiguous=相关但含糊、需要推断、或只支持一部分；no=不支持。',
  '注意：引用存在不等于引用支持结论。只要需要推断才能成立，就判 ambiguous，不要判 yes。',
  '不要因为方法出名就判 used。只输出要求的行，不要输出其它内容。',
].join('\n')

/**
 * 批量语义复核：一次调用复核一篇论文的全部候选标签与关系。
 * 复核失败不阻断主流程：返回空对象，调用方会标成 unchecked（不冒充原文支持）。
 *
 * @param {object} p
 * @param {string} p.title
 * @param {{id:string, kind:'tag'|'relation', label:string, quote:string, page:number|null, attributionHint?:string, relationType?:string}[]} p.items
 * @returns {Promise<Record<string,{attribution:string, support:'yes'|'no'|'ambiguous', reason:string}>>}
 */
export async function reviewCandidatesBatch({ title, items }) {
  const usable = (items || []).filter((i) => i && i.label && i.quote)
  if (usable.length === 0) return {}

  const lines = usable
    .map((i) => {
      const head =
        i.kind === 'relation'
          ? `关系：本文 →「${i.label}」（关系类型：${i.relationType ?? 'cites'}）`
          : `标签：「${i.label}」`
      return `- id: ${i.id}\n${head}\n原文引用（第 ${i.page ?? '?'} 页）：${String(i.quote).slice(0, 400)}`
    })
    .join('\n')

  const user = `标题：${title}

下面每一条给出一个候选结论和它的原文引用。请逐条判断 (A) 归属 与 (B) 语义支持。

请**只输出若干行纯文本**，每行一条，用竖线分隔，不要表头、不要 JSON、不要解释：
id|attribution|support|理由
其中 attribution 取值：used | discussed | baseline | future | na（关系条目填 na）
support 取值：yes | no | ambiguous
理由用一句中文，写明判断依据或缺少什么（不超过 40 字）。

待复核条目：
${lines}`

  try {
    const text = await callModelText({ system: REVIEW_SYSTEM, user, maxTokens: 4000 })
    const byLine = parseReviewLines(
      text,
      usable.map((i) => i.id),
    )
    if (Object.keys(byLine).length > 0) return byLine
  } catch {
    /* 落到下面的 JSON 兜底 */
  }

  try {
    const raw = await callModelText({
      system: REVIEW_SYSTEM,
      user: `${user}

改为输出严格 JSON（不要 markdown 代码块）：
{"reviews":[{"id":"原样返回上面的 id","attribution":"used|discussed|baseline|future|na","support":"yes|no|ambiguous","reason":"一句中文说明"}]}`,
      maxTokens: 4000,
    })
    const json = parseJsonLoose(raw) ?? {}
    const out = {}
    for (const j of Array.isArray(json.reviews) ? json.reviews : []) {
      const id = typeof j?.id === 'string' ? j.id.trim() : ''
      if (!id || !usable.some((i) => i.id === id)) continue
      out[id] = {
        attribution: ['used', 'discussed', 'baseline', 'future', 'na'].includes(j?.attribution)
          ? j.attribution
          : 'na',
        support: ['yes', 'no', 'ambiguous'].includes(j?.support) ? j.support : 'ambiguous',
        reason: typeof j?.reason === 'string' ? j.reason.trim().slice(0, 160) : '',
      }
    }
    return out
  } catch {
    // 复核失败：不阻断，返回空对象 —— 调用方标为「语义未复核」，不冒充原文支持。
    return {}
  }
}

/* ------------------------------------------------------------------ */
/* 第四步：结构校验与合并（程序）                                      */
/* ------------------------------------------------------------------ */

const ATTR_LABEL = { used: '本文采用', discussed: '相关工作', baseline: '对照基线', future: '未来设想' }

/**
 * 合并「引文定位（程序）」与「语义复核（模型）」为一个结论对象。
 * 四个维度分别保存，另给一个程序推导的 verdict 供界面直接使用。
 */
function mergeVerdict({ located, attribution, support, kind, objectMentioned }) {
  const semanticSupport =
    support === 'yes' ? 'supported' : support === 'no' ? 'unsupported' : support === 'ambiguous' ? 'ambiguous' : 'unchecked'
  const isRelation = kind === 'relation'

  if (!located.citationLocated) {
    return {
      verdict: 'unlocated',
      reason: located.citationReason,
    }
  }
  if (semanticSupport === 'unchecked') {
    return {
      verdict: 'pending',
      reason: '原句已定位，但语义复核未执行——按未复核处理，不作为原文支持',
    }
  }
  // 归属门禁只对「标签」生效：家族/机制/任务/与前作的区别，讲的是别人的东西就不能算本文方法。
  // 局限与未来工作（kind='note'）本来就是作者自述，没有「归属」这个维度，不能判成「未归入本文方法」。
  if (kind === 'tag' && attribution !== 'used') {
    return {
      verdict: 'excluded',
      reason: `原句描述的是${ATTR_LABEL[attribution] ?? '其它内容'}，未归入本文方法`,
    }
  }
  if (isRelation && objectMentioned === false) {
    return {
      verdict: 'pending',
      reason: '原句中未出现目标方法名——只出现两个方法名不足以确认引用/改进/继承',
    }
  }
  if (semanticSupport === 'supported') {
    return { verdict: 'paper-supported', reason: '' }
  }
  if (semanticSupport === 'unsupported') {
    return {
      verdict: 'unsupported',
      reason: isRelation
        ? '原句未支持该主体与对象之间的这种关系'
        : `原句未支持该结论`,
    }
  }
  return {
    verdict: 'pending',
    reason: isRelation
      ? '原句与目标方法相关，但不足以确认这是引用/改进/继承——需要人工判断具体关系方向'
      : '原句与结论相关，但语义支持存在歧义，需要人工确认',
  }
}

export async function analyzeMethod({ pages, fileName, title, hint = '' }) {
  const selected = selectPages(pages, 90000).pages
  const user = `文件名：${fileName}\n标题：${title}${hint ? `\n提示（仅用于检索候选，不是结论）：${hint}` : ''}\n\n正文（节选，${selected.length} 页）：\n${selected.map((p) => `【第 ${p.page} 页】\n${p.text}`).join('\n\n')}`

  const raw = await callModelText({ system: SYSTEM, user, maxTokens: 4000 })
  const data = parseJsonLoose(raw) ?? {}

  const arr = (x) => (Array.isArray(x) ? x : [])

  /* ---- 第二步：引文定位（程序） ---- */
  const groups = {
    family: arr(data.family),
    mechanisms: arr(data.mechanisms),
    tasks: arr(data.tasks),
    differences: arr(data.differences),
    limitations: arr(data.limitations),
    futureWork: arr(data.futureWork),
    relations: arr(data.relations),
  }

  const located = {}
  for (const [key, list] of Object.entries(groups)) {
    located[key] = list.map((it) => locateCitation(pages, it))
  }

  /* ---- 第三步：语义复核（模型，一次批量调用） ---- */
  const reviewItems = []
  const idOf = (key, i) => `${key[0]}${i}`
  for (const key of ['family', 'mechanisms', 'tasks', 'differences', 'limitations', 'futureWork']) {
    groups[key].forEach((it, i) => {
      reviewItems.push({
        id: idOf(key, i),
        kind: 'tag',
        label: String(it.label ?? it.text ?? it.change ?? '').slice(0, 120),
        quote: String(it.quote ?? '').slice(0, 400),
        page: Number(it.page) || null,
      })
    })
  }
  groups.relations.forEach((it, i) => {
    reviewItems.push({
      id: idOf('relations', i),
      kind: 'relation',
      label: String(it.target ?? '').slice(0, 120),
      relationType: String(it.type ?? 'cites'),
      quote: String(it.quote ?? '').slice(0, 400),
      page: Number(it.page) || null,
    })
  })

  let reviews = {}
  try {
    reviews = await reviewCandidatesBatch({ title, items: reviewItems })
  } catch {
    reviews = {}
  }

  /* ---- 第四步：结构校验与合并（程序） ---- */
  const build = (key, i) => {
    const it = groups[key][i]
    const loc = located[key][i]
    const rev = reviews[idOf(key, i)] ?? null
    // 三类条目走的判定路径不同：
    //   tag      家族/机制/任务/与前作的区别 —— 需要归属门禁
    //   note     局限/未来工作 —— 作者自述，无归属维度
    //   relation 技术关系 —— 需要主体/对象/关系类型的结构校验
    const kind = key === 'relations' ? 'relation' : key === 'limitations' || key === 'futureWork' ? 'note' : 'tag'
    const isRelation = kind === 'relation'
    const modelAttr = isRelation || kind === 'note' ? null : rev?.attribution && rev.attribution !== 'na' ? rev.attribution : it.attribution ?? null
    const rescued =
      isRelation || kind === 'note' ? { attribution: modelAttr, rescued: false } : rescueAttribution(it.quote, modelAttr, data.ownMethod)
    const attribution = rescued.attribution
    const objectMentioned = isRelation ? mentionsMethod(it.quote, it.target) : undefined
    const merged = mergeVerdict({
      located: loc,
      attribution,
      support: rev?.support ?? 'unchecked',
      kind,
      objectMentioned,
    })
    return {
      ...it,
      // —— 维度一：引文定位（程序） ——
      citationLocated: loc.citationLocated,
      locatedPage: loc.locatedPage,
      citationReason: loc.citationReason,
      matchMethod: loc.matchMethod,
      // —— 维度二：归属（模型 + 程序救回） ——
      attribution,
      /** 模型把自述句误判成非本文时，程序按字面自述证据救回 */
      attributionRescued: rescued.rescued,
      // —— 维度三：语义支持（模型批量复核） ——
      semanticSupport: rev
        ? rev.support === 'yes'
          ? 'supported'
          : rev.support === 'no'
            ? 'unsupported'
            : 'ambiguous'
        : 'unchecked',
      semanticReason: rev?.reason ?? '',
      // —— 结构校验（仅关系） ——
      ...(isRelation
        ? {
            objectMentioned,
            relationReason: objectMentioned
              ? merged.verdict === 'paper-supported'
                ? '原句出现目标方法名，且语义复核确认该关系'
                : merged.reason
              : '原句中未出现目标方法名',
          }
        : {}),
      // —— 程序推导的组合结论（界面直接用这个，不要自己拼） ——
      verdict: merged.verdict,
      verdictReason: merged.reason,
      reviewedAt: new Date().toISOString(),
    }
  }

  const out = {}
  for (const key of ['family', 'mechanisms', 'tasks', 'differences', 'limitations', 'futureWork', 'relations']) {
    out[key] = groups[key].map((_, i) => build(key, i))
  }

  const stats = { 'paper-supported': 0, pending: 0, excluded: 0, unlocated: 0, unsupported: 0 }
  for (const key of Object.keys(out)) {
    for (const it of out[key]) stats[it.verdict] = (stats[it.verdict] ?? 0) + 1
  }

  return {
    ok: true,
    fileName,
    title,
    ownMethod: data.ownMethod ?? null,
    researchProblem: data.researchProblem ?? null,
    authorClaim: data.authorClaim ?? null,
    ...out,
    verdictStats: stats,
    semanticReviewRan: Object.keys(reviews).length > 0,
    analyzedAt: new Date().toISOString(),
    model: 'deepseek-chat',
    analysisPipeline: 'analyze-v2/four-dimension',
  }
}
