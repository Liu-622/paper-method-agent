/**
 * 研究集合服务：方法分类 / 技术演进 / 研究方向（赛题四项能力的核心计算）
 * ------------------------------------------------------------------
 * 全部为**确定性规则**，运行在已有 Paper + Evidence 之上，不引入模型训练。
 * 关键诚实原则：
 *  - 分类先识别「本文方法」，再判断架构与机制；相关工作中提到某机制不算本文采用。
 *  - 每个标签带来源类型（原文明示 / 工具推断 / 人工确认）与证据；
 *    弱线索给「待确认」，无证据不硬分类。
 *  - 关系只画有依据的：共享机制（无向，来自机制重叠）；改进/继承（候选，来自内置清单的公开沿革）。
 *  - 方向由真实缺口（复现缺项 + 机制组合缺口 + 作者局限）合成，每条能追到具体论文。
 */
import type {
  Collection,
  Evidence,
  MethodProfile,
  ClassificationTag,
  ClassifyOrigin,
  PaperRelation,
  ResearchDirection,
  AnalysisRecord,
  MapNode,
  Paper,
} from '@/types'
import { TS_CATALOG, FAMILY_VOCAB } from '@/data/catalog'
import { ANALYSIS_VERSION } from '@/config'

const FAMILY_MAP: [RegExp, string][] = [
  [/n-beats|nbeats|neural basis/i, 'MLP'],
  [/dlinear|nlinear|\blinear\b|ltsf-linear/i, 'Linear'],
  [/transformer|informer|autoformer|fedformer|patchtst|patch tst|crossformer|itransformer|etsformer|pyraformer|triformer/i, 'Transformer'],
  [/timesnet|scinet|micn|\btcn\b|conv/i, 'CNN'],
  [/\brnn\b|lstm|gru/i, 'RNN'],
]

const MECHANISM_MAP: [RegExp, string][] = [
  [/patch|64 words|patching/i, 'Patch 表示'],
  [/channel.?(independent|independence)|\bci\b/i, '通道独立'],
  [/freq|frequency|spectral|fourier/i, '频域处理'],
  [/decompos|auto-?correlation|trend|seasonal/i, '序列分解'],
  [/attention|prob.?sparse|auto-?correlation/i, '注意力'],
  [/conv|2d-variation|isometric|sample convolution/i, '卷积'],
  [/multi-?scale|sample convolution/i, '多尺度'],
  [/residual|basis expansion/i, '残差连接'],
  [/normaliz|reversible instance/i, '归一化去漂移'],
]

/** 识别「本文方法」：优先取 method 字段，其次 catalog，最后标题里的大写缩写 */
function ownMethodOf(p: Paper): { name: string | null; source: 'field' | 'catalog' | 'title' | null } {
  const mv = p.fields.method?.value
  if (mv) {
    const first = String(mv).split(/[、,，;；/|]|\bvs\.?\b/i)[0].trim().slice(0, 40)
    if (first) return { name: first, source: 'field' }
  }
  const cat = TS_CATALOG.find((c) => p.title && (p.title.includes(c.method.split(' / ')[0]) || c.title === p.title))
  if (cat) return { name: cat.method, source: 'catalog' }
  const m = p.title?.match(/\b([A-Z][A-Za-z0-9-]{2,})\b/)
  if (m) return { name: m[1], source: 'title' }
  return { name: null, source: null }
}

function catalogOf(p: Paper) {
  return TS_CATALOG.find((c) => p.title && (p.title.includes(c.method.split(' / ')[0].slice(0, 12)) || c.title === p.title))
}

function evidenceOf(p: Paper, fieldKey: string, evidenceById: Map<string, Evidence>): { ids: string[]; pages: string } {
  const ids = p.fields[fieldKey as keyof typeof p.fields]?.evidenceIds ?? []
  const pages = ids
    .map((id) => evidenceById.get(id)?.page)
    .filter((x): x is number => typeof x === 'number')
    .join(',')
  return { ids, pages }
}

function tag(
  label: string,
  scope: string,
  origin: ClassifyOrigin,
  status: ClassificationTag['status'],
  reason: string,
  evidenceIds: string[],
  extra: Partial<
    Pick<ClassificationTag, 'attribution' | 'quoteLocated' | 'semanticSupport' | 'semanticReason' | 'verdict' | 'manualStatus'>
  > = {},
): ClassificationTag {
  return { label, scope, origin, status, evidenceIds, reason, ...extra }
}

/**
 * 规则分类路径（不调用模型）的统一定级。
 *
 * 「引文定位成功」只说明这句话在论文里；标签本身若是程序按规则推出来的
 * （方法名命中词表、horizon ≥ 96、数据集名含 ett 等），那就是**工具推断**，
 * 不能因为引用真实就升级成「原文明示」。只有模型路径经过语义复核确认
 * 「本文采用 + 原句支持该标签」的条目，才允许显示为原文明示。
 */
