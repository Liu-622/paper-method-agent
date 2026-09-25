import type {
  CheckPerPaper,
  FairnessItem,
  FairnessVerdict,
  FieldKey,
  FieldOrigin,
  FieldStatus,
  Paper,
  ReproItem,
  ReproVerdict,
} from '@/types'
import { FAIRNESS_SPEC, REPRO_SPEC } from '@/data/fieldSchema'
import { reproRuleId, ruleIdOfFairness } from '@/data/rules'
import {
  describeDuration,
  describeHorizon,
  describeInterval,
  describeNormalized,
  horizonDurationMinutes,
  normalizeHorizon,
  normalizeSampleInterval,
  normalizeSplit,
  normalizeSplitRange,
  normalizeValue,
  normalizedEqual,
  setOf,
} from './normalize'
import { commonDatasets, paperUsesDataset, scopedValue } from './scope'
import { recordOf, recordValue } from './records'

/**
 * 实验检查逻辑（纯函数，本地确定性规则）
 * ------------------------------------------------------------------
 * 流程：抽取字段（含真实原文证据）→ 程序按规则检查 → 解释结果 → 用户补充字段后重新检查。
 *
 * 重要约束：
 * 1. 只判断「能不能比较 / 缺什么信息」，**不按论文里的数字给方法排名**。
 * 2. 「未找到」只代表本次上传的文件里没有读到该项，不代表论文有错误。
 * 3. 复合项不能只看单一数字：
 *    - 划分：比例相同 ≠ 用同一段测试数据 → 必须一起核对时间区间；
 *    - 跨度：步数相同 ≠ 预测时长相同 → 必须一起核对采样间隔。
 * 4. 人工补充的值单独标记为「人工补充」，绝不当作「已从论文找到」。
 */

interface FieldView {
  value: string | null
  status: FieldStatus
  origin: FieldOrigin
  evidenceIds: string[]
  normalized: string
  extractedValue?: string | null
  /** 论文里没有被处理到的页码（截断丢弃 / 抽不到文字），这些页不能算"查过了" */
  uncheckedPages: number[]
  /** 限定了数据集口径时：这篇论文没有单独说明该数据集上的这项设置 */
  scopedOut: boolean
  /** 限定了数据集口径时：实际用于比较的那段文本 */
  scopeText?: string
}

/** 论文里没有被真正检查过的页码 */
export function unprocessedPages(paper: Paper): number[] {
  const c = paper.coverage
  if (!c) return []
  return [...new Set([...(c.skippedPages || []), ...(c.emptyPages || [])])].sort((a, b) => a - b)
}

/**
 * 字段的有效状态。
 * 关键点：**「检索后未找到」与「还没检查」必须分开**。
 * 如果论文有页面没被处理（正文超长被截断、页面抽不出文字），
 * 那么一个 missing 字段只能说明"在已处理的页里没找到"，不能声称论文没写。
 */
export function effectiveFieldStatus(paper: Paper, status: FieldStatus): FieldStatus {
  if (status !== 'missing') return status
  if (paper.status !== 'parsed') return status
  return unprocessedPages(paper).length > 0 ? 'unchecked' : 'missing'
}

/**
 * 一个字段在界面上应该显示成哪种状态。
 * 这是「信息不足」四分类的**唯一来源** —— 不要在前端各处自己拼文案。
 *
 *  - ok           已确认：找到了明确依据，且证据支持这个取值
 *  - need_confirm 已有线索，需确认：有值，但集合字段缺"实验用途"证据 / 原文只部分支持
 *  - recovered    定向检索找回：初次漏抽，二次检索找回（属于工具的过程信息，不是论文缺失）
 *  - not_found    待核对：本次检索未找到明确说明（**不等于**原文一定没写）
 *  - not_checked  尚未检查完整：有页面没有可读文本，或论文还没解析完
 */
export type FieldDisplayState = 'ok' | 'need_confirm' | 'recovered' | 'not_found' | 'not_checked'

