/**
 * 全局数据模型定义
 *
 * 设计原则：
 * - 论文内容一律以「字段 + 原文片段 + PDF 页码」的三角结构存储，
 *   这样后面的实验检查和问答都能直接引用出处，不需要重新解析。
 * - 演示数据（source === 'demo'）与用户上传数据（source === 'user'）严格区分，
 *   界面上任何地方都不会把演示内容当成用户文件的分析结果。
 */

/** 论文来源：演示数据 / 用户上传 / 内置公开文献清单 */
export type PaperSource = 'demo' | 'user' | 'catalog'

/** 论文处理状态 */
export type PaperStatus =
  | 'pending'
  | 'parsing'
  | 'extracting'
  | 'parsed'
  /** 正文已读取，但字段还没抽出来（未连接后端或抽取失败） */
  | 'text-only'
  | 'failed'

/**
 * 字段状态：
 *  - found 已找到：有明确原文依据
 *  - missing 未找到：**检索过**相关页面后确认论文没有写
 *  - unchecked 未检查：有页面没有被处理（正文被截断、页面解析不出文字），
 *    因此不能声称"论文没写" —— 这是与 missing 必须区分开的诚实状态
 *  - uncertain 需要确认：论文写了但表述不足以确定取值
 */
export type FieldStatus = 'found' | 'missing' | 'unchecked' | 'uncertain'

/**
 * 结论的支持情况（引用文字存在 ≠ 原文支持这个结论）。
 *
 * 三类结论的证明方式完全不同，绝不能混在一起判定：
 *  - system 系统事实：当前选择了几篇论文、选了哪个数据集、有没有正文……
 *    由**程序状态**直接证明，不需要论文引用，也不能因为"论文里没写这句话"而被撤回。
 *  - rule 规则推导：由**本地确定性规则**推出，必须能指回一个**程序真的执行过**的规则编号
 *    （输入字段 → 规则 → 结果），同样不要求论文原文直接写出这句结论。
 *  - suggestion 建议 / 待验证：**模型自己提出的推论**。它可能对，但没有被任何规则或原文验证过，
 *    因此不能显示成"规则推导"，只能作为待验证的建议。
 *  - full / partial / none / unchecked：论文事实，必须有原文依据并通过引用支持度校验。
 */
export type SupportLevel = 'full' | 'partial' | 'none' | 'unchecked' | 'system' | 'rule' | 'suggestion'

/** 结论来源：论文事实 / 系统事实 / 规则推导 */
export type ClaimSource = 'paper' | 'system' | 'rule'

/** 字段来源：论文抽取 / 用户人工修正 */
export type FieldOrigin = 'paper' | 'user'

/** 可抽取字段的键 */
export type FieldKey =
  // —— 论文概况（详情页卡片） ——
  | 'researchProblem'
  | 'method'
  | 'dataset'
  | 'split'
  | 'splitRange'
  | 'sampleInterval'
  | 'horizon'
  | 'metrics'
  | 'baselines'
  | 'conclusion'
  | 'limitations'
  // —— 实验协议 ——
  | 'evalProtocol'
  | 'preprocessing'
  // —— 复现缺项相关 ——
  | 'learningRate'
  | 'optimizer'
  | 'randomSeed'
  | 'epochs'
  | 'batchSize'
  | 'params'
  | 'codeAvailability'

/** 字段所属分组，用于页面分区渲染 */
export type FieldGroup = 'overview' | 'experiment' | 'repro'

/** 原文片段（证据） */
export interface Evidence {
  id: string
  paperId: string
  /** PDF 页序号，1 起 */
  page: number
  /** 章节号 + 章节名，例如 "4.1 实验设置" */
  section: string
  /** 原文片段（英文原文，保持与论文一致，便于对照） */
  text: string
  /** 可选：中文速览，帮助用户快速理解片段含义 */
  gloss?: string
  /** 片段来源：真实 PDF 抽取 / 演示数据 / 人工补充 */
  source?: 'pdf' | 'demo' | 'manual'
}