const RULE_INFERRED = {
  quoteLocated: true,
  semanticSupport: 'unchecked',
  verdict: 'pending',
} as const

/** 对一篇论文做三维分类 */
function findMention(pages: { page: number; text: string }[] | undefined, keywords: string[]): { page: number; snippet: string } | null {
  if (!pages) return null
  for (const p of pages) {
    for (const kw of keywords) {
      const i = p.text.toLowerCase().indexOf(kw.toLowerCase())
      if (i >= 0) {
        const s = p.text.slice(Math.max(0, i - 60), i + 160).replace(/\s+/g, ' ').trim()
        return { page: p.page, snippet: s.slice(0, 220) }
      }
    }
  }
  return null
}

/** 论文分析状态：仅元信息 / 正文已读取 / 部分分析 / 方法分析完成 */
export function analysisStateOf(p: Paper, pages?: { page: number; text: string }[]): 'metadata' | 'text-read' | 'partial' | 'analyzed' {
  const hasText = Boolean(pages && pages.length > 0) || Boolean(p.textStored)
  const hasFields = Object.keys(p.fields ?? {}).length > 0
  if (hasFields) return 'analyzed'
  if (hasText) {
    const used = p.coverage?.usedPages?.length ?? 0
    const total = p.coverage?.totalPages ?? p.pageCount ?? 0
    if (total > 0 && used < total) return 'partial'
    return 'text-read'
  }
  return 'metadata'
}

export function classifyPaper(p: Paper, evidenceById: Map<string, Evidence>, pages?: { page: number; text: string }[]): MethodProfile {
  const own = ownMethodOf(p)
  const cat = catalogOf(p)
  const ev = evidenceOf(p, 'method', evidenceById)
  const hasText = Boolean(pages && pages.length > 0)
  const name = own.name ?? ''

  const family: ClassificationTag[] = []
  const mechanisms: ClassificationTag[] = []

  // 家族：本文方法名命中规则表；命中多个则多标签
  const hitFamilies = FAMILY_MAP.filter(([re]) => re.test(name)).map(([, f]) => f)
  const catFamilies = cat ? cat.family : []
  const famSet = [...new Set([...hitFamilies, ...catFamilies])]
  for (const f of famSet) {
    if (!hasText) {
      family.push(tag(f, name, 'catalog', 'pending', `内置清单预置标签（arXiv:${cat?.arxiv ?? '—'}），尚未读取正文核验`, []))
    } else if (ev.ids.length > 0) {
      // 第 X 页有逐字证据只证明「方法名」在正文里；«对应 F 架构» 是程序按词表推出来的，
      // 所以这是工具推断，不是原文明示。需要模型语义复核或人工确认才能升级。
      family.push(
        tag(
          f,
          name,
          'inferred',
          'pending',
          `本文方法「${name}」在第 ${ev.pages} 页有逐字证据（引文已定位），但该页未直接写明「本文采用 ${f} 架构」；标签由词表规则推断，待语义复核`,
          ev.ids,
          { ...RULE_INFERRED, attribution: 'used' },
        ),
      )
    } else {
      const m = findMention(pages, [name.slice(0, 20)])
      family.push(tag(f, name, 'inferred', 'pending', m ? `正文出现方法名「${name}」（第 ${m.page} 页），按规则推断为 ${f}；待逐字核验` : `方法名「${name}」命中 ${f}，正文未找到方法名原文，待确认`, []))
    }
  }
  if (family.length === 0) {
    family.push(tag('待分类', name, 'inferred', 'pending', name ? `方法名「${name}」未命中已知家族词表，需人工确认` : '没有读到本文方法名，无法分类', []))
  }

  // 机制：只在「有正文」时做原文定位；无正文一律清单预置
  const hitMech = MECHANISM_MAP.filter(([re]) => re.test(name) || (cat?.method && re.test(cat.method + ' ' + cat.mechanisms.join(' ')))).map(([, m]) => m)
  const catMech = cat ? cat.mechanisms : []
  for (const m of [...new Set([...hitMech, ...catMech])]) {
    if (!hasText) {
      mechanisms.push(tag(m, name, 'catalog', 'pending', `内置清单预置机制（arXiv:${cat?.arxiv ?? '—'}），未读正文`, []))
    } else {
      const found = findMention(pages, [m, ...mechanismAlias(m)])
      if (found) {
        mechanisms.push(tag(m, name, 'inferred', 'pending', `正文第 ${found.page} 页出现「${m}」相关表述，但尚未确认是本文方法采用（可能是相关工作/基线）`, []))
      } else {
        mechanisms.push(tag(m, name, 'inferred', 'pending', `按方法名「${name}」规则推断，正文未定位到「${m}」原文，保留待确认`, []))
      }
    }
  }
  if (mechanisms.length === 0) {
    mechanisms.push(tag('待确认', name, hasText ? 'inferred' : 'catalog', 'pending', hasText ? '正文未定位到明确的技术机制表述' : '未读取正文，无法判断技术机制', []))
  }

  // 任务：长时/短时来自 horizon 字段（有正文证据）；单/多变量来自 dataset 字段；无字段→未知，不贴统一标签
  const tasks: ClassificationTag[] = []
  const horizon = Number((String(p.fields.horizon?.value ?? '').match(/\d+/)?.[0]) ?? 0)
  if (horizon > 0) {
    // 「长时/短时」是拿 horizon 数值按阈值推出来的结论，论文原文未必出现这个标签词，
    // 因此标记为工具推断（引文已定位 ≠ 原文明示）。
    tasks.push(
      tag(
        horizon >= 96 ? '长时预测' : '短时预测',
        name,
        'inferred',
        'pending',
        `预测跨度 ${horizon}（第 ${evidenceOf(p, 'horizon', evidenceById).pages || '—'} 页，引文已定位）按阈值 ${horizon >= 96 ? '≥96' : '<96'} 推断，论文未直接写出该标签词`,
        evidenceOf(p, 'horizon', evidenceById).ids,
        RULE_INFERRED,
      ),
    )
  }
  const ds = String(p.fields.dataset?.value ?? '').toLowerCase()
  if (/ett|electricity|traffic|weather|exchange|multivari|多变量|multivariate/i.test(ds)) {
    tasks.push(
      tag(
        '多变量',
        name,
        'inferred',
        'pending',
        `数据集 ${p.fields.dataset?.value ?? ''}（第 ${evidenceOf(p, 'dataset', evidenceById).pages || '正文'} 页）按数据集名规则判定为多变量，属工具推断`,
        evidenceOf(p, 'dataset', evidenceById).ids,
        RULE_INFERRED,
      ),
    )
  }
  if (tasks.length === 0) {
    tasks.push(tag('待确认', name, hasText ? 'inferred' : 'catalog', 'pending', hasText ? '正文未定位到明确的任务/跨度表述，保留未知' : '未读取正文，无法确认任务范围', []))
  }

  return {
    paperId: p.id,
    ownMethod: own.name,
    family,
    mechanisms,
    tasks,
    generatedAt: new Date().toISOString(),
    analysisVersion: ANALYSIS_VERSION,
  }
}