export function fieldDisplayState(
  paper: Paper,
  key: FieldKey,
): { state: FieldDisplayState; label: string; hint: string } {
  const field = paper.fields[key]
  const unparsed = paper.status !== 'parsed'
  const pendingPages = unprocessedPages(paper)

  if (unparsed) {
    return {
      state: 'not_checked',
      label: '尚未检查完整',
      hint: '这篇论文还没有完成解析/抽取，现在看到的是不完整结果。',
    }
  }
  if (!field || field.status === 'missing') {
    if (pendingPages.length > 0) {
      return {
        state: 'not_checked',
        label: '尚未检查完整',
        hint: `第 ${pendingPages.slice(0, 8).join('、')} 页没有可读文本，这一项还没被完整检查。`,
      }
    }
    if (field?.checkState === 'unchecked') {
      return { state: 'not_checked', label: '尚未检查完整', hint: '有页面没有可读文本，这一项还没被完整检查。' }
    }
    return {
      state: 'not_found',
      label: '本次未找到明确说明',
      hint: '已对全文正文做过定向检索（含同义词），仍未找到明确依据；这不等于原文一定没有写。',
    }
  }
  if (field.status === 'uncertain' || field.usageOk === false || field.support === 'partial') {
    return {
      state: 'need_confirm',
      label: '已有线索，需确认',
      hint:
        field.usageOk === false
          ? '名字在正文里出现，但没有找到"用于实验"的表述（如 evaluate on / compared with），需要核对。'
          : field.support === 'partial'
            ? '原文只支持这个取值的一部分，还有要点没被覆盖。'
            : '原文表述不够明确，只能确定一部分。',
    }
  }
  if (field.checkState === 'retrieval') {
    return {
      state: 'recovered',
      label: '定向检索找回',
      hint: '第一次抽取没有命中，按关键词对全文做定向检索后找到依据（属于工具的漏抽，不是论文缺失）。',
    }
  }
  return { state: 'ok', label: '已确认', hint: '找到明确依据，且证据支持这个取值。' }
}

function fieldOf(paper: Paper, key: FieldKey, scope?: string | null): FieldView {
  const field = paper.fields[key]
  const unparsed = paper.status !== 'parsed'
  const rawValue = field?.value ?? null
  const rawStatus: FieldStatus = unparsed ? 'missing' : (field?.status ?? 'missing')
  const uncheckedPages = unprocessedPages(paper)

  // 数据集口径：从**结构化实验记录**里取这一项在该数据集上的取值（不再临时裁剪整段文本）
  let value = rawValue
  let status = effectiveFieldStatus(paper, rawStatus)
  let scopedOut = false
  let scopeText: string | undefined

  if (scope && key !== 'dataset' && rawValue && rawStatus !== 'missing') {
    const record = recordOf(paper, scope)
    const scoped = record ? recordValue(record, key) : null
    if (scoped === null) {
      scopedOut = true
      status = 'missing'
      value = null
    } else {
      scopeText = scoped
      value = scoped
    }
  }

  return {
    value,
    status,
    origin: field?.origin ?? 'paper',
    evidenceIds: field?.evidenceIds ?? [],
    normalized: unparsed || value === null ? '' : normalizeValue(key, value),
    extractedValue: field?.extracted?.value ?? null,
    uncheckedPages: status === 'unchecked' ? uncheckedPages : [],
    scopedOut,
    scopeText,
  }
}

function isUnparsed(paper: Paper): boolean {
  return paper.status !== 'parsed'
}

function toCheckPerPaper(
  paper: Paper,
  key: FieldKey,
  view: FieldView,
  extra?: string,
): CheckPerPaper {
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    value: view.value,
    normalized: view.normalized,
    status: view.status,
    origin: view.origin,
    evidenceIds: view.evidenceIds,
    unparsed: isUnparsed(paper),
    extra,
    extractedValue: view.extractedValue,
  }
}

function names(list: Paper[]): string {
  return list.map((p) => p.shortLabel).join('、')
}

/**
 * 限定口径时，某篇论文在这一项上为什么"信息不足"：
 *  - 它压根没用这个数据集 → 说清楚「x/y 篇包含」，不能假装可比；
 *  - 用了这个数据集，但没单独说明这一项 → 说"没有单独说明"。
 */
function scopedOutReason(
  rows: { paper: Paper }[],
  scope: string | null,
  label: string,
): string {
  const noDataset = rows.filter((r) => !paperUsesDataset(r.paper, scope ?? ''))
  const notStated = rows.filter((r) => paperUsesDataset(r.paper, scope ?? ''))
  const total = new Set(rows.map((r) => r.paper.id)).size
  const parts: string[] = []
  if (noDataset.length > 0) {
    parts.push(
      `${names(noDataset.map((r) => r.paper))} 没有使用「${scope}」这个数据集（共同数据集里它只被 ${
        total - noDataset.length
      }/${total} 篇论文用到），因此这些论文在该数据集上的${label}并不存在，不能算作已比较`,
    )
  }
  if (notStated.length > 0) {
    parts.push(`${names(notStated.map((r) => r.paper))} 没有单独说明「${scope}」上的${label}`)
  }
  return `无法在「${scope}」上比较${label}：${parts.join('；')}。可以改选其他共同数据集，或按论文整体口径比较。`
}

/** 人工补充的提示语 */
function manualHint(rows: { paper: Paper; view: FieldView }[], usage = '该项'): string {
  const manual = rows.filter((r) => r.view.origin === 'user')
  if (manual.length === 0) return ''
  return `（${names(manual.map((r) => r.paper))} 的${usage}为人工补充，论文原文里没有读到，不作为论文依据）`
}