/** 单个字段的抽取结果 */
export interface PaperField {
  key: FieldKey
  /** 当前生效的值；未找到且无人补充时为 null */
  value: string | null
  status: FieldStatus
  origin: FieldOrigin
  evidenceIds: string[]
  /** 抽取说明 / 为什么标记为需要确认 */
  note?: string
  /**
   * 这一项是怎么得出结论的（三态区分，避免把"漏抽"说成"原文没写"）：
   *  - direct        第一次抽取就命中
   *  - retrieval     第一次没命中，按关键词做定向全文检索后找回（**属于初次漏抽**）
   *  - not_reported  定向全文检索也没找到依据 → 原文没有报告
   *  - unchecked     有页面没有可读文本，这一项没法检查（不等于原文没写）
   */
  checkState?: 'direct' | 'retrieval' | 'not_reported' | 'unchecked'
  /** 集合型字段：是否找到了"用于实验"的表述（false → 界面按「已有线索，需确认」显示） */
  usageOk?: boolean
  /** 按数据集分别保存的取值（dataset / split / sampleInterval） */
  perDataset?: {
    overall: string | null
    perDataset: { dataset: string; value: string; page?: number | null }[]
    scoped: boolean
    note: string | null
  }
  /**
   * 原文片段是否真的支持这个取值（第二步复核的结果）。
   * full=明确支持；partial=只支持一部分；none=不支持（会被撤回）；unchecked=这一步没跑成功。
   */
  support?: SupportLevel
  /** 支持判定的理由（缺什么、支持到什么程度） */
  supportReason?: string
  /** 因为原文不支持而被撤回的模型原始取值（保留下来便于用户核对） */
  withdrawnValue?: string | null
  withdrawnReason?: string
  /**
   * 用户人工补充之前，论文里抽取到的原始记录。
   * 保留它才能做到「原始抽取值和证据不被覆盖」。
   */
  extracted?: {
    value: string | null
    status: FieldStatus
    evidenceIds: string[]
    note?: string
  }
}

/** 论文的页面处理覆盖情况：哪些页真的被"看过" */
export interface Coverage {
  totalPages: number
  /** 真正送进模型、被检查过的页码 */
  usedPages: number[]
  /** 因为正文超长被丢弃的页码（这些页没有被检查） */
  skippedPages: number[]
  /** 抽不到文字的页码（扫描图 / 字体缺失，这些页也没有被检查） */
  emptyPages: number[]
}

/** 论文正文（按页） */
export interface PageText {
  page: number
  text: string
}

/** 一篇论文 */
export interface Paper {
  id: string
  source: PaperSource
  /** 论文短标号，用于表格与检查理由中的稳定引用，例如 P1 / U2 */
  shortLabel: string
  /** 原始文件名；演示论文也会给出一个虚拟文件名 */
  fileName: string
  /** 文件字节数，演示论文为 null */
  fileSize: number | null
  fileLastModified: number | null
  title: string
  authors: string
  year: number | null
  venue: string
  status: PaperStatus
  /** 上传时间 ISO 字符串 */
  uploadedAt: string
  /** 状态补充说明，例如「待解析，功能接入中」 */
  parseMessage?: string
  /** 字段抽取结果，按 key 索引 */
  fields: Partial<Record<FieldKey, PaperField>>
  /* —— 真实解析相关（真实论文才有） —— */
  /** PDF 页数 */
  pageCount?: number
  /** 抽到的正文字符数 */
  textChars?: number
  /** 正文是否已持久化到本地（受浏览器存储上限限制） */
  textStored?: boolean
  /** 上传的原文件是否已保存到本地（IndexedDB），用于刷新后免重新选文件 */
  fileStored?: boolean
  /** 原文件字节内容指纹（用于跨集合去重；只看文件名/大小不可靠） */
  fileFingerprint?: string
  /** 原文件保存失败的原因（隐私模式 / 配额不足等），界面会如实展示 */
  fileStoreError?: string
  /** 解析失败原因（扫描件 / 加密 / 损坏等） */
  parseError?: string
  /** 字段抽取时间 */
  extractedAt?: string
  /**
   * 产出这份结果的「分析版本」（见 config.ANALYSIS_VERSION）。
   * 缺失或落后 → 界面提示「可更新分析」，由用户主动重新分析，**不会后台自动重抽**。
   */
  analysisVersion?: number
  /** 抽取过程中的提示（引用被剔除、正文被截断等） */
  extractWarnings?: string[]
  /** 页面处理覆盖情况：用于区分「检索后未找到」与「尚未检查」 */
  coverage?: Coverage
}

