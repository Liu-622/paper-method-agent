import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/store/AppStore'
import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import type { ResearchDirection } from '@/types'

const SOURCE_LABEL: Record<string, string> = { 'author-future': '作者未来工作', 'limitation-derived': '基于作者局限的工具推导', synthesis: '集合综合推导', 'case-extension': '已有案例延伸', 'user-idea': '用户想法' }

/** 研究方向：证据驱动的研究建议（赛题能力 4 · 研究方向推导） */
export function DirectionsPage() {
  const {
    state, dispatch, toast, currentCollection, collectionPapers,
    runCollectionAnalysis, generateDirections, editDirection, deleteDirection, openEvidence, openDetective,
  } = useApp()
  const navigate = useNavigate()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState({ question: '', hypothesis: '' })
  const [generating, setGenerating] = useState(false)

  const dirs = state.directions.filter((d) => currentCollection && d.relatedPaperIds.some((id) => currentCollection.paperIds.includes(id)) || currentCollection === null)
  const paperById = useMemo(() => new Map(state.papers.map((p) => [p.id, p])), [state.papers])

  const hasProfiles = collectionPapers.some((p) => state.methodProfiles[p.id]?.ownMethod)

  if (!currentCollection) {
    return (
      <div className="page narrow">
        <header className="page-heading"><div><div className="eyebrow">RESEARCH DIRECTIONS</div><h1>研究方向</h1><p>先建一个集合。</p></div><div className="head-actions"><button className="btn btn-primary" onClick={() => navigate('/collections')}>去创建集合</button></div></header>
      </div>
    )
  }

  return (
    <div className="page narrow">
      <header className="page-heading">
        <div>
          <div className="eyebrow">RESEARCH DIRECTIONS</div>
          <h1>研究方向</h1>
          <p>{currentCollection.name} · {collectionPapers.length} 篇。每个建议都有依据、推理和可检验的最小实验；依据不足时少输出，不硬凑。</p>
        </div>
        <div className="head-actions">
          {!hasProfiles && (
            <button className="btn btn-sm" onClick={() => runCollectionAnalysis(currentCollection.id)}>先分类（{collectionPapers.length} 篇）</button>
          )}
          <button className="btn btn-primary" disabled={generating} onClick={async () => {
            setGenerating(true)
            try {
              const count = await generateDirections(currentCollection.id)
              toast('success', '已生成研究方向', `生成 ${count} 项；模型可用时综合具体方案，失败则保留明确标注的规则建议`)
            } finally {
              setGenerating(false)
            }
          }}>
            <Icon name="sparkle" size={15} /> {generating ? '正在综合…' : '生成研究方向'}
          </button>
        </div>
      </header>

      {dirs.length === 0 ? (
        <div className="empty">
          <span className="empty-icon"><Icon name="sparkle" size={20} /></span>
          <strong>还没有研究方向</strong>
          <p className="small muted">点击「生成研究方向」，系统会从复现缺口、机制组合缺口和作者明示的局限中，合成有来源、可检验的研究问题。</p>
        </div>
      ) : (
        <div className="stack">
          {dirs.map((d) => (
            <DirectionCard
              key={d.id}
              d={d}
              paperById={paperById}
              editing={editing === d.id}
              draft={draft}
              onEdit={() => { setEditing(d.id); setDraft({ question: d.question, hypothesis: d.hypothesis }) }}
              onDraft={(v) => setDraft(v)}
              onCancel={() => setEditing(null)}
              onSave={() => { editDirection({ ...d, question: draft.question || d.question, hypothesis: draft.hypothesis || d.hypothesis }); setEditing(null); toast('success', '已保存修改', '原始建议仍可回看') }}
              onDelete={() => deleteDirection(d.id)}
              onEvidence={() => openEvidence('方向依据', d.question, d.evidenceIds)}
              onCompare={() => { dispatch({ type: 'SET_SELECT', ids: d.relatedPaperIds.slice(0, 3) }); navigate('/compare') }}
              onDetective={() => {
                const p = d.relatedPaperIds[0]
                if (p) openDetective({ paperId: p, fieldKey: 'learningRate', from: d.question })
              }}
              onPlan={() => {
                dispatch({ type: 'SET_PLAN_DRAFT', draft: { fromProblem: d.question, paperIds: d.relatedPaperIds, dataset: d.minimalExperiment.dataset, fieldKeys: ['learningRate', 'split', 'preprocessing'], direction: d, createdAt: new Date().toISOString() } })
                navigate('/plan')
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DirectionCard({ d, paperById, editing, draft, onEdit, onDraft, onCancel, onSave, onDelete, onEvidence, onCompare, onDetective, onPlan }: {
  d: ResearchDirection
  paperById: Map<string, { shortLabel: string; title: string }>
  editing: boolean
  draft: { question: string; hypothesis: string }
  onEdit: () => void
  onDraft: (v: { question: string; hypothesis: string }) => void
  onCancel: () => void
  onSave: () => void
  onDelete: () => void
  onEvidence: () => void
  onCompare: () => void
  onDetective: () => void
  onPlan: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="card">
      <div className="card-head">
        <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <div className="row-tight" style={{ flexWrap: 'wrap' }}>
            <Tag tone={d.kind === 'prep' ? 'slate' : 'violet'}>{d.kind === 'prep' ? '资料准备' : '候选方向'}</Tag>
            <Tag tone={d.sourceType === 'author-future' ? 'green' : d.sourceType === 'synthesis' ? 'blue' : d.sourceType === 'case-extension' ? 'orange' : d.sourceType === 'limitation-derived' ? 'orange' : 'violet'}>{SOURCE_LABEL[d.sourceType]}</Tag>
            {d.edited && <Tag tone="orange">已编辑</Tag>}
            {d.kind === 'research' && <Tag tone={d.proposalMode === 'model' ? 'blue' : 'slate'}>{d.proposalMode === 'model' ? '模型综合建议' : '规则建议'}</Tag>}
            <span className="tiny muted-2">{new Date(d.generatedAt).toLocaleDateString()}</span>
          </div>
          {editing ? (
            <input className="input" value={draft.question} onChange={(e) => onDraft({ ...draft, question: e.target.value })} placeholder="研究问题" />
          ) : (
            <div className="context-title" style={{ fontSize: 15 }}>{d.question}</div>
          )}
        </div>
        <span className="spacer" />
        <div className="row-tight">
          {editing ? (
            <>
              <button className="btn btn-sm btn-primary" onClick={onSave}>保存</button>
              <button className="btn btn-sm btn-ghost" onClick={onCancel}>取消</button>
            </>
          ) : (
            <>
              <button className="btn btn-sm btn-ghost" onClick={onEdit}><Icon name="copy" size={13} /> 编辑</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen((o) => !o)}>{open ? '收起' : '展开'}</button>
            </>
          )}
        </div>
      </div>
      <div className="card-body" style={{ gap: 10 }}>
        <div className="small"><b>依据</b>：{d.relatedPaperIds.map((id) => paperById.get(id)?.shortLabel ?? id).join('、') || '无具体论文（集合级缺口）'}</div>
        {d.sourceClaims?.map((claim, i) => (
          <div className="tiny muted-2" key={`${claim.kind}-${i}`}>
            {claim.kind === 'paper-quote' ? `论文原文${claim.page ? ` · 第 ${claim.page} 页` : ''}` : '真实实验案例'}
            {claim.verified ? ' · 已核对' : ' · 待核对'}：{claim.quote}
          </div>
        ))}
        <div className="small"><b>推导</b>：{d.reasoning}</div>
        <div className="small"><b>可检验假设</b>：{editing ? <input className="input" value={draft.hypothesis} onChange={(e) => onDraft({ ...draft, hypothesis: e.target.value })} /> : d.hypothesis}</div>
        <div className="panel">
          <div className="tiny muted-2"><b>最小实验</b>（工具建议，参数与论文原设定区分）</div>
          <div className="small">对照：{d.minimalExperiment.baseline} · 变化：{d.minimalExperiment.variable} · 固定：{d.minimalExperiment.fixed}</div>
          <div className="small">数据：{d.minimalExperiment.dataset} · 指标：{d.minimalExperiment.metrics.join(' / ')}</div>
        </div>
        {d.judgment && (
          <div className="small"><b>判断方式</b>：{d.judgment}</div>
        )}
        {d.fitness && (
          <div className="panel" style={{ background: 'var(--surface-2, transparent)' }}>
            <div className="row-tight">
              <Tag tone={d.fitness.status === 'ready' ? 'green' : d.fitness.status === 'missing-prerequisite' ? 'orange' : 'slate'}>
                {d.fitness.status === 'ready' ? '可进入实验准备' : d.fitness.status === 'missing-prerequisite' ? '缺少必要前提' : '当前工具不能执行'}
              </Tag>
              <span className="tiny muted-2">{d.fitness.note}</span>
            </div>
            {!d.fitness.research && d.fitness.missing.length > 0 && (
              <div className="small" style={{ marginTop: 6 }}>
                <b>待补齐：</b>
                {d.fitness.missing.map((m, i) => <div className="tiny" key={i}>· {m}</div>)}
              </div>
            )}
            {d.fitness.research && (
              <div className="small" style={{ marginTop: 8 }}>
                <b>研究方案前提：</b>{d.fitness.research.status === 'ready' ? '已具体化' : '仍需补齐'}
                {d.fitness.research.missing.map((m, i) => <div className="tiny" key={`research-${i}`}>· {m}</div>)}
              </div>
            )}
            {d.fitness.execution && (
              <div className="small" style={{ marginTop: 8 }}>
                <b>当前产品执行：</b>{d.fitness.execution.status === 'runnable' ? '可执行' : '需外部实现或资源'}
                {d.fitness.execution.missing.map((m, i) => <div className="tiny" key={`execution-${i}`}>· {m}</div>)}
              </div>
            )}
          </div>
        )}
        {open && (
          <>
            {d.generationNote && <div className="small"><b>方案对应说明</b>：{d.generationNote}</div>}
            {d.caseSource && <div className="small"><b>案例版本</b>：{d.caseSource.caseId} · {d.caseSource.generatedAt} · 权重 {Object.values(d.caseSource.weights).join(' / ')}</div>}
            {d.unsupportedSteps && d.unsupportedSteps.length > 0 && (
              <div className="small"><b>执行边界</b>：{d.unsupportedSteps.map((s, i) => <div className="tiny muted-2" key={i}>· {s}</div>)}</div>
            )}
            <div className="small"><b>资源</b>：{d.resources}</div>
            <div className="small"><b>边界</b>：{d.boundary}</div>
            <div className="small muted-2"><b>推荐原因</b>：{d.recommendReason}</div>
          </>
        )}
        <div className="clash-actions">
          <button className="evidence-btn" onClick={onEvidence}>查看依据</button>
          <button className="evidence-btn neutral" onClick={onCompare}>核对相关论文</button>
          <button className="evidence-btn neutral" onClick={onDetective}>补齐配置</button>
          <button className="btn btn-sm btn-primary" onClick={onPlan}><Icon name="plan" size={13} /> 生成验证计划</button>
          <button className="btn btn-sm" onClick={onPlan} title="方法未接入实验室时，生成实施与准备计划，不用教学方法替代验证">实施计划</button>
          <span className="spacer" />
          <button className="icon-btn" onClick={onDelete} aria-label="删除方向" title="删除此方向"><Icon name="trash" size={13} /></button>
        </div>
      </div>
    </div>
  )
}
