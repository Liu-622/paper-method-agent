import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { MAX_SELECTION, useApp, usePickedProblems } from '@/store/AppStore'
import { FIELD_META } from '@/data/fieldSchema'
import type { FieldKey, Paper } from '@/types'
import { runFairnessCheck, summarizeFairness, fieldDisplayState } from '@/services/checks'
import { buildCounts, buildInsights, buildProblemCards, type ProblemCard } from '@/services/insights'
import { commonDatasets, sameDataset } from '@/services/scope'
import { recordComparison, recordValue } from '@/services/records'
import { EmptyState } from '@/components/EmptyState'
import { DemoBanner } from '@/components/DemoBadge'
import { FairnessTag, Tag } from '@/components/StatusTag'
import { PaperStatusTag } from '@/components/StatusTag'
import { FieldStateTag, Highlighted, ProblemCardView } from '@/components/InsightBits'
import { ClashCards } from '@/components/ClashCards'
import { Icon } from '@/components/Icons'
import { Buddy } from '@/components/Buddy'
import { UpdateAnalysisNotice } from '@/components/UpdateAnalysisNotice'

const PAPER_COLORS = ['var(--p1)', 'var(--p2)', 'var(--p3)']
const colorOf = (index: number) => PAPER_COLORS[index % PAPER_COLORS.length]

/** 表格视图的分组 */
const ROWS: { group: string; hint: string; keys: FieldKey[]; compareByFairness: boolean }[] = [
  {
    group: '方法与结论',
    hint: '各篇提出的方法与自述结论',
    keys: ['method', 'baselines', 'conclusion', 'limitations'],
    compareByFairness: false,
  },
  {
    group: '实验条件',
    hint: '决定「成绩能不能直接比较」的关键条件',
    keys: ['dataset', 'split', 'splitRange', 'horizon', 'sampleInterval', 'metrics', 'evalProtocol', 'preprocessing'],
    compareByFairness: true,
  },
  {
    group: '复现所需信息',
    hint: '不影响可比性，但决定你能不能复现出同样的数字',
    keys: ['learningRate', 'optimizer', 'randomSeed', 'epochs', 'batchSize', 'params', 'codeAvailability'],
    compareByFairness: false,
  },
]

const VERDICT_PARENT: Partial<Record<FieldKey, FieldKey>> = { splitRange: 'split', sampleInterval: 'horizon' }
const DETAIL_ROWS: FieldKey[] = ['splitRange', 'sampleInterval']

/** 列表视图里展示的字段顺序（只放"决定能不能比"的那些） */
const LIST_KEYS: FieldKey[] = [...new Set(ROWS.flatMap(row => row.keys))]

function CompareCell({ paper, fieldKey }: { paper: Paper; fieldKey: FieldKey }) {
  const { openEvidence } = useApp()
  const [expanded, setExpanded] = useState(false)
  const field = paper.fields[fieldKey]
  const value = field?.value ?? null
  const long = (value?.length ?? 0) > 90

  return (
    <td>
      <div className="stack-sm">
        {value ? (
          <>
            <div className={`cell-text${!expanded && long ? ' clamp-3' : ''}`}>
              <Highlighted text={value} />
            </div>
            {long && (
              <button className="expand-toggle" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '收起 ▴' : '展开全文 ▾'}
              </button>
            )}
          </>
        ) : (
          <FieldStateTag paper={paper} fieldKey={fieldKey} />
        )}
        <div className="row-tight">
          <button
            className={`evidence-btn${field?.evidenceIds?.length ? '' : ' neutral'}`}
            onClick={() =>
              openEvidence(`${paper.shortLabel} · ${paper.title}`, FIELD_META[fieldKey].label, field?.evidenceIds ?? [])
            }
          >
            <Icon name="search" size={13} /> 原文
          </button>
          {field?.origin === 'user' && <Tag tone="blue">已修正</Tag>}
        </div>
      </div>
    </td>
  )
}

