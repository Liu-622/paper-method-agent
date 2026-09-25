/**
 * 论文对撞台：把论文之间的差异组织成"值得核对的研究问题"
 * ==================================================================
 * 判定分成四类 —— **10% 阈值只用来筛选"值得关注的数值差异"，不决定类别**：
 *  1) performanceDifference  不同方法取得不同成绩 → 展示为"性能差异"，**不称为观点分歧**
 *  2) reportValueMismatch    同一方法报告不同成绩 → "报告值不同，需核对实验设置"
 *  3) claimConflict          两篇论文对同一具体问题提出不相容判断（两侧均有明确原文依据 + 适用范围已核对）
 *  4) comparabilityPending   条件尚不完整 → "可比性待确认"
 * 其它原则：不给论文虚构立场；不制造冲突；没有可核对的内容时**允许 0 张卡**。
 */
import { normalizeText } from './llm.mjs'

export const RELATIONS = {
  performanceDifference: { code: 'performanceDifference', label: '不同方法的性能差异' },
  reportValueMismatch: { code: 'reportValueMismatch', label: '报告值不同，需核对实验设置' },
  claimConflict: { code: 'claimConflict', label: '主张存在分歧' },
  comparabilityPending: { code: 'comparabilityPending', label: '可比性待确认' },
}

/** 逐字可用性：带省略号、过短、占位符的片段不能当作证据展示 */
export function isVerbatimEvidence(text) {
  const t = String(text || '').trim()
  if (t.length < 20) return false
  if (/…|\.\.\.|待补|TODO|\{\{|\}\}|XX{2,}/.test(t)) return false
  return true
}

/** 从"方法"字段里取方法名集合 */
function methodTokens(value) {
  if (!value) return []
  return String(value)
    .split(/[、,，;；/|()（）]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 24 && !/^\d+$/.test(s))
}

/** 方向性断言：粗识别"A 比 B 更低/更高"，只用于判断两侧是否真的不相容 */
function directionOf(text) {
  const t = String(text || '')
  const better = /更低|更小|优于|胜过|好于|降低|better|lower|outperform|surpass|reduce|reduction/i.test(t)
  const worse = /更高|更大|差于|不如|上升|worse|higher|inferior|increase[sd]?/i.test(t)
  return { better, worse }
}

/** 实验室支持情况（决定是否给"运行验证"按钮） */
export function labSupportFor(methods) {
  const set = new Set((methods || []).filter(Boolean).map((m) => String(m).trim()))
  const has = () => set.size > 0
  if (has() && [...set].every((m) => /dlinear|^linear$/i.test(m.trim()))) {
    return { supported: true, scope: 'official-methods', label: '官方 DLinear / Linear 已在实验室接入（同数据、同跨度可运行）' }
  }
  if ([...set].some((m) => /朴素|seasonal|岭回归|ridge/i.test(m))) {
    return { supported: false, scope: 'teaching-only', label: '实验室只有教学方法（季节朴素 + 岭回归），不能用来判断论文方法优劣' }
  }
  return { supported: false, scope: 'unsupported', label: '这两种方法还没有接入实验室，只能先做验证任务设计' }
}

function evOf(paper, key) {
  const f = paper?.fields?.[key]
  if (!f) return { value: null, evidence: [] }
  const ids = f.evidenceIds || []
  let evidence = ids.map((id) => (paper.evidence || []).find((e) => e.id === id)).filter(Boolean)
  // 兜底：没有 evidenceIds 时，按"证据文本出现在取值里（或反之）"匹配
  if (evidence.length === 0 && f.value) {
    const v = String(f.value).slice(0, 80)
    evidence = (paper.evidence || []).filter((e) => {
      const t = String(e?.text || '')
      return t && (t.includes(v.slice(0, 24)) || v.includes(t.slice(0, 24)))
    })
  }
  const out = evidence.slice(0, 3).map((e) => ({ page: e.page, quote: e.text, verbatim: isVerbatimEvidence(e.text) }))
  const value = f.value === undefined || f.value === null ? null : String(f.value)
  return { value, evidence: out, status: f.status, origin: f.origin }
}

