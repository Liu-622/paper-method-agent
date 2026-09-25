import { request } from '@/services/api'

/* ------------------------------------------------------------------ */
/* 小咕实验室 · 前端接口                                               */
/* 执行全部在服务端完成（受控实验模板），前端只负责配置与展示            */
/* ------------------------------------------------------------------ */

export interface LabDataSource {
  kind: 'real' | 'synthetic'
  name: string
  column: string
  url: string | null
  repo: string | null
  rows: number
  start: string
  end: string
  intervalMinutes: number
  note: string
  generator?: string
}

export interface LabMetrics {
  n: number
  mae: number | null
  /** 官方论文方法家族会同时给出 MSE */
  mse?: number | null
  rmse: number | null
  mape: number | null
}

export interface LabConfig {
  horizon: number
  perturbationType: 'noise' | 'missing'
  strength: number
  seed: number
  /** 数据段：探索段 / 独立复验段 */
  segment?: 'explore' | 'independent'
  subset?: string
  column?: string
}

export interface LabRun {
  id: string
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  origin: 'manual' | 'explore' | 'replication'
  /** 方法家族：教学实验 / 官方论文方法 */
  family?: 'teaching' | 'paper-linear'
  dataSplitId?: string
  metricsSpec?: { metrics: string[]; space: string; aggregation: string; nSamples: number; nWindows?: number; predLen?: number }
  perturbation?: { type: string; strength: number; seed: number; changedPoints: number; scope: string; missingFill: string | null }
  slice?: { key: string; label: string; isCustomSlice: boolean; usedStart: number; usedEnd: number; startDate: string | null; endDate: string | null }
  benchmark?: { scope: string; note: string }
  /** 数据段：探索段 / 独立复验段 */
  segment?: 'explore' | 'independent'
  segmentLabel?: string
  createdAt: string
  startedAt: string
  finishedAt?: string
  elapsedMs?: number
  claim?: { text: string; source: string } | null
  replicatedOf?: string | null
  dataSource: LabDataSource
  split?: { trainSize: number; valSize: number; testSize: number; testRange: [number, number] }
  config: LabConfig
  seed?: number
  perturbationPoints?: number
  evaluation?: { nSamples: number; nWindows?: number; origins: number; originRange: [number, number]; horizon: number; target: string }
  methods?: Record<string, { label: string; metrics: LabMetrics; predictionsHash: string }>
  comparison?: { deltaMae: number; leader: 'ridge' | 'seasonal_naive' | 'tie' | 'DLinear' | 'Linear'; relGap: number | null; closeGap: boolean }
  chart?: {
    stride: number
    truth: number[]
    seasonal?: number[]
    ridge?: number[]
    DLinear?: number[]
    Linear?: number[]
  }
  checks?: Record<string, boolean>
  provenance?: { methodScope: string; labVersion: string; note: string }
  error?: string
  interruptedReason?: string
}

export interface LabMapCell {
  horizon: number
  strength: number
  key: string
  status: 'untested' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  /** 证据等级：由程序按"实际跑过什么"判定 */
  evidenceLevel?:
    | 'untested'
    | 'exploration-only'
    | 'seed-replicated'
    | 'independent-replicated'
    | 'failed'
  independentRunId?: string | null
  doneCount?: number
  segment?: 'explore' | 'independent' | null
  runId: string | null
  runCount: number
  replicated: boolean
  error: string | null
  comparison: LabRun['comparison'] | null
  metrics: { seasonal: LabMetrics | null; ridge: LabMetrics | null } | null
  nSamples: number | null
}

export interface LabMap {
  axes: { x: string; y: string; perturbationType: 'noise' | 'missing' }
  cells: LabMapCell[]
  closeGapThreshold: number
  note: string
}

export interface LabMeta {
  ok: boolean
  source: LabDataSource
  total: number
  season: number
  split: { train: [number, number]; val: [number, number]; test: [number, number] }
  preview: number[]
  conditionSpace: {
    horizon: number[]
    perturbationType: string[]
    strength: number[]
    seed: number[]
    lags: number
    alpha: number
    stride: number
  }
  closeGapThreshold: number
  labVersion: string
  methodScope: string
}

