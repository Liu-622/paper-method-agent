import type { ExperimentRecord, FieldKey, FieldStatus, Paper } from '@/types'
import { normalizeValue } from './normalize'
import { rawDatasetsOf, sameDataset, scopedValue } from './scope'

/**
 * 结构化实验记录
 * ------------------------------------------------------------------
 * 把「一篇论文在一个数据集上的实验设置」整理成一条记录，
 * 之后所有比较都在**记录与记录**之间进行，不再在比较路径里临时裁剪整段文本。
 *
 * 记录里每一项都带：
 *  - 取值（已按数据集口径取到，并对数值做了归一化）
 *  - 该取值的读取状态（已找到 / 未找到 / 未检查 / 需要确认 / 人工补充）
 *  - 证据 id（可直接跳转到 PDF 原文与页码）
 *  - 是否来自人工补充
 *
 * 生成方式是确定性的：只用已验证过的字段值与原文，不额外调用模型，
 * 因此同一次抽取结果生成的记录是稳定可复现的。
 */

/** 参与比较的字段（顺序即界面展示顺序） */
const RECORD_FIELDS: FieldKey[] = [
  'split',
  'splitRange',
  'sampleInterval',
  'horizon',
  'metrics',
  'preprocessing',
]

/** 关键项：这几项齐了才算 complete */
const KEY_FIELDS: FieldKey[] = ['split', 'sampleInterval', 'horizon', 'metrics']

function fieldStatusOf(paper: Paper, key: FieldKey, value: string | null): FieldStatus {
  const field = paper.fields[key]
  if (!field) return 'missing'
  if (field.origin === 'user') return 'found'
  if (field.status === 'found' && value) return 'found'
  return field.status
}

/** 论文里没有被处理到的页码（截断丢弃 / 抽不到文字） */
function unprocessed(paper: Paper): number[] {
  const c = paper.coverage
  if (!c) return []
  return [...new Set([...(c.skippedPages || []), ...(c.emptyPages || [])])]
}

/**
 * 生成一篇论文的全部实验记录（每个数据集一条）。
 * 若论文没有读到数据集字段，则退化为一条 dataset='（未读到数据集）' 的全局记录，
 * 这样界面仍能看到它的实验设置，但不会被当成"某个数据集上的可比实验"。
 *
 * 结果按「论文对象 + fields 引用」缓存：store 里任何一次字段变更都会换掉 fields 对象引用，
 * 因此缓存不会过期，同时避免在检查里每个字段都重建一次记录。
 */
const recordCache = new WeakMap<Paper, { fieldsRef: unknown; records: ExperimentRecord[] }>()

export function buildRecords(paper: Paper): ExperimentRecord[] {
  const hit = recordCache.get(paper)
  if (hit && hit.fieldsRef === paper.fields) return hit.records
  const records = computeRecords(paper)
  recordCache.set(paper, { fieldsRef: paper.fields, records })
  return records
}

function computeRecords(paper: Paper): ExperimentRecord[] {
  const datasets = rawDatasetsOf(paper)
  const globalFallback = datasets.length === 0
  const list = globalFallback ? ['（未读到数据集）'] : datasets

  return list.map((dataset) => {
    const values: Partial<Record<FieldKey, string | null>> = {}
    const fieldStatus: Partial<Record<FieldKey, FieldStatus>> = {}
    const evidenceIds: string[] = []
    let scopedCount = 0
    let globalCount = 0

    for (const key of RECORD_FIELDS) {
      const field = paper.fields[key]
      const rawValue = field?.value ?? null
      let value: string | null = null

      // 优先使用抽取阶段**按数据集分别保存**的结构化取值：
      // 抽取时服务端会把 dataset / split / sampleInterval 拆成 perDataset 列表，
      // 这里按数据集精确匹配，避免再靠"从一整段文字里猜哪句属于哪个数据集"（那是漏判的根因）。
      const structured = field?.perDataset?.perDataset?.find((e) => sameDataset(e.dataset, dataset))
      if (structured?.value && field?.status !== 'missing' && !globalFallback) {
        value = structured.value
        scopedCount += 1
        if (!evidenceIds.length && field?.evidenceIds?.length) evidenceIds.push(...field.evidenceIds)
      } else if (rawValue && field?.status !== 'missing' && !globalFallback) {
        const scoped = scopedValue(rawValue, dataset, datasets)
        value = scoped
        if (scoped !== null) {
          if (scoped === rawValue) globalCount += 1
          else scopedCount += 1
        }
      } else {
        value = rawValue
      }

      values[key] = value
      fieldStatus[key] = fieldStatusOf(paper, key, value)
      if (value && field?.evidenceIds?.length) evidenceIds.push(...field.evidenceIds)
    }

    const foundKeys = KEY_FIELDS.filter((k) => values[k] && fieldStatus[k] === 'found')
    const uncheckedKeys = RECORD_FIELDS.filter((k) => fieldStatus[k] === 'unchecked')
    const status: ExperimentRecord['status'] =
      foundKeys.length >= 3
        ? 'complete'
        : foundKeys.length === 0
          ? 'insufficient'
          : 'partial'

    const notes: string[] = []
    if (scopedCount > 0) notes.push('取值来自论文按数据集分别说明的段落')
    else if (globalCount > 0) notes.push('论文没有按数据集分别说明，该项为全局设置（各数据集通用）')
    if (uncheckedKeys.length > 0) {
      notes.push(
        `第 ${unprocessed(paper).join('、')} 页未被处理，相关项只能说明"已处理的页里没有读到"`,
      )
    }

    const metricsText = values.metrics ?? null

    return {
      paperId: paper.id,
      dataset,
      split: values.split ?? null,
      testRange: values.splitRange ?? null,
      sampleInterval: values.sampleInterval ?? null,
      horizon: values.horizon ?? null,
      metrics: metricsText ? [...new Set(normalizeValue('metrics', metricsText).split('+').filter(Boolean))] : [],
      preprocessing: values.preprocessing ?? null,
      evidenceIds: [...new Set(evidenceIds)],
      status,
      fieldStatus,
      scopeNote: notes.join('；') || undefined,
    }
  })
}

/** 取指定数据集（按身份规则匹配）对应的那条记录 */
export function recordOf(paper: Paper, dataset: string | null): ExperimentRecord | null {
  const records = buildRecords(paper)
  if (!dataset) return records[0] ?? null
  return records.find((r) => sameDataset(r.dataset, dataset)) ?? null
}

/** 选定数据集后，各论文的记录 + 覆盖情况 */
export function recordComparison(papers: Paper[], dataset: string | null): {
  dataset: string | null
  rows: { paper: Paper; record: ExperimentRecord | null; hasDataset: boolean }[]
  missing: Paper[]
} {
  const rows = papers.map((paper) => {
    if (!dataset) {
      return { paper, record: buildRecords(paper)[0] ?? null, hasDataset: true }
    }
    const record = recordOf(paper, dataset)
    return { paper, record, hasDataset: record !== null }
  })
  return {
    dataset,
    rows,
    missing: rows.filter((r) => !r.hasDataset).map((r) => r.paper),
  }
}

/** 一条记录是否可用于比较某个字段 */
export function recordValue(record: ExperimentRecord | null, key: FieldKey): string | null {
  if (!record) return null
  if (key === 'split') return record.split
  if (key === 'splitRange') return record.testRange
  if (key === 'sampleInterval') return record.sampleInterval
  if (key === 'horizon') return record.horizon
  if (key === 'metrics') return record.metrics.length ? record.metrics.join('、') : null
  if (key === 'preprocessing') return record.preprocessing
  return null
}
