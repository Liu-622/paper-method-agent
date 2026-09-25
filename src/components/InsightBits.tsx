import { useMemo, useState } from 'react'
import type { FieldKey, Paper } from '@/types'
import { fieldDisplayState } from '@/services/checks'
import type { Insight, ProblemCard } from '@/services/insights'
import { Tag, type Tone } from '@/components/StatusTag'
import { Icon } from '@/components/Icons'

/* ------------------------------------------------------------------ */
/* 关键词加粗：用结构化 React 文本节点渲染，**不注入 HTML**            */
/* ------------------------------------------------------------------ */

/** 这些词属于"方法名/关键机制"，命中就加粗 */
const MECHANISM_WORDS = [
  '序列分解',
  '自相关',
  '自注意力',
  '注意力机制',
  '移动平均',
  '分解',
  '归一化',
  '实例归一化',
  '补丁',
  '频域',
  '小波',
  '傅里叶',
  '稀疏',
  '线性层',
  '蒸馏',
  '注意力',
  'Masked',
  'Patching',
  'Transformer',
  'Autoformer',
  'FEDformer',
  'PatchTST',
  'DLinear',
  'Informer',
  'LogTrans',
  'Reformer',
  'Pyraformer',
  'iTransformer',
]

/** 数值 / 比例 / 单位 */
const VALUE_RE = /(\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2})?|\d{1,2}\s*[:：]\s*\d{1,2}(?:\s*[:：]\s*\d{1,2})?|\d+(?:\.\d+)?\s*(?:%|分钟|小时|天|周|步|epoch|epochs|GB|万|k|M)|O\s*∈\s*\{[^}]+\})/g

type Piece = { text: string; kind: 'plain' | 'mech' | 'value' }

/**
 * 把一个字符串切成三类片段：普通 / 机制名 / 关键数值。
 * 只做"有选择的加粗"，不会整段加粗。
 */
export function splitForHighlight(text: string): Piece[] {
  const src = String(text || '')
  if (!src) return []
  const marks: { start: number; end: number; kind: 'mech' | 'value' }[] = []
  for (const w of MECHANISM_WORDS) {
    let idx = src.indexOf(w)
    while (idx >= 0) {
      marks.push({ start: idx, end: idx + w.length, kind: 'mech' })
      idx = src.indexOf(w, idx + w.length)
    }
  }
  let m: RegExpExecArray | null
  const re = new RegExp(VALUE_RE.source, 'g')
  while ((m = re.exec(src)) !== null) {
    if (m[0].trim()) marks.push({ start: m.index, end: m.index + m[0].length, kind: 'value' })
    if (m[0].length === 0) re.lastIndex += 1
  }
  if (marks.length === 0) return [{ text: src, kind: 'plain' }]
  marks.sort((a, b) => a.start - b.start)
  const merged: typeof marks = []
  for (const mk of marks) {
    const last = merged[merged.length - 1]
    if (last && mk.start <= last.end) {
      last.end = Math.max(last.end, mk.end)
      if (mk.kind === 'mech') last.kind = 'mech'
    } else merged.push({ ...mk })
  }
  const out: Piece[] = []
  let cursor = 0
  for (const mk of merged) {
    if (mk.start > cursor) out.push({ text: src.slice(cursor, mk.start), kind: 'plain' })
    out.push({ text: src.slice(mk.start, mk.end), kind: mk.kind })
    cursor = mk.end
  }
  if (cursor < src.length) out.push({ text: src.slice(cursor), kind: 'plain' })
  return out
}

