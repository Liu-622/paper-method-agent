import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react'
import type {
  AnalysisRecord,
  ClassificationTag,
  Collection,
  Evidence,
  ExperimentProgress,
  FieldKey,
  FieldStatus,
  MethodProfile,
  PageText,
  Paper,
  PaperField,
  PaperRelation,
  ProjectScope,
  QaAnswer,
  ResearchDirection,
  Toast,
  UploadIssue,
  VerificationPlan,
} from '@/types'
import { classifyPapers, buildRelations, deriveDirections, fitResearchDirection, makeAnalysisRecord, buildMapNodes, buildTimeline, evolutionSummary, collectionSummary, type LabCaseExtension } from '@/services/collection'
import { TS_CATALOG } from '@/data/catalog'
import { cloneDemoEvidence, cloneDemoPapers, EVIDENCE_BY_ID } from '@/data/demoData'
import { FIELD_META, FIELD_ORDER } from '@/data/fieldSchema'
import { ANALYSIS_VERSION, CAPABILITIES } from '@/config'
import { clearState, loadState, saveState, type PersistedState } from '@/services/storage'
import { createPendingPaper, requestParseNote, validateFiles, type UploadMeta } from '@/services/parser'
import { extractPdfPages, PdfParseError } from '@/services/pdf'
import {
  clearOriginalFiles,
  loadOriginalFile,
  removeOriginalFile,
  saveOriginalFile,
} from '@/services/filestore'
import { ApiError, fetchHealth, requestExtract, requestRecheckField, requestAnalyze, requestDirectionSynthesis, type HealthResult, type AnalyzeResult, type AnalyzeItem } from '@/services/api'
import { fetchReversalCase } from '@/services/lab'
import { normalizeLabel } from '@/services/labelNorm'
import {
  ANALYSIS_PIPELINE_VERSION,
  fingerprintText,
  fingerprintBytes,
  modelIdOf,
  planAnalysis,
  stalenessOf,
  membershipFingerprint,
  collectionStampStale,
  COLLECTION_ARTIFACT_VERSION,
  type AnalysisProvenance,
  type CollectionStamp,
  type AnalysisMode,
} from '@/services/analysisCache'

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export const MAX_SELECTION = 3
/** 正文本地存储预算（字符），超出后按时间从旧到新丢弃，并如实标记 */
export const TEXT_BUDGET_CHARS = 2_400_000

interface EvidenceDrawerState {
  open: boolean
  title: string
  subtitle: string
  items: Evidence[]
  unresolvedIds: string[]
  note?: string
}

/** 右侧面板里的侦探目标：只存"哪篇论文的哪个字段"，其余信息在面板内从论文对象派生 */
export interface DetectiveCtx {
  paperId: string
  fieldKey: string
  /** 观点卡跳过来时携带的问题说明 */
  from?: string
}

export interface BackendState {
  status: 'unknown' | 'checking' | 'ok' | 'error'
  health?: HealthResult
  error?: string
  checkedAt?: string
}

export interface AppState extends PersistedState {
  toasts: Toast[]
  evidenceDrawer: EvidenceDrawerState
  /** 右侧上下文面板里的侦探任务（由字段行/观点卡的「找线索」发起） */
  detective: DetectiveCtx | null
  busyPaperIds: string[]
  /* —— 研究集合（覆盖 PersistedState 的可选声明为必选） —— */
  collections: Collection[]
  currentCollectionId: string | null
  methodProfiles: Record<string, MethodProfile>
  relations: PaperRelation[]
  directions: ResearchDirection[]
  analyses: AnalysisRecord[]
  /** 单篇分析来源记录（内容指纹 + 分析版本 + 模型标识） */
  analysisProvenance: Record<string, AnalysisProvenance>
  /** 集合级产物生成记录（关系/方向/演进是否过期） */
  collectionStamps: Record<string, CollectionStamp>
  /**
   * 从对比页/检查页「加入验证计划」带过来的草稿（不持久化）：
   * 计划页据此预填论文、数据集口径与要重点核对的风险项，并显示"来自哪个问题"。
   */
  planDraft: {
    fromProblem: string
    paperIds: string[]
    dataset: string | null
    riskId?: string
    fieldKey?: string
    fieldKeys?: string[]
    riskIds?: string[]
    /** 从研究方向卡进入时携带的完整方向（问题/假设/证据/实验设计），计划页据此预填，不能只带标题 */
    direction?: ResearchDirection
    createdAt: string
  } | null
  /** 对比/检查页选中的问题（差异或待核对项），不持久化 */
  pickedProblems: string[]
  /** 「加入验证计划」之前的状态快照，供撤销 */
  planUndoBefore: {
    planDraft: AppState['planDraft']
    datasetScope: string | null | undefined
    verificationPlan: VerificationPlan | null | undefined
    planProgress: Record<string, ExperimentProgress>
  } | null
  /** 正在解析的进度：paperId -> {done,total,stage} */
  progress: Record<string, { done: number; total: number; stage: string }>
  backend: BackendState
  /** 能力开关：只有在真实接通并成功跑过一次之后才会打开 */
  caps: {
    realPdfParsing: boolean
    realLlmExtract: boolean
    realLlmQa: boolean
    /** 上传原文件是否成功写入本地（IndexedDB） */
    persistOriginalFile: boolean
  }
}

const emptyDrawer: EvidenceDrawerState = {
  open: false,
  title: '',
  subtitle: '',
  items: [],
  unresolvedIds: [],
}

