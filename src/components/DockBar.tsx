import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { MAX_SELECTION, useApp, usePickedProblems } from '@/store/AppStore'
import { Icon } from '@/components/Icons'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FIELD_META } from '@/data/fieldSchema'
import type { FieldKey } from '@/types'

/**
 * 底部悬浮操作栏：内容随上下文变化；**未选中任何内容时隐藏**。
 * 论文库：已选 N/3 篇｜开始对比
 * 对比/检查：已选 N 个问题｜查看证据｜生成验证计划
 * 验证计划：当前进度｜导出
 */
export function DockBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch, selectedPapers, openEvidence } = useApp()
  const { picked, clear } = usePickedProblems()
  const [confirmUndo, setConfirmUndo] = useState(false)

  const doUndo = () => {
    dispatch({ type: 'UNDO_PLAN_ADD' })
    navigate('/compare')
  }

  const path = location.pathname
  const selectedCount = selectedPapers.length
  const onLibrary = path === '/' || path === '/library'
  const onCompare = path === '/compare' || path === '/check'
  const onPlan = path === '/plan'

  // 未选择任何内容 → 隐藏
  if (onLibrary && selectedCount === 0) return null
  if (onCompare && picked.length === 0) return null
  if (onPlan && !state.verificationPlan) return null
  if (!onLibrary && !onCompare && !onPlan) return null

  if (onLibrary) {
    return (
      <div className="dock" role="toolbar" aria-label="选区操作">
        <span className="dock-count">
          已选 <strong>{selectedCount}</strong>/{MAX_SELECTION} 篇
          {selectedCount < 2 ? '（至少 2 篇才能对比）' : ''}
        </span>
        <div className="spacer" />
        <div className="dock-actions">
          <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'CLEAR_SELECT' })}>
            清空
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={selectedCount < 2}
            onClick={() => navigate('/compare')}
          >
            <Icon name="compare" size={14} /> 开始对比
          </button>
        </div>
      </div>
    )
  }

  if (onCompare) {
    return (
      <div className="dock" role="toolbar" aria-label="问题操作">
        <span className="dock-count">
          已选 <strong>{picked.length}</strong> 个问题
          {selectedPapers.length > 0 ? `｜${selectedPapers.map((p) => p.shortLabel).join('、')}` : ''}
        </span>
        <div className="spacer" />
        <div className="dock-actions">
          <button className="btn btn-sm btn-ghost" onClick={clear}>
            取消选择
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              const first = picked[0]
              const key = first?.split('::')[1] as FieldKey
              if (!key || !FIELD_META[key]) return
              openEvidence(selectedPapers.map(p => p.shortLabel).join(' · '), FIELD_META[key].label,
                selectedPapers.flatMap(p => p.fields[key]?.evidenceIds ?? []))
            }}
          >
            <Icon name="search" size={14} /> 查看证据
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              dispatch({
                type: 'SET_PLAN_DRAFT',
                draft: {
                  fromProblem: picked.length > 0 ? `对比页选中的 ${picked.length} 个问题` : '对比页的差异与待核对项',
                  paperIds: selectedPapers.map((p) => p.id),
                  dataset: state.datasetScope ?? null,
                  riskId: picked[0]?.split('::')[2] || undefined,
                  fieldKey: picked[0]?.split('::')[1] as FieldKey,
                  fieldKeys: picked.map(id => id.split('::')[1]).filter(Boolean),
                  riskIds: picked.map(id => id.split('::')[2]).filter(Boolean),
                  createdAt: new Date().toISOString(),
                },
              })
              navigate('/plan')
            }}
          >
            <Icon name="rocket" size={14} /> 生成验证计划
          </button>
        </div>
      </div>
    )
  }

  // 验证计划页
  const plan = state.verificationPlan
  const total = plan?.experiments.length ?? 0
  const progress = state.planProgress ?? {}
  const done = (plan?.experiments ?? []).filter((e) => (progress[e.id]?.status ?? 'todo') === 'done').length
  return (
    <div className="dock" role="toolbar" aria-label="计划操作">
      <span className="dock-count">
        当前进度 <strong>{done}</strong>/{total} 个实验
        {state.planDraft ? `｜来自：${state.planDraft.fromProblem}` : ''}
      </span>
      <div className="spacer" />
      <div className="dock-actions">
        {state.planDraft && (
          <button
            className="btn btn-sm"
            title="把计划与进度恢复到「加入之前」，再回到来源问题"
            onClick={() => {
              // 加入之后如果已经记录了结果，撤销会丢掉这些编辑 —— 不能静默丢弃，先确认
              const before = JSON.stringify(state.planUndoBefore?.planProgress ?? {})
              const now = JSON.stringify(state.planProgress ?? {})
              if (state.planUndoBefore && before !== now) {
                setConfirmUndo(true)
                return
              }
              doUndo()
            }}
          >
            <Icon name="arrow-left" size={14} /> 撤销加入
          </button>
        )}
        <button className="btn btn-sm btn-primary" onClick={() => window.dispatchEvent(new Event('paper-guard:export-plan'))}>
          <Icon name="export" size={14} /> 导出计划
        </button>
      </div>

      <ConfirmDialog
        open={confirmUndo}
        title="撤销加入会丢掉你刚记录的结果"
        message={
          <>
            加入这条问题之后，你已经在计划里记录了结果或观察。
            撤销会把这些新记录恢复到「加入之前」，并移除这次加入带来的问题。
            <br />
            如果只想回到对比页看证据，点「取消」，记录会原样保留。
          </>
        }
        confirmText="仍然撤销"
        onCancel={() => setConfirmUndo(false)}
        onConfirm={() => {
          setConfirmUndo(false)
          doUndo()
        }}
      />
    </div>
  )
}