/** 带关键词加粗的文本（Markdown 符号与中文标点按原样显示，不做 HTML 注入） */
export function Highlighted({ text, className }: { text: string; className?: string }) {
  const pieces = useMemo(() => splitForHighlight(text), [text])
  return (
    <span className={className}>
      {pieces.map((p, i) =>
        p.kind === 'plain' ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === 'mech' ? (
          <strong key={i} className="hl-mech">
            {p.text}
          </strong>
        ) : (
          <strong key={i} className="hl-value">
            {p.text}
          </strong>
        ),
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 「信息不足」按原因分开显示                                          */
/* ------------------------------------------------------------------ */

const TONE: Record<string, Tone> = {
  ok: 'green',
  need_confirm: 'orange',
  recovered: 'violet',
  not_found: 'slate',
  not_checked: 'blue',
}

/** 字段状态标签（与 services/checks.fieldDisplayState 一一对应） */
export function FieldStateTag({ paper, fieldKey }: { paper: Paper; fieldKey: FieldKey }) {
  const st = fieldDisplayState(paper, fieldKey)
  return (
    <span title={st.hint}>
      <Tag tone={TONE[st.state] ?? 'plain'}>{st.label}</Tag>
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* 摘要卡片 / 问题卡片                                                 */
/* ------------------------------------------------------------------ */

export function InsightCard({
  insight,
  onEvidence,
}: {
  insight: Insight
  onEvidence: (insight: Insight) => void
}) {
  return (
    <div className={`insight-row list-item ${insight.kind}`}>
      <span className="ir-kind">{insight.title}</span>
      <span className="ir-text">
        <Highlighted text={insight.text} />
      </span>
      {insight.needConfirm && <Tag tone="orange">另有待核对</Tag>}
      <button className="evidence-btn" onClick={() => onEvidence(insight)}>
        <Icon name="search" size={13} /> 依据
      </button>
    </div>
  )
}

export function ProblemCardView({
  card,
  picked,
  onTogglePick,
  onEvidence,
  onAddToPlan,
}: {
  card: ProblemCard
  picked?: boolean
  onTogglePick?: (card: ProblemCard) => void
  onEvidence: (card: ProblemCard) => void
  onAddToPlan: (card: ProblemCard) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`todo-row list-item ${card.kind === 'difference' ? 'diff' : 'gap'}`}>
      <button
        className="todo-row-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? '收起详情' : '展开各篇取值与原因'}
      >
        {onTogglePick && (
          <input
            type="checkbox"
            checked={Boolean(picked)}
            aria-label={`选择问题：${card.title}`}
            onChange={() => onTogglePick(card)}
            onClick={(e) => e.stopPropagation()}
            style={{ flex: 'none', marginTop: 1 }}
          />
        )}
        <span className="tr-title">{card.title}</span>
        <span className="tr-values">
          <Highlighted text={card.conclusion} />
        </span>
        <span className="spacer" />
        {card.kind === 'difference' ? (
          <Tag tone="orange">已发现差异</Tag>
        ) : (
          <Tag tone="slate">本次无法判断</Tag>
        )}
        {card.pendingLabels.length > 0 && <Tag tone="blue">另 {card.pendingLabels.length} 篇待核对</Tag>}
        <Icon name="chevron" size={15} className={`ic-chev${open ? ' ic-open' : ''}`} />
      </button>

      {open && (
        <div className="todo-row-body">
          <div className="tiny muted-2" style={{ marginBottom: 6 }}>
            各篇取值
          </div>
          <ul className="tight-list">
            {card.perPaper.map((x, i) => (
              <li key={i}>
                <span className="mono strong">{x.paperLabel}</span>：{' '}
                {x.value ? <Highlighted text={x.value} /> : <span className="muted-2">未读到</span>}
              </li>
            ))}
          </ul>
          <div className="tiny muted-2" style={{ margin: '8px 0 4px' }}>
            为什么影响比较
          </div>
          <div className="small">{card.why}</div>
          <div className="row-tight" style={{ marginTop: 9 }}>
            <button className="evidence-btn" onClick={() => onEvidence(card)}>
              <Icon name="search" size={13} /> 查看依据
            </button>
            <button className="btn btn-sm" onClick={() => onAddToPlan(card)}>
              <Icon name="rocket" size={14} /> 加入验证计划
            </button>
          </div>
        </div>
      )}
    </div>
  )
}