function initialState(): AppState {
  const persisted = loadState()
  const base: PersistedState = persisted ?? {
    version: 1,
    papers: [],
    evidence: [],
    texts: {},
    scope: 'user',
    demoLoaded: false,
    selectedIds: [],
    compareIds: [],
    datasetScope: null,
    verificationPlan: null,
    planProgress: {},
    qaHistory: [],
    activeQuestion: '',
    simulateQaFailure: false,
    uploadSeq: 0,
    collections: [],
    currentCollectionId: null,
    methodProfiles: {},
    relations: [],
    directions: [],
    analyses: [],
  }
  // 兼容旧存档：补齐缺失的集合字段，不丢已有论文
  base.collections = base.collections ?? []
  base.currentCollectionId = base.currentCollectionId ?? null
  base.methodProfiles = base.methodProfiles ?? {}
  base.relations = base.relations ?? []
  base.directions = base.directions ?? []
  base.analyses = base.analyses ?? []
  base.analysisProvenance = base.analysisProvenance ?? {}
  base.collectionStamps = base.collectionStamps ?? {}
  // 跨刷新恢复：刷新前还停留在「读取/抽取」的论文，重置为「处理中断，可继续」，
  // 不假装任务还在后台运行；点「继续未完成项」只处理这些剩余项。
  base.papers = (base.papers ?? []).map((p) =>
    p.status === 'parsing' || p.status === 'extracting'
      ? { ...p, status: 'pending' as const, parseMessage: '处理中断（刷新前未完成），可继续' }
      : p,
  )
  // 能力开关：根据「历史上真正成功过的痕迹」还原，而不是一刷新就归零
  const userPapers = base.papers.filter((p) => p.source === 'user')
  const pdfDone = userPapers.some((p) => (p.pageCount ?? 0) > 0 && p.textStored)
  const extractDone = userPapers.some(
    (p) => p.status === 'parsed' && Object.values(p.fields).some((f) => f?.origin === 'paper'),
  )
  const qaDone = base.qaHistory.some((a) => a.status === 'answered' && a.mode === 'llm')
  const fileDone = userPapers.some((p) => p.fileStored)

  return {
    ...base,
    collections: base.collections ?? [],
    currentCollectionId: base.currentCollectionId ?? null,
    methodProfiles: base.methodProfiles ?? {},
    relations: base.relations ?? [],
    directions: base.directions ?? [],
    analyses: base.analyses ?? [],
    analysisProvenance: base.analysisProvenance ?? {},
    collectionStamps: base.collectionStamps ?? {},
    toasts: [],
    evidenceDrawer: emptyDrawer,
    detective: null,
    busyPaperIds: [],
    progress: {},
    planDraft: null,
    pickedProblems: [],
    planUndoBefore: null,
    backend: { status: 'unknown' },
    caps: {
      realPdfParsing: pdfDone || CAPABILITIES.realPdfParsing,
      realLlmExtract: extractDone,
      realLlmQa: qaDone,
      persistOriginalFile: fileDone,
    },
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

type Action =
  | { type: 'LOAD_DEMO' }
  | { type: 'ADD_PAPERS'; papers: Paper[] }
  | { type: 'PATCH_PAPER'; id: string; patch: Partial<Paper> }
  | { type: 'REMOVE_PAPER'; id: string }
  | { type: 'SET_TEXT'; paperId: string; pages: PageText[]; stored: boolean }
  | { type: 'DROP_TEXT'; paperId: string }
  | { type: 'SET_EVIDENCE'; paperId: string; items: Evidence[] }
  | { type: 'SET_FIELDS'; paperId: string; fields: Partial<Record<FieldKey, PaperField>>; keepUserFields?: boolean }
  | {
      type: 'UPDATE_FIELD'
      paperId: string
      key: FieldKey
      value: string | null
      status: FieldStatus
    }
  | { type: 'RESET_FIELD'; paperId: string; key: FieldKey }
  | { type: 'SET_UPLOAD_SEQ'; seq: number }
  | { type: 'TOGGLE_SELECT'; id: string }
  | { type: 'SET_SELECT'; ids: string[] }
  | { type: 'CLEAR_SELECT' }
  | { type: 'SET_SCOPE'; scope: ProjectScope }
  | { type: 'PUSH_QA'; answer: QaAnswer }
  | { type: 'CLEAR_QA' }
  | { type: 'SET_ACTIVE_QUESTION'; question: string }
  | { type: 'TOGGLE_SIMULATE_FAILURE' }
  | { type: 'SET_PROGRESS'; paperId: string; value: { done: number; total: number; stage: string } | null }
  /** 公平性比较的数据集口径（共同数据集） */
  | { type: 'SET_DATASET_SCOPE'; dataset: string | null }
  /**
   * 从对比页「加入验证计划」带过来的草稿：论文、数据集口径、要重点核对的风险项。
   * 计划页读它来预填条件，并显示"来自哪个问题"，用户不用重新选一遍。
   */
  | {
      type: 'SET_PLAN_DRAFT'
      draft: {
        fromProblem: string
        paperIds: string[]
        dataset: string | null
        riskId?: string
        fieldKey?: string
        fieldKeys?: string[]
        riskIds?: string[]
        /** 从研究方向卡进入时携带的完整方向 */
        direction?: ResearchDirection
        createdAt: string
      } | null
    }
  | { type: 'CLEAR_PLAN_DRAFT' }
  /** 撤销「加入验证计划」：把计划、进度、数据集口径恢复到加入之前，且不动用户已记录的结果 */
  | { type: 'UNDO_PLAN_ADD' }
  /** 对比/检查页选中的"问题"（差异或待核对项）；底部悬浮栏据此显示操作 */
  | { type: 'TOGGLE_PROBLEM'; id: string }
  | { type: 'SET_PROBLEMS'; ids: string[] }
  | { type: 'CLEAR_PROBLEMS' }
  /** 生成/替换最小验证实验计划 */
  | { type: 'SET_VERIFICATION_PLAN'; plan: VerificationPlan }
  /** 更新某个实验的进度、勾选与用户记录 */
  | { type: 'SET_PLAN_PROGRESS'; expId: string; progress: ExperimentProgress }
  | { type: 'CLEAR_PLAN_PROGRESS' }
  /** 忙状态用增/删动作，避免批量处理时互相覆盖（读旧快照会把已完成的论文重新加回去） */
  | { type: 'BUSY_ADD'; id: string }
  | { type: 'BUSY_REMOVE'; id: string }
  | {
      type: 'SET_PROGRESS'
      paperId: string
      value: { done: number; total: number; stage: string } | null
    }
  | { type: 'SET_BACKEND'; backend: BackendState }
  | { type: 'SET_CAPS'; patch: Partial<AppState['caps']> }
  | { type: 'TOAST_PUSH'; toast: Toast }
  | { type: 'TOAST_DISMISS'; id: string }
  | {
      type: 'OPEN_EVIDENCE'
      title: string
      subtitle: string
      items: Evidence[]
      unresolvedIds: string[]
      note?: string
    }
  | { type: 'CLOSE_EVIDENCE' }
  | { type: 'OPEN_DETECTIVE'; ctx: DetectiveCtx }
  | { type: 'CLOSE_DETECTIVE' }
  /* —— 研究集合 / 分类 / 演进 / 方向 —— */
  | { type: 'SET_CURRENT_COLLECTION'; id: string | null }
  | { type: 'COLLECTION_UPSERT'; collection: Collection }
  | { type: 'COLLECTION_DELETE'; id: string }
  | { type: 'COLLECTION_ADD_PAPERS'; id: string; paperIds: string[] }
  | { type: 'COLLECTION_REMOVE_PAPER'; id: string; paperId: string }
  | { type: 'SET_METHOD_PROFILES'; profiles: Record<string, MethodProfile> }
  | { type: 'SET_RELATIONS'; relations: PaperRelation[] }
  | { type: 'SET_DIRECTIONS'; directions: ResearchDirection[] }
  | { type: 'SET_PROVENANCE'; paperId: string; provenance: AnalysisProvenance }
  | { type: 'COLLECTION_STAMP_DIRTY'; collectionId: string }
  | { type: 'DIRECTION_UPSERT'; direction: ResearchDirection }
  | { type: 'DIRECTION_DELETE'; id: string }
  | { type: 'ANALYSIS_ADD'; record: AnalysisRecord }
  | { type: 'PAPERS_ADD'; papers: Paper[] }
  | { type: 'RESET_ALL' }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'LOAD_DEMO': {
      if (state.demoLoaded) return { ...state, scope: 'demo' }
      return {
        ...state,
        demoLoaded: true,
        scope: 'demo',
        papers: [...state.papers, ...cloneDemoPapers()],
        evidence: [
          ...state.evidence,
          ...cloneDemoEvidence().map((e) => ({ ...e, source: 'demo' as const })),
        ],
      }
    }
    case 'ADD_PAPERS':
      return { ...state, papers: [...state.papers, ...action.papers] }
    case 'PATCH_PAPER':
      return {
        ...state,
        papers: state.papers.map((p) => (p.id === action.id ? { ...p, ...action.patch } : p)),
      }
    case 'REMOVE_PAPER':
      return {
        ...state,
        papers: state.papers.filter((p) => p.id !== action.id),
        selectedIds: state.selectedIds.filter((id) => id !== action.id),
        evidence: state.evidence.filter((e) => e.paperId !== action.id),
      }
    case 'SET_TEXT': {
      const texts = { ...state.texts }
      if (action.stored) texts[action.paperId] = action.pages
      else delete texts[action.paperId]
      return { ...state, texts }
    }
    case 'DROP_TEXT': {
      const texts = { ...state.texts }
      delete texts[action.paperId]
      return { ...state, texts }
    }
    case 'SET_EVIDENCE':
      return {
        ...state,
        evidence: [
          ...state.evidence.filter((e) => e.paperId !== action.paperId),
          ...action.items,
        ],
      }
    case 'SET_FIELDS':
      return {
        ...state,
        papers: state.papers.map((p) => {
          if (p.id !== action.paperId) return p
          // 重新分析/补查时**不覆盖人工修改过的字段**（人工值必须保留并继续标注「已修正」）
          if (!action.keepUserFields) return { ...p, fields: action.fields }
          const merged: Record<string, PaperField> = { ...action.fields }
          for (const [k, f] of Object.entries(p.fields)) {
            if (f?.origin === 'user') merged[k] = f
          }
          return { ...p, fields: merged as typeof p.fields }
        }),
      }
    case 'UPDATE_FIELD': {
      return {
        ...state,
        papers: state.papers.map((paper) => {
          if (paper.id !== action.paperId) return paper
          const prev = paper.fields[action.key]
          // 首次人工补充时，把论文原始抽取值与证据完整保留下来
          const extracted =
            prev?.origin === 'user'
              ? prev.extracted
              : {
                  value: prev?.value ?? null,
                  status: (prev?.status ?? 'missing') as FieldStatus,
                  evidenceIds: prev?.evidenceIds ?? [],
                  note: prev?.note,
                }
          return {
            ...paper,
            fields: {
              ...paper.fields,
              [action.key]: {
                key: action.key,
                value: action.value,
                status: action.status,
                origin: 'user',
                evidenceIds: prev?.evidenceIds ?? [],
                note: prev?.note,
                extracted,
              },
            },
          }
        }),
      }
    }
    case 'RESET_FIELD': {
      const original = cloneDemoPapers().find((p) => p.id === action.paperId)?.fields[action.key]
      return {
        ...state,
        papers: state.papers.map((paper) => {
          if (paper.id !== action.paperId) return paper
          const field = paper.fields[action.key]
          if (field?.extracted) {
            // 真实论文：还原到论文原始抽取值
            return {
              ...paper,
              fields: {
                ...paper.fields,
                [action.key]: {
                  key: action.key,
                  value: field.extracted.value,
                  status: field.extracted.status,
                  origin: 'paper',
                  evidenceIds: field.extracted.evidenceIds,
                  note: field.extracted.note,
                },
              },
            }
          }
          if (original) {
            return { ...paper, fields: { ...paper.fields, [action.key]: { ...original } } }
          }
          return paper
        }),
      }
    }
    case 'SET_UPLOAD_SEQ':
      return { ...state, uploadSeq: action.seq }
    case 'TOGGLE_SELECT': {
      const exists = state.selectedIds.includes(action.id)
      if (exists) {
        return { ...state, selectedIds: state.selectedIds.filter((id) => id !== action.id) }
      }
      if (state.selectedIds.length >= MAX_SELECTION) {
        return {
          ...state,
          toasts: [
            ...state.toasts,
            {
              id: `t-${Date.now()}`,
              type: 'warning',
              message: `最多同时选择 ${MAX_SELECTION} 篇论文`,
              detail: '先取消一篇再添加，避免对比表过于拥挤。',
            },
          ],
        }
      }
      return { ...state, selectedIds: [...state.selectedIds, action.id], pickedProblems: [] }
    }
    case 'SET_SELECT':
      return { ...state, selectedIds: action.ids.slice(0, MAX_SELECTION), pickedProblems: [] }
    case 'CLEAR_SELECT':
      return { ...state, selectedIds: [], pickedProblems: [] }
    case 'SET_SCOPE':
      // 只有真正切换项目时才清空选择；否则「上传文件」这类动作会把你已经选好的对比集合清掉
      if (state.scope === action.scope) return state
      return { ...state, scope: action.scope, selectedIds: [], datasetScope: null, pickedProblems: [] }
    case 'SET_DATASET_SCOPE':
      return state.datasetScope === action.dataset ? state : { ...state, datasetScope: action.dataset, pickedProblems: [] }
    case 'SET_PLAN_DRAFT':
      // 记录"加入之前"的状态，供真正撤销用（不覆盖用户已记录的结果：planProgress 原样快照）
      return {
        ...state,
        planUndoBefore: {
          planDraft: state.planDraft,
          datasetScope: state.datasetScope,
          verificationPlan: state.verificationPlan,
          planProgress: state.planProgress ?? {},
        },
        planDraft: action.draft,
      }
    case 'CLEAR_PLAN_DRAFT':
      return { ...state, planDraft: null }
    case 'UNDO_PLAN_ADD': {
      if (!state.planUndoBefore) return { ...state, planDraft: null }
      const snap = state.planUndoBefore
      return {
        ...state,
        planDraft: snap.planDraft ?? null,
        datasetScope: snap.datasetScope ?? null,
        verificationPlan: snap.verificationPlan ?? null,
        planProgress: snap.planProgress ?? {},
        planUndoBefore: null,
      }
    }
    case 'TOGGLE_PROBLEM': {
      const has = state.pickedProblems.includes(action.id)
      return {
        ...state,
        pickedProblems: has
          ? state.pickedProblems.filter((x) => x !== action.id)
          : [...state.pickedProblems, action.id],
      }
    }
    case 'SET_PROBLEMS':
      return { ...state, pickedProblems: action.ids }
    case 'CLEAR_PROBLEMS':
      return { ...state, pickedProblems: [] }
    case 'SET_VERIFICATION_PLAN':
      return { ...state, verificationPlan: action.plan }
    case 'SET_PLAN_PROGRESS': {
      const next = { ...(state.planProgress ?? {}) }
      next[action.expId] = action.progress
      // 有任何用户记录时，计划就不再是"没有结果"的状态
      const anyResult = Object.values(next).some((p) => p.actualResult.trim())
      const plan = state.verificationPlan
        ? { ...state.verificationPlan, noResultsYet: !anyResult }
        : state.verificationPlan
      return { ...state, planProgress: next, verificationPlan: plan ?? null }
    }
    case 'CLEAR_PLAN_PROGRESS':
      return { ...state, planProgress: {} }
    case 'PUSH_QA':
      return { ...state, qaHistory: [action.answer, ...state.qaHistory].slice(0, 30) }
    case 'CLEAR_QA':
      return { ...state, qaHistory: [], activeQuestion: '' }
    case 'SET_ACTIVE_QUESTION':
      return { ...state, activeQuestion: action.question }
    case 'TOGGLE_SIMULATE_FAILURE':
      return { ...state, simulateQaFailure: !state.simulateQaFailure }
    case 'BUSY_ADD':
      return state.busyPaperIds.includes(action.id)
        ? state
        : { ...state, busyPaperIds: [...state.busyPaperIds, action.id] }
    case 'BUSY_REMOVE':
      return { ...state, busyPaperIds: state.busyPaperIds.filter((id) => id !== action.id) }
    case 'SET_PROGRESS': {
      const progress = { ...state.progress }
      if (action.value) progress[action.paperId] = action.value
      else delete progress[action.paperId]
      return { ...state, progress }
    }
    case 'SET_BACKEND':
      return { ...state, backend: action.backend }
    case 'SET_CAPS':
      return { ...state, caps: { ...state.caps, ...action.patch } }
    case 'TOAST_PUSH':
      return { ...state, toasts: [...state.toasts, action.toast].slice(-4) }
    case 'TOAST_DISMISS':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'OPEN_EVIDENCE':
      return {
        ...state,
        evidenceDrawer: {
          open: true,
          title: action.title,
          subtitle: action.subtitle,
          items: action.items,
          unresolvedIds: action.unresolvedIds,
          note: action.note,
        },
      }
    case 'CLOSE_EVIDENCE':
      return { ...state, evidenceDrawer: { ...state.evidenceDrawer, open: false } }
    case 'OPEN_DETECTIVE':
      return { ...state, detective: action.ctx }
    case 'CLOSE_DETECTIVE':
      return { ...state, detective: null }
    /* —— 研究集合 / 分类 / 演进 / 方向 —— */
    case 'PAPERS_ADD': {
      // upsert：新增论文追加；已存在论文用新值覆盖（用于分析方法完成后更新状态/版本）
      const existing = new Map(state.papers.map((p) => [p.id, p]))
      for (const p of action.papers) existing.set(p.id, { ...existing.get(p.id), ...p })
      return { ...state, papers: [...existing.values()] }
    }
    case 'SET_CURRENT_COLLECTION':
      return { ...state, currentCollectionId: action.id }
    case 'COLLECTION_UPSERT': {
      const rest = state.collections.filter((c) => c.id !== action.collection.id)
      return { ...state, collections: [...rest, { ...action.collection, updatedAt: new Date().toISOString() }] }
    }
    case 'COLLECTION_DELETE':
      return {
        ...state,
        collections: state.collections.filter((c) => c.id !== action.id),
        currentCollectionId: state.currentCollectionId === action.id ? null : state.currentCollectionId,
      }
    case 'COLLECTION_ADD_PAPERS': {
      const cols = state.collections.map((c) => {
        if (c.id !== action.id) return c
        const set = new Set(c.paperIds)
        action.paperIds.forEach((id) => set.add(id))
        return { ...c, paperIds: [...set], updatedAt: new Date().toISOString() }
      })
      return { ...state, collections: cols }
    }
    case 'COLLECTION_REMOVE_PAPER': {
      const cols = state.collections.map((c) =>
        c.id === action.id ? { ...c, paperIds: c.paperIds.filter((id) => id !== action.paperId), updatedAt: new Date().toISOString() } : c,
      )
      return { ...state, collections: cols }
    }
    case 'SET_METHOD_PROFILES':
      return { ...state, methodProfiles: action.profiles }
    case 'SET_RELATIONS':
      return { ...state, relations: action.relations }
    case 'SET_DIRECTIONS':
      return { ...state, directions: action.directions }
    case 'SET_PROVENANCE':
      return { ...state, analysisProvenance: { ...state.analysisProvenance, [action.paperId]: action.provenance } }
    case 'COLLECTION_STAMP_DIRTY':
      return { ...state, collectionStamps: { ...state.collectionStamps, [action.collectionId]: { ...(state.collectionStamps[action.collectionId] ?? {}), artifactVersion: '', generatedAt: new Date().toISOString() } as CollectionStamp } }
    case 'DIRECTION_UPSERT': {
      const rest = state.directions.filter((d) => d.id !== action.direction.id)
      return { ...state, directions: [...rest, action.direction] }
    }
    case 'DIRECTION_DELETE':
      return { ...state, directions: state.directions.filter((d) => d.id !== action.id) }
    case 'ANALYSIS_ADD':
      return { ...state, analyses: [...state.analyses.filter((a) => a.collectionId !== action.record.collectionId), action.record] }
    case 'RESET_ALL':
      clearState()
      return { ...initialState() }
    default:
      return state
  }
}