/* ------------------------------------------------------------------ */
/* 公平性检查                                                          */
/* ------------------------------------------------------------------ */

function fairnessHint(key: FieldKey, perPaper: CheckPerPaper[]): string {
  const values = perPaper.map((p) => p.normalized).filter(Boolean)
  switch (key) {
    case 'dataset': {
      const counts = perPaper.filter((p) => p.normalized).map((p) => setOf(p.normalized).size)
      if (counts.length && Math.min(...counts) < Math.max(...counts)) {
        return '有一方覆盖了更多数据集：只在部分数据集上报告结果时，平均值会偏向更容易的数据集，跨论文比分会失真。'
      }
      return '数据集不完全相同，误差的绝对水平随数据集的周期性强度变化，数字不能直接放在一起比较。'
    }
    case 'metrics': {
      const sets = perPaper.filter((p) => p.normalized).map((p) => setOf(p.normalized))
      if (sets.length >= 2) {
        const [a, b] = sets
        const aSubB = [...a].every((x) => b.has(x))
        const bSubA = [...b].every((x) => a.has(x))
        if (aSubB !== bSubA) {
          const extra = aSubB ? [...b].filter((x) => !a.has(x)) : [...a].filter((x) => !b.has(x))
          return `有一方额外报告了 ${extra.join('、')}，指标集合不同意味着不存在可换算的公式，数值不能混在一起排名。`
        }
      }
      return '指标集合不完全相同，不同指标对误差的敏感度不同，数值之间不可互换。'
    }
    case 'preprocessing': {
      const kinds = new Set(values.map((v) => v.split(':')[0]))
      const srcs = new Set(values.map((v) => v.split(':')[1]).filter(Boolean))
      if (kinds.size > 1) {
        return '归一化方式不同会改变序列幅值与分布，同一模型在两种预处理下的误差不可直接对照。'
      }
      if (srcs.size > 1) {
        return '统计量来源不同：使用全量数据（含测试段）统计量会引入信息泄漏，通常会得到偏乐观的误差，两边分数不在同一起跑线。'
      }
      return '两边的预处理细节不完全一致。'
    }
    case 'split':
      return '划分比例相同也可能用了不同的测试区间，测试段覆盖的时间不同，外推难度就不同，误差不可直接对照。'
    case 'horizon':
      return '误差随预测时长累积。采样间隔不同时，同样的步数对应的实际预测时长差很多，MSE 的量级本身就不一样。'
    case 'evalProtocol':
      return '滚动预测每一步都有真实历史值可用，单次预测要一次性外推整段跨度，后者更难，两者误差不可直接比较。'
    case 'baselines':
      return '「相对提升」的分母不同：基线集合不一样的论文，提升百分比不能跨论文比较。'
    default:
      return '该条件不一致，会影响结果的可比性。'
  }
}