export interface LabRunsPayload {
  ok: boolean
  runs: LabRun[]
  map: LabMap
  summary: { total: number; done: number; failed: number; observed: string[]; trend: unknown[]; note: string }
  findings?: LabFinding[]
  conditionSpace: LabMeta['conditionSpace']
  closeGapThreshold: number
  labVersion: string
  segments?: Record<string, string>
  reproRequirements?: string[]
}

export interface ExploreTraceItem {
  step: number
  kind: string
  planner: string
  plannerNote?: string | null
  config: LabConfig
  runId: string
  status: string
  reason: string
  comparison: LabRun['comparison'] | null
  nSamples: number | null
  replicatedOf?: string | null
  error?: string | null
  segment?: 'explore' | 'independent'
  /** 可审计的五行行动轨迹 */
  observation?: string
  choice?: string
  result?: string
  judgmentChange?: string
}

export interface ExploreResult {
  ok: boolean
  explorationId: string
  budget: number
  used: number
  remaining: number
  stoppedReason: string | null
  stopCode?: string | null
  mode: 'model' | 'rule'
  trace: ExploreTraceItem[]
  findings?: LabFinding[]
  summary: LabRunsPayload['summary']
  map: LabMap
  visibleSegment?: string
  hiddenSegment?: string
  note?: string
}

export const fetchLabMeta = () => request<LabMeta>('/api/lab/meta')

export const fetchLabRuns = (
  perturbationType: 'noise' | 'missing' = 'noise',
  family: 'teaching' | 'paper-linear' = 'teaching',
) => request<LabRunsPayload>(`/api/lab/runs?perturbationType=${perturbationType}&family=${family}`)

export const runLabExperiment = (config: LabConfig, claim?: { text: string; source: string }) =>
  request<{ ok: boolean; record: LabRun }>('/api/lab/run', {
    method: 'POST',
    body: JSON.stringify({ config, origin: 'manual', claim }),
  })