function mechanismAlias(m: string): string[] {
  const a: Record<string, string[]> = {
    序列分解: ['decompos', 'trend', 'seasonal'],
    频域处理: ['frequency', 'fourier', 'spectral'],
    'Patch 表示': ['patch', 'patching'],
    通道独立: ['channel-independ', 'channel independ'],
    注意力: ['attention'],
    卷积: ['convolution', 'conv'],
    多尺度: ['multi-scale', 'multiscale', 'multiple scales'],
    残差连接: ['residual'],
    归一化去漂移: ['normaliz', 'instance norm', 'reversible'],
    自相关: ['autocorrelation', 'auto-correlation'],
  }
  return a[m] ?? [m]
}

export function classifyPapers(papers: Paper[], evidence: Evidence[], texts: Record<string, { page: number; text: string }[]> = {}): Record<string, MethodProfile> {
  const byId = new Map(evidence.map((e) => [e.id, e]))
  const out: Record<string, MethodProfile> = {}
  for (const p of papers) out[p.id] = classifyPaper(p, byId, texts[p.id])
  return out
}

/** 地图节点（论文简影） */
export function buildMapNodes(papers: Paper[], profiles: Record<string, MethodProfile>): MapNode[] {
  return papers.map((p) => {
    const pr = profiles[p.id]
    return {
      paperId: p.id,
      shortLabel: p.shortLabel,
      title: p.title,
      year: p.year,
      family: pr?.family.filter((f) => f.label !== '待分类').map((f) => f.label) ?? [],
      mechanisms: pr?.mechanisms.filter((m) => m.label !== '待确认').map((m) => m.label) ?? [],
      ownMethod: pr?.ownMethod ?? null,
      classified: Boolean(pr?.family.some((f) => f.label !== '待分类')),
    }
  })
}