type ResultFilter = 'key' | 'all' | 'confirmed' | 'different' | 'pending'
const FILTERS: { id: ResultFilter; label: string }[] = [
  { id: 'key', label: '关键差异' },
  { id: 'different', label: '存在差异' },
  { id: 'pending', label: '待核对' },
  { id: 'confirmed', label: '已确认' },
  { id: 'all', label: '全部' },
]

export function ComparePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch, scopedPapers, selectedPapers, toast, openEvidence, recheckOneField } = useApp()
  const [filter, setFilter] = useState<ResultFilter>('key')
  const [view, setView] = useState<'list' | 'table'>('table')
  const [rechecking, setRechecking] = useState<FieldKey | null>(null)
  const { picked: pickedIds, toggle: togglePick } = usePickedProblems()
  const highlightKey = new URLSearchParams(location.search).get('focus')

  const fairness = useMemo(
    () => runFairnessCheck(selectedPapers, state.datasetScope ?? null),
    [selectedPapers, state.datasetScope],
  )
  const fairnessByKey = useMemo(() => {
    const m: Record<string, (typeof fairness)[number]> = {}
    fairness.forEach((f) => {
      m[f.key] = f
    })
    return m
  }, [fairness])
  const sum = summarizeFairness(fairness.filter((f) => f.key !== 'method'))
  const problems = useMemo(() => buildProblemCards(selectedPapers, fairness), [selectedPapers, fairness])
  const counts = useMemo(() => buildCounts(selectedPapers, fairness), [selectedPapers, fairness])
  const insights = useMemo(() => buildInsights(selectedPapers, fairness, state.datasetScope ?? null), [selectedPapers, fairness, state.datasetScope])
  const scopeOptions = useMemo(() => commonDatasets(selectedPapers), [selectedPapers])
  const scopeCoverage = scopeOptions.find((d) => sameDataset(d.name, state.datasetScope ?? ''))
  const records = useMemo(
    () => recordComparison(selectedPapers, state.datasetScope ?? null),
    [selectedPapers, state.datasetScope],
  )

  useEffect(() => {
    if (!highlightKey) return
    const t = window.setTimeout(() => {
      document.querySelector('.field-source-flash')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    return () => window.clearTimeout(t)
  }, [highlightKey])

  const focusProblem: ProblemCard | undefined = problems[0]

  const openEvidenceFor = (evidence: { paperLabel: string; fieldKey: FieldKey }[], label: string) => {
    const first = evidence[0]
    if (!first) return
    const paper = selectedPapers.find((p) => p.shortLabel === first.paperLabel)
    const ids = evidence.flatMap((e) => selectedPapers.find((x) => x.shortLabel === e.paperLabel)?.fields[e.fieldKey]?.evidenceIds ?? [])
    openEvidence(paper ? `${paper.shortLabel} · ${paper.title}` : first.paperLabel, label, ids)
  }

  const addToPlan = (card: { title: string; fieldKey: FieldKey; riskId?: string }) => {
    dispatch({
      type: 'SET_PLAN_DRAFT',
      draft: {
        fromProblem: `${card.title}（来自方法对比）`,
        paperIds: selectedPapers.map((p) => p.id),
        dataset: state.datasetScope ?? null,
        riskId: card.riskId,
        fieldKey: card.fieldKey,
        createdAt: new Date().toISOString(),
      },
    })
    toast('success', '已加入验证计划', '论文、数据集与要核对的条件已带入计划页，可随时在底部撤销。')
    navigate('/plan')
  }

  const toggle = (paper: Paper) => {
    if (paper.status !== 'parsed') {
      toast('warning', `${paper.shortLabel} 还没有完成字段抽取`, '对比需要字段信息，请先等它解析完成或点「重新抽取」。')
      return
    }
    dispatch({ type: 'TOGGLE_SELECT', id: paper.id })
  }

  const allDemo = scopedPapers.every((p) => p.source === 'demo')
  const perPaperValue = (key: FieldKey, idx: number) => recordValue(records.rows[idx]?.record ?? null, key)

  return (
    <div className="page">
      {/* ---------------- 1. 页头（一个页面只有一个主操作） ---------------- */}
      <header className="page-heading">
        <div>
          <div className="eyebrow">COMPARE</div>
          <h1>看看这些论文，差在哪里</h1>
          <p>选 2～{MAX_SELECTION} 篇：先看清实验条件能不能对得上，再决定要不要横向比成绩。</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-primary" disabled={selectedPapers.length < 2} onClick={() => navigate('/plan')}>
            <Icon name="rocket" size={15} /> 生成验证计划
          </button>
        </div>
      </header>

      <ClashCards papers={selectedPapers} toast={toast} />

      {allDemo && scopedPapers.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <DemoBanner>：下面三篇是虚构的演示论文，用来快速看完整流程。</DemoBanner>
        </div>
      )}

      {/* ---------------- 2. 紧凑论文选择区 ---------------- */}
      <div className="paper-picker" role="listbox" aria-label="选择要比较的论文" aria-multiselectable="true">
        {scopedPapers.map((paper) => {
          const added = state.selectedIds.includes(paper.id)
          const method = paper.fields.method?.value ? String(paper.fields.method.value).split(/[、,，;/]/)[0].slice(0, 26) : ''
          return (
            <button
              key={paper.id}
              role="option"
              aria-selected={added}
              className={`picker-item${added ? ' selected' : ''}`}
              onClick={() => toggle(paper)}
              title={`${paper.title}${paper.pageCount ? ` · ${paper.pageCount} 页` : ''}`}
            >
              <Icon name={added ? 'check-circle' : 'file-text'} size={14} />
              <span className="pi-label nowrap">{paper.shortLabel}</span>
              {method && <span className="pi-method nowrap">{method}</span>}
              <PaperStatusTag status={paper.status} />
            </button>
          )
        })}
        {scopedPapers.length === 0 && <div className="small muted">当前项目里还没有论文。</div>}
        {selectedPapers.length > 0 && (
          <button
            className="picker-item"
            onClick={() => navigate(`/paper/${selectedPapers[0].id}`)}
            title="打开第一篇选中论文的详情"
          >
            <Icon name="external" size={14} /> 打开详情
          </button>
        )}
      </div>

      {selectedPapers.length < 2 ? (
        <div style={{ marginTop: 16 }}>
          <EmptyState
            icon={<Buddy size="lg" px={84} title="小咕在等你选论文" />}
            title="先选两篇，我帮你把差的地方挑出来"
            description="点上面的书签卡片即可加入对比（最多 3 篇）。之后我会按「方法、实验条件、复现信息」逐项对齐，每条都能点开原文核对。"
            actions={
              <button
                className="btn btn-primary"
                onClick={() =>
                  dispatch({ type: 'SET_SELECT', ids: scopedPapers.filter((p) => p.status === 'parsed').slice(0, 3).map((p) => p.id) })
                }
                disabled={scopedPapers.filter((p) => p.status === 'parsed').length < 2}
              >
                帮我选前 3 篇
              </button>
            }
          />
        </div>
      ) : (
        <>
          {/* ---------------- 3. 重点区域 ---------------- */}
          <div className="focus-block">
            <div className="focus-head">
              <Buddy size="sm" px={40} mood={focusProblem ? 'idle' : 'happy'} title="小咕" />
              <div style={{ minWidth: 0 }}>
                <div className="focus-title">
                  {focusProblem ? (
                    <>
                      先核对 <Highlighted text={focusProblem.title} />
                      {focusProblem.kind === 'difference' ? '：已读到的设置存在差异' : '：补齐这一项，再做判断'}
                    </>
                  ) : (
                    <>当前已读到的条件未发现差异，仍需核对证据与比较口径。</>
                  )}
                </div>
                <div className="focus-sub">
                  {state.datasetScope ? `口径：${state.datasetScope}｜` : '未限定数据集｜'}
                  {selectedPapers.map((p) => p.shortLabel).join(' · ')}
                </div>
              </div>
            </div>

            {focusProblem && (
              <div className="focus-values">
                {selectedPapers.map((p, i) => {
                  const v = focusProblem.perPaper[i]?.value ?? perPaperValue(focusProblem.fieldKey, i)
                  return (
                    <span key={p.id} className={`focus-value${v ? '' : ' pending'}`}>
                      <span className="fv-name" style={{ color: colorOf(i) }}>
                        {p.shortLabel}
                      </span>
                      <span className="fv-value">
                        {v ? <Highlighted text={String(v).slice(0, 34)} /> : '待核对'}
                      </span>
                    </span>
                  )
                })}
              </div>
            )}

            <div className="focus-actions">
              {focusProblem && (
                <button className="evidence-btn" onClick={() => openEvidenceFor(focusProblem.evidence, focusProblem.title)}>
                  <Icon name="search" size={13} /> 查看证据
                </button>
              )}
              {pickedIds.length > 0 && <span className="focus-meta">已选 {pickedIds.length} 个问题</span>}
              <span className="spacer" />
              <span className="focus-meta">
                待核对 {counts.pending.n}/{counts.pending.total} 项 · 已确认 {counts.organized.n}/{counts.organized.total} 项
              </span>
            </div>

            <details className="analysis">
              <summary>分析详情</summary>
              <div className="small muted" style={{ margin: '6px 0 8px' }}>
                {counts.organized.definition}；{counts.different.definition}；{counts.pending.definition}。
              </div>
              {insights.map((ins) => (
                <div key={ins.id} className="insight-row">
                  <span className="ir-kind">{ins.title}</span>
                  <span>
                    <Highlighted text={ins.text} />
                  </span>
                  <span className="spacer" />
                  <button className="evidence-btn" onClick={() => openEvidenceFor(ins.evidence, ins.title)}>
                    依据
                  </button>
                </div>
              ))}
              <div className="tiny muted-2" style={{ marginTop: 6 }}>
                说明：这里只做条件对齐，不给方法排名；一致只代表前提成立，不代表结论已被验证。
              </div>
            </details>
          </div>

          {/* ---------------- 4. 内容工具条（吸顶） ---------------- */}
          <div className="workbar">
            <div className="workbar-group">
              <span className="workbar-label">数据集</span>
              <button
                className={`chip${!state.datasetScope ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'SET_DATASET_SCOPE', dataset: null })}
              >
                整体口径
              </button>
              {scopeOptions.slice(0, 6).map((d) => (
                <button
                  key={d.name}
                  className={`chip${sameDataset(d.name, state.datasetScope ?? '') ? ' active' : ''}${
                    d.paperIds.length < selectedPapers.length ? ' partial' : ''
                  }`}
                  onClick={() => dispatch({ type: 'SET_DATASET_SCOPE', dataset: d.name })}
                  title={d.missingPaperIds.length > 0 ? `有 ${d.missingPaperIds.length} 篇未确认涉及这个数据集` : '所选论文都涉及'}
                >
                  {d.name}
                  <span className="chip-sub">
                    {d.paperIds.length}/{selectedPapers.length}
                  </span>
                </button>
              ))}
              {scopeOptions.length > 6 && <select className="select input-sm" aria-label="更多数据集" value={state.datasetScope ?? ''} onChange={e => dispatch({ type: 'SET_DATASET_SCOPE', dataset: e.target.value || null })}><option value="">更多数据集…</option>{scopeOptions.map(d => <option key={d.name} value={d.name}>{d.name}（{d.paperIds.length}/{selectedPapers.length}）</option>)}</select>}
            </div>

            <div className="spacer" />

            <div className="workbar-group">
              <span className="workbar-label">结果</span>
              {FILTERS.map((f) => (
                <button key={f.id} className={`chip${filter === f.id ? ' active' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>

            <div className="seg" role="tablist" aria-label="视图">
              <button role="tab" aria-selected={view === 'table'} className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>
                比较矩阵
              </button>
              <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
                问题卡片
              </button>
            </div>
          </div>

          {state.datasetScope && scopeCoverage && scopeCoverage.missingPaperIds.length > 0 && (
            <div className="small muted" style={{ marginBottom: 10 }}>
              有 {scopeCoverage.missingPaperIds.length} 篇没有涉及 {state.datasetScope}，它们会显示「未涉及该数据集」，
              不计作论文漏写；换回「整体口径」可以看全部条件。
            </div>
          )}

          {/* ---------------- 5. 结果 ---------------- */}
          <UpdateAnalysisNotice papers={selectedPapers} compact />
          {view === 'list' ? (
            <div className="result-list">
              {LIST_KEYS.filter((k) => selectedPapers.some((p) => p.fields[k] !== undefined))
                .filter((k) => {
                  if (filter === 'all') return true
                  const parentKey = VERDICT_PARENT[k] ?? k
                  const fair = DETAIL_ROWS.includes(k) ? fairnessByKey[parentKey] : fairnessByKey[k]
                  if (filter === 'different') return fair?.verdict === 'different'
                  const states = selectedPapers.map((p) => fieldDisplayState(p, k).state)
                  if (filter === 'pending') return states.some((s) => s === 'not_found' || s === 'need_confirm' || s === 'not_checked')
                  if (filter === 'confirmed') return states.every((s) => s === 'ok' || s === 'recovered')
                  return fair?.verdict === 'different' || states.some((s) => s !== 'ok' && s !== 'recovered')
                })
                .map((k) => {
                  const parentKey = VERDICT_PARENT[k] ?? k
                  const fair = DETAIL_ROWS.includes(k) ? fairnessByKey[parentKey] : fairnessByKey[k]
                  const card = problems.find((c) => c.fieldKey === k)
                  return (
                    <details key={k} open={highlightKey === k || undefined} className={`result-item${fair?.verdict === 'different' ? ' diff' : ''}${highlightKey === k ? ' field-source-flash' : ''}`}>
                      <summary
                        className="result-head"
                        title="展开各篇取值、原因与操作"
                      >
                        <span className="result-field">{FIELD_META[k].label}</span>
                        {fair && <FairnessTag verdict={fair.verdict} />}
                        <span className="result-values">
                          {selectedPapers.map((p, i) => {
                            const v = perPaperValue(k, i)
                            return (
                              <span key={p.id} className={`rv${v ? '' : ' pending'}`}>
                                <b style={{ color: colorOf(i) }}>{p.shortLabel}</b> {v ? String(v).slice(0, 18) : '待核对'}
                              </span>
                            )
                          })}
                        </span>
                        <span className="spacer" /><Icon name="chevron" size={15} className="result-expand" />
                        {card && (
                          <input
                            type="checkbox"
                            checked={pickedIds.includes(`${card.kind}::${card.fieldKey}::${card.riskId ?? ''}`)}
                            aria-label={`选择问题：${FIELD_META[k].label}`}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation()
                              togglePick(`${card.kind}::${card.fieldKey}::${card.riskId ?? ''}`)
                            }}
                          />
                        )}
                      </summary>
                      <div className="result-body">
                        <div className="per-paper-grid">{selectedPapers.map((p, i) => <div className="per-paper" key={p.id}><div className="per-paper-label" style={{ marginBottom: 8 }}>{p.shortLabel} · {p.title.replace(/^\d+[_\s-]*/, '').split(/[_\s]/)[0]}</div><div className="small">{perPaperValue(k, i) || p.fields[k]?.value ? <Highlighted text={String(perPaperValue(k, i) || p.fields[k]?.value)} /> : <FieldStateTag paper={p} fieldKey={k} />}</div></div>)}</div>
                        <div className="tiny muted-2" style={{ margin: '8px 0 4px' }}>
                          为什么会影响比较
                        </div>
                        <div className="small">{fair?.whyItMatters ?? '该条件不一致会影响结果可比性。'}</div>
                        {fair?.partial && fair.pendingPaperLabels?.length ? (
                          <div className="tiny muted-2" style={{ marginTop: 4 }}>
                            另有 {fair.pendingPaperLabels.length} 篇待核对：{fair.pendingPaperLabels.join('、')}
                          </div>
                        ) : null}
                        <div className="row-tight" style={{ marginTop: 8 }}>
                          <button
                            className="evidence-btn"
                            onClick={() => openEvidenceFor(selectedPapers.map((p) => ({ paperLabel: p.shortLabel, fieldKey: k })), FIELD_META[k].label)}
                          >
                            <Icon name="search" size={13} /> 查看依据
                          </button>
                          <button
                            className="btn btn-sm"
                            disabled={rechecking === k}
                            title="只对这一项做定向全文检索与引用校验，不会重跑整篇"
                            onClick={async () => {
                              if (rechecking) return
                              setRechecking(k)
                              try {
                                for (const p of selectedPapers) {
                                  if (p.fields[k] === undefined) continue
                                  await recheckOneField(p, k)
                                }
                              } finally {
                                setRechecking(null)
                              }
                            }}
                          >
                            <Icon name="refresh" size={14} /> {rechecking === k ? '正在补查…' : '补查这一项'}
                          </button>
                          {card && (
                            <button className="btn btn-sm" onClick={() => addToPlan({ title: FIELD_META[k].label, fieldKey: k, riskId: card.riskId })}>
                              <Icon name="plus" size={14} /> 加入验证计划
                            </button>
                          )}
                          <button
                            className="btn btn-sm"
                            title="进实验室：改一个条件，看真实计算结果"
                            onClick={() =>
                              navigate(
                                `/lab?key=${k}&source=paper${selectedPapers[0] ? `&paper=${selectedPapers[0].id}` : ''}`,
                              )
                            }
                          >
                            <Icon name="lab" size={14} /> 进实验室验证
                          </button>
                        </div>
                      </div>
                    </details>
                  )
                })}
              {problems.length === 0 && filter === 'key' && (
                <div className="small muted">没有需要优先处理的差异；切到「全部」可以看到完整条件。</div>
              )}
            </div>
          ) : (
            ROWS.map((row) => {
              const keys = row.keys.filter((k) => selectedPapers.some((p) => p.fields[k] !== undefined))
              if (keys.length === 0) return null
              return (
                <div key={row.group}>
                  <div className="section-title">
                    <h2>{row.group}</h2>
                    <span className="sub">{row.hint}</span>
                  </div>
                  <div className="matrix-wrap">
                    <table className="matrix">
                      <thead>
                        <tr>
                          <th className="row-label">对比项</th>
                          {selectedPapers.map((p, i) => (
                            <th key={p.id} style={{ minWidth: 230 }}>
                              <span className="mono strong" style={{ color: colorOf(i) }}>
                                {p.shortLabel}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {keys.map((k) => {
                          const isDetail = DETAIL_ROWS.includes(k)
                          const parentKey = VERDICT_PARENT[k] ?? k
                          const fair = isDetail ? fairnessByKey[parentKey] : fairnessByKey[k]
                          return (
                            <tr key={k} className={highlightKey === k ? 'field-source-flash' : undefined}>
                              <td className="row-label">
                                {FIELD_META[k].label}
                                {row.compareByFairness && fair && (
                                  <div style={{ marginTop: 5 }}>
                                    <FairnessTag verdict={fair.verdict} />
                                  </div>
                                )}
                              </td>
                              {selectedPapers.map((p) => (
                                <CompareCell key={p.id} paper={p} fieldKey={k} />
                              ))}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => dispatch({ type: 'CLEAR_SELECT' })}>
              清空选择
            </button>
            <div className="spacer" />
            <button className="btn" onClick={() => navigate(`/qa`)}>
              <Icon name="qa" size={14} /> 就这些问小咕
            </button>
          </div>
        </>
      )}
    </div>
  )
}
