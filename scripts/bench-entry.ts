/**
 * benchmark 用的工具侧计算入口（会被 esbuild 打包成 Node 可跑的模块）
 * 把「字段抽取结果」变成工具的结构化输出：实验记录、检查项、引用页码。
 */
import type { Paper, PageText } from '@/types'
import { runFairnessCheck, runReproCheck } from '@/services/checks'
import { buildRecords } from '@/services/records'
import { normalizeValue, setOf } from '@/services/normalize'

export interface PapersInput {
  id: string
  shortLabel: string
  fileName: string
  title: string
  pages: PageText[]
  /** /api/extract 返回的 fields：{key: {status, value, evidence:[{page,quote}], support}} */
  fields: Record<string, { status: string; value: string | null; evidence: { page: number; quote: string }[]; support?: string }>
  coverage?: Paper['coverage']
}

/** 把抽取结果还原成前端使用的 Paper 结构（证据 id 与 store 里生成规则一致） */
export function toPaper(input: PapersInput): Paper {
  const fields: Paper['fields'] = {}
  Object.entries(input.fields || {}).forEach(([key, raw]) => {
    const evidenceIds = (raw.evidence || []).map((_, i) => `ev-${input.id}-${key}-${i}`)
    fields[key as keyof Paper['fields']] = {
      key: key as never,
      value: raw.value,
      status: raw.status as never,
      origin: 'paper',
      evidenceIds,
      support: raw.support as never,
    }
  })
  return {
    id: input.id,
    source: 'user',
    shortLabel: input.shortLabel,
    fileName: input.fileName,
    fileSize: 0,
    title: input.title,
    year: 2024,
    venue: '—',
    status: 'parsed',
    uploadedAt: new Date().toISOString(),
    fields,
    pageCount: input.pages.length,
    textStored: true,
    coverage: input.coverage,
  }
}

/** 每篇论文的「证据 id → 页码 / 原文」，用于验证引用是否真的存在 */
export function evidenceIndex(input: PapersInput) {
  const out: Record<string, { paperId: string; shortLabel: string; page: number; quote: string }> = {}
  Object.entries(input.fields || {}).forEach(([key, raw]) => {
    ;(raw.evidence || []).forEach((ev, i) => {
      out[`ev-${input.id}-${key}-${i}`] = {
        paperId: input.id,
        shortLabel: input.shortLabel,
        page: ev.page,
        quote: ev.quote,
      }
    })
  })
  return out
}

export function analyze(inputs: PapersInput[], scopes: (string | null)[] = [null]) {
  const papers = inputs.map(toPaper)
  const evidence: Record<string, { paperId: string; shortLabel: string; page: number; quote: string }> = {}
  inputs.forEach((i) => Object.assign(evidence, evidenceIndex(i)))

  const fairnessByScope: Record<string, ReturnType<typeof runFairnessCheck>> = {}
  for (const s of scopes) {
    fairnessByScope[s === null ? 'none' : s] = runFairnessCheck(papers, s)
  }

  return {
    fairnessByScope,
    repro: runReproCheck(papers),
    records: papers.map((p) => ({ paperId: p.id, shortLabel: p.shortLabel, records: buildRecords(p) })),
    evidence,
    datasets: papers.map((p) => ({
      paperId: p.id,
      shortLabel: p.shortLabel,
      datasets: [...setOf(normalizeValue('dataset', p.fields.dataset?.value ?? ''))],
    })),
  }
}