function datasetsOf(value) {
  if (!value) return []
  return String(value)
    .split(/[、,，;；/|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((s) => s.length > 1)
}

function nums(text) {
  if (!text) return []
  return [...String(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
}

/**
 * 只取"像指标值"的数字，用于**筛选**值得关注的数值差异：
 * 先去掉 horizon / pred_len 这类跨度描述，再排除紧跟在字母后面的数字（例如 ETTm2 的 2）。
 */
function metricNums(text) {
  if (!text) return []
  const stripped = String(text).replace(/(?:horizon|pred_len|prediction length|look-?back|span)\s*[:=]?\s*\d+(?:\.\d+)?/gi, ' ')
  const all = [...stripped.matchAll(/(?<![A-Za-z0-9.])\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
  const decimals = all.filter((n) => !Number.isInteger(n))
  return decimals.length > 0 ? decimals : all
}

function positionsOf(paper) {
  const dims = {}
  const keys = ['dataset', 'metrics', 'horizon', 'split', 'preprocessing', 'epochs', 'batchSize', 'learningRate', 'method', 'conclusion']
  for (const k of keys) dims[k] = evOf(paper, k)
  return dims
}

const DIM_LABEL = {
  dataset: '数据集',
  metrics: '评价指标',
  horizon: '预测跨度',
  split: '数据划分',
  preprocessing: '预处理 / 归一化',
  epochs: '训练轮数',
  batchSize: '批大小',
  learningRate: '学习率',
  method: '方法',
  conclusion: '结论',
}

function conditionsOf(dim) {
  return {
    dataset: dim.dataset?.value || null,
    horizon: dim.horizon?.value || null,
    metrics: dim.metrics?.value || null,
    split: dim.split?.value || null,
    preprocessing: dim.preprocessing?.value || null,
  }
}

const sideOf = (paper, pos, fallbackStatement) => ({
  paper: paper.shortLabel,
  statement: pos.conclusion.value || fallbackStatement,
  evidence: pos.conclusion.evidence,
  conditions: conditionsOf(pos),
  methods: methodTokens(pos.method.value),
})

/**
 * 生成观点卡（最多 3 张，允许 0 张）。
 * papers: [{ id, shortLabel, title, fields, evidence }]
 */
export function buildClashCards({ papers, maxCards = 3 }) {
  const list = (papers || []).slice(0, 3)
  if (list.length < 2) return { ok: false, reason: '至少需要选择 2 篇论文', cards: [] }

  const cards = []
  const diagnostics = []
  const skipped = []

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const A = list[i]
      const B = list[j]
      const pa = positionsOf(A)
      const pb = positionsOf(B)

      const dsA = datasetsOf(pa.dataset.value)
      const dsB = datasetsOf(pb.dataset.value)
      const sharedDs = dsA.filter((d) => dsB.includes(d))
      const metA = datasetsOf(pa.metrics.value)
      const metB = datasetsOf(pb.metrics.value)
      const sharedMet = metA.filter((m) => metB.includes(m))
      const hA = nums(pa.horizon.value)
      const hB = nums(pb.horizon.value)
      const sameHorizon = Boolean(hA.length && hB.length && hA.some((x) => hB.includes(x)))
      const hasBothClaims = Boolean(pa.conclusion.value && pb.conclusion.value)
      const evA = pa.conclusion.evidence
      const evB = pb.conclusion.evidence
      const verbatimA = evA.filter((e) => e.verbatim)
      const verbatimB = evB.filter((e) => e.verbatim)
      const methodsA = methodTokens(pa.method.value)
      const methodsB = methodTokens(pb.method.value)
      const sharedMethods = methodsA.filter((m) => methodsB.some((x) => x.toLowerCase() === m.toLowerCase()))

      const gapInfo = (() => {
        const nA = metricNums(pa.conclusion.value)
        const nB = metricNums(pb.conclusion.value)
        const cand = []
        for (const x of nA) for (const y of nB) if (x > 0 && y > 0) cand.push(Math.abs(x - y) / Math.max(x, y))
        return { nA, nB, gap: cand.length ? Math.min(...cand) : null }
      })()
      // 阈值只用于"值不值得看"，不用于决定类别
      const worthChecking = gapInfo.gap !== null && gapInfo.gap > 0.1
      // 两侧报告的数值是否真的不同（相同就没有"报告值不同"可言，避免硬造卡）
      const valuesDiffer =
        gapInfo.gap === null ? normalizeText(pa.conclusion.value || '') !== normalizeText(pb.conclusion.value || '') : gapInfo.gap > 0.001

      diagnostics.push({
        pair: `${A.shortLabel} × ${B.shortLabel}`,
        hasBothClaims,
        evidenceVerbatim: `${verbatimA.length}/${verbatimB.length}`,
        sharedDatasets: sharedDs,
        sharedMetrics: sharedMet,
        horizonA: pa.horizon.value,
        horizonB: pb.horizon.value,
        sameHorizon,
        methodsA,
        methodsB,
        sharedMethods,
        numericGap: gapInfo.gap,
        worthChecking,
      })

      const numsText = gapInfo.gap !== null ? `最小相对差别约 ${(gapInfo.gap * 100).toFixed(1)}%` : '数值差别未提取到'
      const scopeText = `数据集 ${sharedDs[0] ?? '（未对齐）'}、指标 ${sharedMet.map((m) => m.toUpperCase())[0] ?? '（未对齐）'}、跨度 ${hA[0] ?? '—'}`

      /* ---------- 3) 主张存在分歧：必须"同一具体问题 + 两侧逐字依据 + 方向相反" ---------- */
      const dirA = directionOf(pa.conclusion.value)
      const dirB = directionOf(pb.conclusion.value)
      const opposite = (dirA.better && dirB.worse) || (dirA.worse && dirB.better)
      const sameSubject = sharedMethods.length > 0 || (sharedDs.length > 0 && methodsA.length > 0 && methodsB.length > 0)

      if (hasBothClaims && verbatimA.length > 0 && verbatimB.length > 0 && sharedDs.length > 0 && sharedMet.length > 0 && sameHorizon) {
        if (opposite && sameSubject) {
          cards.push({
            id: `clash-${A.id}-${B.id}-conflict`,
            dimension: 'conclusion',
            question: `在 ${sharedDs[0]}、${scopeText.split('、').slice(1).join('、')} 上，两篇论文对同一组方法的方向性判断相反 —— 到底哪一侧的条件不同？`,
            sideA: sideOf(A, pa, '（未读到结论）'),
            sideB: sideOf(B, pb, '（未读到结论）'),
            keyCondition: `共享：${scopeText}｜${numsText}`,
            relation: RELATIONS.claimConflict,
            relationReason:
              '两侧都有**逐字可核对的原文依据**，都作用在同一数据集/指标/跨度上，且对同一组方法给出了**方向相反**的判断（一侧说更低/更优，另一侧说更高/更差）——这属于主张层面的分歧，而不是单纯的成绩差异。',
            nextStep: '先逐项对齐实验设置（划分、预处理、通道范围、聚合方式、是否取平均），再看是否需要按其中一侧的条件重跑',
            actions: ['detective', 'check', 'plan'],
            signals: { numericGap: gapInfo.gap, worthChecking, verbatimEvidence: true },
          })
        } else if (sharedMethods.length > 0 && valuesDiffer) {
          cards.push({
            id: `clash-${A.id}-${B.id}-report`,
            dimension: 'conclusion',
            question: `两侧都报告了「${sharedMethods[0]}」的成绩，但数值不同（${numsText}）—— 这是实验设置不同，还是报告口径不同？`,
            sideA: sideOf(A, pa, '（未读到结论）'),
            sideB: sideOf(B, pb, '（未读到结论）'),
            keyCondition: `共享：${scopeText}｜共同方法：${sharedMethods[0]}｜${numsText}`,
            relation: RELATIONS.reportValueMismatch,
            relationReason:
              '**同一个方法**在两篇论文里给出了不同数值。这类差异通常来自实验设置或报告口径（是否多次运行取平均、通道范围、单位空间、聚合方式），本工具不判断谁对谁错。',
            nextStep: `先核对「${sharedMethods[0]}」在两侧的完整设置：划分、预处理、是否取多次平均、指标的单位空间`,
            actions: ['detective', 'check', 'plan'],
            signals: { numericGap: gapInfo.gap, worthChecking, verbatimEvidence: verbatimA.length > 0 && verbatimB.length > 0 },
          })
        } else if (valuesDiffer) {
          cards.push({
            id: `clash-${A.id}-${B.id}-perf`,
            dimension: 'conclusion',
            question: `${methodsA[0] ?? A.shortLabel} 与 ${methodsB[0] ?? B.shortLabel} 在 ${sharedDs[0]}（${scopeText.split('、').slice(1).join('、')}）上的成绩差 ${numsText} —— 值得核对的是条件，而不是排名。`,
            sideA: sideOf(A, pa, '（未读到结论）'),
            sideB: sideOf(B, pb, '（未读到结论）'),
            keyCondition: `共享：${scopeText}｜两侧方法不同：${methodsA.join('/') || '未读到'} vs ${methodsB.join('/') || '未读到'}`,
            relation: RELATIONS.performanceDifference,
            relationLabelNote: '性能差异，不是观点分歧',
            relationReason:
              '两侧是**不同方法**在相近条件上的成绩差异，属于**性能差异**：它说明"谁在这组条件下误差更低"，不构成论文之间的主张冲突（也不代表在别的条件下同样成立）。',
            nextStep: '把条件对齐后（同一划分、同一预处理、同一单位空间）再比较；或直接在当前已支持的方法上跑一次压力测试',
            actions: ['detective', 'check', 'plan'],
            signals: { numericGap: gapInfo.gap, worthChecking, verbatimEvidence: verbatimA.length > 0 && verbatimB.length > 0 },
          })
        }
      }

      /* ---------- 4) 可比性待确认：条件不完整 / 依据不足 ---------- */
      const pairs = [
        ['split', pa.split, pb.split],
        ['preprocessing', pa.preprocessing, pb.preprocessing],
        ['epochs', pa.epochs, pb.epochs],
        ['batchSize', pa.batchSize, pb.batchSize],
        ['learningRate', pa.learningRate, pb.learningRate],
      ]
      const missing = []
      const differing = []
      for (const [key, a, b] of pairs) {
        if (a.value && b.value) {
          if (normalizeText(a.value).slice(0, 24) !== normalizeText(b.value).slice(0, 24)) {
            differing.push({ key, a: a.value, b: b.value })
          }
        } else if ((a.value && !b.value) || (!a.value && b.value)) {
          missing.push({ key, hasSide: a.value ? A.shortLabel : B.shortLabel, missingSide: a.value ? B.shortLabel : A.shortLabel })
        }
      }
      const needsPending = !hasBothClaims || !sameHorizon || sharedDs.length === 0 || sharedMet.length === 0 || verbatimA.length + verbatimB.length < 2 || missing.length > 0
      if (needsPending) {
        const reasonBits = []
        if (!hasBothClaims) reasonBits.push('至少一侧没有可用的结论字段')
        if (!sameHorizon) reasonBits.push(`预测跨度没有对齐（${pa.horizon.value ?? '未读到'} vs ${pb.horizon.value ?? '未读到'}）`)
        if (sharedDs.length === 0) reasonBits.push(`数据集没有对齐（${pa.dataset.value ?? '未读到'} vs ${pb.dataset.value ?? '未读到'}）`)
        if (sharedMet.length === 0) reasonBits.push('评价指标没有对齐')
        if (verbatimA.length + verbatimB.length < 2) reasonBits.push('可逐字核对的原文依据不足两条')
        if (missing.length > 0) reasonBits.push(`缺少 ${missing[0].missingSide} 的「${DIM_LABEL[missing[0].key]}」`)
        cards.push({
          id: `clash-${A.id}-${B.id}-pending-${missing[0]?.key ?? (sameHorizon ? 'evidence' : 'horizon')}`,
          dimension: missing[0]?.key ?? (sameHorizon ? 'conclusion' : 'horizon'),
          question: `这两篇论文现在能不能直接比？还缺什么才能确认？`,
          sideA: sideOf(A, pa, '（未读到）'),
          sideB: sideOf(B, pb, '（未读到）'),
          keyCondition: `差距点：${missing[0] ? `缺少 ${missing[0].missingSide} 的「${DIM_LABEL[missing[0].key]}」` : reasonBits[0] ?? '条件未对齐'}`,
          relation: RELATIONS.comparabilityPending,
          relationReason: `可比性还没建立：${reasonBits.join('；')}。在补齐之前，任何"谁更好"的说法都缺少必要条件，本工具不做判断。`,
          nextStep: missing[0]
            ? `先为 ${missing[0].missingSide} 补「${DIM_LABEL[missing[0].key]}」的线索（论文正文 → 附录 → 官方仓库脚本）`
            : '先把数据集、指标、跨度对齐；对齐后再判断属于哪一类差异',
          actions: ['detective', 'plan'],
          detectiveField: missing[0]?.key,
          detectivePaper: missing[0]?.missingSide === A.shortLabel ? A.id : missing[0] ? B.id : undefined,
          signals: { numericGap: gapInfo.gap, worthChecking, verbatimEvidence: verbatimA.length > 0 && verbatimB.length > 0 },
        })
      } else if (differing.length > 0) {
        const d = differing[0]
        cards.push({
          id: `clash-${A.id}-${B.id}-pending-${d.key}`,
          dimension: d.key,
          question: `两侧的「${DIM_LABEL[d.key]}」不同（${String(d.a).slice(0, 24)} vs ${String(d.b).slice(0, 24)}），要按哪一侧的条件来比？`,
          sideA: sideOf(A, pa, '（未读到）'),
          sideB: sideOf(B, pb, '（未读到）'),
          keyCondition: `差异项：${DIM_LABEL[d.key]}`,
          relation: RELATIONS.comparabilityPending,
          relationLabelNote: '条件差异，不是观点分歧',
          relationReason: `「${DIM_LABEL[d.key]}」不同属于**实验条件差异**：条件不一致时两侧数字不可直接比较，因此这里不给"谁更好"的结论。`,
          nextStep: '选定一侧条件作为基准（或做一个两者都覆盖的小实验），再比成绩',
          actions: ['detective', 'check', 'plan'],
          detectiveField: d.key,
          signals: { numericGap: gapInfo.gap, worthChecking, verbatimEvidence: verbatimA.length > 0 && verbatimB.length > 0 },
        })
      } else {
        skipped.push({ pair: `${A.shortLabel} × ${B.shortLabel}`, reason: '条件对齐、依据充分，且没有需要核对的差异（或差异过小）' })
      }
    }
  }

  const uniq = []
  const seen = new Set()
  for (const c of cards) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    uniq.push(c)
  }
  // 优先展示"主张分歧/报告值不同"，其次性能差异，最后可比性待确认
  const rank = { claimConflict: 0, reportValueMismatch: 1, performanceDifference: 2, comparabilityPending: 3 }
  uniq.sort((x, y) => rank[x.relation.code] - rank[y.relation.code])

  return {
    ok: true,
    cards: uniq.slice(0, maxCards),
    relations: RELATIONS,
    diagnostics,
    skipped,
    note: '类别由规则判定：不同方法的成绩差 → 性能差异；同一方法的数值不同 → 报告值不同需核对设置；方向相反且有逐字依据 → 主张分歧；条件不齐 → 可比性待确认。10% 阈值只用于提示"数值差异值得看"，不决定类别；不能制造冲突，因此允许 0 张卡。',
    checked: uniq.length,
  }
}
