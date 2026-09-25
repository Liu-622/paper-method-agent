import type {
  FairnessVerdict,
  FieldStatus,
  PaperStatus,
  QaStatus,
  ReproVerdict,
  SupportLevel,
} from '@/types'

export type Tone = 'green' | 'orange' | 'red' | 'violet' | 'slate' | 'blue' | 'plain'

export function Tag({
  tone = 'plain',
  dot = false,
  children,
}: {
  tone?: Tone
  dot?: boolean
  children: React.ReactNode
}) {
  return (
    <span className={`tag tag-${tone}`}>
      {dot && <span className="dot" />}
      {children}
    </span>
  )
}

/* —— 实验公平性检查结论 —— */
export const FAIRNESS_TEXT: Record<FairnessVerdict, string> = {
  consistent: '条件一致',
  different: '存在差异',
  insufficient: '待核对',
}
export function FairnessTag({ verdict }: { verdict: FairnessVerdict }) {
  const tone: Tone =
    verdict === 'consistent' ? 'green' : verdict === 'different' ? 'orange' : 'slate'
  return (
    <Tag tone={tone} dot>
      {FAIRNESS_TEXT[verdict]}
    </Tag>
  )
}

/* —— 复现缺项检查结论 —— */
export const REPRO_TEXT: Record<ReproVerdict, string> = {
  found: '已找到',
  missing: '未找到',
  unchecked: '未检查',
  need_confirm: '需要确认',
  manual: '人工补充',
}
export function ReproTag({ verdict }: { verdict: ReproVerdict }) {
  const tone: Tone =
    verdict === 'found'
      ? 'green'
      : verdict === 'missing'
        ? 'red'
        : verdict === 'unchecked'
          ? 'violet'
          : verdict === 'manual'
            ? 'blue'
            : 'orange'
  return (
    <Tag tone={tone} dot>
      {REPRO_TEXT[verdict]}
    </Tag>
  )
}

/* —— 字段抽取状态 —— */
export const FIELD_STATUS_TEXT: Record<FieldStatus, string> = {
  found: '已找到',
  missing: '未找到',
  unchecked: '未检查',
  uncertain: '需要确认',
}
export function FieldStatusTag({ status }: { status: FieldStatus }) {
  const tone: Tone =
    status === 'found' ? 'green' : status === 'missing' ? 'orange' : status === 'unchecked' ? 'violet' : 'blue'
  return (
    <Tag tone={tone} dot>
      {FIELD_STATUS_TEXT[status]}
    </Tag>
  )
}

/* —— 结论的来源与支持程度 —— */
export const SUPPORT_TEXT: Record<SupportLevel, string> = {
  full: '原文支持',
  partial: '部分支持',
  none: '原文不支持（已撤回）',
  unchecked: '未复核',
  system: '系统事实',
  rule: '规则推导',
  suggestion: '建议 / 待验证',
}

/** 三来源的说明：界面上要能一眼看出「为什么这条结论不需要论文引用」 */
export const SUPPORT_WHY: Record<SupportLevel, string> = {
  full: '论文原文明确写出了这条结论的关键内容。',
  partial: '论文原文与这条结论相关，但没有覆盖全部要点，建议回原文确认。',
  none: '提供的正文里找不到能支持这条结论的依据，已从回答中撤回。',
  unchecked: '「原文是否支持」这一步复核没有成功完成，请对照引用自行确认。',
  system: '这是程序状态（当前选择、比较口径、可用正文等），由程序状态直接证明，不需要论文引用。',
  rule: '这条结论有对应的、程序实际执行过的检查规则：会展示规则编号、输入字段（含证据）与输出结果。',
  suggestion:
    '这是模型自己提出的推论：没有对应的、程序执行过的规则，也没有通过原文支持判定，按「建议 / 待验证」处理。',
}

export function SupportTag({ support }: { support: SupportLevel }) {
  const tone: Tone =
    support === 'full'
      ? 'green'
      : support === 'system'
        ? 'blue'
        : support === 'rule'
          ? 'violet'
          : support === 'partial'
            ? 'orange'
            : support === 'none'
              ? 'red'
              : 'slate'
  return (
    <Tag tone={tone} dot>
      {SUPPORT_TEXT[support]}
    </Tag>
  )
}

/* —— 论文处理状态 —— */
export const PAPER_STATUS_TEXT: Record<PaperStatus, string> = {
  parsed: '字段已抽取',
  extracting: '抽取字段中',
  parsing: '读取正文中',
  pending: '排队中',
  'text-only': '正文已读取',
  failed: '解析失败',
}
export function PaperStatusTag({ status }: { status: PaperStatus }) {
  const tone: Tone =
    status === 'parsed'
      ? 'green'
      : status === 'parsing' || status === 'extracting'
        ? 'blue'
        : status === 'failed'
          ? 'red'
          : status === 'text-only'
            ? 'orange'
            : 'slate'
  return <Tag tone={tone}>{PAPER_STATUS_TEXT[status]}</Tag>
}

export function QaStatusTag({ status }: { status: QaStatus }) {
  if (status === 'answered') return <Tag tone="green">已生成回答</Tag>
  if (status === 'unsupported') return <Tag tone="orange">尚未支持</Tag>
  return <Tag tone="red">请求失败</Tag>
}