/* ------------------------------------------------------------------ */
/* Context                                                             */
/* ------------------------------------------------------------------ */

interface AppContextValue {
  state: AppState
  dispatch: React.Dispatch<Action>
  scopedPapers: Paper[]
  selectedPapers: Paper[]
  evidenceMap: Record<string, Evidence>
  /** 只保留真正有正文本地存储的论文 */
  pagesOf: (paperId: string) => PageText[] | undefined
  toast: (type: Toast['type'], message: string, detail?: string) => void
  loadDemo: () => void
  switchScope: (scope: ProjectScope) => void
  uploadFiles: (files: File[]) => Promise<UploadIssue[]>
  reextract: (paperId: string, file?: File) => Promise<void>
  /**
   * 单字段补查：只对这一个字段做定向全文检索 + 引用校验。
   * 返回 null 表示没跑成（正文不在本地 / 请求失败），此时**保留原有取值**。
   */
  recheckOneField: (
    paper: Paper,
    key: FieldKey,
  ) => Promise<{ status: 'found' | 'uncertain' | 'missing'; value: string | null; note?: string } | null>
  /** 删除论文：同时清掉本地保存的原文件与正文 */
  removePaper: (paperId: string) => void
  /** 重置全部本地数据：同时清掉 IndexedDB 里的原文件 */
  resetAll: () => void
  /** 设置公平性比较的数据集口径（null = 按论文整体口径） */
  setDatasetScope: (dataset: string | null) => void
  checkBackend: () => Promise<HealthResult | null>
  openEvidence: (title: string, subtitle: string, evidenceIds: string[]) => void
  /** 打开右侧面板的侦探（不自动运行） */
  openDetective: (ctx: DetectiveCtx) => void
  closeDetective: () => void
  openEvidenceItems: (
    title: string,
    subtitle: string,
    items: Evidence[],
    note?: string,
  ) => void
  /* —— 研究集合 / 分类 / 演进 / 方向 —— */
  currentCollection: Collection | null
  collectionPapers: Paper[]
  importCatalog: () => string[]
  createCollection: (name: string, domain?: string) => Collection
  renameCollection: (id: string, name: string) => void
  deleteCollection: (id: string) => void
  addPapersToCollection: (id: string, paperIds: string[]) => void
  removePaperFromCollection: (id: string, paperId: string) => void
  bootstrapTsCollection: () => string
  runCollectionAnalysis: (collectionId: string) => void
  generateDirections: (collectionId: string) => Promise<number>
  importCatalogPages: () => Promise<number>
  analyzeCollectionPapers: (collectionId: string, mode?: AnalysisMode) => Promise<{ done: number; failed: number; skipped: number; cancelled: boolean }>
  cancelAnalysis: () => void
  editDirection: (dir: ResearchDirection) => void
  deleteDirection: (id: string) => void
  /** 当前集合的分析缓存状态：每篇论文的 staleness + 集合级产物是否过期 */
  collectionAnalysisStatus: () => { perPaper: { paper: Paper; staleness: string }[]; counts: Record<string, number>; stampStale: boolean } | null
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  /* 持久化（排除临时状态；集合与分析产物必须落盘，否则刷新即丢） */
  useEffect(() => {
    saveState({
      version: 1,
      papers: state.papers,
      evidence: state.evidence,
      texts: state.texts,
      scope: state.scope,
      demoLoaded: state.demoLoaded,
      selectedIds: state.selectedIds,
      compareIds: state.compareIds,
      datasetScope: state.datasetScope ?? null,
      verificationPlan: state.verificationPlan ?? null,
      planProgress: state.planProgress ?? {},
      qaHistory: state.qaHistory,
      activeQuestion: state.activeQuestion,
      simulateQaFailure: state.simulateQaFailure,
      uploadSeq: state.uploadSeq,
      collections: state.collections,
      currentCollectionId: state.currentCollectionId ?? null,
      methodProfiles: state.methodProfiles,
      relations: state.relations,
      directions: state.directions,
      analyses: state.analyses,
      analysisProvenance: state.analysisProvenance,
      collectionStamps: state.collectionStamps,
    })
  }, [
    state.papers,
    state.evidence,
    state.texts,
    state.scope,
    state.demoLoaded,
    state.selectedIds,
    state.compareIds,
    state.datasetScope,
    state.verificationPlan,
    state.planProgress,
    state.qaHistory,
    state.activeQuestion,
    state.simulateQaFailure,
    state.uploadSeq,
    state.collections,
    state.currentCollectionId,
    state.methodProfiles,
    state.relations,
    state.directions,
    state.analyses,
    state.analysisProvenance,
    state.collectionStamps,
  ])

