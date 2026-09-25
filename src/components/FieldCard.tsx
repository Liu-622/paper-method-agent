import { useState } from 'react'
import type { FieldKey, Paper, PaperField } from '@/types'
import { FIELD_META } from '@/data/fieldSchema'
import { useApp, useFieldEditor } from '@/store/AppStore'
import { FieldStatusTag, Tag } from './StatusTag'

/**
 * 字段卡片
 * ------------------------------------------------------------------
 * - 状态标签（已找到 / 未找到 / 需要确认）+ 来源标签（人工补充）
 * - 「查看依据」→ 侧栏展示论文名、PDF 页序号、原文片段（真实论文为 PDF 原文）
 * - 「补充 / 修正」→ 人工补充的值会标注「人工补充」，
 *   论文原始抽取值与证据保留在卡片上，不会被覆盖
 */
export function FieldCard({
  paper,
  fieldKey,
  showGroupHint = false,
}: {
  paper: Paper
  fieldKey: FieldKey
  showGroupHint?: boolean
}) {
  const { openEvidence, dispatch, toast, state } = useApp()
  const save = useFieldEditor()
  const meta = FIELD_META[fieldKey]
  const field: PaperField | undefined = paper.fields[fieldKey]

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(field?.value ?? '')

  const value = field?.value ?? null
  const status = field?.status ?? 'missing'
  const isManual = field?.origin === 'user'
  const hasEvidence = (field?.evidenceIds?.length ?? 0) > 0
  const fromPdf = state.evidence.some(
    (e) => e.paperId === paper.id && field?.evidenceIds?.includes(e.id),
  )

  const open = () => {
    openEvidence(
      `${paper.shortLabel} · ${paper.title}`,
      `${meta.label}${field?.evidenceIds?.length ? ` · 共 ${field.evidenceIds.length} 条片段` : ''}`,
      field?.evidenceIds ?? [],
    )
  }

  const startEdit = () => {
    setDraft(value ?? '')
    setEditing(true)
  }

  const commit = () => {
    save(paper, fieldKey, draft)
    setEditing(false)
  }

  const revert = () => {
    dispatch({ type: 'RESET_FIELD', paperId: paper.id, key: fieldKey })
    setEditing(false)
    toast('info', '已还原为论文抽取值', '检查结果已同步刷新。')
  }

  return (
    <div
      className={`field-card ${status === 'missing' ? 'missing' : status === 'uncertain' ? 'uncertain' : ''}`}
    >
      <div className="field-head">
        <span className="label">{meta.label}</span>
        <FieldStatusTag status={status} />
        {isManual && <Tag tone="blue">人工补充</Tag>}
        {!isManual && fromPdf && <Tag tone="green">PDF 原文</Tag>}
        {/* 三态区分：初次漏抽 / 原文未报告 / 未检查 —— 三者不是一回事 */}
        {field?.checkState === 'retrieval' && <Tag tone="violet">定向检索找回（初次漏抽）</Tag>}
        {field?.checkState === 'not_reported' && <Tag tone="plain">原文未报告（已全文检索）</Tag>}
        {field?.checkState === 'unchecked' && <Tag tone="orange">未检查（页面无可读文本）</Tag>}
        <div className="spacer" />
        <div className="row-tight">
          <button
            className={`evidence-btn${hasEvidence ? '' : ' neutral'}`}
            onClick={open}
            title={hasEvidence ? '查看对应原文片段' : '该项没有找到原文片段'}
          >
            🔍 查看依据{hasEvidence ? ` (${field?.evidenceIds.length})` : ''}
          </button>
          {!editing && (
            <button className="btn btn-sm btn-ghost" onClick={startEdit}>
              {isManual ? '修改补充' : '补充 / 修正'}
            </button>
          )}
        </div>
      </div>

      {showGroupHint && <div className="tiny muted-2">{meta.hint}</div>}

      {editing ? (
        <div className="stack-sm">
          <div className="field-edit-row">
            <textarea
              className="textarea"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={`填写${meta.label}（留空表示未提供）`}
              autoFocus
            />
          </div>
          <div className="row-tight">
            <button className="btn btn-sm btn-primary" onClick={commit}>
              保存并重新检查
            </button>
            <button className="btn btn-sm" onClick={() => setEditing(false)}>
              取消
            </button>
            {isManual && (
              <button className="btn btn-sm btn-ghost" onClick={revert}>
                还原为论文值
              </button>
            )}
          </div>
          <div className="tiny muted-2">
            这里填写的内容会标记为「人工补充」，不会被当作论文原文依据。
          </div>
        </div>
      ) : value ? (
        <div className="field-value">{value}</div>
      ) : (
        <div className="field-value empty">
          {status === 'uncertain'
            ? '论文里只给出了不完整的信息，需要人工确认。'
            : '论文中没有读到这一项。'}
        </div>
      )}

      {/* 人工补充时，保留并展示论文原始抽取值 */}
      {isManual && field?.extracted && !editing && (
        <div className="field-note">
          📌 <b>论文原始抽取值：</b>
          {field.extracted.value ? (
            <>
              「{field.extracted.value}」
              {field.extracted.evidenceIds.length > 0 && (
                <button
                  className="evidence-btn"
                  style={{ marginLeft: 8 }}
                  onClick={() =>
                    openEvidence(
                      `${paper.shortLabel} · ${paper.title}`,
                      `${meta.label} · 论文原始依据`,
                      field.extracted!.evidenceIds,
                    )
                  }
                >
                  🔍 原始依据 ({field.extracted.evidenceIds.length})
                </button>
              )}
            </>
          ) : (
            '论文里没有找到这一项（未找到）'
          )}
          <div className="tiny muted-2" style={{ marginTop: 4 }}>
            当前显示的值是人工补充的，不是论文原文内容。
          </div>
        </div>
      )}

      {!editing && field?.note && <div className="field-note">📌 {field.note}</div>}
    </div>
  )
}
