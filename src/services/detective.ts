import { request } from '@/services/api'

/* ==================== 小咕侦探 ==================== */

export interface DetectiveEvidence {
  kind: 'paper' | 'code'
  page?: number | null
  section?: string | null
  quote?: string
  path?: string
  line?: number
  snippet?: string
  sha?: string
  url?: string
}

export interface ClueBinding {
  repo: string
  repoUrl: string
  sha: string
  license: string
  script: string
  line: number
  method: string | null
  methodDeclaredAt: { line: number; declaration: string } | null
  dataset: string | null
  task: string
  horizon: number | null
  seqLen: number | null
  status: 'script-explicit' | 'repo-default' | 'file-level'
  confirmed: boolean
  statusLabel: string
}

export interface DetectiveClue {
  id: string
  field: string
  value: string
  appliesTo: { method: string | null; dataset: string | null; task: string; horizon: number | null }
  sourceType: 'paper' | 'official-code'
  evidence: DetectiveEvidence
  /** 归属绑定：仓库版本 / 方法 / 数据集 / 任务 / 跨度 / 脚本（代码线索才有） */
  binding?: ClueBinding
  methodMatch?: { ok: boolean; requested: string | null; clueMethod: string | null; note: string }
  override?: { script: string; line: number; value: string; method: string | null; horizon: number | null; declaration: string } | null
  adoptable?: boolean
  adoptionNote?: string | null
  scope: string
  inconsistent: boolean | null
  existingValue?: string
  confidence: 'candidate' | 'cross-dataset' | 'raw-snippet' | 'confirmed'
  note?: string
}

export interface DetectiveResult {
  ok: boolean
  reason?: string
  taskId: string
  field: string
  fieldLabel: string
  mode: 'model' | 'program'
  summary: string
  clues: DetectiveClue[]
  rejected: { field?: string; value?: string; reason: string }[]
  stages: { at: number; label: string; detail: string }[]
  sourcesChecked: { kind: string; label: string; path?: string; sha?: string; url?: string; detail?: string; hit: number; failed?: boolean }[]
  nextStep: string
  limits: { maxFiles: number; maxExcerpts: number; maxBytesPerFile: number; maxTotalBytes: number; maxClues: number }
  bytesRead: number
  note: string
}

export const DETECTIVE_FIELD_LABEL: Record<string, string> = {
  learningRate: '学习率',
  batchSize: '批大小',
  epochs: '训练轮数',
  seqLen: '输入长度',
  horizon: '预测跨度',
  split: '数据划分',
  preprocessing: '预处理 / 归一化',
}

export const DETECTIVE_FIELDS = Object.keys(DETECTIVE_FIELD_LABEL)

export const runDetectiveTask = (payload: {
  fieldKey: string
  dataset?: string | null
  model?: string | null
  horizon?: number | null
  pages: { page: number; section?: string | null; text: string }[]
  fields?: Record<string, unknown>
  taskId: string
}) => request<DetectiveResult>('/api/detective/run', { method: 'POST', body: JSON.stringify(payload) })

export const cancelDetectiveTask = (taskId: string) =>
  request<{ ok: boolean; cancelled: boolean; note: string }>('/api/detective/cancel', { method: 'POST', body: JSON.stringify({ taskId }) })

/* ==================== 派生配置层（采用线索不覆盖原始抽取结果） ==================== */

export interface DerivedEntry {
  key: string
  value: string
  paperId: string
  clueId: string
  scope: string
  /** 采用性质：来自出处 / 用户选择的新设置（归属不匹配时） */
  adoptedAs: 'source' | 'user-choice'
  binding?: ClueBinding
  source:
    | { kind: 'official-code'; path: string; line: number; sha: string; url?: string }
    | { kind: 'paper'; page: number; quote: string }
  adoptedAt: string
  note?: string
}

const DERIVED_KEY = 'paper-repro-guard.derived-config.v1'

