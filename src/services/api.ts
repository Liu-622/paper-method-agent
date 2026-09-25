import type { ClaimSource, FieldKey, PageText, Coverage, SupportLevel, PaperField, ResearchDirection } from '@/types'

/**
 * 后端接口客户端
 * ------------------------------------------------------------------
 * 真实抽取与真实问答都在后端完成（模型密钥只存在于后端）。
 * 后端地址的解析顺序：
 *   1. 运行时可配置（localStorage，界面上可以填，部署静态站点时用它指向自己的后端）
 *   2. 构建时注入的 VITE_API_BASE
 *   3. 同源（'' → 相对路径 /api/...，本地单进程运行时就是这种情况）
 */

const BACKEND_URL_KEY = 'paper-repro-guard.backendUrl'
const BACKEND_TOKEN_KEY = 'paper-repro-guard.backendToken'

export function getBackendUrl(): string {
  try {
    const saved = window.localStorage.getItem(BACKEND_URL_KEY)
    if (saved) return saved.replace(/\/+$/, '')
  } catch {
    /* ignore */
  }
  const fromEnv = (import.meta.env.VITE_API_BASE as string | undefined) || ''
  return fromEnv.replace(/\/+$/, '')
}

export function setBackendUrl(url: string): void {
  try {
    if (url.trim()) window.localStorage.setItem(BACKEND_URL_KEY, url.trim().replace(/\/+$/, ''))
    else window.localStorage.removeItem(BACKEND_URL_KEY)
  } catch {
    /* ignore */
  }
}

export function getAccessToken(): string {
  try {
    const saved = window.localStorage.getItem(BACKEND_TOKEN_KEY)
    if (saved) return saved
  } catch {
    /* ignore */
  }
  // 构建时注入的口令：部署到静态托管时可以一起烧进产物，避免使用者手动填
  return ((import.meta.env.VITE_API_TOKEN as string | undefined) || '').trim()
}

export function setAccessToken(token: string): void {
  try {
    if (token.trim()) window.localStorage.setItem(BACKEND_TOKEN_KEY, token.trim())
    else window.localStorage.removeItem(BACKEND_TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export function isSameOrigin(): boolean {
  return getBackendUrl() === ''
}

export interface BackendError {
  code: string
  message: string
  detail?: string
  status?: number
}

export class ApiError extends Error {
  info: BackendError
  constructor(info: BackendError) {
    super(info.message)
    this.name = 'ApiError'
    this.info = info
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getBackendUrl()
  const url = `${base}${path}`
  const token = getAccessToken()
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-access-token': token } : {}),
        ...(init?.headers || {}),
      },
    })
  } catch (e) {
    throw new ApiError({
      code: 'NETWORK',
      message: `连不上后端服务（${url}）。请确认后端已启动，或在上方填写正确的后端地址。`,
      detail: e instanceof Error ? e.message : String(e),
    })
  }

  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new ApiError({
      code: 'BAD_RESPONSE',
      message: isSameOrigin()
        ? '当前站点只有静态文件，没有后端接口 —— 字段抽取与问答需要后端调用模型。请在左下角「运行设置」里填写你自己的后端地址（启动方式：node server/index.mjs，或把 server/ 部署到任意 Node 托管）。'
        : '这个地址返回的不是 JSON，请确认它指向的是本项目的后端服务。',
      detail: text.slice(0, 200),
      status: res.status,
    })
  }

  if (!res.ok) {
    const info = (data || {}) as BackendError
    throw new ApiError({
      code: info.code || 'HTTP_ERROR',
      message: info.message || `后端返回 ${res.status}`,
      detail: info.detail,
      status: res.status,
    })
  }

  return data as T
}

export interface HealthResult {
  ok: boolean
  model: string
  apiStyle: string
  baseUrlHost: string
  hasCredentials: boolean
  requiresAccessToken: boolean
  capabilities: {
    realPdfParsing: boolean
    realLlmExtract: boolean
    realLlmQa: boolean
  }
}

export function fetchHealth(): Promise<HealthResult> {
  return request<HealthResult>('/api/health', { method: 'GET' })
}

