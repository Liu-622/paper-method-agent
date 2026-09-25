import type {
  Evidence,
  FairnessItem,
  FieldKey,
  PageText,
  Paper,
  QaAnswer,
  QaCitation,
  ReproItem,
} from '@/types'
import { EVIDENCE_BY_ID } from '@/data/demoData'
import { FIELD_META } from '@/data/fieldSchema'
import { QA_LATENCY_MS } from '@/config'
import { summarizeFairness, summarizeRepro } from './checks'
import { ApiError, requestAsk } from './api'
import { ruleMetaOf } from '@/data/rules'

/**
 * 论文问答
 * ------------------------------------------------------------------
 * 两条路径，界面会明确标出用的是哪一条：
 *  1. 真实论文 → 调后端 /api/ask，模型阅读所选论文的**真实正文片段**回答，
 *     引用由服务端逐条回查原文，页码与句子可以直接和 PDF 对照。
 *  2. 演示数据 → 本地规则根据演示字段与检查结果生成（标注「演示数据」）。
 *     真实论文在没接后端时不会走这条路，而是直接说明「未连接模型」，不用固定回答敷衍。
 */

export const PRESET_QUESTIONS: {
  id: string
  text: string
  scope: 'multi' | 'single'
  hint: string
}[] = [
  {
    id: 'q-compare',
    text: '这几篇论文的方法主要有什么区别？',
    scope: 'multi',
    hint: '比较各自的模型设计路线',
  },
  {
    id: 'q-fairness',
    text: '它们的实验结果能直接比较吗？',
    scope: 'multi',
    hint: '依据实验公平性检查给出结论',
  },
  {
    id: 'q-repro',
    text: '复现这篇论文还需要确认哪些设置？',
    scope: 'multi',
    hint: '列出复现缺项与影响',
  },
  {
    id: 'q-conclusion',
    text: '这些论文的主要结论分别是什么？',
    scope: 'multi',
    hint: '汇总各篇自述结论',
  },
  {
    id: 'q-limitation',
    text: '它们各自承认哪些局限？',
    scope: 'multi',
    hint: '汇总作者自述局限',
  },
]

export interface QaRequestContext {
  papers: Paper[]
  fairness: FairnessItem[]
  repro: ReproItem[]
  question: string
  simulateFailure: boolean
  /** 当前比较口径（共同数据集）；null 表示按论文整体口径 */
  datasetScope?: string | null
  /** 每篇论文解析出的真实正文（按页）；演示论文没有 */
  pagesByPaper: Record<string, PageText[]>
  /** 后端是否已接通（health 探测通过且配置了密钥） */
  backendReady: boolean
  /** 后端探测失败的原因，用于给出可操作的提示 */
  backendError?: string
}

type Intent =
  | 'compare-method'
  | 'fairness'
  | 'repro'
  | 'conclusion'
  | 'limitation'
  | 'dataset'
  | 'unsupported'