  /* 开发期校验：字段引用的证据 id 都能找到 */
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const missing: string[] = []
    state.papers.forEach((paper) => {
      Object.values(paper.fields).forEach((field) => {
        field?.evidenceIds.forEach((id) => {
          if (!EVIDENCE_BY_ID[id] && !state.evidence.find((e) => e.id === id)) {
            missing.push(`${paper.shortLabel}/${field.key} -> ${id}`)
          }
        })
      })
    })
    if (missing.length) {
      // eslint-disable-next-line no-console
      console.warn('[证据校验] 以下字段引用了不存在的原文片段：', missing)
    }
  }, [state.papers, state.evidence])

  const toast = useCallback(
    (type: Toast['type'], message: string, detail?: string) => {
      const item: Toast = { id: `t-${Date.now()}-${Math.random()}`, type, message, detail }
      dispatch({ type: 'TOAST_PUSH', toast: item })
      window.setTimeout(() => dispatch({ type: 'TOAST_DISMISS', id: item.id }), 7000)
    },
    [dispatch],
  )

  /* ---------------- 后端探测 ---------------- */
  const checkBackend = useCallback(async (): Promise<HealthResult | null> => {
    dispatch({ type: 'SET_BACKEND', backend: { status: 'checking' } })
    try {
      const health = await fetchHealth()
      dispatch({
        type: 'SET_BACKEND',
        backend: { status: 'ok', health, checkedAt: new Date().toISOString() },
      })
      dispatch({
        type: 'SET_CAPS',
        patch: {
          realLlmExtract: Boolean(health.capabilities?.realLlmExtract),
          realLlmQa: Boolean(health.capabilities?.realLlmQa),
        },
      })
      return health
    } catch (e) {
      const message = e instanceof ApiError ? e.info.message : e instanceof Error ? e.message : '未知错误'
      dispatch({
        type: 'SET_BACKEND',
        backend: { status: 'error', error: message, checkedAt: new Date().toISOString() },
      })
      dispatch({ type: 'SET_CAPS', patch: { realLlmExtract: false, realLlmQa: false } })
      return null
    }
  }, [])

  useEffect(() => {
    void checkBackend()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---------------- 项目作用域 ---------------- */
  const loadDemo = useCallback(() => {
    dispatch({ type: 'LOAD_DEMO' })
    toast('info', '已进入示例项目', '以下 3 篇论文为虚构的演示数据，不是真实论文分析结果。')
  }, [dispatch, toast])

  const switchScope = useCallback((scope: ProjectScope) => {
    dispatch({ type: 'SET_SCOPE', scope })
  }, [])

  /* ---------------- 正文本地存储预算 ---------------- */
  const persistText = useCallback(
    (paperId: string, pages: PageText[]) => {
      const cur = stateRef.current
      const nextTexts = { ...cur.texts, [paperId]: pages }
      let total = Object.values(nextTexts).reduce(
        (n, list) => n + list.reduce((m, p) => m + p.text.length, 0),
        0,
      )
      if (total <= TEXT_BUDGET_CHARS) {
        dispatch({ type: 'SET_TEXT', paperId, pages, stored: true })
        dispatch({ type: 'PATCH_PAPER', id: paperId, patch: { textStored: true } })
        return true
      }

      // 超预算：按上传时间从旧到新丢弃其它论文的正文
      const others = cur.papers
        .filter((p) => p.id !== paperId && nextTexts[p.id])
        .sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))
      const dropped: Paper[] = []
      for (const p of others) {
        if (total <= TEXT_BUDGET_CHARS) break
        const removed = nextTexts[p.id].reduce((m, x) => m + x.text.length, 0)
        delete nextTexts[p.id]
        total -= removed
        dropped.push(p)
      }

      if (total > TEXT_BUDGET_CHARS) {
        // 单篇就超预算：只保存前面能装下的部分页
        let used = 0
        const kept: PageText[] = []
        for (const p of pages) {
          if (used + p.text.length > TEXT_BUDGET_CHARS * 0.8) break
          kept.push(p)
          used += p.text.length
        }
        dispatch({ type: 'SET_TEXT', paperId, pages: kept, stored: true })
        dispatch({ type: 'PATCH_PAPER', id: paperId, patch: { textStored: true } })
        toast(
          'warning',
          '这篇论文太长，只保存了前面一部分正文',
          `浏览器本地存储有限，已保留前 ${kept.length}/${pages.length} 页；字段与证据不受影响，但「上传的文件内容」只保存了这部分。`,
        )
        return true
      }

      dispatch({ type: 'SET_TEXT', paperId, pages, stored: true })
      dispatch({ type: 'PATCH_PAPER', id: paperId, patch: { textStored: true } })
      dropped.forEach((p) => {
        dispatch({ type: 'PATCH_PAPER', id: p.id, patch: { textStored: false } })
      })
      if (dropped.length) {
        toast(
          'info',
          '为腾出本地存储空间，旧论文的正文未再保留',
          `${dropped.map((p) => p.shortLabel).join('、')} 的字段与证据仍在，但正文文本已被清理（可在详情页点「重新解析」恢复）。`,
        )
      }
      return true
    },
    [toast],
  )

  /* ---------------- 抽取字段 ---------------- */
  const runExtract = useCallback(
    async (paper: Paper, pages: PageText[]) => {
      dispatch({
        type: 'SET_PROGRESS',
        paperId: paper.id,
        value: { done: 0, total: 0, stage: '模型抽取字段与证据' },
      })
      dispatch({ type: 'PATCH_PAPER', id: paper.id, patch: { status: 'extracting', parseMessage: '正在用模型抽取字段与证据…' } })
      try {
        const result = await requestExtract({
          fileName: paper.fileName,
          title: paper.title,
          pages,
        })

        const items: Evidence[] = []
        const fields: Partial<Record<FieldKey, PaperField>> = {}
        for (const key of FIELD_ORDER) {
          const raw = result.fields?.[key]
          if (!raw) continue
          const evidenceIds: string[] = []
          raw.evidence.forEach((ev, i) => {
            const id = `ev-${paper.id}-${key}-${i}`
            items.push({
              id,
              paperId: paper.id,
              page: ev.page,
              section: `${FIELD_META[key].label}｜第 ${ev.page} 页`,
              text: ev.quote,
              source: 'pdf',
            })
            evidenceIds.push(id)
          })
          fields[key] = {
            key,
            value: raw.value,
            status: raw.status,
            origin: 'paper',
            evidenceIds,
            note: raw.note,
            // 保留「原文是否支持这个取值」的复核结果与撤回记录
            support: raw.support,
            supportReason: raw.supportReason,
            withdrawnValue: raw.withdrawnValue ?? null,
            withdrawnReason: raw.withdrawnReason,
            // 三态区分（初次漏抽 / 原文未报告 / 未检查）与按数据集保存的取值
            checkState: raw.checkState,
            perDataset: raw.perDataset,
          }
        }

        dispatch({ type: 'SET_EVIDENCE', paperId: paper.id, items })
        dispatch({ type: 'SET_FIELDS', paperId: paper.id, fields })
        dispatch({
          type: 'PATCH_PAPER',
          id: paper.id,
          patch: {
            status: 'parsed',
            extractedAt: new Date().toISOString(),
            analysisVersion: ANALYSIS_VERSION,
            extractWarnings: result.warnings || [],
            coverage: result.coverage,
            parseMessage: `已用 ${(result.elapsedMs / 1000).toFixed(1)} 秒完成字段抽取，引用已按原文校验${
              result.coverage && result.coverage.skippedPages.length > 0
                ? `（第 ${result.coverage.skippedPages.join('、')} 页未送入模型）`
                : ''
            }`,
          },
        })
        dispatch({ type: 'SET_CAPS', patch: { realLlmExtract: true } })
        if (result.warnings?.length) {
          toast('warning', `${paper.shortLabel} 抽取完成，但有需要注意的地方`, result.warnings[0])
        } else {
          toast('success', `${paper.shortLabel} 字段抽取完成`, '点击字段旁的「查看依据」可以核对原文页码与片段。')
        }
      } catch (e) {
        const info =
          e instanceof ApiError
            ? e.info
            : { code: 'UNKNOWN', message: e instanceof Error ? e.message : '抽取失败' }
        dispatch({
          type: 'PATCH_PAPER',
          id: paper.id,
          patch: {
            status: 'text-only',
            parseMessage: `正文已读取（${pages.length} 页），但字段抽取没有完成：${info.message}`,
          },
        })
        toast('error', `${paper.shortLabel} 字段抽取未完成`, `${info.message} 可以点「重新抽取」再试。`)
      } finally {
        dispatch({ type: 'SET_PROGRESS', paperId: paper.id, value: null })
        dispatch({ type: 'BUSY_REMOVE', id: paper.id })
      }
    },
    [toast],
  )

  /* ---------------- 单篇完整解析流程 ----------------
   * 注意：这里接收「论文对象」而不是 id。
   * 批量上传时刚 dispatch 完 ADD_PAPERS，stateRef 里可能还没有这些条目，
   * 用 id 去查会查不到（早期版本因此会静默跳过第一篇），所以直接传对象。
   */
  const parsePaperObject = useCallback(
    async (paper: Paper, file?: File) => {
      const paperId = paper.id

      dispatch({ type: 'BUSY_ADD', id: paperId })
      dispatch({ type: 'PATCH_PAPER', id: paperId, patch: { status: 'parsing', parseError: undefined, parseMessage: '正在读取 PDF 正文…' } })
      dispatch({ type: 'SET_PROGRESS', paperId, value: { done: 0, total: 0, stage: '读取 PDF 正文' } })

      let pages: PageText[] | null = stateRef.current.texts[paperId] || null

      if (!pages) {
        // 没给文件时，先看本地是否存过原文件（IndexedDB）——有的话就不用再让用户选一次
        let effectiveFile = file
        let restoredFromLocal = false
        if (!effectiveFile) {
          const stored = await loadOriginalFile(paperId)
          if (stored) {
            effectiveFile = stored
            restoredFromLocal = true
            dispatch({
              type: 'PATCH_PAPER',
              id: paperId,
              patch: { parseMessage: '已取回本地保存的原文件，正在重新读取正文…' },
            })
          }
        }

        if (!effectiveFile) {
          dispatch({
            type: 'PATCH_PAPER',
            id: paperId,
            patch: {
              status: 'failed',
              parseError:
                '本地没有这份 PDF 的正文与原文件，需要重新选择文件再解析（可能是换了浏览器、清了站点数据，或保存时配额不足）。',
              parseMessage: '需要重新选择文件',
            },
          })
          dispatch({ type: 'SET_PROGRESS', paperId, value: null })
          dispatch({ type: 'BUSY_REMOVE', id: paperId })
          return
        }
        try {
          const result = await extractPdfPages(effectiveFile, (done, total) => {
            dispatch({
              type: 'SET_PROGRESS',
              paperId,
              value: { done, total, stage: '读取 PDF 正文' },
            })
          })
          pages = result.pages
          persistText(paperId, result.pages)

          // 把原文件也存到本地：下次刷新可以直接重新解析，不用再选文件
          const saved = await saveOriginalFile(paperId, effectiveFile)
          const emptyPages = result.pages
            .filter((p) => (p.text || '').trim().length < 20)
            .map((p) => p.page)
          dispatch({
            type: 'PATCH_PAPER',
            id: paperId,
            patch: {
              pageCount: result.pageCount,
              textChars: result.totalChars,
              extractWarnings: result.warnings,
              // 客户端先给出「抽不到文字的页」；抽字段时后端再补上「被截断丢弃的页」
              coverage: {
                totalPages: result.pageCount,
                usedPages: [],
                skippedPages: [],
                emptyPages,
              },
              fileStored: saved,
              fileStoreError: saved
                ? undefined
                : '浏览器拒绝了原文件保存（可能是隐私模式或存储配额不足），刷新后需要重新选择文件。',
              parseMessage: `已读取 ${result.pageCount} 页正文（${result.totalChars.toLocaleString('zh-CN')} 字符）${
                restoredFromLocal ? '（来自本地保存的原文件）' : ''
              }，接下来抽取字段…`,
            },
          })
          dispatch({ type: 'SET_CAPS', patch: { realPdfParsing: true, persistOriginalFile: saved } })
          if (!saved) {
            toast(
              'warning',
              `${paper.shortLabel}：原文件没能保存到本地`,
              '刷新后再需要重新解析时，要重新选择一次文件。正文、字段与证据仍然已保存。',
            )
          }
          if (result.warnings.length) {
            toast('warning', `${paper.shortLabel}：部分页面没有文字`, result.warnings[0])
          }
        } catch (e) {
          const err =
            e instanceof PdfParseError
              ? { code: e.code, message: e.message }
              : { code: 'UNKNOWN', message: e instanceof Error ? e.message : '解析失败' }
          dispatch({
            type: 'PATCH_PAPER',
            id: paperId,
            patch: { status: 'failed', parseError: err.message, parseMessage: `解析失败：${err.message}` },
          })
          dispatch({ type: 'SET_PROGRESS', paperId, value: null })
          dispatch({ type: 'BUSY_REMOVE', id: paperId })
          toast('error', `${paper.shortLabel} 解析失败`, err.message)
          return
        }
      } else {
        dispatch({
          type: 'PATCH_PAPER',
          id: paperId,
          patch: {
            parseMessage: `已恢复本地保存的正文（${pages.length} 页），接下来抽取字段…`,
            pageCount: pages.length,
            textChars: pages.reduce((n, p) => n + p.text.length, 0),
          },
        })
      }

      await runExtract(stateRef.current.papers.find((p) => p.id === paperId) || paper, pages)
    },
    [persistText, runExtract, toast],
  )

  /** 按 id 解析（用于「重新抽取 / 重新解析」按钮） */
  const parsePaper = useCallback(
    async (paperId: string, file?: File) => {
      const paper = stateRef.current.papers.find((p) => p.id === paperId)
      if (!paper) {
        toast('warning', '没有找到这篇论文', '它可能已经被删除，请刷新页面后重试。')
        return
      }
      await parsePaperObject(paper, file)
    },
    [parsePaperObject, toast],
  )
  const reextract = useCallback(
    async (paperId: string, file?: File) => {
      await parsePaper(paperId, file)
    },
    [parsePaper],
  )

  /** 删除论文：状态里删条目的同时，把本地保存的原文件一起清掉 */
  const removePaper = useCallback((paperId: string) => {
    dispatch({ type: 'REMOVE_PAPER', id: paperId })
    void removeOriginalFile(paperId).then(() => {
      dispatch({ type: 'SET_PROGRESS', paperId, value: null })
      dispatch({ type: 'BUSY_REMOVE', id: paperId })
    })
  }, [])

  /** 重置本地数据：localStorage 与 IndexedDB 一起清，避免"删了但文件还在" */
  const resetAll = useCallback(() => {
    dispatch({ type: 'RESET_ALL' })
    void clearOriginalFiles()
  }, [])

  const setDatasetScope = useCallback((dataset: string | null) => {
    dispatch({ type: 'SET_DATASET_SCOPE', dataset })
  }, [])

  /* ---------------- 上传 ---------------- */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<UploadIssue[]> => {
      const current = stateRef.current
      if (files.length === 0) return []
      const { accepted, issues } = validateFiles(files, current.papers)

      if (issues.length > 0) {
        toast('warning', `${issues.length} 个文件被跳过`, '具体原因见论文库上方的「本次上传的提示」。')
      }
      if (accepted.length === 0) {
        if (issues.length > 0) toast('warning', '没有文件被加入列表', '请根据提示调整后再试。')
        return issues
      }

      const uploadedAt = new Date().toISOString()
      const startSeq = current.uploadSeq
      // 把 accepted 的 meta 对应回 File 对象（按 name+size），用于计算字节内容指纹
      const metaFiles = new Map<UploadMeta, File>()
      for (const meta of accepted) {
        const f = files.find((x) => x.name === meta.fileName && x.size === meta.fileSize)
        if (f) metaFiles.set(meta, f)
      }
      // 字节内容指纹去重：只看文件名/大小不可靠。同内容不同文件名也要能识别。
      const existingFp = new Set(current.papers.filter((p) => p.fileFingerprint).map((p) => p.fileFingerprint as string))
      const acceptedMeta: UploadMeta[] = []
      const fpByMeta = new Map<UploadMeta, string>()
      for (const meta of accepted) {
        const f = metaFiles.get(meta)
        if (!f) { acceptedMeta.push(meta); continue }
        const fp = await fingerprintBytes(f)
        if (existingFp.has(fp)) {
          issues.push({ fileName: meta.fileName, type: 'duplicate', message: '内容相同：论文库已有同一份文件（字节指纹一致），未重复导入。可到「论文库」把它加入集合。' })
          continue
        }
        existingFp.add(fp)
        fpByMeta.set(meta, fp)
        acceptedMeta.push(meta)
      }
      const paperList = acceptedMeta.map((meta, idx) => {
        const p = createPendingPaper(meta, startSeq + idx + 1, uploadedAt)
        const fp = fpByMeta.get(meta)
        if (fp) p.fileFingerprint = fp
        return p
      })
      // 把 File 对象按顺序对应到论文条目，用于随后真实解析
      const fileMap = new Map<string, File>()
      let accIdx = 0
      for (const meta of acceptedMeta) {
        const f = metaFiles.get(meta)
        const target = paperList[accIdx]
        if (target && f) { fileMap.set(target.id, f); accIdx += 1 }
      }
      paperList.forEach((p) => {
        if (!fileMap.has(p.id)) {
          const match = files.find((f) => f.name === p.fileName && f.size === p.fileSize)
          if (match) fileMap.set(p.id, match)
        }
      })

      dispatch({ type: 'ADD_PAPERS', papers: paperList })
      dispatch({ type: 'SET_SCOPE', scope: 'user' })
      dispatch({ type: 'SET_UPLOAD_SEQ', seq: startSeq + paperList.length })
      toast('success', `已加入 ${paperList.length} 篇论文`, '正在读取 PDF 正文并抽取字段，请稍候…')

      for (const p of paperList) {
        await parsePaperObject(p, fileMap.get(p.id))
      }

      const note = requestParseNote()
      toast('info', note.title, note.detail)
      return issues
    },
    [parsePaperObject, toast],
  )

  /* ---------------- 证据 ---------------- */
  const resolve = useCallback((ids: string[]) => {
    const pool: Record<string, Evidence> = { ...EVIDENCE_BY_ID }
    stateRef.current.evidence.forEach((e) => {
      pool[e.id] = e
    })
    const items: Evidence[] = []
    const unresolvedIds: string[] = []
    ids.forEach((id) => {
      if (pool[id]) items.push(pool[id])
      else unresolvedIds.push(id)
    })
    return { items, unresolvedIds }
  }, [])

  const openEvidence = useCallback(
    (title: string, subtitle: string, evidenceIds: string[]) => {
      const { items, unresolvedIds } = resolve(evidenceIds)
      dispatch({ type: 'OPEN_EVIDENCE', title, subtitle, items, unresolvedIds })
    },
    [resolve],
  )

  /** 打开右侧面板的侦探：只记录目标，不自动运行 */
  const openDetective = useCallback((ctx: DetectiveCtx) => {
    dispatch({ type: 'OPEN_DETECTIVE', ctx })
  }, [])

  const closeDetective = useCallback(() => {
    dispatch({ type: 'CLOSE_DETECTIVE' })
  }, [])

  /* ---------------- 研究集合 / 分类 / 演进 / 方向 ---------------- */
  const importCatalog = useCallback(() => {
    const existing = new Set(state.papers.map((p) => p.id))
    const papers: Paper[] = TS_CATALOG.filter((c) => !existing.has(c.id)).map((c, i) => ({
      id: c.id,
      source: 'catalog' as const,
      shortLabel: `C${i + 1}`,
      fileName: `${c.method.split(' / ')[0]}.pdf`,
      fileSize: null,
      fileLastModified: null,
      title: c.title,
      authors: c.authors,
      year: c.year,
      venue: c.venue,
      status: 'pending' as const,
      uploadedAt: new Date().toISOString(),
      parseMessage: `公开文献清单（arXiv:${c.arxiv}）。元信息；上传对应 PDF 后可解析正文与字段。`,
      fields: {},
    }))
    dispatch({ type: 'PAPERS_ADD', papers })
    return papers.map((p) => p.id)
  }, [state.papers])

  const createCollection = useCallback((name: string, domain = '时间序列预测'): Collection => {
    const col: Collection = { id: `col-${Date.now().toString(36)}`, name, domain, paperIds: [], updatedAt: new Date().toISOString() }
    dispatch({ type: 'COLLECTION_UPSERT', collection: col })
    dispatch({ type: 'SET_CURRENT_COLLECTION', id: col.id })
    return col
  }, [])

  const renameCollection = useCallback((id: string, name: string) => {
    const col = state.collections.find((c) => c.id === id)
    if (col) dispatch({ type: 'COLLECTION_UPSERT', collection: { ...col, name } })
  }, [state.collections])

  const deleteCollection = useCallback((id: string) => {
    dispatch({ type: 'COLLECTION_DELETE', id })
  }, [])

  const addPapersToCollection = useCallback((id: string, paperIds: string[]) => {
    dispatch({ type: 'COLLECTION_ADD_PAPERS', id, paperIds })
  }, [])

  const removePaperFromCollection = useCallback((id: string, paperId: string) => {
    dispatch({ type: 'COLLECTION_REMOVE_PAPER', id, paperId })
  }, [])

  /** 一键：导入内置公开文献清单并建/并入「时间序列预测研究」集合 */
  const bootstrapTsCollection = useCallback(() => {
    const ids = importCatalog()
    const existing = state.collections.find((c) => c.domain === '时间序列预测' && c.name.includes('时间序列预测'))
    const col = existing ?? createCollection('时间序列预测研究', '时间序列预测')
    if (!existing) dispatch({ type: 'SET_CURRENT_COLLECTION', id: col.id })
    dispatch({ type: 'COLLECTION_ADD_PAPERS', id: col.id, paperIds: ids })
    return col.id
  }, [importCatalog, createCollection, state.collections])

  /** 对当前集合跑一次分类 + 关系（保留人工确认的标签与关系） */
  const runCollectionAnalysis = useCallback((collectionId: string) => {
    const col = state.collections.find((c) => c.id === collectionId)
    if (!col) return
    const papers = col.paperIds.map((id) => state.papers.find((p) => p.id === id)).filter((p): p is Paper => Boolean(p))
    const profiles = classifyPapers(papers, state.evidence, state.texts)
    dispatch({ type: 'SET_METHOD_PROFILES', profiles })
    const relations = buildRelations(papers, profiles, state.relations)
    dispatch({ type: 'SET_RELATIONS', relations })
    const covered = papers.filter((p) => profiles[p.id]?.family.some((f) => f.label !== '待分类')).map((p) => p.id)
    const failed = papers.filter((p) => !profiles[p.id]?.ownMethod).map((p) => p.id)
    dispatch({ type: 'ANALYSIS_ADD', record: makeAnalysisRecord(col, papers, profiles, covered, failed) })
  }, [state.collections, state.papers, state.evidence, state.texts, state.relations])

  const generateDirections = useCallback(async (collectionId: string): Promise<number> => {
    const col = state.collections.find((c) => c.id === collectionId)
    if (!col) return 0
    const papers = col.paperIds.map((id) => state.papers.find((p) => p.id === id)).filter((p): p is Paper => Boolean(p))
    const labCases: LabCaseExtension[] = []

    // 案例延伸只能读取版本化真实案例；接口/文件缺失时不生成，绝不在方向函数里写死数字。
    try {
      const result = await fetchReversalCase(true)
      const c = result.ok ? result.case : undefined
      const a = c?.slices?.explore
      const b = c?.slices?.consistency
      if (c && a && b && c.caseId && c.generatedAt) {
        const f = (v: number) => Number(v).toFixed(4)
        labCases.push({
          caseId: c.caseId,
          caseName: `${c.title}（DLinear vs Linear；采用官方模型实现、本项目训练的权重）`,
          generatedAt: c.generatedAt,
          weights: c.weights,
          settings: c.settings,
          extensionQuestion: 'DLinear 与 Linear 在两个固定时间段出现不同领先方后，逐档增加输入扰动时，这一时间段反转现象是否仍然保持？',
          hypothesis: '若反转主要来自时间段差异而不是无扰动这一特殊条件，则在预先登记的多个输入扰动档位下，两段的领先方仍可能不同；也可能反转消失（支持 / 削弱 / 无法判断）',
          ranWhat: `DLinear 与 Linear 采用官方模型实现、本项目训练的权重（${c.weights.DLinear} / ${c.weights.Linear}）；${String(c.settings.dataset)} ${String(c.settings.target)}，seq_len=${String(c.settings.seqLen)}、pred_len=${String(c.settings.predLen)}、${String(c.settings.perturbation)}、seed=${String(c.settings.seed)}`,
          reusedObservation: `案例 ${c.caseId}（${c.generatedAt}）：${a.label}由 ${a.leader} 领先（ΔMAE ${f(a.deltaMae)}），${b.label}由 ${b.leader} 领先（ΔMAE ${f(b.deltaMae)}）；这是当前权重与设置下的观察`,
          changed: '保持原案例的两个时间段与权重不变，只改变输入窗口的扰动强度；扰动不修改真实目标',
          unverified: '反转在不同输入扰动档位下是否保持、差异是否超过运行噪声，以及能否推广到其它数据集，均尚未验证',
          relatedPaperIds: papers.filter((p) => /dlinear|linear/i.test(p.shortLabel + ' ' + (state.methodProfiles[p.id]?.ownMethod ?? ''))).slice(0, 2).map((p) => p.id),
          minimalExperiment: {
            baseline: 'DLinear vs Linear',
            variable: '输入窗口扰动强度（从实验室已有档位中预先登记；扰动不修改真实目标）',
            fixed: `原案例的两个时间段、同一对权重、数据集、目标列、训练划分、指标、聚合、采样步长、种子与 pred_len=${String(c.settings.predLen)}`,
            dataset: `${String(c.settings.dataset)}（${String(c.settings.target)}）`,
            metrics: ['MAE', 'MSE', 'RMSE'],
          },
          resources: '当前实验室已经包含该案例的两种方法、权重、两个时间段与输入扰动控制，可直接运行并保存记录',
          boundary: '已有观察只适用于案例记录中的权重、切片、数据与设置；扰动实验是条件压力测试，不等于论文原结论，也不预设反转一定保持',
        })
      }
    } catch {
      // 没有可读案例时不生成 case-extension；其它论文方向仍然可用。
    }

    let dirs = deriveDirections(papers, state.methodProfiles, state.evidence, state.texts, labCases)
    // 真实案例延伸已经由程序按当前实验室能力生成，保留其可执行边界；
    // 模型只综合论文来源方向，避免把案例改成产品当前无法运行的其它跨度/数据集实验。
    const research = dirs.filter((d) => d.kind === 'research' && d.sourceType !== 'case-extension')
    if (state.backend.health?.hasCredentials && research.length) {
      try {
        const response = await requestDirectionSynthesis({
          domain: col.domain,
          papers: papers.map((p) => {
            const profile = state.methodProfiles[p.id]
            return {
              id: p.id,
              label: p.shortLabel,
              method: profile?.ownMethod,
              researchProblem: profile?.researchProblem,
              authorClaim: profile?.authorClaim,
              limitations: (profile?.limitations ?? []).filter((x) => x.verdict === 'paper-supported').map((x) => x.text),
              futureWork: (profile?.futureWork ?? []).filter((x) => x.verdict === 'paper-supported').map((x) => x.text),
            }
          }),
          directions: research,
        })
        const proposals = new Map(response.directions.map((d) => [d.id, d]))
        dirs = dirs.map((base) => {
          const proposal = proposals.get(base.id)
          if (!proposal || base.kind !== 'research') return base
          const merged: ResearchDirection = {
            ...base,
            question: proposal.question || base.question,
            hypothesis: proposal.hypothesis || base.hypothesis,
            minimalExperiment: proposal.minimalExperiment || base.minimalExperiment,
            judgment: proposal.judgment || base.judgment,
            prerequisites: proposal.prerequisites ?? base.prerequisites,
            unsupportedSteps: proposal.unsupportedSteps ?? base.unsupportedSteps,
            resources: proposal.resources || base.resources,
            boundary: proposal.boundary || base.boundary,
            recommendReason: proposal.recommendReason || base.recommendReason,
            proposalMode: 'model',
            generationNote: proposal.generationNote,
          }
          // 模型只生成建议；来源/引文/案例版本沿用 base，并由程序重新检查适配性。
          return { ...merged, ...fitResearchDirection(merged) }
        })
      } catch (e) {
        const detail = e instanceof ApiError ? e.info.message : e instanceof Error ? e.message : '模型暂不可用'
        toast('warning', '已使用规则建议', `模型综合失败：${detail}。来源证据和规则方案已保留，可稍后重新生成。`)
      }
    }
    dispatch({ type: 'SET_DIRECTIONS', directions: dirs })
    return dirs.length
  }, [state.collections, state.papers, state.methodProfiles, state.evidence, state.texts, state.backend.health, toast])

  /** 导入本地已抽取的 12 篇真实正文（public/catalog-pages.json），把 catalog 论文升级为「正文已读取」 */
  const importCatalogPages = useCallback(async (): Promise<number> => {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}catalog-pages.json`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { papers: { id: string; numPages: number; pages: { page: number; text: string }[] }[] }
      const idMap: Record<string, string> = {
        informer: 'cat-informer', nbeats: 'cat-nbeats', scinet: 'cat-scinet', etsformer: 'cat-etsformer',
        timesnet: 'cat-timesnet', crossformer: 'cat-crossformer', micn: 'cat-micn', itransformer: 'cat-itransformer',
        autoformer: 'cat-autoformer', fedformer: 'cat-fedformer', patchtst: 'cat-patchtst', dlinear: 'cat-dlinear',
      }
      let n = 0
      for (const pp of data.papers) {
        const paperId = idMap[pp.id]
        if (!paperId) continue
        const p = state.papers.find((x) => x.id === paperId)
        if (!p) continue
        dispatch({ type: 'SET_TEXT', paperId, pages: pp.pages.map((pg) => ({ page: pg.page, text: pg.text })), stored: true })
        dispatch({
          type: 'PAPERS_ADD',
          papers: [{
            ...p,
            pageCount: pp.numPages,
            textStored: true,
            textChars: pp.pages.reduce((s, pg) => s + pg.text.length, 0),
            status: Object.keys(p.fields ?? {}).length > 0 ? 'parsed' : 'text-only',
            coverage: { totalPages: pp.numPages, usedPages: pp.pages.map((pg) => pg.page), skippedPages: [], emptyPages: [] },
          }],
        })
        n += 1
      }
      return n
    } catch (e) {
      toast('error', '导入真实正文失败', e instanceof Error ? e.message : String(e))
      return 0
    }
  }, [state.papers, toast])

  /* ---------------- 论文方法分析（模型 /api/analyze，并发池 + 取消 + 迟到隔离） ---------------- */
  const analyzeController = React.useRef<AbortController | null>(null)
  const analyzeGen = React.useRef(0)

  const profileFromAnalyze = (paperId: string, r: AnalyzeResult): MethodProfile => {
    const now = new Date().toISOString()
    /**
     * 合成一个分类标签。
     *
     * 四个维度分开保存，绝不能压成一个布尔量：
     *   引文定位 citationLocated（程序） / 归属 attribution（模型） /
     *   语义支持 semanticSupport（模型批量复核） / 人工状态 manualStatus（仅用户操作）。
     *
     * 「引文定位成功」只说明这句话在论文里，不说明它支持这个标签 ——
     * 只有「归属=本文采用」+「引文已定位」+「语义复核确认支持」三者同时成立，
     * 才显示为「原文明示」；缺任何一项都只是工具推断，且必须写明缺哪一项。
     */
    const makeTag = (label: string, kind: 'family' | 'mechanism' | 'task', it: AnalyzeItem): ClassificationTag => {
      const located = it.citationLocated === true
      const attribution = (it.attribution ?? undefined) as ClassificationTag['attribution']
      const semantic = (it.semanticSupport ?? 'unchecked') as ClassificationTag['semanticSupport']
      const paperShown = attribution === 'used' && located && semantic === 'supported'
      const origin: ClassificationTag['origin'] = paperShown ? 'paper' : 'inferred'
      const status: ClassificationTag['status'] = paperShown
        ? 'confirmed'
        : semantic === 'unsupported'
          ? 'unsupported'
          : 'pending'
      const reason = paperShown
        ? `${it.citationReason ?? '原句逐字命中'}；语义复核确认原句支持该标签`
        : it.verdictReason || it.semanticReason || it.citationReason || '未通过完整校验，待人工确认'

      // 标签归一化：模型自由文本映射到统一词表；保留原表述，不硬塞类别。
      // family 无法可靠映射时进入「其他」泳道；mechanism/task 无法映射则保留原表述并标记 unmapped。
      const rawLabel = label
      const norm = normalizeLabel(kind, rawLabel)
      const displayLabel = kind === 'family' ? (norm.canonical ?? '其他') : (norm.canonical ?? rawLabel)

      return {
        label: displayLabel,
        rawLabel: norm.status === 'mapped' && rawLabel !== displayLabel ? rawLabel : undefined,
        normStatus: norm.status,
        scope: r.ownMethod ?? '本文方法',
        origin,
        status,
        evidenceIds: [],
        attribution,
        quoteLocated: located,
        semanticSupport: semantic,
        semanticReason: it.semanticReason || it.verdictReason || '',
        verdict: it.verdict,
        reason,
      }
    }
    const usedMechanisms = (r.mechanisms ?? []).filter((m) => m.attribution === 'used')
    const excludedMechanisms = (r.mechanisms ?? []).filter((m) => m.attribution !== 'used')
    const family = (r.family ?? []).filter((f) => f.attribution === 'used').map((f) => makeTag(f.label ?? '', 'family', f))
    const mechanisms = usedMechanisms.map((m) => makeTag(m.label ?? '', 'mechanism', m))
    const tasks = (r.tasks ?? []).filter((t) => t.attribution === 'used').map((t) => makeTag(t.label ?? '', 'task', t))
    const item = <T extends Record<string, unknown>>(x: AnalyzeItem, extra: T) => ({
      ...extra,
      quote: x.quote,
      page: x.page,
      attribution: x.attribution ?? undefined,
      quoteLocated: x.citationLocated === true,
      semanticSupport: (x.semanticSupport ?? 'unchecked') as string,
      semanticReason: x.semanticReason || x.verdictReason || '',
      verdict: (x.verdict ?? undefined) as string | undefined,
      verdictReason: x.verdictReason || '',
    })
    return {
      paperId,
      ownMethod: r.ownMethod ?? null,
      family: family.length ? family : [{ label: '待分类', scope: '本文方法', origin: 'inferred', status: 'pending', evidenceIds: [], reason: '模型未给出本文采用的家族标签' }],
      mechanisms,
      tasks,
      generatedAt: now,
      analysisVersion: ANALYSIS_VERSION,
      analyzedBy: 'model',
      analyzedAt: now,
      researchProblem: r.researchProblem ?? null,
      authorClaim: r.authorClaim ?? null,
      differences: (r.differences ?? []).map((d) => item(d, { target: d.target ?? '', change: d.change ?? '' })) as MethodProfile['differences'],
      limitations: (r.limitations ?? []).map((l) => item(l, { text: l.text ?? '' })) as MethodProfile['limitations'],
      futureWork: (r.futureWork ?? []).map((f) => item(f, { text: f.text ?? '' })) as MethodProfile['futureWork'],
      excluded: excludedMechanisms.map((m) => ({
        label: m.label ?? '',
        attribution: m.attribution ?? '',
        quote: m.quote,
        page: m.page,
        verbatim: m.citationLocated === true,
        semanticReason: m.verdictReason || m.semanticReason || '',
      })),
      semanticReviewRan: r.semanticReviewRan === true,
      analysisPipeline: r.analysisPipeline,
    }
  }

  /**
   * 批量方法分析：并发 2，可取消，迟到结果隔离。
   * 按缓存计划决定本次真正要跑哪些论文：
   *  - view          只看已有结果，不调用模型
   *  - analyze-new   只分析「尚未分析 / 上次失败」的论文
   *  - update-stale  再加正文变化 / 分析流程升级 / 模型变化的过期项（默认）
   *  - force         全部重跑（调用方必须先告诉用户涉及多少篇）
   */
  const analyzeCollectionPapers = useCallback(async (collectionId: string, mode: AnalysisMode = 'update-stale'): Promise<{ done: number; failed: number; skipped: number; cancelled: boolean }> => {
    const col = state.collections.find((c) => c.id === collectionId)
    if (!col) return { done: 0, failed: 0, skipped: 0, cancelled: false }
    const papers = col.paperIds
      .map((id) => state.papers.find((p) => p.id === id))
      .filter((p): p is Paper => p !== undefined && Boolean(state.texts[p.id]?.length))
    if (papers.length === 0) {
      toast('warning', '没有可分析的正文', '先「导入真实正文」或上传并解析 PDF。')
      return { done: 0, failed: 0, skipped: 0, cancelled: false }
    }

    // 缓存计划：只跑真正需要跑的论文；其余直接复用，不偷偷调模型
    const modelId = modelIdOf(state.backend.health)
    const plan = planAnalysis(papers, state.texts, state.methodProfiles, state.analysisProvenance, modelId, mode)
    if (plan.toRun.length === 0) {
      if (mode !== 'view') toast('info', '没有需要分析的论文', `已有 ${plan.reused.length} 篇为有效缓存，未调用模型。`)
      return { done: 0, failed: 0, skipped: plan.reused.length, cancelled: false }
    }

    analyzeController.current?.abort()
    const ctrl = new AbortController()
    analyzeController.current = ctrl
    const gen = ++analyzeGen.current
    let done = 0
    let failed = 0
    let cancelled = false

    const runOne = async (p: Paper): Promise<void> => {
      dispatch({ type: 'BUSY_ADD', id: p.id })
      try {
        const pages = stateRef.current.texts[p.id] ?? []
        const hint = stateRef.current.methodProfiles[p.id]?.ownMethod ?? undefined
        const fp = fingerprintText(pages, p.fileName)
        const r = await requestAnalyze({ fileName: p.fileName, title: p.title, pages, hint, signal: ctrl.signal })
        if (gen !== analyzeGen.current) return // 迟到结果隔离：已取消/新一轮则丢弃
        if (r.ok) {
          const profile = profileFromAnalyze(p.id, r)
          dispatch({ type: 'SET_METHOD_PROFILES', profiles: { ...stateRef.current.methodProfiles, [p.id]: profile } })
          const rels = (r.relations ?? []).filter((x) => x.target && (x.type === 'cites' || x.type === 'improves')).map((x, i) => {
            /**
             * 技术关系的三重校验（只找到两个方法名，不足以确认引用/改进/继承）：
             *   1. 引文定位（程序）：原句是否逐字出现在论文里。
             *   2. 结构校验（程序）：原句里是否真的出现了目标方法名。
             *   3. 语义支持（模型批量复核）：原句是否支持「本文 → 目标方法 + 该关系类型」。
             * 三项全部成立才标 confirmed；否则一律 candidate，并写明缺哪一项。
             */
            const located = x.citationLocated === true
            const objectMentioned = x.objectMentioned === true
            const semantic = x.semanticSupport ?? 'unchecked'
            const confirmed = located && objectMentioned && semantic === 'supported'
            const gap = !located
              ? '原句未逐字定位到正文'
              : !objectMentioned
                ? '原句未出现目标方法名'
                : semantic === 'unchecked'
                  ? '语义复核未执行'
                  : semantic === 'ambiguous'
                    ? '语义复核存在歧义，无法确定关系方向'
                    : semantic === 'unsupported'
                      ? '语义复核不支持该关系类型'
                      : ''
            return {
              id: `rel-model-${p.id}-${i}`,
              from: p.id,
              to: x.target ?? '',
              type: (x.type === 'improves' ? 'improves' : 'cites') as PaperRelation['type'],
              directed: true,
              evidenceIds: [],
              generatedBy: 'model' as const,
              review: (confirmed ? 'confirmed' : 'candidate') as PaperRelation['review'],
              reason: `正文第 ${x.locatedPage ?? x.page ?? '?'} 页：${x.quote ?? ''}（${
                x.type === 'cites' ? '引用关系' : '改进/继承'
              }；${confirmed ? '原句逐字命中、出现目标方法名，且语义复核确认该关系' : `待确认——${gap}`}）`,
              quoteLocated: located,
              objectMentioned,
              semanticSupport: semantic,
            }
          })
          if (rels.length) dispatch({ type: 'SET_RELATIONS', relations: [...stateRef.current.relations.filter((r) => r.from !== p.id), ...rels] })
          dispatch({ type: 'PAPERS_ADD', papers: [{ ...p, status: 'parsed', analysisVersion: ANALYSIS_VERSION }] })
          // 记录来源：内容指纹 + 分析流程版本 + 模型标识（不含密钥）→ 供缓存失效判断
          dispatch({
            type: 'SET_PROVENANCE',
            paperId: p.id,
            provenance: {
              paperId: p.id,
              contentFingerprint: fp,
              pipelineVersion: ANALYSIS_PIPELINE_VERSION,
              modelId,
              analyzedAt: new Date().toISOString(),
              semanticReviewRan: r.semanticReviewRan === true,
              status: 'ok',
            },
          })
          done += 1
        } else {
          failed += 1
          // 失败保留上一份有效结果，并记录失败状态（下次「分析未完成项」会重试这一篇）
          dispatch({
            type: 'SET_PROVENANCE',
            paperId: p.id,
            provenance: {
              paperId: p.id,
              contentFingerprint: fp,
              pipelineVersion: ANALYSIS_PIPELINE_VERSION,
              modelId,
              analyzedAt: new Date().toISOString(),
              semanticReviewRan: false,
              status: 'failed',
              note: r.message,
            },
          })
          toast('warning', `分析方法失败：${p.shortLabel}`, r.message ?? '')
        }
      } catch (e) {
        if (gen !== analyzeGen.current) return
        failed += 1
        toast('warning', `分析方法失败：${p.shortLabel}`, e instanceof Error ? e.message : String(e))
      } finally {
        dispatch({ type: 'BUSY_REMOVE', id: p.id })
      }
    }

    // 并发池（2 个）—— 只跑缓存计划里真正需要跑的论文
    const queue = plan.toRun.map((t) => t.paper)
    const workers = Array.from({ length: 2 }, async () => {
      while (queue.length) {
        if (ctrl.signal.aborted) { cancelled = true; break }
        const p = queue.shift()
        if (!p) break
        await runOne(p)
      }
    })
    await Promise.all(workers)
    // 只要本次真的动了任何一篇，集合级产物（关系/方向/演进）就标记为需要更新，但旧结果仍可看
    if (done > 0) dispatch({ type: 'COLLECTION_STAMP_DIRTY', collectionId })
    return { done, failed, skipped: plan.reused.length, cancelled }
  }, [state.collections, state.papers, state.texts, state.methodProfiles, state.analysisProvenance, state.backend.health, toast])

  const cancelAnalysis = useCallback(() => {
    analyzeController.current?.abort()
  }, [])

  /** 当前集合的分析缓存状态（不触发任何模型调用），供集合页区分「查看/分析未完成/更新过期/强制重跑」 */
  const collectionAnalysisStatus = useCallback(() => {
    const col = state.collections.find((c) => c.id === state.currentCollectionId) ?? state.collections[0] ?? null
    if (!col) return null
    const modelId = modelIdOf(state.backend.health)
    const papers = col.paperIds.map((id) => state.papers.find((p) => p.id === id)).filter((p): p is Paper => Boolean(p))
    const counts: Record<string, number> = {}
    const perPaper = papers.map((p) => {
      const st = stalenessOf(p, state.texts[p.id], state.methodProfiles[p.id], state.analysisProvenance[p.id], modelId)
      counts[st] = (counts[st] ?? 0) + 1
      return { paper: p, staleness: st }
    })
    const stampStale = collectionStampStale(state.collectionStamps[col.id], col, state.papers, modelId)
    return { perPaper, counts, stampStale }
  }, [state.collections, state.currentCollectionId, state.papers, state.texts, state.methodProfiles, state.analysisProvenance, state.collectionStamps, state.backend.health])

  const editDirection = useCallback((dir: ResearchDirection) => {
    const prev = state.directions.find((d) => d.id === dir.id)
    const next: ResearchDirection = { ...dir, edited: true, original: prev?.original ?? (prev ? { question: prev.question, reasoning: prev.reasoning, hypothesis: prev.hypothesis } : undefined) }
    dispatch({ type: 'DIRECTION_UPSERT', direction: next })
  }, [state.directions])

  const deleteDirection = useCallback((id: string) => {
    dispatch({ type: 'DIRECTION_DELETE', id })
  }, [])

  const currentCollection = useMemo(
    () => state.collections.find((c) => c.id === state.currentCollectionId) ?? state.collections[0] ?? null,
    [state.collections, state.currentCollectionId],
  )

  const collectionPapers = useMemo(() => {
    if (!currentCollection) return []
    return currentCollection.paperIds.map((id) => state.papers.find((p) => p.id === id)).filter((p): p is Paper => Boolean(p))
  }, [currentCollection, state.papers])

  const openEvidenceItems = useCallback(
    (title: string, subtitle: string, items: Evidence[], note?: string) => {
      dispatch({ type: 'OPEN_EVIDENCE', title, subtitle, items, unresolvedIds: [], note })
    },
    [],
  )

  /* ---------------- 派生数据 ---------------- */
  const scopedPapers = useMemo(
    () => state.papers.filter((p) => p.source === state.scope),
    [state.papers, state.scope],
  )

  const selectedPapers = useMemo(
    () =>
      state.selectedIds
        .map((id) => state.papers.find((p) => p.id === id))
        .filter((p): p is Paper => Boolean(p)),
    [state.selectedIds, state.papers],
  )

  const evidenceMap = useMemo(() => {
    const map: Record<string, Evidence> = { ...EVIDENCE_BY_ID }
    state.evidence.forEach((e) => {
      map[e.id] = e
    })
    return map
  }, [state.evidence])

  const pagesOf = useCallback(
    (paperId: string): PageText[] | undefined => state.texts[paperId],
    [state.texts],
  )

  /* ---------------- 单字段补查 ---------------- */
  const recheckOneField = useCallback(
    async (paper: Paper, key: FieldKey) => {
      const pages = state.texts[paper.id]
      if (!pages || pages.length === 0) {
        toast(
          'warning',
          `${paper.shortLabel} 的正文不在本地，无法补查`,
          '可以先在论文详情页点「重新解析」恢复正文（需要原文件或重新选择 PDF），再补查这一项。',
        )
        return null
      }
      try {
        const res = await requestRecheckField({
          fileName: paper.fileName,
          title: paper.title,
          pages,
          key,
        })
        if (!res.ok) {
          toast('error', `${FIELD_META[key].label} 补查没有完成`, res.message || '已保留原有取值与证据，可以重试。')
          return null
        }
        const items: Evidence[] = []
        const ids: string[] = []
        const stamp = Date.now()
        ;(res.evidence ?? []).forEach((ev, i) => {
          const id = `ev-${paper.id}-${key}-rc-${stamp}-${i}`
          items.push({
            id,
            paperId: paper.id,
            page: ev.page,
            section: `${FIELD_META[key].label}｜补查 · 第 ${ev.page} 页`,
            text: ev.quote,
            source: 'pdf',
          })
          ids.push(id)
        })
        if (items.length > 0) dispatch({ type: 'SET_EVIDENCE', paperId: paper.id, items })
        const prev = paper.fields[key]
        const status = res.status ?? 'missing'
        const next: PaperField = {
          key,
          value: status === 'missing' ? null : (res.value ?? null),
          status,
          origin: 'paper',
          evidenceIds: ids.length > 0 ? ids : (prev?.evidenceIds ?? []),
          note: res.note,
          checkState: status === 'missing' ? 'not_reported' : 'retrieval',
          support: undefined,
          supportReason: undefined,
          extracted: prev?.extracted,
        }
        dispatch({ type: 'SET_FIELDS', paperId: paper.id, fields: { [key]: next }, keepUserFields: true })
        if (prev?.origin === 'user') {
          toast(
            'info',
            `${FIELD_META[key].label}：本次补查的结果没有覆盖你的人工修改`,
            '人工修改仍然生效；补查到的取值与证据已记录，可在详情页对照。',
          )
        } else if (res.status === 'found') {
          toast(
            'success',
            `${FIELD_META[key].label}：补查到依据`,
            `已更新取值（第 ${(res.evidence ?? []).map((e) => e.page).join('、') || '—'} 页有原文片段）。${
              res.note ? `备注：${res.note}` : ''
            }`,
          )
        } else if (res.status === 'uncertain') {
          toast('warning', `${FIELD_META[key].label}：找到线索但需要确认`, res.note || '只找到部分依据，已标为「已有线索，需确认」。')
        } else {
          toast(
            'info',
            `${FIELD_META[key].label}：本次仍未找到明确说明`,
            res.note ||
              `已检索全部 ${res.checkedPages ?? pages.length} 页正文。这不等于原文一定没有写，可以换关键词或在原文里检索。`,
          )
        }
        return { status, value: next.value, note: res.note }
      } catch (e) {
        const info = e instanceof ApiError ? e.info : { message: e instanceof Error ? e.message : '补查失败' }
        toast('error', `${FIELD_META[key].label} 补查失败`, `${info.message} 已保留原有取值与证据，可以重试。`)
        return null
      }
    },
    [state.texts, toast],
  )

  const value: AppContextValue = {
    state,
    dispatch,
    scopedPapers,
    selectedPapers,
    evidenceMap,
    pagesOf,
    recheckOneField,
    toast,
    loadDemo,
    switchScope,
    uploadFiles,
    reextract,
    removePaper,
    resetAll,
    setDatasetScope,
    checkBackend,
    openEvidence,
    openDetective,
    closeDetective,
    openEvidenceItems,
    currentCollection,
    collectionPapers,
    importCatalog,
    createCollection,
    renameCollection,
    deleteCollection,
    addPapersToCollection,
    removePaperFromCollection,
    bootstrapTsCollection,
    runCollectionAnalysis,
    generateDirections,
    importCatalogPages,
    analyzeCollectionPapers,
    cancelAnalysis,
    collectionAnalysisStatus,
    editDirection,
    deleteDirection,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp 必须在 <AppProvider> 内使用')
  return ctx
}

/** 对比/检查页「已选问题」的读写（底部悬浮栏与问题卡片共用） */
export function usePickedProblems() {
  const { state, dispatch } = useApp()
  const picked = state.pickedProblems
  return {
    picked,
    isPicked: (id: string) => picked.includes(id),
    toggle: (id: string) => dispatch({ type: 'TOGGLE_PROBLEM', id }),
    set: (ids: string[]) => dispatch({ type: 'SET_PROBLEMS', ids }),
    clear: () => dispatch({ type: 'CLEAR_PROBLEMS' }),
  }
}

/**
 * 更新字段。
 * 人工补充的值标为「人工补充」，不会变成「已从论文找到」；
 * 论文原始抽取值与证据会保留在 field.extracted 里。
 */
export function useFieldEditor() {
  const { dispatch, toast } = useApp()
  return useCallback(
    (paper: Paper, key: FieldKey, value: string) => {
      const trimmed = value.trim()
      const status: FieldStatus = trimmed ? 'found' : 'missing'
      dispatch({ type: 'UPDATE_FIELD', paperId: paper.id, key, value: trimmed || null, status })
      toast(
        'success',
        trimmed ? '已记录人工补充，检查结果已同步刷新' : '已清空该字段，检查项会变为「未找到」',
        '人工补充的值会标注「人工补充」；论文原始抽取值与证据仍会保留。',
      )
    },
    [dispatch, toast],
  )
}