export function loadDerived(): DerivedEntry[] {
  try {
    const raw = localStorage.getItem(DERIVED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveDerived(list: DerivedEntry[]) {
  try {
    localStorage.setItem(DERIVED_KEY, JSON.stringify(list.slice(-200)))
  } catch {
    /* 存不下来不影响当前会话 */
  }
}

/** 采用一条线索：写入派生配置层，同一 (paperId,key) 只保留最新一条 */
export function adoptClue(paperId: string, clue: DetectiveClue, opts: { asUserChoice?: boolean } = {}): DerivedEntry {
  const methodMismatch = clue.methodMatch?.ok === false
  const entry: DerivedEntry = {
    key: clue.field,
    value: clue.value,
    paperId,
    clueId: clue.id,
    scope: clue.scope,
    // 归属不匹配（或用户主动选择）时标为"用户选择的新设置"，不伪装成论文/该方法的设置
    adoptedAs: opts.asUserChoice || methodMismatch ? 'user-choice' : 'source',
    binding: clue.binding,
    source:
      clue.evidence.kind === 'code'
        ? { kind: 'official-code', path: String(clue.evidence.path), line: Number(clue.evidence.line), sha: String(clue.evidence.sha), url: clue.evidence.url }
        : { kind: 'paper', page: Number(clue.evidence.page), quote: String(clue.evidence.quote || clue.value) },
    adoptedAt: new Date().toISOString(),
    note: clue.methodMatch?.ok === false ? clue.methodMatch.note : undefined,
  }
  const list = loadDerived().filter((e) => !(e.paperId === paperId && e.key === clue.field))
  list.push(entry)
  saveDerived(list)
  return entry
}

export function removeDerived(paperId: string, key: string) {
  saveDerived(loadDerived().filter((e) => !(e.paperId === paperId && e.key === key)))
}

export function derivedFor(paperId: string, key?: string): DerivedEntry[] {
  return loadDerived().filter((e) => e.paperId === paperId && (!key || e.key === key))
}

export function describeDerivedSource(e: DerivedEntry): string {
  return e.source.kind === 'official-code'
    ? `官方代码 ${e.source.path}:${e.source.line}（提交 ${e.source.sha.slice(0, 8)}）`
    : `论文第 ${e.source.page} 页原文`
}

/* ==================== 论文对撞台 ==================== */

export interface ClashSide {
  paper: string
  statement: string
  evidence: { page: number; quote: string; verbatim?: boolean }[]
  conditions: Record<string, string | null>
  methods?: string[]
}

export interface ClashCard {
  id: string
  dimension: string
  question: string
  sideA: ClashSide
  sideB: ClashSide
  keyCondition: string
  relation: {
    code: 'performanceDifference' | 'reportValueMismatch' | 'claimConflict' | 'comparabilityPending'
    label: string
  }
  relationLabelNote?: string
  relationReason: string
  nextStep: string
  actions: string[]
  detectiveField?: string
  detectivePaper?: string
  signals?: { numericGap: number | null; worthChecking: boolean; verbatimEvidence: boolean }
}

export const buildClash = (papers: unknown[], maxCards = 3) =>
  request<{
    ok: boolean
    reason?: string
    cards: ClashCard[]
    note: string
    checked: number
    diagnostics: Record<string, unknown>[]
    skipped: { pair: string; reason: string }[]
    labSupport: { supported: boolean; scope: string; label: string }
  }>('/api/clash/build', { method: 'POST', body: JSON.stringify({ papers, maxCards }) })

/* ==================== 挑战模式（只给条件，不给结果） ==================== */

export interface ChallengeSetup {
  ok: boolean
  caseId: string
  title: string
  question: string
  weights: { DLinear: string | null; Linear: string | null }
  settings: Record<string, string | number>
  slices: Record<'explore' | 'consistency', { range: [number, number]; dates: { start: string; end: string }; label: string }>
  note: string
}

export const fetchChallengeSetup = () => request<ChallengeSetup>('/api/lab/case/reversal/setup')