/* ------------------------------------------------------------------ */
/* 检查结果                                                            */
/* ------------------------------------------------------------------ */

/** 公平性检查结论 */
export type FairnessVerdict = 'consistent' | 'different' | 'insufficient'

/**
 * 复现缺项检查结论
 *  - found 已找到
 *  - missing 未找到：正文页面都检查过，确认没写
 *  - unchecked 未检查：还有页面没有被处理，不能下「没写」的结论
 *  - need_confirm 需要确认：论文写了但表述不足
 *  - manual 人工补充：论文没写、由使用者补上
 */
export type ReproVerdict = 'found' | 'missing' | 'unchecked' | 'need_confirm' | 'manual'

/** 某篇论文在某个检查项上的取值 */
export interface CheckPerPaper {
  paperId: string
  paperTitle: string
  /** 展示用原始值 */
  value: string | null
  /** 归一化后的比较值（用于程序判等） */
  normalized: string
  status: FieldStatus
  origin: FieldOrigin
  evidenceIds: string[]
  /** 该论文尚未解析时为 true */
  unparsed?: boolean
  /** 该项由多个字段合成比较时，附带的补充说明（例如划分区间、采样间隔、预测时长） */
  extra?: string
  /** 人工补充前的原始抽取值，用于如实展示 */
  extractedValue?: string | null
}

/** 实验公平性检查项 */
export interface FairnessItem {
  id: string
  label: string
  /** 该项关注的字段 */
  key: FieldKey
  /** 参与比较的字段（复合项会有多个） */
  keys: FieldKey[]
  verdict: FairnessVerdict
  /** 判断理由（程序生成，说明具体差在哪） */
  reason: string
  /** 为什么这个条件会影响可比性 */
  whyItMatters: string
  perPaper: CheckPerPaper[]
  /** 该项是否引入了人工补充的值 */
  hasManualInput?: boolean
  /** 本次比较限定的共同数据集口径（null = 按论文整体口径） */
  scope?: string | null
  /** 产出该判定的规则编号（规则必须是程序真的执行过的，见 src/data/rules.ts） */
  ruleId?: string
  /**
   * 「已知 + 部分未知」：判定基于**能读到的那些论文**得出，同时还有若干篇待核对。
   * 界面必须同时展示"已发现的差异/一致"与"另 N 篇待核对"，不能让未知值盖掉已知结论。
   */
  partial?: boolean
  pendingPaperLabels?: string[]
}

/** 复现缺项检查项 */
export interface ReproItem {
  id: string
  label: string
  key: FieldKey
  verdict: ReproVerdict
  /** 判断理由 */
  reason: string
  /** 缺失/需确认时对复现的影响 */
  impact: string
  perPaper: CheckPerPaper[]
  /** 该项是否引入了人工补充的值 */
  hasManualInput?: boolean
  /** 产出该判定的规则编号（规则必须是程序真的执行过的，见 src/data/rules.ts） */
  ruleId?: string
}

/* ------------------------------------------------------------------ */
/* 问答                                                                */
/* ------------------------------------------------------------------ */