/** 关系：共享机制（无向，来自机制重叠）；改进/继承（候选，来自内置清单公开沿革） */
export function buildRelations(papers: Paper[], profiles: Record<string, MethodProfile>, existingManual: PaperRelation[] = []): PaperRelation[] {
  const out: PaperRelation[] = []
  const verified = (m: ClassificationTag) => m.verdict === 'paper-supported' || m.status === 'confirmed'
  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const tagsOf = (id: string) => (profiles[id]?.mechanisms ?? []).filter((m) => m.label !== '待确认')
      const ta = tagsOf(papers[i].id)
      const tb = tagsOf(papers[j].id)
      const bLabels = tb.map((m) => m.label)
      const shared = ta.map((m) => m.label).filter((m) => bLabels.includes(m))
      if (shared.length > 0) {
        // 连线状态必须与它依赖的标签状态一致：只要有一侧的共享机制标签还没到
        // 「原文支持」，这条连线就不能显示成「已确认」——否则会出现
        // 列表里写「待确认」、地图上连线写「已确认」的矛盾。
        const sideA = ta.filter((m) => shared.includes(m.label))
        const sideB = tb.filter((m) => shared.includes(m.label))
        const aOk = sideA.every(verified)
        const bOk = sideB.every(verified)
        const allVerified = aOk && bOk && sideA.length > 0 && sideB.length > 0
        const unverifiedSides = [!aOk ? papers[i].shortLabel : '', !bOk ? papers[j].shortLabel : ''].filter(Boolean)
        out.push({
          id: `rel-share-${papers[i].id}-${papers[j].id}`,
          from: papers[i].id,
          to: papers[j].id,
          type: 'shared-mechanism',
          directed: false,
          evidenceIds: [],
          generatedBy: 'program',
          review: allVerified ? 'confirmed' : 'candidate',
          reason: `两篇都标注了技术机制：${shared.join('、')}（无向关系，不代表继承或引用）${
            allVerified ? '；两侧标签均已通过语义复核' : `；但 ${unverifiedSides.join('、')} 的对应机制标签尚未通过语义复核，本连线随之为待确认`
          }`,
        })
      }
    }
  }
  // 「改进/继承」只来自模型 /api/analyze 产出且逐字命中正文的关系（在 store 里注入）。
  // 年份先后 / 参考文献 / 作基线都不构成继承，这里不再硬编码任何沿革箭头。
  const manual = existingManual.filter((r) => r.generatedBy === 'manual')
  return [...out, ...manual]
}

/** 时间线（按年份 + 家族泳道） */
export function buildTimeline(papers: Paper[], nodes: MapNode[]) {
  const withYear = nodes.filter((n) => n.year !== null).sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
  const unknown = nodes.filter((n) => n.year === null)
  const lanes = FAMILY_VOCAB.filter((f) => withYear.some((n) => n.family.includes(f)))
  return { withYear, unknown, lanes, yearMin: withYear[0]?.year ?? null, yearMax: withYear[withYear.length - 1]?.year ?? null }
}

/** 演进摘要（带引用，只描述集合内观察，不下范式转移结论） */
export function evolutionSummary(papers: Paper[], nodes: MapNode[]): string[] {
  const lines: string[] = []
  const byYear = [...nodes.filter((n) => n.year !== null)].sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
  if (byYear.length < 2) {
    lines.push('当前集合里年份可靠的论文不足两篇，暂不生成时间线演进判断。')
    return lines
  }
  const first = byYear[0]
  const last = byYear[byYear.length - 1]
  lines.push(`当前集合覆盖 ${byYear[0].year}–${last.year} 共 ${byYear.length} 篇有年份的论文（另有 ${nodes.length - byYear.length} 篇年份待确认）。`)
  const mechCount: Record<string, number> = {}
  for (const n of byYear) for (const m of n.mechanisms) mechCount[m] = (mechCount[m] ?? 0) + 1
  const sorted = Object.entries(mechCount).sort((a, b) => b[1] - a[1])
  if (sorted.length) lines.push(`集合中最常出现的技术机制是「${sorted[0][0]}」（${sorted[0][1]} 篇），其次是${sorted[1] ? `「${sorted[1][0]}」（${sorted[1][1]} 篇）` : '—'}。`)
  const earlyFamilies = new Set(byYear.slice(0, Math.ceil(byYear.length / 2)).flatMap((n) => n.family))
  const lateFamilies = new Set(byYear.slice(Math.ceil(byYear.length / 2)).flatMap((n) => n.family))
  const gained = [...lateFamilies].filter((f) => !earlyFamilies.has(f))
  if (gained.length) lines.push(`后半段新增了 ${gained.join('、')} 家族的方法（例如 ${last.ownMethod ?? last.shortLabel}）。`)
  lines.push(`以上是**本集合内**的观察，不代表整个领域已完成范式转移；不同路线（如分解-线性 vs 频域-Transformer）可能长期并存。`)
  return lines
}

/** 研究方向：分成「资料与复现准备任务(prep)」与「候选研究方向(research)」，不混为一谈 */
/** 已有实验案例的延伸建议来源（真实实验记录，非自动拼装）。 */
export interface LabCaseExtension {
  caseId: string
  caseName: string
  generatedAt: string
  weights: Record<string, string>
  settings: Record<string, string | number>
  extensionQuestion: string
  hypothesis: string
  /** 原案例实际运行了什么方法、数据与条件 */
  ranWhat: string
  /** 本建议沿用了原案例的哪个观察 */
  reusedObservation: string
  /** 新建议改变了什么 */
  changed: string
  /** 哪些推断尚未经过验证 */
  unverified: string
  relatedPaperIds?: string[]
  minimalExperiment: { baseline: string; variable: string; fixed: string; dataset: string; metrics: string[] }
  resources: string
  boundary: string
}

