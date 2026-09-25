import type {
  Collection,
  Evidence,
  ExperimentProgress,
  MethodProfile,
  PageText,
  Paper,
  PaperRelation,
  QaAnswer,
  ProjectScope,
  ResearchDirection,
  AnalysisRecord,
  VerificationPlan,
} from '@/types'
import type { AnalysisProvenance, CollectionStamp } from '@/services/analysisCache'
import { STORAGE_KEY } from '@/config'

/**
 * 本地持久化（localStorage 部分）
 * ------------------------------------------------------------------
 * localStorage 只放**文本类**数据；PDF 二进制放不下，那部分交给 IndexedDB
 * （见 services/filestore.ts）。这里保存：
 *  - 解析出的正文文本（按页，带页码）—— 字段、证据与问答都依赖它
 *  - 论文条目（文件名、大小、上传时间、状态）
 *  - 字段的抽取结果与人工补充（含原始抽取值）
 *  - 选择状态、问答历史、界面偏好
 *
 * 上传的原文件存在 IndexedDB，因此刷新后可以直接用原文件重新解析，
 * 不需要让用户再选一次文件。
 */

export interface PersistedState {
  version: 1
  papers: Paper[]
  evidence: Evidence[]
  /** 解析出的正文文本，按 paperId 保存（受浏览器存储上限约束） */
  texts: Record<string, PageText[]>
  scope: ProjectScope
  demoLoaded: boolean
  selectedIds: string[]
  compareIds: string[]
  /** 公平性比较的数据集口径（null = 按论文整体口径） */
  datasetScope?: string | null
  /** 最小验证实验计划（就地编辑，随工作区保存） */
  verificationPlan?: VerificationPlan | null
  /** 每个实验的进度与用户记录的结果（key = 实验 id） */
  planProgress?: Record<string, ExperimentProgress>
  qaHistory: QaAnswer[]
  activeQuestion: string
  simulateQaFailure: boolean
  uploadSeq: number
  /* —— 研究集合 / 方法分类 / 演进 / 方向（赛题四项能力） —— */
  collections?: Collection[]
  currentCollectionId?: string | null
  methodProfiles?: Record<string, MethodProfile>
  relations?: PaperRelation[]
  directions?: ResearchDirection[]
  analyses?: AnalysisRecord[]
  /** 单篇分析来源记录（内容指纹 + 分析版本 + 模型标识），供缓存失效判断 */
  analysisProvenance?: Record<string, AnalysisProvenance>
  /** 集合级产物（关系/方向/演进）的生成记录，供「集合成员变化后需更新」判断 */
  collectionStamps?: Record<string, CollectionStamp>
}

export function loadState(): PersistedState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedState
    if (!parsed || parsed.version !== 1) return null
    if (!Array.isArray(parsed.papers)) return null
    if (!parsed.texts || typeof parsed.texts !== 'object') parsed.texts = {}
    return parsed
  } catch {
    return null
  }
}

let saveTimer: number | null = null
let pendingState: PersistedState | null = null

function flushState(): void {
  if (!pendingState) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingState))
    pendingState = null
  } catch {
    // Keep the pending snapshot so a subsequent save can retry.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushState)
}

export function saveState(state: PersistedState): void {
  pendingState = state
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flushState, 250)
}

export function clearState(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  pendingState = null
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