export type QaStatus = 'answered' | 'unsupported' | 'failed'

export interface QaCitation {
  evidenceId: string
  paperId: string
  paperTitle: string
  page: number
  section: string
  text: string
  /** 引用来源：论文原文片段可核对 / 演示片段 / 人工补充的字段 */
  source?: 'pdf' | 'demo' | 'manual'
}

export interface QaAnswer {
  id: string
  question: string
  status: QaStatus
  /** 生成方式：本轮为本地规则生成，接入模型后改为 'llm' */
  mode: 'demo-rule' | 'llm'
  /** 正文段落 */
  paragraphs: string[]
  /** 要点列表 */
  bullets: string[]
  citations: QaCitation[]
  /**
   * 逐条结论的支持判定（引用文字存在 ≠ 原文支持这条结论）。
   * 支持为 none 的结论不会出现在 paragraphs/bullets 里，而是被撤回。
   */
  claims?: QaClaim[]
  /** 因为找不到原文支持而被撤回的结论 */
  withdrawn?: { text: string; reason: string }[]
  /** 提示信息，例如「尚未接入模型」 */
  notice?: string
  /** 回答基于的论文 */
  paperIds: string[]
  createdAt: string
}

/** 一条结论（段落或要点）及其原文支持情况 */
export interface QaClaim {
  id: string
  kind: 'paragraph' | 'bullet'
  text: string
  support: SupportLevel
  reason: string
  /** 支持这条结论的证据 id（可在引用列表里高亮） */
  evidenceIds: string[]
  /** 结论来源：论文事实 / 系统事实 / 规则推导 / 建议待验证 */
  source?: ClaimSource | 'suggestion'
  /**
   * 规则推导类结论的依据。**必须带 ruleId** ——
   * 只有程序实际执行过的规则才有编号；没有编号的推论会被降级为「建议 / 待验证」。
   */
  derivation?: {
    ruleId: string
    ruleName: string
    scope?: string | null
    inputs: { key: string; label: string; value: string; paperLabel: string; evidenceIds?: string[] }[]
    rule: string
    result: string
  }
}

/**
 * 结构化实验记录：一篇论文在一个数据集上的一条实验设置。
 * 选定共同数据集后，比较的就是**记录与记录**，而不是临时裁剪整段文本。
 */
export interface ExperimentRecord {
  paperId: string
  /** 数据集名（论文里的原始写法） */
  dataset: string
  split: string | null
  testRange: string | null
  sampleInterval: string | null
  horizon: string | null
  metrics: string[]
  preprocessing: string | null
  /** 这条记录里每个字段的证据 id（合并去重） */
  evidenceIds: string[]
  /** 记录完整度：complete 关键项齐全 / partial 部分缺 / insufficient 基本没读到 */
  status: 'complete' | 'partial' | 'insufficient'
  /** 逐字段的读取状态，便于界面解释 */
  fieldStatus: Partial<Record<FieldKey, FieldStatus>>
  /** 这条记录来自哪个口径（论文按数据集分别说明 / 全局设置） */
  scopeNote?: string
}

/* ------------------------------------------------------------------ */
/* 界面辅助类型                                                        */
/* ------------------------------------------------------------------ */

export interface Toast {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
}

/** 演示项目 / 我的论文库 */
export type ProjectScope = 'demo' | 'user'

export interface UploadIssue {
  fileName: string
  type: 'rejected-format' | 'rejected-size' | 'duplicate' | 'empty'
  message: string
}

/* ------------------------------------------------------------------ */
/* 最小验证实验计划（按用户资源生成，见 services/planner.ts）           */
/* ------------------------------------------------------------------ */

export type DeviceKind = 'cpu' | 'gpu1' | 'custom'
export type TimeBudget = '1h' | '1d' | '3d' | '1w'
export type PlanGoal = 'pipeline' | 'single-claim' | 'fairness'
export type DataReadiness = 'ready' | 'partial' | 'none'
export type ExperimentStatus = 'not_started' | 'running' | 'to_confirm' | 'done'