export const exploreLab = (payload: {
  claim: { text: string; source: string } | null
  budget: number
  perturbationType: 'noise' | 'missing'
  explorationId: string
}) =>
  request<ExploreResult>('/api/lab/explore', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const cancelLabExploration = (explorationId: string) =>
  request<{ ok: boolean; cancelled: boolean }>('/api/lab/cancel', {
    method: 'POST',
    body: JSON.stringify({ explorationId }),
  })

export const clearLabRuns = () => request<{ ok: boolean }>('/api/lab/clear', { method: 'POST' })

/* ---------------- 官方论文方法（DLinear / Linear） ---------------- */

export interface PaperMethodRun {
  runId: string
  method: 'DLinear' | 'Linear'
  methodSource: string
  createdAt: string
  task: { dataset: string; target: string; features: string; seqLen: number; predLen: number; encIn: number }
  hyper: { epochs: number; batch: number; lr: number; optim: string; loss: string; individual: boolean; seed: number }
  timing: { trainSeconds: number; epochSeconds: number[]; inferSeconds: number }
  params: number
  dataSha256: string | null
  metrics: { mae: number; mse: number; rmse: number; nSamples: number } | null
  hasParity: boolean
  officialSha: string
  notes: string[]
}

export interface PaperSplit {
  train: { usedStart: number; usedEnd: number; startDate: string; endDate: string }
  val: { usedStart: number; usedEnd: number; startDate: string; endDate: string }
  test: { usedStart: number; usedEnd: number; startDate: string; endDate: string }
  evalStart: number
  evalEnd: number
  datasetRows: number
  outOfBenchmark: { from: number; to: number; len: number; startDate: string; endDate: string; note: string }
  customSlices: Record<
    'explore' | 'consistency',
    { usedStart: number; usedEnd: number; usedLen: number; startDate: string; endDate: string; label: string; isCustomSlice: boolean }
  >
}

export interface PaperComparisonSpace {
  key: string
  label: string
  mae: number | null
  mse: number | null
  comparable: boolean
  gapMae?: number | null
  gapMse?: number | null
  missing?: string[]
  note: string
}

export interface PaperComparison {
  reference: {
    source: string
    sourceLevel: string
    protocol: Record<string, unknown>
    values: { DLinear: { mse: number; mae: number }; Linear: { mse: number; mae: number } }
    note: string
  }
  rows: {
    method: string
    runId: string
    spaces: PaperComparisonSpace[]
    gapSummary: { localMae: number; refMae: number; diff: number; relPercent: number } | null
    factorsToCheck: string[]
  }[]
  alignmentRule: string
  noCausalClaim: string
}

export interface PaperSourceBlock {
  pdfPath: string
  pages: number
  title: string
  authors: string
  venue: string
  methodQuote: { text: string; page: number }
  kernelQuote: { text: string; page: number }
  protocolQuote: { text: string; page: number }
  tableQuote: { text: string; page: number }
  referenceValues: Record<string, { mse: number; mae: number; page: number; table: string }>
  toolQuestion: { text: string; note: string }
  toolObservation: { text: string; note: string }
  caveats: string[]
}

export interface PaperMethodsPayload {
  ok: boolean
  methods: Record<'DLinear' | 'Linear', { key: string; label: string; source: string; repo: string; sha: string; script: string; paper: string }>
  trained: PaperMethodRun[]
  latestRunIds: Partial<Record<'DLinear' | 'Linear', string>>
  comparison?: PaperComparison
  paperSource?: PaperSourceBlock
  split: PaperSplit
  strengths: number[]
  seeds: number[]
  dataSplitId: string
  paper: { title: string; venue: string; repo: string; sha: string; license: string; textAvailable: boolean; note: string }
}

export interface PaperConsistency {
  ok: boolean
  slice: string
  sliceLabel: string
  rows: { strength: number; deltaMae: number; absDeltaMae: number; leader: string; nSamples: number; runId: string; startDate: string; endDate: string }[]
  direction: 'increasing' | 'decreasing' | 'none'
  leaderStable: boolean
  elapsedMs: number
  note: string
}

export const fetchPaperMethods = () => request<PaperMethodsPayload>('/api/lab/paper/methods')

export const runPaperMethod = (payload: {
  perturbationType: 'noise' | 'missing'
  strength: number
  seed: number
  sliceKey?: 'explore' | 'consistency' | 'all'
  claim?: { text: string; source: string } | null
}) => request<{ ok: boolean; record: LabRun }>('/api/lab/paper/run', { method: 'POST', body: JSON.stringify(payload) })

export const explorePaperMethods = (payload: {
  budget: number
  perturbationType: 'noise' | 'missing'
  explorationId: string
  claim?: { text: string; source: string } | null
}) =>
  request<{
    ok: boolean
    explorationId: string
    budget: number
    used: number
    remaining: number
    stopCode: string | null
    stoppedReason: string | null
    mode: 'model' | 'rule'
    trace: ExploreTraceItem[]
    findings: LabFinding[]
    visibleSlice: string
    hiddenSlice: string
    note: string
  }>('/api/lab/paper/explore', { method: 'POST', body: JSON.stringify(payload) })

export const checkPaperConsistency = (payload: {
  perturbationType: 'noise' | 'missing'
  strengths: number[]
  seed: number
  claim?: { text: string; source: string } | null
}) => request<PaperConsistency>('/api/lab/paper/consistency', { method: 'POST', body: JSON.stringify(payload) })

/* ---------------- 核心案例：换个时间段，领先者会变吗？ ---------------- */

export interface CaseSlice {
  key: 'explore' | 'consistency'
  range: [number, number]
  dates: { start: string; end: string }
  label: string
  windows: number
  targetPoints: number
  targetIndexRange: [number, number]
  metrics: { DLinear: LabMetrics; Linear: LabMetrics }
  deltaMae: number
  leader: string
  relGap: number | null
  closeGap: boolean
  chart: { stride: number; truth: number[]; DLinear: number[]; Linear: number[] }
  slice: LabRun['slice']
  metricsSpec: { metrics: string[]; space: string; aggregation: string; nSamples: number; predLen?: number }
}

export interface LabCase {
  generatedAt: string
  caseId: string
  title: string
  weights: { DLinear: string; Linear: string }
  settings: Record<string, string | number>
  slices: { explore: CaseSlice; consistency: CaseSlice }
  reversal: boolean
  verdict: string
  caveats: string[]
  paper: { question: { text: string; note: string }; observation: { text: string; note: string }; note: string }
  rerun: { command: string; config: Record<string, unknown> }
  methodSource: Record<string, string>
  raw?: unknown
}

export const fetchReversalCase = (cached: boolean) =>
  request<{ ok: boolean; source?: 'cached' | 'fresh'; case?: LabCase; code?: string; message?: string }>(
    `/api/lab/case/reversal?cached=${cached ? 1 : 0}`,
  )

export const caseExportUrl = (format: 'md' | 'json') => `/api/lab/case/reversal/export?format=${format}`

/** 小咕的三段解释：由程序根据真实数字组织（不夸大、不编造） */
export function caseExplanations(c: LabCase) {
  const a = c.slices.explore
  const b = c.slices.consistency
  const f = (v: number) => v.toFixed(4)
  const lead = (s: CaseSlice) => (s.leader === 'DLinear' ? 'DLinear' : s.leader === 'Linear' ? 'Linear' : '两者持平')

  const whatItMeans = c.reversal
    ? `在这两个时间段上，同一对权重给出的领先方不同：探索段（${a.dates.start.slice(0, 10)} 起）是 ${lead(a)} 领先，ΔMAE ${f(a.deltaMae)}；另一时间段（${b.dates.start.slice(0, 10)} 起）是 ${lead(b)} 领先，ΔMAE ${f(b.deltaMae)}。这说明**这个比较对评估时间段敏感**：单个时间段上的领先结果不能自动推广到所有时段。这只是一对权重、一个数据集、一个预测跨度上的观察，不能扩大成对整篇论文的判决。`
    : `这两个时间段上领先方一致：都是 ${lead(a)} 领先（ΔMAE 分别为 ${f(a.deltaMae)} 与 ${f(b.deltaMae)}）。也就是说，在本次设置下**没有观察到**"换个时间段领先方就变"的现象；任何抢先的说法都应该被更正。`

  const nextChecks = [
    `两个时间段的**数据水平与波动**是否不同（探索段 OT 均值/标准差 vs 另一时间段）——这属于待验证解释，不能仅凭反转就断言原因。`,
    `反转是否集中在**少量窗口**上：把两段各 ${a.windows} 个窗口按时间分成更小的子段，看差距是否稳定（注意窗口互相重叠，不能当独立样本）。`,
    `换**其它随机种子训练的权重**再跑同样两段：如果反转消失，说明它与某一次训练的权重绑定；如果保留，说明更像数据时间段本身的性质。`,
  ]

  const carryOn = `把当前方法与权重（DLinear=\`${c.weights.DLinear}\`、Linear=\`${c.weights.Linear}\`）、指标（${a.metricsSpec.metrics.join('/')}）、两个时间段与问题带入现有有限预算探索。**注意**：接下来改变的变量是输入扰动（噪声/缺失），它和"时间段"是两个不同的变量 —— 不能把时间段变化的影响说成噪声造成的。`

  return { whatItMeans, nextChecks, carryOn }
}

/* ---------------- 结论转译器 / 发现卡 / 独立复验 ---------------- */

export interface LabTranslationPaper {
  shortLabel: string
  method: string
  datasets: string[]
  metrics: string[]
  horizons: number[]
  result: string | null
  split?: string | null
  splitRange?: string | null
  conditions?: string
  codeAvailability?: string | null
  hasRunnableImpl?: boolean
  evidence: { page: number | null; quote: string }[]
}

export interface LabTranslation {
  level: string
  levelKey: 'full' | 'partial' | 'proxy' | 'demo'
  levelReason: string
  claim: { text: string; source: string } | null
  paperConclusion: {
    text: string
    source: string
    evidence: { paper: string; page: number | null; quote: string }[]
    structured: {
      paper: string
      method: string
      datasets: string[]
      metrics: string[]
      horizons: number[]
      result: string
      split: string | null
      splitRange: string | null
    }[]
    note: string
  }
  paperExperiment: {
    method: string
    datasets: string[]
    conditions: string[]
    reported: string[]
    assets: {
      hasRunnableImpl: boolean
      codeAvailability: string[]
      missing: string[]
    }
  }
  currentExperiment: {
    methods: string[]
    methodScope: string
    data: string
    conditions: string
    sameAsPaper: string[]
    differentFromPaper: string[]
    canVerify: string[]
    cannotVerify: string[]
  }
  matrix: { dimension: string; paper: string; current: string; match: string; note: string }[]
  verdict: string
  disclaimer: string
  runsSeen: number
}

export interface LabFinding {
  id: string
  title: string
  claim: string
  methods: string[]
  segment: 'explore' | 'independent'
  segmentLabel: string
  perturbationType: string
  strength: number
  conditions: { horizon: number; seed: number; absDeltaMae: number; leader: string; nSamples: number | null }[]
  exploreCount: number
  leaderStable: boolean
  leadChanged: boolean
  monotonic: boolean
  trendDirection: 'decreasing' | 'increasing' | 'none'
  replicated: boolean
  minConclusion: string
  notExtrapolateTo: string[]
  needsIndependentReplication: boolean
}

export interface LabReplication {
  ok: boolean
  error?: string
  findingId?: string
  finding?: LabFinding
  exploreTrend?: LabFinding['conditions']
  independentTrend?: LabFinding['conditions']
  exploreDirection?: string
  independentDirection?: string
  sameDirection?: boolean
  ranCount?: number
  failedCount?: number
  conclusion?: string
  stillInsufficient?: boolean
  note?: string
}

export const translateLab = (payload: {
  papers: LabTranslationPaper[]
  claim: { text: string; source: string } | null
  config: LabConfig
  dataSource: LabDataSource | null
}) =>
  request<{ ok: boolean; card: LabTranslation; reproRequirements: string[] }>('/api/lab/translate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

export const replicateLabFinding = (payload: { findingId: string; claim: { text: string; source: string } | null }) =>
  request<LabReplication>('/api/lab/replicate', { method: 'POST', body: JSON.stringify(payload) })

export const EVIDENCE_LABEL: Record<string, string> = {
  untested: '未测试',
  'exploration-only': '仅探索发现',
  'seed-replicated': '已换种子复验',
  'independent-replicated': '已独立时间段复验',
  failed: '运行失败',
}

export const STOP_REASON_LABEL: Record<string, string> = {
  budget: '预算耗尽',
  cancelled: '用户取消',
  replicated: '发现已完成复验',
  'no-conditions': '没有新的有效实验条件',
  'consecutive-failures': '连续运行失败',
}

/* ---------------- 展示用的标签与格式化 ---------------- */

export const PERTURBATION_LABEL: Record<string, string> = {
  noise: '输入噪声强度',
  missing: '输入缺失比例',
}

export const LEADER_LABEL: Record<string, string> = {
  ridge: '岭回归误差更低',
  seasonal_naive: '季节朴素误差更低',
  tie: '两者持平',
}

export function fmt(v: number | null | undefined, digits = 4): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—'
}

/** 差距是否「较小」：阈值来自服务端（越小的相对差距越不可靠），不作统计显著性声明 */
export function gapText(run: LabRun): string {
  if (!run.comparison) return '—'
  const { leader, deltaMae, closeGap } = run.comparison
  const lead = leader === 'tie' ? '两者持平' : `${LEADER_LABEL[leader]}`
  const d = Math.abs(deltaMae).toFixed(4)
  return closeGap ? `${lead}（差距 ${d}，差距较小）` : `${lead}（差距 ${d}）`
}

export function isStaleRun(status: string): boolean {
  return status === 'running' || status === 'interrupted'
}

/** 本次配置与初始条件的差异说明（用于「与初始条件对比」） */
export function diffAgainstBase(base: LabConfig | null, now: LabConfig): string[] {
  if (!base) return []
  const out: string[] = []
  if (base.horizon !== now.horizon) out.push(`预测跨度 ${base.horizon} → ${now.horizon}`)
  if (base.perturbationType !== now.perturbationType)
    out.push(`扰动类型 ${PERTURBATION_LABEL[base.perturbationType]} → ${PERTURBATION_LABEL[now.perturbationType]}`)
  if (base.strength !== now.strength) out.push(`扰动强度 ${base.strength} → ${now.strength}`)
  if (base.seed !== now.seed) out.push(`随机种子 ${base.seed} → ${now.seed}`)
  return out
}

/** 导出实验记录（Markdown） */
export function labToMarkdown(
  runs: LabRun[],
  meta: LabMeta | null,
  claim: { text: string; source: string } | null,
  summary: LabRunsPayload['summary'] | null,
  extras: { translation?: LabTranslation | null; findings?: LabFinding[]; replication?: LabReplication | null } = {},
): string {
  const lines: string[] = []
  lines.push('# 小咕实验室 · 实验记录')
  lines.push('')
  lines.push(`- 要验证的说法：${claim ? claim.text : '（未指定）'}`)
  lines.push(`- 说法来源：${claim ? claim.source : '—'}`)
  lines.push(
    `- 方法：季节性朴素预测（seasonal_naive）与岭回归自回归（ridge）—— 代理验证/教学演示级实验，**不是 Autoformer / FEDformer / PatchTST 的复现**`,
  )
  if (meta) {
    lines.push(`- 数据：${meta.source.name}（${meta.source.kind === 'real' ? '真实公开数据' : '合成数据'}）`)
    lines.push(`  - 来源：${meta.source.url ?? meta.source.repo ?? '—'}`)
    lines.push(`  - 子集：${meta.source.column} 单变量；共 ${meta.source.rows} 点，${meta.source.start} → ${meta.source.end}，采样间隔 ${meta.source.intervalMinutes} 分钟`)
    lines.push(`  - 划分（按时间）：训练 ${meta.split.train[0]}–${meta.split.train[1]}，验证 ${meta.split.val[0]}–${meta.split.val[1]}，测试 ${meta.split.test[0]}–${meta.split.test[1]}`)
    lines.push(`  - 测试段再分：探索段 46080–51840；独立复验段 51840–69680（探索期间不可见）`)
  }

  if (extras.translation) {
    const t = extras.translation
    lines.push('')
    lines.push('## 结论转译卡')
    lines.push('')
    lines.push(`- **等级：${t.level}**（${t.levelReason}）`)
    lines.push(`- 不可外推的声明：${t.disclaimer}`)
    lines.push(`- 严格结论：${t.verdict}`)
    lines.push('')
    lines.push('### 1. 论文原始结论')
    lines.push(`- 原文说法：${t.paperConclusion.text}`)
    t.paperConclusion.evidence.forEach((e) => lines.push(`  - ${e.paper} 第 ${e.page ?? '—'} 页：${e.quote}`))
    t.paperConclusion.structured.forEach((s) =>
      lines.push(`  - 结构化整理：${s.paper}｜方法 ${s.method}｜数据集 ${s.datasets.join('/') || '—'}｜指标 ${s.metrics.join('/') || '—'}｜跨度 ${s.horizons.join('/') || '—'}｜原文结果 ${s.result}`),
    )
    lines.push(`  - 说明：${t.paperConclusion.note}`)
    lines.push('')
    lines.push('### 2. 原论文实验')
    lines.push(`- 方法：${t.paperExperiment.method}`)
    lines.push(`- 数据集：${t.paperExperiment.datasets.join(' / ') || '—'}`)
    t.paperExperiment.reported.forEach((r) => lines.push(`- ${r}`))
    lines.push(`- 是否具备可执行实现：${t.paperExperiment.assets.hasRunnableImpl ? '是' : '否'}`)
    if (!t.paperExperiment.assets.hasRunnableImpl) {
      lines.push('- 升级为复现模式所缺材料：')
      t.paperExperiment.assets.missing.forEach((m) => lines.push(`  - ${m}`))
    }
    lines.push('')
    lines.push('### 3. 当前可执行实验')
    lines.push(`- 实际运行方法：${t.currentExperiment.methods.join(' / ')}（${t.currentExperiment.methodScope}）`)
    lines.push(`- 实际数据与条件：${t.currentExperiment.data}｜${t.currentExperiment.conditions}`)
    lines.push(`- 与原论文相同：${t.currentExperiment.sameAsPaper.join('；') || '（无）'}`)
    lines.push(`- 与原论文不同：${t.currentExperiment.differentFromPaper.join('；')}`)
    lines.push(`- 能验证什么：${t.currentExperiment.canVerify.join('；')}`)
    lines.push(`- 不能验证什么：${t.currentExperiment.cannotVerify.join('；')}`)
    lines.push('')
    lines.push('### 可验证范围矩阵')
    lines.push('')
    lines.push('| 维度 | 论文原实验 | 当前实验 | 是否匹配 |')
    lines.push('| --- | --- | --- | --- |')
    t.matrix.forEach((m) => lines.push(`| ${m.dimension} | ${m.paper} | ${m.current} | ${m.match} |`))
  }

  lines.push('')
  lines.push('## 全部实验记录（不做筛选）')
  lines.push('')
  lines.push('| # | 状态 | 数据段 | 来源 | 跨度 | 扰动 | 强度 | 种子 | 样本数 | 季节朴素 MAE | 岭回归 MAE | 结论 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  runs.forEach((r, i) => {
    const sn = r.methods?.seasonal_naive?.metrics
    const rg = r.methods?.ridge?.metrics
    lines.push(
      `| ${i + 1} | ${r.status} | ${r.segment === 'independent' ? '独立复验段' : '探索段'} | ${r.origin}${r.replicatedOf ? '（复验）' : ''} | ${r.config?.horizon ?? '—'} | ${r.config?.perturbationType ?? '—'} | ${r.config?.strength ?? '—'} | ${r.config?.seed ?? '—'} | ${r.evaluation?.nSamples ?? '—'} | ${fmt(sn?.mae)} | ${fmt(rg?.mae)} | ${r.error ? `失败：${r.error}` : gapText(r)} |`,
    )
  })

  if (extras.findings && extras.findings.length > 0) {
    lines.push('')
    lines.push('## 发现卡')
    extras.findings.forEach((f) => {
      lines.push('')
      lines.push(`### ${f.title}`)
      lines.push(`- 使用的方法：${f.methods.join(' / ')}`)
      lines.push(`- 数据段：${f.segmentLabel}`)
      lines.push(`- 已测试条件：${f.conditions.map((c) => `跨度 ${c.horizon}（种子 ${c.seed}，|ΔMAE| ${c.absDeltaMae.toFixed(4)}）`).join('；')}`)
      lines.push(`- 探索次数：${f.exploreCount}`)
      lines.push(`- 是否独立复验：${f.replicated ? '已复验' : '尚未独立复验'}`)
      lines.push(`- 能支持的最小结论：${f.minConclusion}`)
      lines.push(`- 不能外推到：${f.notExtrapolateTo.join('；')}`)
    })
  }

  if (extras.replication) {
    const r = extras.replication
    lines.push('')
    lines.push('## 独立时间段复验')
    lines.push('')
    lines.push(`- 探索段趋势：${(r.exploreTrend ?? []).map((c) => `${c.horizon}:${c.absDeltaMae.toFixed(4)}`).join(' → ')}`)
    lines.push(`- 独立复验段趋势：${(r.independentTrend ?? []).map((c) => `${c.horizon}:${c.absDeltaMae.toFixed(4)}`).join(' → ')}`)
    lines.push(`- 是否同方向：${r.sameDirection ? '同方向' : '不同方向'}`)
    lines.push(`- 结论：${r.conclusion}`)
    lines.push(`- 是否仍不足以判断：${r.stillInsufficient ? '是' : '否'}`)
  }

  if (summary) {
    lines.push('')
    lines.push('## 观察与边界')
    lines.push('')
    summary.observed.forEach((o) => lines.push(`- ${o}`))
    lines.push(`- ${summary.note}`)
    lines.push(
      '- 只填观察或只勾步骤不代表假设成立；「差距较小」按公开阈值（相对差距 < 2%）判断，**不是统计显著性**。',
    )
  }
  lines.push('')
  lines.push('## 复跑配置（JSON）')
  lines.push('')
  lines.push('```json')
  lines.push(
    JSON.stringify(
      runs.map((r) => ({
        id: r.id,
        segment: r.segment ?? 'explore',
        config: r.config,
        seed: r.config?.seed,
        replicatedOf: r.replicatedOf ?? null,
      })),
      null,
      2,
    ),
  )
  lines.push('```')
  return lines.join('\n')
}