/** 单字段比较 */
function compareSingle(
  spec: { id: string; label: string; key: FieldKey; keys: FieldKey[]; whyItMatters: string },
  papers: Paper[],
  scope: string | null = null,
): FairnessItem {
  const rows = papers.map((p) => ({ paper: p, view: fieldOf(p, spec.key, scope) }))
  const perPaper = rows.map((r) => toCheckPerPaper(r.paper, spec.key, r.view, scopeExtra(r, scope)))
  const unparsed = rows.filter((r) => isUnparsed(r.paper))
  const scopedOut = rows.filter((r) => !isUnparsed(r.paper) && r.view.scopedOut)
  const noValue = rows.filter(
    (r) => !isUnparsed(r.paper) && !r.view.scopedOut && r.view.status !== 'uncertain' && !r.view.normalized,
  )
  const vague = rows.filter((r) => !isUnparsed(r.paper) && r.view.status === 'uncertain')
  const unchecked = rows.filter((r) => !isUnparsed(r.paper) && r.view.status === 'unchecked')
  const scopeNote = scope ? `（口径：${scope}）` : ''

  let verdict: FairnessVerdict = 'consistent'
  let reason = ''
  // 「已知差异 + 另若干篇待核对」：两者要同时展示，不能被未知值盖掉
  let partial = false
  let pendingPaperLabels: string[] = []

  if (papers.length < 2) {
    verdict = 'insufficient'
    reason = '需要至少选择 2 篇论文才能比较实验条件。'
  } else if (unparsed.length > 0) {
    verdict = 'insufficient'
    reason = `有 ${unparsed.length} 篇论文还没有完成字段抽取（${names(
      unparsed.map((r) => r.paper),
    )}），无法读取其${spec.label}，因此当前无法判断是否一致。`
  } else if (scopedOut.length > 0) {
    verdict = 'insufficient'
    reason = scopedOutReason(scopedOut, scope, spec.label)
  } else if (noValue.length + vague.length > 0) {
    // 关键：**已知差异不能被"另一篇未知"盖掉**。
    // 只要能读到值的论文 ≥2 篇，就先比较这些；同时把"还有 N 篇待核对"明确写出来。
    const pendingRows = [...noValue, ...vague, ...unchecked]
    const readable = rows.filter((r) => !pendingRows.includes(r))
    const pendingLabels = pendingRows.map((r) => r.paper.shortLabel)
    const pendingNote = `另有 ${pendingRows.length} 篇待核对（${pendingLabels.join(
      '、',
    )}）：${pendingRows
      .map((r) =>
        noValue.includes(r)
          ? `${r.paper.shortLabel} 没有给出${spec.label}`
          : vague.includes(r)
            ? `${r.paper.shortLabel} 只给了不完整的说法`
            : `${r.paper.shortLabel} 有页面未检查`,
      )
      .join('；')}。`

    if (readable.length >= 2) {
      const first = readable[0]
      const same = readable.every((r) => normalizedEqual(first.view.normalized, r.view.normalized, spec.key))
      const readableList = readable
        .map((r) => `${r.paper.shortLabel}：${describeNormalized(spec.key, r.view.normalized)}`)
        .join('；')
      if (same) {
        verdict = 'consistent'
        reason = `能读到的 ${readable.length} 篇论文的${spec.label}一致${scopeNote}：${describeNormalized(
          spec.key,
          first.view.normalized,
        )}。${pendingNote}${manualHint(rows, spec.label)}`
      } else {
        verdict = 'different'
        reason = `已发现差异${scopeNote} —— ${readableList}。${pendingNote}`
      }
      partial = true
      pendingPaperLabels = pendingLabels
    } else {
      verdict = 'insufficient'
      const parts: string[] = []
      if (noValue.length > 0) {
        parts.push(`${noValue.length} 篇没有给出${spec.label}（${names(noValue.map((r) => r.paper))}）`)
      }
      if (vague.length > 0) {
        parts.push(`${vague.length} 篇只给了不完整的说法、需要回原文确认（${names(vague.map((r) => r.paper))}）`)
      }
      if (unchecked.length > 0) {
        parts.push(
          `${names(unchecked.map((r) => r.paper))} 还有页面没有被检查到（第 ${unchecked
            .map((r) => r.view.uncheckedPages.join('、'))
            .join('；')} 页），只能说明已处理的页面里没有读到`,
        )
      }
      reason = `这项无法比较：${parts.join('，')}。仅凭已读到的内容无法判断两边是否一致。`
    }
  } else {
    const first = rows[0]
    const same = rows.every((r) => normalizedEqual(first.view.normalized, r.view.normalized, spec.key))
    if (same) {
      verdict = 'consistent'
      reason = `所选 ${rows.length} 篇论文的${spec.label}一致${scopeNote}：${describeNormalized(
        spec.key,
        first.view.normalized,
      )}。${manualHint(rows, spec.label)}`
    } else {
      verdict = 'different'
      const list = rows
        .map((r) => `${r.paper.shortLabel}：${describeNormalized(spec.key, r.view.normalized)}`)
        .join('；')
      reason = `各论文的${spec.label}不完全相同${scopeNote} —— ${list}。`
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    key: spec.key,
    keys: spec.keys,
    verdict,
    reason,
    whyItMatters: spec.whyItMatters,
    perPaper,
    hasManualInput: rows.some((r) => r.view.origin === 'user'),
    scope,
    partial,
    pendingPaperLabels,
  }
}

/** 限定口径时给每篇论文补一句「本次比较用的是哪段说明」 */
function scopeExtra(row: { paper: Paper; view: FieldView }, scope: string | null): string | undefined {
  if (!scope) return undefined
  if (row.view.scopedOut) return `论文没有单独说明「${scope}」上的这项设置`
  return `口径：${scope}｜取自原文的这段说明：${(row.view.scopeText || '').slice(0, 120)}`
}

/**
 * 划分：比例 + 时间区间一起看。
 * 比例相同但区间未知 → 信息不足（不能算「条件一致」）。
 */
function compareSplit(
  spec: { id: string; label: string; key: FieldKey; keys: FieldKey[]; whyItMatters: string },
  papers: Paper[],
  scope: string | null = null,
): FairnessItem {
  const rows = papers.map((p) => ({
    paper: p,
    ratio: normalizeSplit(fieldOf(p, 'split', scope).value ?? ''),
    range: normalizeSplitRange(fieldOf(p, 'splitRange', scope).value ?? ''),
    ratioField: fieldOf(p, 'split', scope),
    rangeField: fieldOf(p, 'splitRange', scope),
  }))

  const perPaper = rows.map((r) =>
    toCheckPerPaper(
      r.paper,
      'split',
      {
        ...r.ratioField,
        // 复合项：把比例与区间的证据合并，方便「查看双方证据」一次看全
        evidenceIds: [...r.ratioField.evidenceIds, ...r.rangeField.evidenceIds],
      },
      `测试区间：${
        r.rangeField.value
          ? describeNormalized('splitRange', r.range)
          : r.rangeField.scopedOut
            ? `论文没有单独说明「${scope}」上的测试区间`
            : '论文未说明（无法确认测试段是哪一段时间）'
      }${r.rangeField.origin === 'user' ? '（人工补充）' : ''}${
        scope
          ? `｜口径：${scope}（取自原文：${(r.ratioField.scopeText || r.rangeField.scopeText || '').slice(0, 90)}）`
          : ''
      }`,
    ),
  )

  const scopedOut = rows.filter((r) => !isUnparsed(r.paper) && (r.ratioField.scopedOut || r.rangeField.scopedOut))
  const unparsed = rows.filter((r) => isUnparsed(r.paper))
  let verdict: FairnessVerdict = 'consistent'
  let reason = ''
  // 「已知差异 + 另若干篇待核对」需要同时展示
  let partial = false
  let pendingPaperLabels: string[] = []

  if (papers.length < 2) {
    verdict = 'insufficient'
    reason = '需要至少选择 2 篇论文才能比较实验条件。'
  } else if (unparsed.length > 0) {
    verdict = 'insufficient'
    reason = `有 ${unparsed.length} 篇论文还没有完成字段抽取（${names(unparsed.map((r) => r.paper))}），无法读取划分信息。`
  } else if (scopedOut.length > 0) {
    verdict = 'insufficient'
    reason = scopedOutReason(scopedOut, scope, '划分')
  } else if (rows.some((r) => !r.ratio)) {
    // **已知的划分差异不能被"另一篇没写"盖掉**：能读到比例的论文 ≥2 篇时先比较它们，
    // 同时明确列出"还有几篇待核对"。
    const withRatio = rows.filter((r) => r.ratio)
    const pending = rows.filter((r) => !r.ratio).map((r) => r.paper.shortLabel)
    const pendingNote = `另有 ${pending.length} 篇待核对（${pending.join('、')}）：${
      withRatio.length >= 2 ? '这几篇没有给出划分比例，不能因此断定它们与上面几篇不同。' : '没有给出划分比例。'
    }`
    if (withRatio.length >= 2) {
      const sameRatio = withRatio.every((r) => r.ratio === withRatio[0].ratio)
      partial = true
      pendingPaperLabels = pending
      if (sameRatio) {
        verdict = 'consistent'
        reason = `能读到的 ${withRatio.length} 篇划分比例一致（${withRatio[0].ratio}）。${pendingNote}`
      } else {
        verdict = 'different'
        reason = `已发现划分差异 —— ${withRatio
          .map((r) => `${r.paper.shortLabel}：${r.ratio}`)
          .join('；')}。${pendingNote}`
      }
    } else {
      verdict = 'insufficient'
      const missing = rows.filter((r) => !r.ratio).map((r) => r.paper)
      reason = `有 ${missing.length} 篇没有给出划分比例（${names(missing)}），无法判断是否一致。`
    }
  } else {
    const ratioSame = rows.every((r) => r.ratio === rows[0].ratio)
    if (!ratioSame) {
      verdict = 'different'
      reason = `划分比例不同 —— ${rows
        .map((r) => `${r.paper.shortLabel}：${r.ratio}`)
        .join('；')}。测试段长度不同，外推难度不同，误差不可直接对照。`
    } else {
      const noRange = rows.filter((r) => !r.range)
      if (noRange.length > 0) {
        verdict = 'insufficient'
        reason = `划分比例相同（均为 ${rows[0].ratio}），但 ${names(
          noRange.map((r) => r.paper),
        )} 没有说明测试集覆盖的时间区间 —— 相同比例不代表同一段测试数据，需要回原文确认起止时间后才能判断是否可比。`
      } else {
        const rangeSame = rows.every((r) => r.range === rows[0].range)
        if (rangeSame) {
          verdict = 'consistent'
          reason = `划分比例与测试区间都一致：${rows[0].ratio}，${describeNormalized(
            'splitRange',
            rows[0].range,
          )}。${manualHint(
            rows.map((r) => ({ paper: r.paper, view: r.rangeField })),
            '测试区间',
          )}`
        } else {
          verdict = 'different'
          reason = `划分比例相同（均为 ${rows[0].ratio}），但测试区间不同 —— ${rows
            .map((r) => `${r.paper.shortLabel}：${describeNormalized('splitRange', r.range)}`)
            .join('；')}。测试段覆盖的时间不同，误差不可直接对照。`
        }
      }
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    key: spec.key,
    keys: spec.keys,
    verdict,
    reason,
    whyItMatters: spec.whyItMatters,
    perPaper,
    scope,
    hasManualInput: rows.some(
      (r) => r.ratioField.origin === 'user' || r.rangeField.origin === 'user',
    ),
    partial,
    pendingPaperLabels,
  }
}

/**
 * 跨度：步数 + 采样间隔一起看，比较实际预测时长。
 * 步数相同但采样间隔未知 → 信息不足（不能算「条件一致」）。
 */
function compareHorizon(
  spec: { id: string; label: string; key: FieldKey; keys: FieldKey[]; whyItMatters: string },
  papers: Paper[],
  scope: string | null = null,
): FairnessItem {
  const rows = papers.map((p) => {
    const stepsField = fieldOf(p, 'horizon', scope)
    const intervalField = fieldOf(p, 'sampleInterval', scope)
    const steps = normalizeHorizon(stepsField.value ?? '')
    const interval = normalizeSampleInterval(intervalField.value ?? '')
    const minutes = horizonDurationMinutes(stepsField.value, intervalField.value)
    return { paper: p, steps, interval, minutes, stepsField, intervalField }
  })

  const perPaper = rows.map((r) =>
    toCheckPerPaper(
      r.paper,
      'horizon',
      {
        ...r.stepsField,
        evidenceIds: [...r.stepsField.evidenceIds, ...r.intervalField.evidenceIds],
      },
      `采样间隔：${r.interval ? describeInterval(r.interval) : '论文未说明'}${
        r.intervalField.origin === 'user' ? '（人工补充）' : ''
      }；预测时长：${
        r.minutes !== null
          ? describeDuration(r.minutes)
          : r.steps.split(',').length > 1 || r.interval.split(',').length > 1
            ? '论文给出多组跨度 / 多种采样间隔，无法折算成单一时长'
            : '无法计算'
      }`,
    ),
  )

  const scopedOut = rows.filter(
    (r) => !isUnparsed(r.paper) && (r.stepsField.scopedOut || r.intervalField.scopedOut),
  )
  const unparsed = rows.filter((r) => isUnparsed(r.paper))
  let verdict: FairnessVerdict = 'consistent'
  let reason = ''

  if (papers.length < 2) {
    verdict = 'insufficient'
    reason = '需要至少选择 2 篇论文才能比较实验条件。'
  } else if (unparsed.length > 0) {
    verdict = 'insufficient'
    reason = `有 ${unparsed.length} 篇论文还没有完成字段抽取（${names(
      unparsed.map((r) => r.paper),
    )}），无法读取预测跨度信息。`
  } else if (scopedOut.length > 0) {
    verdict = 'insufficient'
    reason = scopedOutReason(scopedOut, scope, '预测跨度与采样间隔')
  } else if (rows.some((r) => !r.steps)) {
    const missing = rows.filter((r) => !r.steps).map((r) => r.paper)
    verdict = 'insufficient'
    reason = `有 ${missing.length} 篇没有给出预测跨度（${names(missing)}），无法判断是否一致。`
  } else if (rows.some((r) => !r.interval)) {
    const unknown = rows.filter((r) => !r.interval).map((r) => r.paper)
    verdict = 'insufficient'
    reason = `有 ${unknown.length} 篇没有读到采样间隔（${names(
      unknown,
    )}）—— 步数相同不代表预测时长相同，需要确认采样间隔后才能判断是否可比。`
  } else {
    const firstSteps = rows[0].steps
    const firstInterval = rows[0].interval
    const stepsSame = rows.every((r) => r.steps === firstSteps)
    const intervalSame = rows.every((r) => r.interval === firstInterval)
    const singleValue = firstSteps.split(',').length === 1 && firstInterval.split(',').length === 1

    if (stepsSame && intervalSame) {
      verdict = 'consistent'
      reason = `预测跨度与采样间隔都一致：跨度 ${describeHorizon(
        firstSteps,
      )}；采样间隔 ${describeInterval(firstInterval)}${
        singleValue ? `，即预测时长 ${describeDuration(rows[0].minutes)}` : ''
      }。${manualHint(
        rows.map((r) => ({ paper: r.paper, view: r.intervalField })),
        '采样间隔',
      )}`
    } else {
      verdict = 'different'
      const parts: string[] = []

      if (!stepsSame) {
        const sets = rows.map((r) => new Set(r.steps.split(',')))
        const common = [...sets[0]].filter((x) => sets.every((s) => s.has(x)))
        parts.push(
          `预测跨度不完全相同 —— ${rows
            .map((r) => `${r.paper.shortLabel}：${describeHorizon(r.steps)}`)
            .join('；')}（${
            common.length
              ? `共同覆盖 ${describeHorizon(common.join(','))}`
              : '没有共同覆盖的跨度'
          }）`,
        )
      }

      if (!intervalSame) {
        const sets = rows.map((r) => new Set(r.interval.split(',')))
        const common = [...sets[0]].filter((x) => sets.every((s) => s.has(x)))
        parts.push(
          `采样间隔不完全相同 —— ${rows
            .map((r) => `${r.paper.shortLabel}：${describeInterval(r.interval)}`)
            .join('；')}（${
            common.length ? `共同使用 ${describeInterval(common.join(','))}` : '没有共同的采样间隔'
          }）`,
        )
      }

      reason = `${parts.join('。')}。跨度和采样间隔不一致时，同样的误差数字代表的预测时长不同，不能直接放在一起比大小。`
    }
  }

  return {
    id: spec.id,
    label: spec.label,
    key: spec.key,
    keys: spec.keys,
    verdict,
    reason,
    whyItMatters: spec.whyItMatters,
    perPaper,
    hasManualInput: rows.some(
      (r) => r.stepsField.origin === 'user' || r.intervalField.origin === 'user',
    ),
  }
}

export function runFairnessCheck(papers: Paper[], scope: string | null = null): FairnessItem[] {
  const usable = papers.filter((p) => p.status === 'parsed' || p.status === 'text-only')

  // 口径校验：选定的数据集必须每篇论文都用到了，否则整轮检查都建立在不成立的共同点上
  const scopeUsable =
    scope && usable.length >= 2 && usable.every((p) => paperUsesDataset(p, scope)) ? scope : null

  return FAIRNESS_SPEC.map((spec) => {
    const item =
      spec.id === 'fair-split'
        ? compareSplit(spec, papers, scopeUsable)
        : spec.id === 'fair-horizon'
          ? compareHorizon(spec, papers, scopeUsable)
          : compareSingle(spec, papers, scopeUsable)

    // 规则编号：只有**这里**（程序真的执行过的规则）才会打上编号。
    // 界面上"规则推导"的可信度就建立在这个编号上：没有编号的推论一律降级为"建议/待验证"。
    item.ruleId = ruleIdOfFairness(item)

    // 「数据集」这一项必须说清：集合不同 ≠ 共同实验不可比较
    if (spec.id === 'fair-dataset') {
      item.scope = scopeUsable
      if (scopeUsable) {
        item.verdict = 'consistent'
        item.reason = `本次比较已限定在两篇论文共同使用的数据集「${scopeUsable}」上，数据集口径已经对齐。注意：两篇论文的整体数据集集合并不相同，被比较的数字必须来自这个共同数据集。`
      } else if (item.verdict === 'different') {
        const shared = sharedDatasets(papers)
        const list = usable
          .map(
            (p) =>
              `${p.shortLabel}：${[...setOf(normalizeValue('dataset', p.fields.dataset?.value ?? ''))]
                .join('、')}`,
          )
          .join('；')
        item.reason = `两篇论文的整体数据集集合不完全相同 —— ${list}。${
          shared.length >= 1
            ? `但这不代表共同实验不可比较：两篇都用到 ${shared.join('、')}，选定共同数据集后，划分、跨度、采样间隔与指标都可以在这个口径下逐项比较。`
            : '两篇论文没有共同使用的数据集，因此实验数字无法横向对照，只能比较方法本身。'
        }`
      }
    }

    if (item.verdict === 'different' && spec.id !== 'fair-dataset') {
      const hint = fairnessHint(spec.key, item.perPaper)
      if (hint) item.reason = `${item.reason}${hint}`
    }
    return item
  })
}

/** 多篇论文共同使用的数据集（口径选择器就用它） */
export function sharedDatasets(papers: Paper[]): string[] {
  return commonDatasets(papers).map((o) => o.name)
}

/** 汇总公平性结论 */
export function summarizeFairness(items: FairnessItem[]): {
  consistent: number
  different: number
  insufficient: number
  canCompare: number
  total: number
} {
  const consistent = items.filter((i) => i.verdict === 'consistent').length
  const different = items.filter((i) => i.verdict === 'different').length
  const insufficient = items.filter((i) => i.verdict === 'insufficient').length
  const total = items.length || 0
  const canCompare = total ? consistent / total : 0
  return { consistent, different, insufficient, canCompare, total }
}

/* ------------------------------------------------------------------ */
/* 复现缺项检查                                                        */
/* ------------------------------------------------------------------ */

export function runReproCheck(papers: Paper[]): ReproItem[] {
  return REPRO_SPEC.map((spec) => {
    const rows = papers.map((p) => ({ paper: p, view: fieldOf(p, spec.key) }))
    const perPaper = rows.map((r) => toCheckPerPaper(r.paper, spec.key, r.view))

    const verdictOf = (r: { paper: Paper; view: FieldView }): ReproVerdict => {
      if (isUnparsed(r.paper)) return 'need_confirm'
      if (r.view.origin === 'user' && r.view.value) return 'manual'
      if (r.view.status === 'uncertain') return 'need_confirm'
      // 「未检查」必须与「未找到」分开：有页面没被处理时，不能声称论文没写
      if (r.view.status === 'unchecked') return 'unchecked'
      if (r.view.status === 'found' && r.view.value) return 'found'
      return 'missing'
    }

    const missingOnes = rows.filter((r) => verdictOf(r) === 'missing')
    const uncheckedOnes = rows.filter((r) => verdictOf(r) === 'unchecked')
    const confirmOnes = rows.filter((r) => verdictOf(r) === 'need_confirm')
    const manualOnes = rows.filter((r) => verdictOf(r) === 'manual')

    let verdict: ReproVerdict = 'found'
    let reason = ''

    if (rows.length === 0) {
      verdict = 'need_confirm'
      reason = '请先选择要检查的论文。'
    } else if (missingOnes.length > 0) {
      verdict = 'missing'
      reason = `已在论文正文里检索过、没有找到${spec.label}：${names(
        missingOnes.map((r) => r.paper),
      )}（正文的所有页面都已处理）。「未找到」只表示这份文件里没有这一项，不代表论文有错误，但复现前需要先确认或自行设定。`
    } else if (uncheckedOnes.length > 0) {
      verdict = 'unchecked'
      const detail = uncheckedOnes
        .map((r) => `${r.paper.shortLabel}（第 ${r.view.uncheckedPages.join('、')} 页未处理）`)
        .join('；')
      reason = `这一项还不能下结论：${detail}。这些页面没有被送进检查（正文超长被截断，或页面抽不出文字），所以只能说明**已处理的页面里**没有读到${spec.label}，不能说明论文没写。可以补上这些页面后重新抽取，或人工补充。`
    } else if (confirmOnes.length > 0) {
      verdict = 'need_confirm'
      const detail = confirmOnes
        .map((r) => {
          const note = r.paper.fields[spec.key]?.note
          return `${r.paper.shortLabel}${note ? `（${note}）` : ''}`
        })
        .join('；')
      reason = `有 ${confirmOnes.length} 篇论文的${spec.label}需要人工确认：${detail}`
    } else if (manualOnes.length > 0) {
      verdict = 'manual'
      const detail = manualOnes
        .map((r) => `${r.paper.shortLabel} 人工补充为「${r.view.value}」`)
        .join('；')
      const fromPaper = rows.filter((r) => verdictOf(r) === 'found')
      reason = `论文原文里没有读到${spec.label}，以下取值由使用者人工补充：${detail}。${
        fromPaper.length ? `其余论文（${names(fromPaper.map((r) => r.paper))}）是论文原文抽取值。` : ''
      }人工补充的内容不作为论文依据，复现时建议向作者确认或明确记录为自己设定的值。`
    } else {
      verdict = 'found'
      const list = rows
        .map(
          (r) =>
            `${r.paper.shortLabel}：${r.view.value ?? describeNormalized(spec.key, r.view.normalized)}`,
        )
        .join('；')
      reason = `所选论文都写明了${spec.label} —— ${list}。`
    }

    return {
      id: spec.id,
      label: spec.label,
      key: spec.key,
      verdict,
      reason,
      impact: spec.impact,
      perPaper,
      hasManualInput: manualOnes.length > 0,
      ruleId: reproRuleId(verdict),
    }
  })
}

export function summarizeRepro(items: ReproItem[]): {
  found: number
  missing: number
  unchecked: number
  needConfirm: number
  manual: number
  total: number
} {
  return {
    found: items.filter((i) => i.verdict === 'found').length,
    missing: items.filter((i) => i.verdict === 'missing').length,
    unchecked: items.filter((i) => i.verdict === 'unchecked').length,
    needConfirm: items.filter((i) => i.verdict === 'need_confirm').length,
    manual: items.filter((i) => i.verdict === 'manual').length,
    total: items.length,
  }
}

/** 找出所有「没读到的字段 + 需要确认的字段 + 还没检查到的字段」 */
export function collectGaps(repro: ReproItem[]): ReproItem[] {
  return repro.filter(
    (i) => i.verdict === 'missing' || i.verdict === 'need_confirm' || i.verdict === 'unchecked',
  )
}