function detectIntent(question: string): Intent {
  const q = question.replace(/\s+/g, '')
  if (/能(不能)?(直接)?比(较|)?|可比|公平|成绩|结果.*比|比.*结果/.test(q)) return 'fairness'
  if (/复现|缺(什么|项|少)|还要确认|需要确认|漏了|没给|未给出|哪些设置/.test(q)) return 'repro'
  if (/(方法|模型|结构|思路).*(区别|不同|差异|差别)|(区别|不同|差异|差别).*(方法|模型)/.test(q))
    return 'compare-method'
  if (/(区别|不同|差异|差别|对比)/.test(q)) return 'compare-method'
  if (/(结论|主要结果|效果|表现|提升了|降了)/.test(q)) return 'conclusion'
  if (/(局限|不足|缺点|适用范围|风险)/.test(q)) return 'limitation'
  if (/(数据集|数据是什么|用了什么数据|基于什么数据)/.test(q)) return 'dataset'
  return 'unsupported'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildCitations(
  papers: Paper[],
  evidenceIds: string[],
  extra: Evidence[] = [],
): QaCitation[] {
  const pool: Record<string, Evidence> = { ...EVIDENCE_BY_ID }
  extra.forEach((e) => {
    pool[e.id] = e
  })
  const seen = new Set<string>()
  const result: QaCitation[] = []
  for (const id of evidenceIds) {
    if (seen.has(id)) continue
    const ev = pool[id]
    if (!ev) continue
    seen.add(id)
    const paper = papers.find((p) => p.id === ev.paperId)
    result.push({
      evidenceId: ev.id,
      paperId: ev.paperId,
      paperTitle: paper?.title ?? ev.paperId,
      page: ev.page,
      section: ev.section,
      text: ev.text,
    })
  }
  return result
}

const FAIRNESS_VERDICT_TEXT: Record<string, string> = {
  consistent: '条件一致',
  different: '存在差异',
  insufficient: '信息不足',
}

const REPRO_VERDICT_TEXT: Record<string, string> = {
  found: '已找到',
  missing: '未找到',
  need_confirm: '需要确认',
}

const REPRO_SUGGESTION: Partial<Record<FieldKey, string>> = {
  preprocessing: '先按训练集统计量做 z-score 标准化跑一版，再换成 min-max 复跑，看误差差距有多大。',
  learningRate: '在 1e-4 ~ 1e-2 之间做一次粗搜索（每个量级 1 个点），记录验证集 MSE 的变化。',
  optimizer: '先用 Adam 跑通流程，再换成 AdamW 复跑，比较收敛曲线。',
  randomSeed: '固定一个种子跑 3～5 次，报告均值与标准差，用波动范围判断"方法提升"是否显著。',
  epochs: '记录验证集误差曲线，先确定收敛所需的轮数，再决定是否使用早停。',
  batchSize: '先固定批大小与学习率，只改批大小时同步按比例调整学习率，观察是否影响最终误差。',
  params: '统计自己实现的模型参数量，与论文数值对齐后再比较误差，避免"更大模型赢"。',
  codeAvailability: '先按论文描述自己实现一版基线，把论文报告的数字作为参考区间，而不是必须达到的目标。',
}

function paperHeading(paper: Paper): string {
  return `${paper.shortLabel}（${paper.title}）`
}

function fieldValue(paper: Paper, key: FieldKey): string | null {
  const field = paper.fields[key]
  if (!field) return null
  if (field.origin === 'user') {
    return field.value ? `${field.value}（你已人工修正）` : null
  }
  return field.value
}

function fieldEvidence(paper: Paper, key: FieldKey): string[] {
  return paper.fields[key]?.evidenceIds ?? []
}

/* ------------------------------------------------------------------ */
/* 各类回答生成                                                        */
/* ------------------------------------------------------------------ */

function answerCompareMethod(ctx: QaRequestContext): Omit<QaAnswer, 'id' | 'createdAt' | 'question' | 'paperIds'> {
  const { papers, fairness } = ctx
  const bullets = papers.map(
    (p) => `${paperHeading(p)}：${fieldValue(p, 'method') ?? '论文中没有读到明确的方法描述'}`,
  )
  const citations = buildCitations(
    papers,
    papers.flatMap((p) => fieldEvidence(p, 'method')),
  )

  const diffKeys = ['dataset', 'horizon', 'metrics', 'evalProtocol', 'preprocessing'] as FieldKey[]
  const diffs = fairness
    .filter((f) => diffKeys.includes(f.key) && f.verdict !== 'consistent')
    .map((f) => `${f.label}：${FAIRNESS_VERDICT_TEXT[f.verdict]} —— ${f.reason}`)

  const paragraphs = [
    `所选 ${papers.length} 篇论文的方法路线并不相同，各自的定位如下：`,
    diffKeys.length
      ? '除了方法本身，它们的实验条件也存在差异，这些差异会直接影响能不能比较成绩：'
      : '它们的实验条件在已检查的项目上暂时一致。',
    '以上差异来自论文自述，只能说明设计取向不同，不能据此判断哪一篇更好。',
  ]

  return {
    status: 'answered',
    mode: 'demo-rule',
    paragraphs,
    bullets: [...bullets, ...(diffs.length ? ['【实验条件差异】', ...diffs] : [])],
    citations,
    notice: '演示数据 · 本地规则生成：内容与页面上的演示字段、检查结果一致。',
  }
}

function answerFairness(ctx: QaRequestContext): Omit<QaAnswer, 'id' | 'createdAt' | 'question' | 'paperIds'> {
  const { papers, fairness } = ctx
  const sum = summarizeFairness(fairness.filter((f) => f.key !== 'method'))
  const items = fairness.filter((f) => f.key !== 'method')
  const blockers = items.filter((f) => f.verdict !== 'consistent')

  const bullets = blockers.map(
    (f) => `${f.label}｜${FAIRNESS_VERDICT_TEXT[f.verdict]}：${f.reason}`,
  )

  const head = `按当前 ${items.length} 项实验条件逐项对比：${sum.consistent} 项条件一致，${sum.different} 项存在差异，${sum.insufficient} 项信息不足。`

  const paragraphs = [head]

  if (sum.different > 0) {
    paragraphs.push(
      `存在 ${sum.different} 项差异，主要是：${blockers
        .filter((b) => b.verdict === 'different')
        .map((b) => b.label)
        .join('、')}。这些条件不同时，论文报告的误差数值处于不同的任务难度下，不能直接放在一起排名。`,
    )
  }
  if (sum.insufficient > 0) {
    paragraphs.push(
      `另有 ${sum.insufficient} 项信息不足，需要在原文中补齐后才能判断是否一致：${blockers
        .filter((b) => b.verdict === 'insufficient')
        .map((b) => b.label)
        .join('、')}。`,
    )
  }
  if (sum.different === 0 && sum.insufficient === 0) {
    paragraphs.push(
      '当前检查到的条件是一致的，因此可以在同一口径下做对照实验；但"条件一致"只说明比较的前提成立，不代表论文结论已经被验证。',
    )
  } else {
    paragraphs.push(
      '如果你需要横向比较，建议先把上面存在差异的信息不足的条件对齐（统一数据集、跨度、指标与评估协议），再复跑一次对照实验。',
    )
  }

  const citations = buildCitations(
    papers,
    blockers.flatMap((b) => b.perPaper.flatMap((p) => p.evidenceIds)),
  )

  return {
    status: 'answered',
    mode: 'demo-rule',
    paragraphs,
    bullets,
    citations,
    notice: '演示数据 · 本地规则生成：结论来自本地检查规则，逐项可展开到演示片段。',
  }
}

function answerRepro(ctx: QaRequestContext): Omit<QaAnswer, 'id' | 'createdAt' | 'question' | 'paperIds'> {
  const { papers, repro } = ctx
  const sum = summarizeRepro(repro)
  const gaps = repro.filter((i) => i.verdict !== 'found')

  const bullets = gaps.map((item) => {
    const perPaperText = item.perPaper
      .filter((p) => p.status !== 'found' || !p.value)
      .map((p) => {
        const paper = ctx.papers.find((x) => x.id === p.paperId)
        return `${paper?.shortLabel ?? p.paperId}：${REPRO_VERDICT_TEXT[item.verdict]}${
          paper?.fields[item.key]?.note ? `（${paper.fields[item.key]?.note}）` : ''
        }`
      })
      .join('；')
    const suggestion = REPRO_SUGGESTION[item.key]
    return `${item.label}｜${REPRO_VERDICT_TEXT[item.verdict]}：${perPaperText}。影响：${item.impact}${
      suggestion ? ` 建议：${suggestion}` : ''
    }`
  })

  const paragraphs = [
    `按 ${repro.length} 项复现必需信息逐项检查：${sum.found} 项已找到，${sum.missing} 项未找到，${sum.needConfirm} 项需要确认。`,
    '下面按项说明「缺的是什么、为什么会卡住复现、建议怎么补」。注意「未找到」只表示本次上传的文件里没有读到这一项，不代表论文本身有错误。',
    gaps.length === 0
      ? '当前所选论文的复现信息比较完整，可以直接按文中设置搭建环境。'
      : `优先处理影响最大的 ${Math.min(3, gaps.length)} 项：${gaps
          .slice(0, 3)
          .map((g) => g.label)
          .join('、')}。修改字段后可以点「重新检查」验证结论是否变化。`,
  ]

  const citations = buildCitations(
    papers,
    gaps.flatMap((g) => g.perPaper.flatMap((p) => p.evidenceIds)),
  )

  return {
    status: 'answered',
    mode: 'demo-rule',
    paragraphs,
    bullets,
    citations,
    notice: '演示数据 · 本地规则生成：缺项清单与「实验检查」页显示的结果完全一致。',
  }
}

function answerFieldQuestion(
  ctx: QaRequestContext,
  key: FieldKey,
  intro: string,
  outro: string,
): Omit<QaAnswer, 'id' | 'createdAt' | 'question' | 'paperIds'> {
  const { papers } = ctx
  const bullets = papers.map((p) => {
    const v = fieldValue(p, key)
    return `${paperHeading(p)}：${v ?? `没有读到${FIELD_META[key].label}（未找到，不等于论文有错误）`}`
  })
  const citations = buildCitations(
    papers,
    papers.flatMap((p) => fieldEvidence(p, key)),
  )
  const missing = papers.filter((p) => !fieldValue(p, key))
  const paragraphs = [intro]
  if (missing.length) {
    paragraphs.push(
      `其中 ${missing.map((p) => p.shortLabel).join('、')} 没有读到对应内容，可能是字段抽取漏了，也可能是论文确实没写，建议点开原文确认。`,
    )
  }
  paragraphs.push(outro)

  return {
    status: 'answered',
    mode: 'demo-rule',
    paragraphs,
    bullets,
    citations,
    notice: '演示数据 · 本地规则生成：回答由演示字段直接汇总，引用可点击查看演示片段。',
  }
}

function answerUnsupported(ctx: QaRequestContext): Omit<QaAnswer, 'id' | 'createdAt' | 'question' | 'paperIds'> {
  return {
    status: 'unsupported',
    mode: 'demo-rule',
    paragraphs: [
      '这个问题在当前选中的内容上回答不了：你现在看的是**演示数据**，演示问答由本地规则生成，只能处理上面几个预设方向。',
      '为了避免用同一个固定答案敷衍你，这里直接说明"暂时不能处理"。',
    ],
    bullets: [
      '演示数据可回答：方法差异、实验结果能否直接比较、复现还需要确认什么、主要结论、作者自述局限、使用了哪些数据集。',
      '想自由提问，请切换到「我的论文」并上传真实 PDF：真实论文的问答会由模型阅读正文原文回答，并返回可核对的页码与片段。',
    ],
    citations: [],
    notice: '演示数据 · 本地规则生成：请点击上方预设问题，或上传真实论文后自由提问。',
  }
}

/* ------------------------------------------------------------------ */
/* 真实论文：走后端模型                                                */
/* ------------------------------------------------------------------ */

/** 把问答引用转成侧栏可以直接展示的片段 */
export function citationToEvidence(c: QaCitation): Evidence {
  return {
    id: c.evidenceId,
    paperId: c.paperId,
    page: c.page,
    section: c.section || c.paperTitle,
    text: c.text,
    source: c.source ?? 'pdf',
  }
}

async function askReal(
  ctx: QaRequestContext,
  target: Paper[],
  base: Omit<QaAnswer, 'status' | 'mode' | 'paragraphs' | 'bullets' | 'citations' | 'notice'>,
): Promise<QaAnswer> {
  const withText = target.filter((p) => (ctx.pagesByPaper[p.id]?.length ?? 0) > 0)
  const skipped = target.filter((p) => (ctx.pagesByPaper[p.id]?.length ?? 0) === 0)

  if (withText.length === 0) {
    return {
      ...base,
      status: 'unsupported',
      mode: 'llm',
      paragraphs: [
        '所选论文还没有可用的正文文本，模型无法阅读原文回答。',
        '请先在论文库里上传文本型 PDF，等状态变成「字段已抽取」之后再提问。如果是扫描件，需要先做 OCR 转成可选中文字的 PDF。',
      ],
      bullets: [],
      citations: [],
      notice: '缺少论文正文。',
    }
  }

  try {
    // 把本地检查结果一起送过去：模型可以直接引用这些"规则推导"，
    // 后端会用它们给"规则推导"类结论标注依据（规则编号 + 输入字段 + 输入证据 + 结果）。
    // **只有带 ruleId（程序真的执行过的规则）的检查项**才允许把结论标成"规则推导"。
    const checks = [
      ...ctx.fairness.map((f) => ({
        id: f.id,
        key: String(f.key),
        label: f.label,
        ruleId: f.ruleId,
        ruleName: ruleMetaOf(f.ruleId)?.name,
        scope: f.scope ?? null,
        verdict: f.verdict,
        verdictText:
          f.verdict === 'consistent' ? '条件一致' : f.verdict === 'different' ? '存在差异' : '信息不足',
        reason: f.reason,
        perPaper: f.perPaper.map((p) => ({
          paperId: p.paperId,
          label: target.find((x) => x.id === p.paperId)?.shortLabel || p.paperId,
          value: p.value,
          evidenceIds: p.evidenceIds,
        })),
      })),
      ...ctx.repro.slice(0, 6).map((r) => ({
        id: r.id,
        key: String(r.key),
        label: r.label,
        ruleId: r.ruleId,
        ruleName: ruleMetaOf(r.ruleId)?.name,
        scope: null,
        verdict: r.verdict,
        verdictText: REPRO_VERDICT_TEXT[r.verdict] || r.verdict,
        reason: r.reason,
        perPaper: r.perPaper.map((p) => ({
          paperId: p.paperId,
          label: target.find((x) => x.id === p.paperId)?.shortLabel || p.paperId,
          value: p.value,
          evidenceIds: p.evidenceIds,
        })),
      })),
    ]

    const result = await requestAsk({
      question: ctx.question,
      context: {
        paperCount: withText.length,
        datasetScope: ctx.datasetScope ?? null,
        checks,
      },
      papers: withText.map((p) => ({
        id: p.id,
        shortLabel: p.shortLabel,
        title: p.title,
        pages: ctx.pagesByPaper[p.id],
      })),
    })

    const citations: QaCitation[] = result.citations.map((c) => ({
      evidenceId: c.evidenceId,
      paperId: c.paperId,
      paperTitle: c.paperTitle,
      page: c.page,
      section: `${c.shortLabel} · 第 ${c.page} 页`,
      text: c.quote,
      source: 'pdf',
    }))

    const paragraphs = [...result.paragraphs]
    if (skipped.length > 0) {
      paragraphs.push(
        `注意：${skipped.map((p) => p.shortLabel).join('、')} 还没有可用正文，本次回答没有使用这几篇论文的内容。`,
      )
    }
    if (result.warnings.length > 0) {
      paragraphs.push(`校验提示（引用与结论支持）：${result.warnings.join(' ')}`)
    }

    const supportCount = {
      full: (result.claims || []).filter((c) => c.support === 'full').length,
      partial: (result.claims || []).filter((c) => c.support === 'partial').length,
      unchecked: (result.claims || []).filter((c) => c.support === 'unchecked').length,
    }

    return {
      ...base,
      status: 'answered',
      mode: 'llm',
      paragraphs,
      bullets: result.bullets,
      citations,
      claims: result.claims,
      withdrawn: result.withdrawn,
      notice: `由模型阅读论文真实正文生成；每条引用都回查了原文，每条结论还做了「原文是否支持」的复核：${supportCount.full} 条明确支持${
        supportCount.partial ? `、${supportCount.partial} 条只部分支持` : ''
      }${
        result.withdrawn?.length ? `、${result.withdrawn.length} 条因找不到原文支持已撤回` : ''
      }${supportCount.unchecked ? `、${supportCount.unchecked} 条未能复核` : ''}。共使用 ${
        withText.length
      } 篇论文，耗时 ${(result.elapsedMs / 1000).toFixed(1)} 秒。`,
    }
  } catch (e) {
    const info =
      e instanceof ApiError
        ? { code: e.info.code, message: e.info.message }
        : { code: 'UNKNOWN', message: e instanceof Error ? e.message : '问答失败' }
    const needCredentials = info.code === 'NO_CREDENTIALS' || info.code === 'UNAUTHORIZED'
    return {
      ...base,
      status: 'failed',
      mode: 'llm',
      paragraphs: [
        `这次没有拿到回答：${info.message}`,
        needCredentials
          ? '后端没有可用的模型密钥，或访问口令不正确。请在服务端配置 LLM_API_KEY（或 ANTHROPIC_AUTH_TOKEN）与 LLM_BASE_URL 后重启后端；如果后端加了访问口令，请在「运行设置」里填写同样的口令。'
          : '可以点「重新回答」重试；如果持续失败，请检查后端日志与模型配额。',
      ],
      bullets: [],
      citations: [],
      notice: '请求失败：可以重试。',
    }
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export async function askQuestion(ctx: QaRequestContext): Promise<QaAnswer> {
  const base = {
    id: `qa-${Date.now()}`,
    question: ctx.question,
    paperIds: ctx.papers.map((p) => p.id),
    createdAt: new Date().toISOString(),
  }

  if (ctx.simulateFailure) {
    return {
      ...base,
      status: 'failed',
      mode: 'demo-rule',
      paragraphs: [
        '问答服务这次没有返回结果。这是「运行设置」里打开的失败模拟，用来展示失败与重试状态；关掉开关后可以正常回答。',
      ],
      bullets: [],
      citations: [],
      notice: '请求失败：可以点击「重新回答」再试一次。',
    }
  }

  if (ctx.papers.length === 0) {
    return {
      ...base,
      status: 'unsupported',
      mode: 'demo-rule',
      paragraphs: ['还没有选择论文。请先在论文库里勾选 1～3 篇论文，再回到这里提问。'],
      bullets: [],
      citations: [],
      notice: '请先选择论文。',
    }
  }

  const allDemo = ctx.papers.every((p) => p.source === 'demo')

  /* —— 真实论文：只有后端可用才走模型，否则如实说明，不用固定回答敷衍 —— */
  if (!allDemo) {
    if (!ctx.backendReady) {
      const hasText = ctx.papers.some((p) => (ctx.pagesByPaper[p.id]?.length ?? 0) > 0)
      return {
        ...base,
        status: 'unsupported',
        mode: 'llm',
        paragraphs: [
          '真实论文的问答需要后端调用模型，当前没有连接到可用后端，所以这次不能回答。',
          hasText
            ? '好消息是：所选论文的正文已经读到了本地，后端一接通就能直接基于原文回答。'
            : '同时所选论文也还没有读到正文，请先上传文本型 PDF 并等待解析完成。',
          '接入方式：启动本项目的后端服务（node server/index.mjs）并配置模型密钥；如果前端部署在静态托管上，请在下方的「运行设置」里填写后端地址。',
        ],
        bullets: [],
        citations: [],
        notice: `未连接模型：${ctx.backendError || '后端不可用'}。`,
      }
    }
    return askReal(ctx, ctx.papers, base)
  }

  /* —— 演示数据：本地规则生成，界面会标注「演示数据」 —— */
  const [min, max] = QA_LATENCY_MS
  await delay(min + Math.random() * (max - min))

  const intent = detectIntent(ctx.question)
  let body: Omit<QaAnswer, 'id' | 'createdAt' | 'question' | 'paperIds'>

  switch (intent) {
    case 'fairness':
      body = answerFairness(ctx)
      break
    case 'repro':
      body = answerRepro(ctx)
      break
    case 'compare-method':
      body = answerCompareMethod(ctx)
      break
    case 'conclusion':
      body = answerFieldQuestion(
        ctx,
        'conclusion',
        '以下是各篇论文自述的主要结论（为保持可比性，这里不做跨论文排名）：',
        '这些数字都带有各自的实验条件，比较前请先看「实验检查」页的条件是否一致。',
      )
      break
    case 'limitation':
      body = answerFieldQuestion(
        ctx,
        'limitations',
        '各篇论文自己承认的局限如下，这部分通常决定了方法能不能迁移到你的数据上：',
        '局限往往和你的场景直接相关，建议优先确认其中与你的数据条件相关的部分。',
      )
      break
    case 'dataset':
      body = answerFieldQuestion(
        ctx,
        'dataset',
        '各篇论文使用的数据集：',
        '数据集不完全相同时，误差的绝对值不可直接对照。',
      )
      break
    default:
      body = answerUnsupported(ctx)
      break
  }

  return { ...base, ...body }
}

