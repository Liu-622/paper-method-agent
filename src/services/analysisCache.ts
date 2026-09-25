import type { Collection, MethodProfile, PageText, Paper, PaperRelation, ResearchDirection } from '@/types'

/**
 * 分析缓存与更新策略
 * ------------------------------------------------------------------
 * 目的：让「方法档案 / 分类 / 关系 / 演进摘要 / 研究方向」是**可持久化、可判断过期**的缓存，
 * 而不是每次进页面都要重新调用模型。默认操作复用有效缓存，只处理新增、失败或过期项。
 *
 * 缓存关联的四类信息（缺一不可，否则无法判断「这份结果还作不作数」）：
 *   1. 论文内容指纹      contentFingerprint —— 正文变了，单篇档案就过期
 *   2. 分析流程版本      pipelineVersion    —— 校验逻辑升级，旧结论一律作废重算
 *   3. 模型配置标识      modelId            —— 不含密钥，只记录 model + apiStyle + host
 *   4. 集合成员与输入版本 collectionStamp  —— 集合增删论文后，集合级摘要/关系/方向要更新
 */

/** 分析流程版本：只要确认逻辑（引文定位/归属/语义支持）变了，就把它 +1，旧结果自动视为过期。 */
export const ANALYSIS_PIPELINE_VERSION = 'analyze-v2/four-dimension'

/** 集合级产物（演进摘要、关系、方向）的版本，与单篇档案分开，因为它们的输入是整批论文。 */
export const COLLECTION_ARTIFACT_VERSION = 'collection-v2/case-extension'

export type Staleness = 'fresh' | 'missing' | 'stale-content' | 'stale-pipeline' | 'stale-model' | 'failed'

/** 单篇论文的分析来源记录（随结果一起持久化）。 */
export interface AnalysisProvenance {
  paperId: string
  /** 分析时该论文正文的内容指纹 */
  contentFingerprint: string
  /** 分析流程版本 */
  pipelineVersion: string
  /** 模型配置标识（不含密钥） */
  modelId: string
  analyzedAt: string
  /** 本次是否真的跑过语义复核 */
  semanticReviewRan: boolean
  /** 结果状态：ok=成功；partial=部分完成；failed=失败（上一份有效结果被保留） */
  status: 'ok' | 'partial' | 'failed'
  /** 失败/部分完成的原因，供界面如实展示 */
  note?: string
}

/** 集合级产物的生成记录。 */
export interface CollectionStamp {
  collectionId: string
  /** 生成时集合的成员指纹（成员一变，说明这批产物不再覆盖当前集合） */
  membershipFingerprint: string
  /** 生成时实际覆盖的论文 */
  coveredPaperIds: string[]
  /** 生成时失败/跳过的论文 */
  failedPaperIds: string[]
  artifactVersion: string
  generatedAt: string
  /** 生成时使用的模型标识 */
  modelId: string
}

/** 内容指纹：稳定、便宜、对空白与大小写不敏感，用于判断「正文是否变了」。 */
export function fingerprintText(pages: PageText[] | undefined, fallback = ''): string {
  const src = (pages ?? []).map((p) => `${p.page}:${String(p.text ?? '')}`).join('\n') || fallback
  return fnv1a(normalizeForHash(src))
}

/** 文件指纹：用于重复导入识别（同内容不同文件名也要能认出来）。 */
export function fingerprintFileParts(parts: { name?: string; size?: number; pageCount?: number; firstPageText?: string }): string {
  return fnv1a(normalizeForHash(`${parts.pageCount ?? 0}|${Math.round((parts.size ?? 0) / 512)}|${(parts.firstPageText ?? '').slice(0, 400)}`))
}

/**
 * 原文件字节内容指纹：SHA-256（浏览器 crypto.subtle；仅 localhost/https 可用）。
 * 不可用时退回「FNV-1a 逐字节」采样。用于跨集合去重——只看文件名/大小不可靠。
 */