/** 实验室已接入、可真实运行的方法（进入实验室前仍需核对配置匹配） */
const LAB_METHODS = new Set(['DLinear', 'Linear', 'LTSF-Linear', 'NLinear', 'seasonal_naive', 'ridge'])

/**
 * 把「作者局限/未来工作」具体化成可操作的实验方案（工具建议，规则、确定性、不调用模型）。
 * 不再统一填「待确定」：按局限/未来工作的措辞给出一组具体、可执行的变量/对照/数据/指标，
 * 并明确这是「工具建议」，不是论文原设定。无法命中的才落到通用建议。
 */
function concretizeExperiment(pr: MethodProfile | undefined, shortLabel: string, text: string) {
  const t = String(text || '').toLowerCase()
  const own = pr?.ownMethod ?? shortLabel

  // 变化点 / 非平稳
  if (/change.?point|变点|变化点|nonstationar|非平稳|trend break|level shift|regime|动态变化/i.test(t)) {
    return {
      baseline: `${own}（原样）`,
      variable: '在测试序列中构造/识别变化点（趋势断点、水平漂移或方差异变），比较「含变化点区段」vs「无变化点区段」的预测误差；区间按先验规则切分，不得用测试结果反选有利区间',
      fixed: 'seq_len、pred_len、训练集、指标与聚合方式沿用原文；窗口重叠情况如实记录',
      dataset: '原文基准数据集；需能标注/构造变化点（例如 Electricity/ETT 的已知非平稳区段，或合成压力测试——后者只能检查该机制，不等同真实场景验证）',
      metrics: ['MAE', 'MSE'],
    }
  }
  // 节假日 / 协变量 / 外部变量
  if (/holiday|节假日|covariate|协变量|calendar|日历|external|外部|节假日效应/i.test(t)) {
    return {
      baseline: `${own}（不加协变量）`,
      variable: '加入节假日/日历协变量（day-of-week、节假日标记、外部日期表）作为额外输入特征',
      fixed: 'seq_len、pred_len、训练/测试划分沿用原文；两组只差「是否含协变量」',
      dataset: '候选数据需含可解释的时间戳，并能确定地域、适用节假日日历及训练/测试段事件覆盖；ETTm2、Traffic 或 Electricity 仅可作为待核对候选，不能因有 date 列就视为已适配',
      metrics: ['MAE', 'MSE'],
    }
  }
  // 大规模预训练 / 迁移
  if (/pre.?train|预训练|transfer|迁移|foundation|大模型|scale.?up/i.test(t)) {
    return {
      baseline: `${own}（从头训练）`,
      variable: '用多数据集预训练后在下游微调，对比从头训练',
      fixed: '下游数据、seq_len、pred_len、微调步数与原文一致',
      dataset: '预训练用多数据集（ETT/Electricity/Traffic/Weather），下游沿用原文',
      metrics: ['MAE', 'MSE'],
    }
  }
  // 通用：给出可执行的最小对照（工具建议）
  return {
    baseline: own,
    variable: '按局限逐项构造可操作变量（例如：输入长度、噪声水平、采样间隔等单个因素），每次只改一项',
    fixed: 'seq_len、pred_len、训练/测试划分、指标与原文一致',
    dataset: pr?.ownMethod ? '原文基准数据集（若无则需补充）' : '需补充',
    metrics: ['MAE', 'MSE'],
  }
}


/**
 * 实验适配检查（规则、确定性、不调用模型）：
 * 判断「数据、变量、对照、指标」是否真的能检验这张卡里的假设。
 * 不用空话填充——无法确定就列为待确认项并说明影响。
 */