export interface ResourceProfile {
  device: DeviceKind
  deviceNote: string
  timeBudget: TimeBudget
  goal: PlanGoal
  dataset: string | null
  riskIds: string[]
  codeUrl: string
  codeReady: DataReadiness
  dataReady: DataReadiness
}

/** 计划里的一项参数：必须标明来源；论文没写清楚的一律是 unconfirmed */
export interface PlanValue {
  label: string
  value: string
  source: 'paper' | 'tool' | 'unconfirmed'
  field?: FieldKey
  evidenceIds?: string[]
  note?: string
}

export interface PlanStep {
  id: string
  text: string
  done: boolean
}

export interface VerificationExperiment {
  id: string
  priority: number
  title: string
  question: string
  whyPriority: string
  relatedRiskIds: string[]
  relatedRiskLabels: string[]
  relatedEvidence: { field: FieldKey; label: string; page: number | null; quote: string }[]
  values: PlanValue[]
  prepare: { data: string[]; code: string[]; env: string[] }
  steps: PlanStep[]
  keepConstant: string[]
  variables: string[]
  metrics: string[]
  supportIf: string[]
  refuteIf: string[]
  stopIf: string[]
  scaleNote: string
  pending: string[]
}

export interface VerificationPlan {
  id: string
  createdAt: string
  profile: ResourceProfile
  dataset: string | null
  paperLabels: string[]
  experiments: VerificationExperiment[]
  /** 暂不适合本轮的任务（资源/数据/代码不满足），单独列出而不是塞进实验里 */
  deferredTasks?: { title: string; reason: string }[]
  ruleIds: string[]
  noResultsYet: boolean
}

export interface ExperimentProgress {
  status: ExperimentStatus
  steps: Record<string, boolean>
  actualResult: string
  observation: string
}

export interface RiskOption {
  id: string
  /** 对应的字段名（如 split / sampleInterval / randomSeed），用于选择任务模板 */
  key: string
  label: string
  detail: string
  kind: 'fairness' | 'repro'
  ruleId: string
  verdictText: string
  perPaper: CheckPerPaper[]
}

/* ==================================================================
 * 研究集合 / 方法分类 / 演进 / 研究方向（赛题四项能力）
 * ------------------------------------------------------------------
 * 用稳定 ID 关联，不依赖列表下标；来源区分「原文 / 工具推断 / 人工」；
 * 重新分析不静默覆盖人工修正。
 * ================================================================== */

/** 文献集合：复用现有 Paper 对象，只保存 ID 列表，不复制论文内容 */
export interface Collection {
  id: string
  name: string
  /** 领域，例如 时间序列预测 */
  domain: string
  paperIds: string[]
  updatedAt: string
}

/** 单篇论文的批量解析任务状态（队列阶段，用户可理解） */
export type ParseStage = 'queued' | 'reading' | 'extracting' | 'verifying' | 'done' | 'failed' | 'cancelled' | 'partial'

export interface ParseJob {
  paperId: string
  stage: ParseStage
  /** 阶段补充说明（失败原因 / 部分完成说明） */
  note?: string
  startedAt?: string
}

/** 方法分类：分维度、可解释、来源区分 */
export type ClassifyOrigin = 'paper' | 'inferred' | 'catalog' | 'manual'
export type ClassifyStatus = 'confirmed' | 'pending' | 'unsupported'

