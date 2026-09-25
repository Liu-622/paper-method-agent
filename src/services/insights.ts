import type { FairnessItem, FieldKey, Paper } from '@/types'
import { FIELD_META } from '@/data/fieldSchema'
import { fieldDisplayState } from './checks'

/** 摘要条目：全部由当前字段与规则结果生成，不写死在示例里 */
export interface Insight {
  id: string
  kind: 'method-diff' | 'aligned' | 'priority'
  /** 小标题（例如「方法区别」「可以对齐的条件」「优先核对」） */
  title: string
  /** 一句话结论 */
  text: string
  /** 涉及的论文（短名） */
  papers: string[]
  /** 点击「查看依据」时打开哪些字段 */
  evidence: { paperLabel: string; fieldKey: FieldKey }[]
  /** 建议带进验证计划的风险项（规则 id） */
  riskId?: string
  /** 这条结论还带着"另若干篇待核对" */
  needConfirm?: boolean
}

/** 每个字段的短描述：用于摘要里的「一句话说明」 */
function shortValue(value: string | null, max = 46): string {
  if (!value) return '未读到'
  const v = value.replace(/\s+/g, ' ').trim()
  return v.length > max ? `${v.slice(0, max)}…` : v
}

/** 关键数值/比例（用于保持原文里的数字，不做改写） */
function ratioIn(value: string | null): string | null {
  const m = String(value || '').match(/\d{1,2}\s*[:：]\s*\d{1,2}(?:\s*[:：]\s*\d{1,2})?/)
  return m ? m[0].replace(/\s+/g, '') : null
}

/**
 * 「先看这几条」：最多 3 条，数据不够就少显示，不凑数量。
 * 生成顺序 = 用户最需要的顺序：方法区别 → 可对齐条件 → 优先核对的一项差异/缺口。
 */
export function buildInsights(papers: Paper[], fairness: FairnessItem[], _scope: string | null): Insight[] {
  const out: Insight[] = []
  if (papers.length < 2) return out
  const labelOf = (paperId: string) => papers.find((p) => p.id === paperId)?.shortLabel ?? paperId

  // 1) 方法最主要的区别（只在确实读到方法时才生成）
  const methodViews = papers.filter((p) => p.fields.method?.value)
  if (methodViews.length >= 2) {
    const texts = methodViews.map((p) => shortValue(p.fields.method?.value ?? null, 40))
    const distinct = new Set(texts).size
    if (distinct >= 2) {
      out.push({
        id: 'ins-method',
        kind: 'method-diff',
        title: '方法区别',
        text: `方法上的主要差别：${methodViews.map((p, i) => `${p.shortLabel} 用「${texts[i]}」`).join('；')}。`,
        papers: methodViews.map((p) => p.shortLabel),
        evidence: methodViews.map((p) => ({ paperLabel: p.shortLabel, fieldKey: 'method' as FieldKey })),
      })
    }
  }

  // 2) 已确认可以对齐的实验条件（来自真实规则判定，不看文案）
  const aligned = fairness.filter((f) => f.key !== 'method' && f.verdict === 'consistent')
  if (aligned.length > 0) {
    const top = aligned[0]
    const ratios = top.perPaper.map((x) => ratioIn(x.value)).filter(Boolean)
    out.push({
      id: 'ins-aligned',
      kind: 'aligned',
      title: '可以对齐的条件',
      text: `「${top.label}」这几篇是一致的${ratios.length ? `（${ratios.join('、')}）` : ''}，可以按同一口径继续核对；一致只代表前提成立，不代表结论已被验证。`,
      papers: top.perPaper.map((x) => labelOf(x.paperId)),
      evidence: top.perPaper.map((x) => ({ paperLabel: labelOf(x.paperId), fieldKey: top.key })),
    })
  }

  // 3) 最值得优先核对的一项差异/缺口
  const diff = fairness.find((f) => f.key !== 'method' && f.verdict === 'different')
  const gap = fairness.find(
    (f) =>
      f.key !== 'method' &&
      f.verdict === 'insufficient' &&
      f.key !== 'dataset' && // 数据集不同往往是"覆盖面不同"，优先级低于划分/跨度/指标
      f.key !== 'baselines',
  )
  const target = diff || gap
  if (target) {
    out.push({
      id: 'ins-priority',
      kind: 'priority',
      title: diff ? '优先核对（已发现差异）' : '优先核对（信息不足）',
      text: `${target.reason}`,
      papers: target.perPaper.map((x) => labelOf(x.paperId)),
      evidence: target.perPaper.map((x) => ({ paperLabel: labelOf(x.paperId), fieldKey: target.key })),
      riskId: target.ruleId,
      needConfirm: target.partial,
    })
  }

  return out.slice(0, 3)
}