export function fitResearchDirection(d: ResearchDirection): Partial<ResearchDirection> {
  const m = d.minimalExperiment
  const researchMissing: string[] = []
  const executionMissing: string[] = []
  // 数据要求：只要数据是「需要补/待确认」而非「已具备并核对」，就列为前置任务（给出具体数据要求）
  if (!m.dataset || /待定|待确定|需补充|需能|需要|需含|原文基准/.test(m.dataset)) {
    researchMissing.push(`数据要求：${m.dataset || '未指定'}（当前未确认具备，需按此准备数据）`)
  }
  if (/待确定|待定|作者|边界条件|设想的方案|保持原设置|沿用/.test(m.variable)) {
    researchMissing.push('变量未具体化：需把「作者局限/未来工作」替换为可操作变量（变化点识别方式、节假日定义、协变量列表等），否则无法设计对照')
  }
  if (/待确定|待定|作者|边界条件|保持原设置|沿用|代表/.test(m.baseline)) {
    researchMissing.push('对照未具体化：需明确与哪个方法在哪个共同任务/设置下比较，不能只写「Transformer 对比 Linear」')
  }
  if (!m.metrics?.length) researchMissing.push('未指定评价指标')

  const combined = `${d.question} ${d.hypothesis} ${m.variable} ${m.dataset}`.toLowerCase()
  if (/holiday|节假日|calendar|日历|covariate|协变量/.test(combined)) {
    researchMissing.push('需确认数据地域与日期含义，并选择适用的节假日日历；只有 date 列不足以确定节假日')
    researchMissing.push('需统计训练/验证/测试段中的相关事件覆盖，并确认这些协变量在预测时可提前获得')
    researchMissing.push('需确认当前方法实现支持额外协变量；若不支持，要先实现并固定输入接口')
  }
  if (/change.?point|变化点|变点|trend break|level shift|regime|非平稳/.test(combined)) {
    researchMissing.push('需预先固定变化点的标注或生成规则，并在看测试结果前确定区间，避免结果导向选段')
  }

  const baseMethods = m.baseline
    .replace(/（.*?）|\(.*?\)/g, '')
    .split(/\s*(?:vs\.?|与|和|对比|\/|、)\s*/i)
    .map((x) => x
      .replace(/\s*(?:官方实现|原文配置|官方配置|本项目训练权重|当前案例).*$/i, '')
      .trim())
    .filter(Boolean)
  const unsupportedMethods = baseMethods.filter((name) => !LAB_METHODS.has(name))
  if (unsupportedMethods.length) {
    executionMissing.push(`当前实验室未接入「${unsupportedMethods.join('、')}」，需要外部实现/权重与运行配置，不能用教学方法替代`)
  }
  if (/预测跨度|pred.?len|horizon|多跨度|96\/192|192\/336|336\/720/i.test(m.variable)) {
    executionMissing.push('改变预测跨度需要为每个 pred_len 使用匹配配置重新训练/加载权重，不能直接复用现有 pred_len=96 权重')
  }
  if (/协变量|covariate|日历|holiday|节假日/.test(combined)) {
    executionMissing.push('当前产品尚未确认该方法支持日历/节假日协变量输入，需要先完成实现与输入维度适配')
  }

  const judgment = '用对照实验比较变量改变前后（或两组设置）的指标差；只有差异能归因于该变量、且区间/样本选择不依赖测试结果时，才支持假设'
  const status: 'ready' | 'missing-prerequisite' | 'not-supported' = researchMissing.length
    ? 'missing-prerequisite'
    : executionMissing.length
      ? 'not-supported'
      : 'ready'
  const missing = [...researchMissing, ...executionMissing]
  return {
    judgment: d.judgment || judgment,
    prerequisites: [...new Set([...(d.prerequisites ?? []), ...researchMissing])],
    unsupportedSteps: [...new Set([...(d.unsupportedSteps ?? []), ...executionMissing])],
    fitness: {
      status,
      missing,
      note: researchMissing.length
        ? '研究方案仍缺少必要数据或变量定义；当前产品能否执行单独列示，二者不能互相覆盖'
        : executionMissing.length
          ? '研究方案前提已基本明确，但当前产品仍缺少方法实现、权重或匹配配置'
          : '研究方案前提已明确，且当前产品具备相应执行入口；运行前仍需核对具体版本',
      research: {
        status: researchMissing.length ? 'missing-prerequisite' : 'ready',
        missing: researchMissing,
        note: researchMissing.length ? '补齐这些前提后，实验设计才具备可判定性' : '数据、变量、对照和指标已具体化',
      },
      execution: {
        status: executionMissing.length ? 'external-required' : 'runnable',
        missing: executionMissing,
        note: executionMissing.length ? '需要外部实现、重新训练或输入接口改造' : '当前产品已接入所需方法与配置',
      },
    },
  }
}