export interface ExtractResult {
  ok: boolean
  fields: Record<
    string,
    {
      status: 'found' | 'uncertain' | 'missing'
      value: string | null
      evidence: { page: number; quote: string }[]
      note?: string
      /** 第二步复核：原文片段是否真的支持这个取值 */
      support?: SupportLevel
      supportReason?: string
      /** 因原文不支持而被撤回的模型原始取值 */
      withdrawnValue?: string | null
      withdrawnReason?: string
      /** 这一项是怎么得出结论的（direct / retrieval / not_reported / unchecked） */
      checkState?: 'direct' | 'retrieval' | 'not_reported' | 'unchecked'
      recoveredBy?: 'retrieval'
      /** 按数据集分别保存的取值 */
      perDataset?: PaperField['perDataset']
    }
  >
  warnings: string[]
  pagesUsed: number[]
  truncated: boolean
  /** 页面处理覆盖情况（用于区分「未找到」与「未检查」） */
  coverage?: Coverage
  elapsedMs: number
  pagesReceived: number
}

export function requestExtract(input: {
  fileName: string
  title: string
  pages: PageText[]
}): Promise<ExtractResult> {
  return request<ExtractResult>('/api/extract', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export interface RecheckResult {
  ok: boolean
  key?: string
  status?: 'found' | 'uncertain' | 'missing'
  value?: string | null
  evidence?: { page: number; quote: string }[]
  note?: string
  checkedPages?: number
  candidateCount?: number
  searched?: { page: number; text: string }[]
  elapsedMs?: number
  code?: string
  message?: string
}

/**
 * 方法分析结果（/api/analyze 返回）的单个条目。
 *
 * 四个判断维度必须分开看，不能互相替代：
 *  - citationLocated  引文定位（程序判定）：原句是否真的在对应论文、对应页里。
 *  - attribution      归属（模型判定）：本文采用 / 相关工作 / 基线 / 未来设想。
 *  - semanticSupport  语义支持（模型批量复核）：原句是否支持这个标签或关系。
 *  - manualStatus     人工状态：只能来自用户操作，接口不会返回。
 *
 * 界面请直接使用程序推导的 `verdict`，不要自己用 citationLocated 拼结论 ——
 * 「引用存在」不等于「引用支持结论」。
 */
export type AnalyzeVerdict = 'paper-supported' | 'pending' | 'excluded' | 'unlocated' | 'unsupported'

export interface AnalyzeItem {
  label?: string
  text?: string
  target?: string
  change?: string
  quote?: string
  page?: number
  attribution?: 'used' | 'discussed' | 'baseline' | 'future' | null
  type?: 'cites' | 'improves' | 'baseline'
  /** 维度一 · 引文定位（程序） */
  citationLocated?: boolean
  locatedPage?: number | null
  citationReason?: string
  /** 维度三 · 语义支持（模型批量复核） */
  semanticSupport?: 'supported' | 'unsupported' | 'ambiguous' | 'unchecked'
  semanticReason?: string
  /** 关系条目的结构校验：原句里是否真的出现了目标方法名 */
  objectMentioned?: boolean
  relationReason?: string
  /** 程序推导的组合结论，界面直接用这个 */
  verdict?: AnalyzeVerdict
  verdictReason?: string
  reviewedAt?: string
  /** 兼容旧缓存数据 */
  verbatim?: boolean
  support?: 'verbatim' | 'unlocated'
  supportReason?: string
}

export interface AnalyzeResult {
  ok: boolean
  fileName?: string
  title?: string
  ownMethod?: string | null
  researchProblem?: string | null
  authorClaim?: string | null
  family?: AnalyzeItem[]
  mechanisms?: AnalyzeItem[]
  tasks?: AnalyzeItem[]
  differences?: AnalyzeItem[]
  limitations?: AnalyzeItem[]
  futureWork?: AnalyzeItem[]
  relations?: AnalyzeItem[]
  /** 各类结论的数量统计（程序按 verdict 汇总） */
  verdictStats?: Record<string, number>
  /** 本次是否真的跑过语义复核；为 false 时不得把任何条目显示成「原文支持」 */
  semanticReviewRan?: boolean
  /** 分析流程版本，用于缓存失效判断 */
  analysisPipeline?: string
  elapsedMs?: number
  code?: string
  message?: string
}

/** 论文方法分析（模型 + 服务端逐字校验） */
export function requestAnalyze(input: {
  fileName: string
  title: string
  pages: PageText[]
  hint?: string
  signal?: AbortSignal
}): Promise<AnalyzeResult> {
  return request<AnalyzeResult>('/api/analyze', {
    method: 'POST',
    body: JSON.stringify({ fileName: input.fileName, title: input.title, pages: input.pages, hint: input.hint }),
    signal: input.signal,
  })
}

export interface DirectionSynthesisResult {
  ok: boolean
  directions: Array<{
    id: string
    question?: string
    hypothesis?: string
    minimalExperiment?: ResearchDirection['minimalExperiment']
    judgment?: string
    prerequisites?: string[]
    unsupportedSteps?: string[]
    resources?: string
    boundary?: string
    recommendReason?: string
    generationNote?: string
  }>
  generatedAt?: string
}

/**
 * 用模型把已核验来源对应成具体实验方案。来源类型、论文 ID、引文、案例版本
 * 不由模型返回，调用方必须保留原值并再次执行本地适配检查。
 */
export function requestDirectionSynthesis(input: {
  domain: string
  papers: Array<{
    id: string
    label: string
    method?: string | null
    researchProblem?: string | null
    authorClaim?: string | null
    limitations?: string[]
    futureWork?: string[]
  }>
  directions: ResearchDirection[]
}): Promise<DirectionSynthesisResult> {
  return request<DirectionSynthesisResult>('/api/directions/synthesize', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** 单字段补查：只针对一个字段做定向全文检索 + 引用校验 */
export function requestRecheckField(input: {
  fileName: string
  title: string
  pages: PageText[]
  key: string
}): Promise<RecheckResult> {
  return request<RecheckResult>('/api/recheck-field', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export interface AskApiCitation {
  paperId: string
  paperTitle: string
  shortLabel: string
  page: number
  quote: string
  evidenceId: string
}

export interface AskApiClaim {
  id: string
  kind: 'paragraph' | 'bullet'
  text: string
  support: SupportLevel
  reason: string
  evidenceIds: string[]
  source?: ClaimSource | 'suggestion'
  /** 系统事实是否与程序状态一致 */
  systemOk?: boolean
  /** 规则推导类结论的依据：必须带规则编号（表示规则是程序真的执行过的） */
  derivation?: {
    ruleId: string
    ruleName: string
    scope?: string | null
    inputs: { key: string; label: string; value: string; paperLabel: string; evidenceIds?: string[] }[]
    rule: string
    result: string
  }
}

export interface AskApiResult {
  ok: boolean
  paragraphs: string[]
  bullets: string[]
  citations: AskApiCitation[]
  /** 逐条结论的来源与支持判定 */
  claims?: AskApiClaim[]
  /** 因为找不到原文支持而被撤回的论文事实类结论 */
  withdrawn?: { text: string; reason: string }[]
  /** 被降级为「建议 / 待验证」的模型推论（没有对应的、程序执行过的规则） */
  suggestions?: { text: string; reason: string }[]
  insufficient: boolean
  warnings: string[]
  elapsedMs: number
  papersUsed: { id: string; shortLabel: string; pages: number }[]
}

export function requestAsk(input: {
  question: string
  papers: { id: string; shortLabel: string; title: string; pages: PageText[] }[]
  /** 本地检查结果等上下文，让模型能直接引用「规则推导」类结论 */
  context?: {
    paperCount?: number
    datasetScope?: string | null
    checks?: {
      id: string
      key?: string
      label?: string
      /** 规则编号：只有程序真的执行过的规则才有 */
      ruleId?: string
      ruleName?: string
      scope?: string | null
      verdict?: string
      verdictText?: string
      reason?: string
      perPaper?: { paperId: string; label: string; value: string | null; evidenceIds?: string[] }[]
    }[]
  }
}): Promise<AskApiResult> {
  return request<AskApiResult>('/api/ask', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** 后端返回的字段键名与前端 FieldKey 对齐校验 */
export function isKnownField(key: string): key is FieldKey {
  return [
    'researchProblem',
    'method',
    'dataset',
    'split',
    'splitRange',
    'sampleInterval',
    'horizon',
    'metrics',
    'baselines',
    'conclusion',
    'limitations',
    'evalProtocol',
    'preprocessing',
    'learningRate',
    'optimizer',
    'randomSeed',
    'epochs',
    'batchSize',
    'params',
    'codeAvailability',
  ].includes(key)
}
