import { useState } from 'react'
import type { FieldKey, Paper } from '@/types'
import { useApp, useFieldEditor } from '@/store/AppStore'
import { FIELD_META } from '@/data/fieldSchema'
import { fieldDisplayState } from '@/services/checks'
import { Icon } from './Icons'
import { Highlighted } from './InsightBits'
import { Tag } from './StatusTag'

/** 这些字段适合"让小咕找线索"（第一版聚焦：超参 + 划分 + 预处理） */
const DETECTIVE_KEYS: FieldKey[] = ['learningRate', 'batchSize', 'epochs', 'horizon', 'split', 'preprocessing']

/**
 * 字段阅读行：字段名 + 取值（关键数字/术语加粗）+ 来源标记 + 操作
 * · 点「核对原文」在右侧打开证据面板（面板内可切换论文、复制、补查）
 * · 来源明确区分：论文原文 / 人工修改 / 工具推导（定向检索找回）
 */
export function FieldReading({ paper, fieldKey }: { paper: Paper; fieldKey: FieldKey }) {
  const { openEvidence, recheckOneField, pagesOf } = useApp()
  const editField = useFieldEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const field = paper.fields[fieldKey]
  const meta = FIELD_META[fieldKey]
  const state4 = fieldDisplayState(paper, fieldKey)
  const value = field?.value ?? null
  const long = (value?.length ?? 0) > 120
  const [expanded, setExpanded] = useState(false)

  const originTag =
    field?.origin === 'user' ? (
      <Tag tone="blue">人工修改</Tag>
    ) : field?.checkState === 'retrieval' ? (
      <Tag tone="violet">定向检索找回</Tag>
    ) : field?.origin === 'paper' ? (
      <Tag tone="slate">论文原文</Tag>
    ) : null

  const hasText = (pagesOf(paper.id)?.length ?? 0) > 0

  return (
    <div className="reading-row">
      <div className="reading-label">
        {meta.label}
        <div className="tiny muted-2" style={{ marginTop: 2 }}>
          {state4.label}
        </div>
      </div>
      <div className="reading-value">
        {editing ? (
          <div className="stack-sm">
            <textarea
              className="textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="填写你在原文里核对到的取值；这会标注为「人工修改」，不会覆盖论文原文的抽取值。"
            />
            <div className="row-tight">
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  editField(paper, fieldKey, draft.trim())
                  setEditing(false)
                }}
                disabled={!draft.trim()}
              >
                保存修改
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          </div>
        ) : value ? (
          <>
            <div className={long && !expanded ? 'clamp-3' : undefined}>
              <Highlighted text={String(value)} />
            </div>
            {long && (
              <button className="expand-toggle" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '收起 ▴' : '展开全文 ▾'}
              </button>
            )}
          </>
        ) : (
          <span className="muted-2">{state4.label} —— {state4.hint}</span>
        )}

        <div className="row-tight" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
          {originTag}
          {field?.support === 'partial' && <Tag tone="orange">原文只支持一部分</Tag>}
          {field?.usageOk === false && <Tag tone="orange">缺实验用途证据</Tag>}
          {(field?.evidenceIds?.length ?? 0) > 0 && (
            <span className="tiny muted-2">依据 {field?.evidenceIds.length} 条</span>
          )}
        </div>
      </div>

      <div className="reading-actions">
        <button
          className="evidence-btn"
          onClick={() => openEvidence(`${paper.shortLabel} · ${paper.title}`, meta.label, field?.evidenceIds ?? [])}
          title="在右侧打开原文依据（可在面板内切换论文、复制原文、补查）"
        >
          <Icon name="search" size={13} /> 核对原文
        </button>
        <button
          className="evidence-btn"
          disabled={busy || !hasText}
          title={hasText ? '只对这一项做定向检索与引用校验' : '正文不在本地，需要先在论文库点「重新解析」'}
          onClick={async () => {
            if (busy) return
            setBusy(true)
            try {
              await recheckOneField(paper, fieldKey)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Icon name="refresh" size={13} /> {busy ? '补查中…' : '补查'}
        </button>
        <button
          className="icon-btn"
          title="人工修改这一项（会保留论文原始取值）"
          onClick={() => {
            setDraft(value ?? '')
            setEditing(true)
          }}
        >
          <Icon name="plus" size={14} />
        </button>
        {DETECTIVE_KEYS.includes(fieldKey) && (
          <button
            className="evidence-btn"
            title="让小咕侦探去论文附录与官方仓库脚本里找这一项的线索（不会自动覆盖当前取值）"
            onClick={() => window.dispatchEvent(new CustomEvent('open-detective', { detail: { paperId: paper.id, fieldKey } }))}
          >
            <Icon name="lab" size={13} /> 找线索
          </button>
        )}
      </div>
    </div>
  )
}