export function deriveDirections(
  papers: Paper[],
  profiles: Record<string, MethodProfile>,
  evidence: Evidence[],
  texts: Record<string, { page: number; text: string }[]> = {},
  labCases: LabCaseExtension[] = [],
): ResearchDirection[] {
  const out: ResearchDirection[] = []
  const gen = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const hasText = (p: Paper) => Boolean(texts[p.id] && texts[p.id].length > 0)

  /* ============ 一、资料与复现准备任务（prep） ============ */
  const noText = papers.filter((p) => !hasText(p))
  if (noText.length > 0) {
    out.push({
      id: `dir-${gen()}`,
      kind: 'prep',
      question: `解析 ${noText.length} 篇尚未读取正文的论文`,
      sourceType: 'synthesis',
      evidenceIds: [],
      relatedPaperIds: noText.map((p) => p.id),
      reasoning: `这些论文当前只有内置清单元信息（标题/年份/来源），尚未读取 PDF 正文；在读取前，不能对学习方法、机制、任务或缺失项作任何判断。`,
      hypothesis: '',
      minimalExperiment: { baseline: '—', variable: '—', fixed: '—', dataset: '—', metrics: [] },
      resources: '上传对应 PDF 或使用本地已下载的原文',
      boundary: '仅限集合内尚未读取正文的论文',
      recommendReason: '没有正文就无法产生可靠的分析结论，这是当前最优先的一步',
      generatedAt: new Date().toISOString(),
    })
  }
  const textPapers = papers.filter(hasText)
  const fieldGaps = textPapers.filter((p) => !p.fields.learningRate?.value || !p.fields.split?.value || !p.fields.preprocessing?.value)
  if (fieldGaps.length > 0) {
    out.push({
      id: `dir-${gen()}`,
      kind: 'prep',
      question: `补齐 ${fieldGaps.length} 篇已读正文论文的实验设置（学习率/划分/预处理）`,
      sourceType: 'synthesis',
      evidenceIds: [],
      relatedPaperIds: fieldGaps.map((p) => p.id),
      reasoning: `这些论文正文已读取，但字段抽取尚未完成或原文未明确给出某些设置——这属于「资料尚未查全」，不等于作者未报告；需要补查后才能谈可比性。`,
      hypothesis: '',
      minimalExperiment: { baseline: '—', variable: '—', fixed: '—', dataset: '—', metrics: [] },
      resources: '在论文详情页对缺失字段点「补查」，或用小咕侦探去附录/官方仓库找',
      boundary: '仅限已读取正文的论文',
      recommendReason: '补齐设置是后续公平比较的前提，但本身不是研究问题',
      generatedAt: new Date().toISOString(),
    })
  }

  /* ============ 二、候选研究方向（research，可检验问题） ============ */
  // a) 作者明确提出的「未来工作」→ author-future；作者报告的「局限」→ limitation-derived（工具推导）。
  //    不把工具生成的假设包装成作者原话：局限只能证明「作者报告过」，由我们据此生成的问题标为工具推导。
  const makeExp = (pr: MethodProfile | undefined, shortLabel: string, text: string) => concretizeExperiment(pr, shortLabel, text)

  for (const p of textPapers) {
    const pr = profiles[p.id]
    const fw = pr?.futureWork?.[0]
    if (!fw) continue
    const premiseOk = fw.quoteLocated === true && (fw.semanticSupport ?? 'unchecked') === 'supported'
    const d: ResearchDirection = {
      id: `dir-${gen()}`,
      kind: 'research',
      question: `作者提出的未来工作「${String(fw.text ?? '').slice(0, 80)}…」是否可独立检验？`,
      sourceType: 'author-future',
      evidenceIds: [],
      relatedPaperIds: [p.id],
      reasoning: `${p.shortLabel} 明确提出了这一未来工作（第 ${fw.page ?? '?'} 页；${premiseOk ? '原文已核对' : '前提待确认'}）。这是作者原话给出的方向，不是工具臆测。`,
      hypothesis: '该未来工作在作者未验证的条件下是否成立（支持 / 不支持 / 无法判断）。',
      minimalExperiment: makeExp(pr, p.shortLabel, fw.text ?? ''),
      resources: '需要该方法实现；数据与设置按原文',
      boundary: '仅限作者声明的未来工作范围',
      recommendReason: '作者明确提出的未来工作，来源最可靠',
      generatedAt: new Date().toISOString(),
    }
    d.sourceClaims = fw.quote ? [{ kind: 'paper-quote', paperId: p.id, page: fw.page, quote: fw.quote, verified: premiseOk }] : []
    d.proposalMode = 'rule'
    out.push({ ...d, ...fitResearchDirection(d) })
  }

  for (const p of textPapers) {
    const pr = profiles[p.id]
    const lim = pr?.limitations?.[0]
    if (!lim) continue
    const premiseOk = lim.quoteLocated === true && (lim.semanticSupport ?? 'unchecked') === 'supported'
    const d: ResearchDirection = {
      id: `dir-${gen()}`,
      kind: 'research',
      question: `作者自述的局限「${String(lim.text ?? '').slice(0, 80)}…」在多大范围内成立？`,
      sourceType: 'limitation-derived',
      evidenceIds: [],
      relatedPaperIds: [p.id],
      reasoning: `${p.shortLabel} 报告了这一局限（第 ${lim.page ?? '?'} 页；${premiseOk ? '原文已核对' : '前提待确认'}）。这只能证明作者报告过该局限——据此生成的问题是由工具推导的候选方向，不是作者原话。${premiseOk ? '' : '前提未确认会影响该方向的成立，需先核对原文。'}`,
      hypothesis: '在作者限定的条件之外，该局限是否仍然成立（支持 / 不支持 / 无法判断）。',
      minimalExperiment: makeExp(pr, p.shortLabel, lim.text ?? ''),
      resources: '需要该方法实现；数据与设置按原文',
      boundary: '仅限该作者论文声明的范围；作为工具推导的方向，新颖性需进一步检索确认',
      recommendReason: premiseOk ? '基于作者明示局限的工具推导，原文已核对' : '基于作者明示局限的工具推导，前提待核对',
      generatedAt: new Date().toISOString(),
    }
    d.sourceClaims = lim.quote ? [{ kind: 'paper-quote', paperId: p.id, page: lim.page, quote: lim.quote, verified: premiseOk }] : []
    d.proposalMode = 'rule'
    out.push({ ...d, ...fitResearchDirection(d) })
  }

  // b) 已有实验案例的延伸建议：只从「真实实验记录」生成（labCases 由调用方从实验室载入）。
  //    已删除「有 Linear 和 Transformer 就自动生成时间段反转案例延伸」的隐含逻辑：
  //    没有真实来源关系时，不为了补齐来源类型而强行生成案例延伸卡。
  for (const c of labCases) {
    const d: ResearchDirection = {
      id: `dir-${gen()}`,
      kind: 'research',
      question: c.extensionQuestion,
      sourceType: 'case-extension',
      evidenceIds: [],
      relatedPaperIds: c.relatedPaperIds ?? [],
      sourceClaims: [{ kind: 'lab-case', quote: c.reusedObservation, verified: true }],
      reasoning: `来源：真实实验案例「${c.caseName}」。原案例实际运行：${c.ranWhat}。本建议沿用了原案例的观察：${c.reusedObservation}。新建议改变的是：${c.changed}。尚未经过验证的推断：${c.unverified}。`,
      hypothesis: c.hypothesis,
      minimalExperiment: c.minimalExperiment,
      resources: c.resources,
      boundary: c.boundary,
      recommendReason: '由真实实验记录延伸而来，有可核对的案例依据，而非为了凑来源类型自动生成',
      sourceVersion: `${c.caseId}:${c.generatedAt}`,
      proposalMode: 'rule',
      caseSource: {
        caseId: c.caseId,
        generatedAt: c.generatedAt,
        weights: c.weights,
        settings: c.settings,
        observed: c.reusedObservation,
      },
      generatedAt: new Date().toISOString(),
    }
    out.push({ ...d, ...fitResearchDirection(d) })
  }

  // 去重并保留来源多样性：资料任务最多 2 张；真实案例延伸优先保留 1 张，
  // 避免大量 author-future 把 case-extension 永久挤出前 6 张。
  const seen = new Set<string>()
  const unique = out.filter((d) => {
    const k = d.question.slice(0, 24)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  const prep = unique.filter((d) => d.kind === 'prep').slice(0, 2)
  const research = unique.filter((d) => d.kind === 'research')
  const selected: ResearchDirection[] = []
  const take = (source: ResearchDirection['sourceType'], limit: number) => {
    for (const d of research) {
      if (selected.length >= 4 || limit <= 0) break
      if (d.sourceType === source && !selected.includes(d)) {
        selected.push(d)
        limit -= 1
      }
    }
  }
  take('case-extension', 1)
  take('limitation-derived', 1)
  take('author-future', 2)
  take('synthesis', 1)
  for (const d of research) {
    if (selected.length >= 4) break
    if (!selected.includes(d)) selected.push(d)
  }
  return [...prep, ...selected]
}

/** 生成一次分析记录（覆盖情况） */
export function makeAnalysisRecord(collection: Collection, papers: Paper[], profiles: Record<string, MethodProfile>, coveredIds: string[], failedIds: string[]): AnalysisRecord {
  return {
    id: `ana-${Date.now().toString(36)}`,
    collectionId: collection.id,
    inputPaperIds: collection.paperIds,
    coveredPaperIds: coveredIds,
    failedPaperIds: failedIds,
    skippedPaperIds: collection.paperIds.filter((id) => !coveredIds.includes(id) && !failedIds.includes(id)),
    generatedAt: new Date().toISOString(),
    analysisVersion: ANALYSIS_VERSION,
  }
}

/** 集合分类摘要（数字实时计算，多标签计数说明不互斥） */
export function collectionSummary(papers: Paper[], profiles: Record<string, MethodProfile>) {
  const classified = papers.filter((p) => profiles[p.id]?.family.some((f) => f.label !== '待分类')).length
  const pending = papers.length - classified
  const fam = new Set<string>()
  const mech = new Set<string>()
  for (const p of papers) {
    for (const f of profiles[p.id]?.family ?? []) if (f.label !== '待分类') fam.add(f.label)
    for (const m of profiles[p.id]?.mechanisms ?? []) if (m.label !== '待确认') mech.add(m.label)
  }
  return { total: papers.length, classified, pending, familyCount: fam.size, mechanismCount: mech.size }
}