export interface ClassificationTag {
  /** 规范化标签名，例如 Transformer / 序列分解 / 长时预测 */
  label: string
  /** 适用的方法或实验范围，例如 DLinear（本文方法） */
  scope: string
  origin: ClassifyOrigin
  status: ClassifyStatus
  /** 证据：页码或内置清单来源 */
  evidenceIds: string[]
  reason: string
  pendingReason?: string
  /* —— 四个独立判断，必须分开保存，不能互相替代 —— */
  /** 维度二 · 归属：原句讲的是本文采用 / 相关工作 / 基线 / 未来设想 */
  attribution?: 'used' | 'discussed' | 'baseline' | 'future'
  /** 维度一 · 引文定位：原句是否逐字定位到对应论文页（程序判定，只回答"这句话在不在"） */
  quoteLocated?: boolean
  /** 维度三 · 语义支持：原句是否支持该标签（模型批量复核判定） */
  semanticSupport?: 'supported' | 'unsupported' | 'ambiguous' | 'unchecked'
  /** 语义复核的具体说明；存在歧义时这里给出具体原因，而不是统一降为"待确认" */
  semanticReason?: string
  /** 程序推导的组合结论（界面直接用这个，不要自己用 quoteLocated 拼） */
  verdict?: 'paper-supported' | 'pending' | 'excluded' | 'unlocated' | 'unsupported'
  /** 维度四 · 人工状态：用户是否审核/修改（只有用户操作才会置位，程序与模型都不得写入） */
  manualStatus?: 'confirmed' | 'edited'
  /** 归一化前的原始表述（模型自由文本），保留不覆盖 */
  rawLabel?: string
  /** 标签归一化状态：mapped = 命中统一词表；unmapped = 无法可靠映射，保留原表述 */
  normStatus?: 'mapped' | 'unmapped'
}

export interface MethodProfile {
  paperId: string
  /** 本文提出的 / 研究的方法（不是对比基线） */
  ownMethod: string | null
  family: ClassificationTag[]
  mechanisms: ClassificationTag[]
  tasks: ClassificationTag[]
  generatedAt: string
  analysisVersion: number
  /* —— 技术档案（模型 /api/analyze 产出，供地图/演进/方向共用） —— */
  analyzedBy?: 'model' | 'rule'
  analyzedAt?: string
  researchProblem?: string | null
  authorClaim?: string | null
  differences?: {
    target: string
    change: string
    quote?: string
    page?: number
    attribution?: string
    quoteLocated?: boolean
    semanticSupport?: string
    semanticReason?: string
    verdict?: string
    verdictReason?: string
  }[]
  limitations?: {
    text: string
    quote?: string
    page?: number
    attribution?: string
    quoteLocated?: boolean
    semanticSupport?: string
    semanticReason?: string
    verdict?: string
    verdictReason?: string
  }[]
  futureWork?: {
    text: string
    quote?: string
    page?: number
    quoteLocated?: boolean
    semanticSupport?: string
    semanticReason?: string
    verdict?: string
    verdictReason?: string
  }[]
  /** 正文提到、但非本文采用（相关工作/基线/未来设想），用于证明"没有误归入本文方法" */
  excluded?: {
    label: string
    attribution: string
    quote?: string
    page?: number
    verbatim?: boolean
    semanticReason?: string
  }[]
  /** 本次分析是否真的跑过语义复核；为 false 时不得把任何条目显示成「原文支持」 */
  semanticReviewRan?: boolean
  /** 分析流程版本（用于缓存失效判断） */
  analysisPipeline?: string
}

/** 论文关系（图连线） */
export type RelationType = 'shared-mechanism' | 'cites' | 'improves'
export type RelationReview = 'confirmed' | 'candidate'

export interface PaperRelation {
  id: string
  from: string
  to: string
  type: RelationType
  /** 有方向：引用/改进为有向，共享机制为无向 */
  directed: boolean
  evidenceIds: string[]
  generatedBy: 'program' | 'model' | 'manual'
  review: RelationReview
  reason: string
  /* —— 关系的三重校验：只找到两个方法名不足以确认引用/改进/继承 —— */
  /** 引文定位（程序）：原句是否逐字出现在论文里 */
  quoteLocated?: boolean
  /** 结构校验（程序）：原句里是否真的出现了目标方法名 */
  objectMentioned?: boolean
  /** 语义支持（模型批量复核）：原句是否支持「本文 → 目标方法 + 该关系类型」 */
  semanticSupport?: 'supported' | 'unsupported' | 'ambiguous' | 'unchecked'
  /** 用户是否人工确认过这条关系（只能由用户操作置位） */
  manualStatus?: 'confirmed' | 'edited'
}