export interface CountBlock {
  n: number
  total: number
  /** 分母的口径说明（必须写出来，避免被当成准确率） */
  definition: string
}

export interface CompareCounts {
  organized: CountBlock
  different: CountBlock
  pending: CountBlock
}

/**
 * 顶部计数：**每一项都给出分母与定义**，不把字段数量包装成"准确率/可信度"。
 */
export function buildCounts(papers: Paper[], fairness: FairnessItem[]): CompareCounts {
  const keys = Object.keys(FIELD_META) as FieldKey[]
  let slots = 0
  let read = 0
  let pending = 0
  for (const p of papers) {
    for (const k of keys) {
      if (p.fields[k] === undefined) continue
      slots += 1
      const st = fieldDisplayState(p, k)
      if (st.state === 'ok' || st.state === 'recovered') read += 1
      else if (st.state === 'not_found' || st.state === 'need_confirm' || st.state === 'not_checked') pending += 1
    }
  }
  const items = fairness.filter((f) => f.key !== 'method')
  const different = items.filter((f) => f.verdict === 'different').length
  return {
    organized: {
      n: read,
      total: slots,
      definition: `在 ${papers.length} 篇论文共 ${slots} 个字段里，已读到明确依据的字段数`,
    },
    different: {
      n: different,
      total: items.length,
      definition: `在 ${items.length} 项实验条件里，程序判定「存在差异」的项数`,
    },
    pending: {
      n: pending,
      total: slots,
      definition: '需要你回原文确认或尚未检查完整的字段数（不等于"论文没写"）',
    },
  }
}

/** 需要优先处理的问题卡片（差异优先，其次信息不足） */
export interface ProblemCard {
  id: string
  kind: 'difference' | 'gap'
  title: string
  conclusion: string
  perPaper: { paperLabel: string; value: string | null }[]
  why: string
  evidence: { paperLabel: string; fieldKey: FieldKey }[]
  pendingLabels: string[]
  riskId?: string
  fieldKey: FieldKey
}

export function buildProblemCards(papers: Paper[], fairness: FairnessItem[]): ProblemCard[] {
  const labelOf = (paperId: string) => papers.find((p) => p.id === paperId)?.shortLabel ?? paperId
  const items = fairness.filter((f) => f.key !== 'method')
  const pick = [...items.filter((f) => f.verdict === 'different'), ...items.filter((f) => f.verdict === 'insufficient')]
  return pick.slice(0, 4).map((f, i) => ({
    id: `prob-${i}-${f.id}`,
    kind: f.verdict === 'different' ? 'difference' : 'gap',
    title: f.label,
    conclusion: f.verdict === 'different' ? `已发现差异：${f.label}` : `${f.label}：本次无法判断是否一致`,
    perPaper: f.perPaper.map((x) => ({ paperLabel: labelOf(x.paperId), value: x.value })),
    why: f.whyItMatters,
    evidence: f.perPaper.map((x) => ({ paperLabel: labelOf(x.paperId), fieldKey: f.key })),
    pendingLabels: f.pendingPaperLabels ?? [],
    riskId: f.ruleId,
    fieldKey: f.key,
  }))
}