export async function fingerprintBytes(file: File): Promise<string> {
  try {
    const buf = await file.arrayBuffer()
    const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
    if (subtle) {
      const digest = await subtle.digest('SHA-256', buf)
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    /* fall through */
  }
  const chunk = file.slice(0, 2_000_000)
  const buf = new Uint8Array(await chunk.arrayBuffer())
  let h = 0x811c9dc5
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return 'fnv-' + (h >>> 0).toString(16)
}

function normalizeForHash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[\u0000-\u001f]/g, '').trim()
}

/** FNV-1a 32bit：不需要加密强度，只需要稳定且够短。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function membershipFingerprint(collection: Collection | null | undefined, papers: Paper[]): string {
  if (!collection) return ''
  const ids = [...collection.paperIds].sort()
  const versions = ids.map((id) => `${id}@${papers.find((p) => p.id === id)?.analysisVersion ?? 0}`)
  return fnv1a(versions.join(','))
}

/** 模型配置标识：只记录可公开的定位信息，密钥永远不进来。 */
export function modelIdOf(health: { model?: string; apiStyle?: string; baseUrlHost?: string } | null | undefined): string {
  if (!health) return 'model:unknown'
  return `model:${health.model ?? '?'}|style:${health.apiStyle ?? '?'}|host:${health.baseUrlHost ?? '?'}`
}

/**
 * 判断单篇论文的缓存状态。
 * 只有 'fresh' 才可以直接复用；其余都要在用户点击「更新过期结果 / 分析尚未处理」时才处理。
 */
export function stalenessOf(
  paper: Paper,
  pages: PageText[] | undefined,
  profile: MethodProfile | undefined,
  prov: AnalysisProvenance | undefined,
  modelId: string,
): Staleness {
  if (!profile) return prov?.status === 'failed' ? 'failed' : 'missing'
  if (!prov) return 'stale-pipeline' // 旧数据没有来源记录，一律视为需要重算
  const fp = fingerprintText(pages, paper.textStored ? '' : paper.fileName)
  if (fp && prov.contentFingerprint && fp !== prov.contentFingerprint) return 'stale-content'
  if (prov.pipelineVersion !== ANALYSIS_PIPELINE_VERSION) return 'stale-pipeline'
  if (prov.status === 'failed') return 'failed'
  if (modelId && prov.modelId && modelId !== 'model:unknown' && prov.modelId !== modelId) return 'stale-model'
  return 'fresh'
}

export const STALENESS_LABEL: Record<Staleness, string> = {
  fresh: '结果有效',
  missing: '尚未分析',
  'stale-content': '正文已更新',
  'stale-pipeline': '分析流程已升级',
  'stale-model': '模型配置已变化',
  failed: '上次分析失败',
}

export type AnalysisMode = 'view' | 'analyze-new' | 'update-stale' | 'force'

export interface AnalysisPlan {
  mode: AnalysisMode
  /** 本次真正会调用模型的论文 */
  toRun: { paper: Paper; staleness: Staleness }[]
  /** 直接复用缓存、不调用模型的论文 */
  reused: { paper: Paper; staleness: Staleness }[]
  /** 各类状态的数量统计，供界面展示 */
  counts: Record<Staleness, number>
}

/**
 * 计算一次分析要做什么。
 *
 * - view         只看已有结果，不调用模型（默认）
 * - analyze-new  只分析「尚未分析 / 上次失败」的论文
 * - update-stale 上面两者 + 已过期的（正文变化 / 流程升级 / 模型变化）
 * - force        全部重跑（调用方必须先告诉用户涉及多少篇，不允许后台静默全跑）
 */