/** 研究方向（建议卡） */
export type DirectionSource = 'author-future' | 'limitation-derived' | 'synthesis' | 'case-extension' | 'user-idea'

/** 实验适配检查的可操作程度（不代表假设成立） */
export type DirectionFitness = 'ready' | 'missing-prerequisite' | 'not-supported'

export interface ResearchDirection {
  id: string
  /** prep = 资料与复现准备任务；research = 候选研究方向（可检验问题） */
  kind: 'prep' | 'research'
  question: string
  sourceType: DirectionSource
  /** 依据：哪几篇论文、哪些原句/实验设置（evidenceIds 与相关论文） */
  evidenceIds: string[]
  relatedPaperIds: string[]
  /** 方向生成所依据的可见来源；论文引文和实验案例分开保存，模型不得改写 */
  sourceClaims?: {
    kind: 'paper-quote' | 'lab-case'
    paperId?: string
    page?: number
    quote: string
    verified: boolean
  }[]
  reasoning: string
  hypothesis: string
  /** 最小实验：对照 / 变量 / 固定条件 / 数据 / 指标 */
  minimalExperiment: {
    baseline: string
    variable: string
    fixed: string
    dataset: string
    metrics: string[]
  }
  /** 结果如何解释（支持 / 不支持假设的判断方式） */
  judgment?: string
  /** 进入实验前需要补齐的前置任务与材料 */
  prerequisites?: string[]
  /** 当前工具无法执行、需要导出方案的步骤 */
  unsupportedSteps?: string[]
  /** 实验适配检查结果：可进入准备 / 缺少必要前提 / 当前工具不能执行 */
  fitness?: {
    /** 兼容旧界面的汇总状态 */
    status: DirectionFitness
    missing: string[]
    note: string
    /** 研究设计本身是否具备必要数据、变量定义与比较条件 */
    research?: { status: 'ready' | 'missing-prerequisite'; missing: string[]; note: string }
    /** 当前产品是否已经接入执行所需的方法、权重与配置 */
    execution?: { status: 'runnable' | 'external-required'; missing: string[]; note: string }
  }
  resources: string
  boundary: string
  recommendReason: string
  /** 生成时的来源版本（论文内容指纹/分析版本），进入验证计划时用于追溯 */
  sourceVersion?: string
  /** 建议的生成方式；模型失败时明确降级为规则建议 */
  proposalMode?: 'model' | 'rule'
  generationNote?: string
  /** case-extension 的版本化来源，不能用写死数字代替 */
  caseSource?: {
    caseId: string
    generatedAt: string
    weights: Record<string, string>
    settings: Record<string, string | number>
    observed: string
  }
  /** 用户编辑版本（覆盖原建议但保留原建议可回看） */
  edited?: boolean
  original?: { question: string; reasoning: string; hypothesis: string }
  generatedAt: string
}

/** 分析记录：一次集合分析的覆盖情况 */
export interface AnalysisRecord {
  id: string
  collectionId: string
  inputPaperIds: string[]
  coveredPaperIds: string[]
  failedPaperIds: string[]
  skippedPaperIds: string[]
  generatedAt: string
  analysisVersion: number
}

/** 方法地图里的节点（论文）简影 */
export interface MapNode {
  paperId: string
  shortLabel: string
  title: string
  year: number | null
  family: string[]
  mechanisms: string[]
  ownMethod: string | null
  classified: boolean
}