export function planAnalysis(
  papers: Paper[],
  texts: Record<string, PageText[]>,
  profiles: Record<string, MethodProfile>,
  provenance: Record<string, AnalysisProvenance>,
  modelId: string,
  mode: AnalysisMode,
): AnalysisPlan {
  const counts: Record<Staleness, number> = { fresh: 0, missing: 0, 'stale-content': 0, 'stale-pipeline': 0, 'stale-model': 0, failed: 0 }
  const toRun: AnalysisPlan['toRun'] = []
  const reused: AnalysisPlan['reused'] = []

  for (const p of papers) {
    const st = stalenessOf(p, texts[p.id], profiles[p.id], provenance[p.id], modelId)
    counts[st] += 1
    const run =
      mode === 'force'
        ? true
        : mode === 'analyze-new'
          ? st === 'missing' || st === 'failed'
          : mode === 'update-stale'
            ? st !== 'fresh'
            : false
    if (run) toRun.push({ paper: p, staleness: st })
    else reused.push({ paper: p, staleness: st })
  }

  // 先跑没分析过的，再跑失败的，最后才更新过期的 —— 让用户尽快看到新内容
  const order: Record<Staleness, number> = { missing: 0, failed: 1, 'stale-content': 2, 'stale-pipeline': 3, 'stale-model': 4, fresh: 5 }
  toRun.sort((a, b) => order[a.staleness] - order[b.staleness])

  return { mode, toRun, reused, counts }
}

/**
 * 集合级产物是否过期：成员变了、产物版本变了、或模型变了。
 * 过期时旧结果仍然可看，只是要标注「生成范围与时间」。
 */
export function collectionStampStale(stamp: CollectionStamp | undefined, collection: Collection | null, papers: Paper[], modelId: string): boolean {
  if (!stamp) return true
  if (stamp.artifactVersion !== COLLECTION_ARTIFACT_VERSION) return true
  if (modelId && stamp.modelId && modelId !== 'model:unknown' && stamp.modelId !== modelId) return true
  if (collection && stamp.membershipFingerprint !== membershipFingerprint(collection, papers)) return true
  return false
}

/** 集合级产物的一句话说明：生成范围与时间。过期时如实说明。 */
export function collectionStampNote(stamp: CollectionStamp | undefined, stale: boolean, papers: Paper[]): string {
  if (!stamp) return '还没有生成过集合级结果（演进摘要 / 关系 / 方向）。'
  const when = new Date(stamp.generatedAt)
  const time = Number.isNaN(when.getTime()) ? stamp.generatedAt : when.toLocaleString()
  const scope = stamp.coveredPaperIds.map((id) => papers.find((p) => p.id === id)?.shortLabel ?? id.slice(0, 6)).join('、')
  const failed = stamp.failedPaperIds.length
  const base = `生成于 ${time}，覆盖 ${stamp.coveredPaperIds.length} 篇${scope ? `（${scope}）` : ''}${failed ? `，${failed} 篇未完成` : ''}。`
  return stale ? `${base} 集合成员或分析流程已变化，以下结论尚未覆盖当前全部论文 —— 仍可查看，但请点击「更新集合结果」。` : base
}

/** 只保留用户手工编辑/收藏的内容，集合更新时不得删除。 */
export function keepUserOwned<T extends { edited?: boolean; favorite?: boolean; manualStatus?: string; generatedBy?: string }>(items: T[]): T[] {
  return items.filter((i) => i?.edited === true || i?.favorite === true || i?.manualStatus !== undefined || i?.generatedBy === 'manual')
}

/** 关系里的用户手改项：集合重算时保留，不被程序生成的候选覆盖。 */
export function manualRelations(relations: PaperRelation[]): PaperRelation[] {
  return relations.filter((r) => r.generatedBy === 'manual' || r.manualStatus !== undefined)
}

/** 方向里的用户想法与用户编辑项：集合重算时保留。 */
export function keepUserDirections(directions: ResearchDirection[]): ResearchDirection[] {
  return directions.filter((d) => d.sourceType === 'user-idea' || d.edited === true)
}
