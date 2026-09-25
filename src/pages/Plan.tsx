import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MAX_SELECTION, useApp } from '@/store/AppStore'
import { Icon } from '@/components/Icons'
import type {
  ExperimentProgress,
  ResourceProfile,
  RiskOption,
  VerificationExperiment,
  VerificationPlan,
} from '@/types'
import {
  DEFAULT_PROFILE,
  DEVICE_TEXT,
  GOAL_TEXT,
  NO_RESULT_WARNING,
  OBSERVATION_ONLY_WARNING,
  SOURCE_TEXT,
  STATUS_TEXT,
  TIME_TEXT,
  clampManualStatus,
  collectRiskOptions,
  generatePlan,
  nextStatus,
  planToMarkdown,
} from '@/services/planner'
import { commonDatasets } from '@/services/scope'
import { EmptyState } from '@/components/EmptyState'
import { DemoBanner } from '@/components/DemoBadge'
import { SupportTag, Tag } from '@/components/StatusTag'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/* ------------------------------------------------------------------ */
/* 两个示例场景（明确标注为示例）                                       */
/* ------------------------------------------------------------------ */

interface Scenario {
  id: string
  label: string
  hint: string
  profile: Partial<ResourceProfile>
  /** 生成后要体现的重点 */
  expect: string
}

const SCENARIOS: Scenario[] = [
  {
    id: 'cpu-limited',
    label: '示例 A：仅 CPU、时间有限',
    hint: '先检查数据处理与评估流程，不训练模型',
    profile: { device: 'cpu', timeBudget: '1h', goal: 'pipeline' },
    expect: '计划会把「划分/区间/采样间隔/指标口径」放在优先级 1，并在规模说明里明确不做训练。',
  },
  {
    id: 'gpu-fairness',
    label: '示例 B：有单张 GPU',
    hint: '优先核对一项影响公平比较的实验条件',
    profile: { device: 'gpu1', timeBudget: '1d', goal: 'fairness' },
    expect: '计划会把共同的、影响可比性的条件放在优先级 1，并说明最小规模跑通不等于复现。',
  },
]

/* ------------------------------------------------------------------ */

function ValueRow({ value }: { value: VerificationExperiment['values'][number] }) {
  const tone = value.source === 'paper' ? 'green' : value.source === 'tool' ? 'blue' : 'orange'
  return (
    <tr>
      <td className="small" style={{ whiteSpace: 'nowrap' }}>
        {value.label}
      </td>
      <td className="small">{value.value}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <Tag tone={tone}>{SOURCE_TEXT[value.source]}</Tag>
      </td>
    </tr>
  )
}

function ExperimentCard({
  exp,
  progress,
  onToggleStep,
  onResult,
  onStatus,
}: {
  exp: VerificationExperiment
  progress: ExperimentProgress | undefined
  onToggleStep: (stepId: string, done: boolean) => void
  onResult: (patch: { actualResult?: string; observation?: string }) => void
  onStatus: (status: ExperimentProgress['status']) => void
}) {
  const [open, setOpen] = useState(true)
  const status = progress?.status ?? nextStatus(exp, progress)
  const checked = exp.steps.filter((s) => progress?.steps?.[s.id]).length
  const hasResult = Boolean(progress?.actualResult?.trim())

  return (
    <div className="card experiment-card" style={{ marginBottom: 14 }}>
      <div className="card-head">
        <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Tag tone="violet">优先级 {exp.priority}</Tag>
          <strong>{exp.title}</strong>
          <Tag tone={status === 'done' ? 'green' : status === 'running' ? 'blue' : status === 'to_confirm' ? 'orange' : 'plain'} dot>
            {STATUS_TEXT[status]}
          </Tag>
          <span className="tiny muted-2">
            步骤 {checked}/{exp.steps.length}
            {hasResult ? ' · 已填实际结果' : ' · 未填实际结果'}
          </span>
          <div className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={() => setOpen((v) => !v)}>
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {open && (
        <div className="card-body">
          <div className="stack-sm">
            <div>
              <div className="small muted-2">要确认的问题</div>
              <div>{exp.question}</div>
            </div>
            <div>
              <div className="small muted-2">为什么优先做</div>
              <div>{exp.whyPriority}</div>
            </div>
            {exp.relatedRiskLabels.length > 0 && (
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <span className="small muted-2">关联风险项：</span>
                {exp.relatedRiskLabels.map((l) => (
                  <Tag key={l} tone="orange">
                    {l}
                  </Tag>
                ))}
              </div>
            )}
          </div>

          <details className="experiment-reference"><summary>查看参数与待确认条件 · 每项保留来源</summary>
          <h4 style={{ marginTop: 14 }}>关键参数</h4>
          <table className="table">
            <thead>
              <tr>
                <th>参数</th>
                <th>取值</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {exp.values.map((v, i) => (
                <ValueRow key={`${v.label}-${i}`} value={v} />
              ))}
            </tbody>
          </table>
          <div className="small muted-2" style={{ marginTop: 6 }}>
            标「{SOURCE_TEXT.paper}」的项来自论文原文（可在论文详情页按字段查看页码与英文原句）；
            标「{SOURCE_TEXT.tool}」的是本工具的建议；标「{SOURCE_TEXT.unconfirmed}」的**必须先回原文确认**，
            本工具不会替你填一个看起来合理的数值。
          </div>

          {exp.pending.length > 0 && (
            <div className="banner banner-warn" style={{ marginTop: 12 }}>
              <span className="banner-icon">❓</span>
              <div>
                <strong>待确认项（论文没写清楚）</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {exp.pending.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          </details>
          <div className="grid-3" style={{ marginTop: 14 }}>
            <div>
              <h4>需要准备</h4>
              <div className="small muted-2">数据</div>
              <ul className="small">
                {exp.prepare.data.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <div className="small muted-2">代码</div>
              <ul className="small">
                {exp.prepare.code.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <div className="small muted-2">环境</div>
              <ul className="small">
                {exp.prepare.env.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4>最小操作步骤（可勾选）</h4>
              <div className="stack-sm">
                {exp.steps.map((s) => (
                  <label key={s.id} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(progress?.steps?.[s.id])}
                      onChange={(e) => onToggleStep(s.id, e.target.checked)}
                    />
                    <span className="small">{s.text}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <h4>保持一致的条件</h4>
              <ul className="small">
                {exp.keepConstant.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <h4>需要改变的变量</h4>
              <ul className="small">
                {exp.variables.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
              <h4>应记录的指标</h4>
              <ul className="small">
                {exp.metrics.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="grid-2" style={{ marginTop: 14 }}>
            <div className="banner banner-ok">
              <span className="banner-icon">✅</span>
              <div>
                <strong>什么结果支持当前假设</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {exp.supportIf.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="banner banner-warn">
              <span className="banner-icon">⚠️</span>
              <div>
                <strong>什么结果不支持当前假设</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {exp.refuteIf.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          <div className="banner banner-info" style={{ marginTop: 12 }}>
            <span className="banner-icon">🛑</span>
            <div>
              <strong>什么情况下停止 / 改用更小的实验</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {exp.stopIf.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="small muted-2" style={{ marginTop: 10 }}>
            规模说明：{exp.scaleNote}
          </div>

          <h4 style={{ marginTop: 16 }}>我的记录</h4>
          <div className="grid-2">
            <label className="stack-sm">
              <span className="small muted-2">实际结果（跑出来的数字 / 观察到的事实）</span>
              <textarea
                className="input"
                rows={3}
                value={progress?.actualResult ?? ''}
                placeholder="例如：按 7:1:2 划分后，训练/验证/测试长度分别为 …；复算 MSE 为 …"
                onChange={(e) => onResult({ actualResult: e.target.value })}
              />
            </label>
            <label className="stack-sm">
              <span className="small muted-2">我的观察（哪一步和论文不一致、可能的原因）</span>
              <textarea
                className="input"
                rows={3}
                value={progress?.observation ?? ''}
                placeholder="例如：测试区间与论文不同，导致结果偏乐观；下一步准备向作者确认划分边界"
                onChange={(e) => onResult({ observation: e.target.value })}
              />
            </label>
          </div>

          <div className="row" style={{ marginTop: 10, alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="small muted-2">状态：</span>
            {(Object.keys(STATUS_TEXT) as (keyof typeof STATUS_TEXT)[]).map((s) => (
              <button
                key={s}
                className={`btn btn-sm${status === s ? ' btn-primary' : ''}`}
                disabled={s === 'done' && !progress?.actualResult?.trim()}
                title={
                  s === 'done' && !progress?.actualResult?.trim()
                    ? '没有「实际结果」不能标为已完成（观察不算结果）'
                    : undefined
                }
                onClick={() => {
                  // 手动切换走与自动推导**同一道校验**：没有实际结果点不了「已完成」
                  const [clamped, blocked] = clampManualStatus(s, progress)
                  onStatus(clamped)
                  if (blocked) {
                    window.alert(OBSERVATION_ONLY_WARNING)
                  }
                }}
              >
                {STATUS_TEXT[s]}
              </button>
            ))}
            <span className="tiny muted-2">
            已完成 = 已记录实际结果，不代表假设成立。
            </span>
          </div>

          {!progress?.actualResult?.trim() && progress?.observation?.trim() && (
            <div className="banner banner-warn" style={{ marginTop: 10 }}>
              <span className="banner-icon">✍️</span>
              <div>{OBSERVATION_ONLY_WARNING}</div>
            </div>
          )}
          {!hasResult && <div className="banner banner-warn" style={{ marginTop: 10 }}>{NO_RESULT_WARNING}</div>}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

export function PlanPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { state, dispatch, scopedPapers, selectedPapers, toast } = useApp()
  const [profile, setProfile] = useState<ResourceProfile>(
    () => state.verificationPlan?.profile ?? { ...DEFAULT_PROFILE, dataset: state.datasetScope ?? null },
  )
  const [scenarioId, setScenarioId] = useState<string>('')
  const [pendingBuild, setPendingBuild] = useState<ResourceProfile | null>(null)
  const initializedRiskScope = useRef<string | null>(null)

  const scopeOptions = useMemo(() => commonDatasets(selectedPapers), [selectedPapers])
  const risks = useMemo(
    () => collectRiskOptions(selectedPapers, profile.dataset),
    [selectedPapers, profile.dataset],
  )

  // 默认只勾前 2 条最相关的风险，不让用户面对一个空表单
  useEffect(() => {
    const scopeKey = `${selectedPapers.map(p => p.id).join('|')}::${profile.dataset ?? ''}`
    if (initializedRiskScope.current !== scopeKey && risks.length > 0) {
      initializedRiskScope.current = scopeKey
      setProfile((p) => ({ ...p, riskIds: risks.slice(0, 2).map((r) => r.id) }))
    }
  }, [risks, profile.dataset, selectedPapers])

  // 从对比页/检查页「加入验证计划」带过来的草稿：自动带入论文、数据集与要核对的风险项
  useEffect(() => {
    const draft = state.planDraft
    if (!draft) return
    if (draft.paperIds.length > 0 && draft.paperIds.some((id) => !state.selectedIds.includes(id))) {
      dispatch({ type: 'SET_SELECT', ids: draft.paperIds.slice(0, 3) })
    }
    // 风险项：草稿里带的是规则编号（如 R-02），这里映射回风险项 id
    const matched = collectRiskOptions(selectedPapers, draft.dataset ?? null).filter((r) =>
      r.ruleId === draft.riskId || r.id === draft.riskId || r.key === draft.fieldKey ||
      draft.fieldKeys?.includes(r.key) || draft.riskIds?.some(id => id === r.ruleId || id === r.id))
    setProfile((p) => ({
      ...p,
      dataset: draft.dataset ?? null,
      riskIds: matched.length > 0 ? matched.map((r) => r.id) : p.riskIds,
    }))
    // 只在草稿变化时应用一次
  }, [state.planDraft])

  const plan = state.verificationPlan ?? null
  const progress = state.planProgress ?? {}

  const build = (p: ResourceProfile, confirmed = false) => {
    const hasWork = Object.values(progress).some(x => x.actualResult?.trim() || x.observation?.trim() || Object.values(x.steps ?? {}).some(Boolean))
    if (plan && hasWork && !confirmed) { setPendingBuild(p); return }
    const built = generatePlan(selectedPapers, p, p.dataset, collectRiskOptions(selectedPapers, p.dataset))
    dispatch({ type: 'SET_VERIFICATION_PLAN', plan: built })
    dispatch({ type: 'CLEAR_PLAN_PROGRESS' })
    toast('success', '已生成最小验证计划', `共 ${built.experiments.length} 个实验，按优先级排列。`)
  }

  const applyScenario = (s: Scenario) => {
    setScenarioId(s.id)
    const next: ResourceProfile = {
      ...DEFAULT_PROFILE,
      dataset: profile.dataset,
      riskIds: risks.slice(0, 2).map((r) => r.id),
      ...s.profile,
    }
    setProfile(next)
    build(next)
  }

  const exportMarkdown = () => {
    if (!plan) return
    const md = planToMarkdown(plan, progress)
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `验证计划-${new Date().toISOString().slice(0, 10)}.md`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast('success', '已导出 Markdown', '包含全部参数来源、步骤勾选状态与你的记录。')
  }

  const copyMarkdown = async () => {
    if (!plan) return
    try {
      await navigator.clipboard.writeText(planToMarkdown(plan, progress))
      toast('success', '已复制到剪贴板', '可以直接粘贴到实验记录里。')
    } catch {
      toast('warning', '复制失败', '浏览器拒绝了剪贴板访问，请改用「导出 Markdown」。')
    }
  }

  const allDemo = selectedPapers.length > 0 && selectedPapers.every((p) => p.source === 'demo')

  useEffect(() => {
    const handler = () => exportMarkdown()
    window.addEventListener('paper-guard:export-plan', handler)
    return () => window.removeEventListener('paper-guard:export-plan', handler)
  }, [plan, progress])
  useEffect(() => {
    if (params.get('export') !== '1') return
    setParams({}, { replace: true })
    if (plan) exportMarkdown()
    else toast('info', '还没有可导出的计划', '先选择论文并生成计划。')
  }, [params])

  return (
    <div className="page plan-page">
      <div className="row" style={{ marginBottom: 14, alignItems: 'center' }}>
        <div>
          <div className="eyebrow">FROM QUESTION TO ACTION</div><h1>让下一步，具体一点</h1>
          <div className="small muted-2">
            根据你的设备、时间与待核对问题，安排可以执行的验证任务。
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => navigate(state.planDraft?.direction ? '/directions' : '/check')}>
          {state.planDraft?.direction ? '回到研究方向' : '回到实验检查'}
        </button>
      </div>

      {allDemo && (
        <div style={{ marginBottom: 14 }}>
          <DemoBanner>：下面的计划基于虚构的演示论文，用于演示"风险 → 计划"的生成流程。</DemoBanner>
        </div>
      )}

      {selectedPapers.length === 0 ? (
        <EmptyState
          icon="🧭"
          title="先选择要复现的论文"
          description="验证计划需要至少 1 篇论文（建议 2 篇：有共同数据集才能做公平性核对）。可以到论文库勾选，或先载入示例项目。"
          actions={
            <button className="btn btn-primary" onClick={() => navigate('/library')}>
              去论文库选择
            </button>
          }
        />
      ) : (
        <>
          {/* 来源已变化时只提示，不改动用户记录 */}
          {state.planDraft &&
            (() => {
              // 研究方向里的 dataset 是实验目标数据，不是对比页的筛选口径；
              // 只有来自对比/检查页的草稿才比较 datasetScope。
              const changedDataset = !state.planDraft.direction && state.planDraft.dataset !== (state.datasetScope ?? null)
              const changedPapers = state.planDraft.paperIds.length !== selectedPapers.length || state.planDraft.paperIds.some(id => !selectedPapers.some(p => p.id === id))
              if (!changedDataset && !changedPapers) return null
              return (
                <div className="update-notice" style={{ marginBottom: 12 }}>
                  <Icon name="refresh" size={15} />
                  <div>
                    <strong>来源已更新。</strong>
                    这条计划来自「{state.planDraft.fromProblem}」，但当前
                    {changedDataset
                      ? `数据集口径是 ${state.datasetScope ?? '整体口径'}，与生成计划时不同`
                      : '选中的论文与生成计划时不同'}
                    。现有记录不会自动改写；重新生成会替换当前计划，请先导出保存。
                  </div>
                </div>
              )
            })()}

          {/* 来源问题的条件已带入，可一键回到对应来源 */}
          {state.planDraft && (
            <div className="banner banner-info" style={{ marginBottom: 14 }}>
              <span className="banner-icon">🧭</span>
              <div>
                来自{state.planDraft.direction ? '研究方向' : '对比/检查页'}的问题：<strong>{state.planDraft.fromProblem}</strong>
                。已自动带入{' '}
                <strong>{state.planDraft.paperIds.length}</strong> 篇论文
                {state.planDraft.dataset ? (
                  <>
                    、数据集口径 <strong>{state.planDraft.dataset}</strong>
                  </>
                ) : null}
                {profile.riskIds.length > 0 ? (
                  <>
                    、风险项 <strong>{profile.riskIds.length}</strong> 个
                  </>
                ) : null}
                —— 不需要重新选择所有条件。
                {state.planDraft.direction && (
                  <div className="stack-sm" style={{ gap: 2, marginTop: 8, borderTop: '1px solid var(--divider)', paddingTop: 8 }}>
                    <div className="tiny muted-2">来源：{state.planDraft.direction.sourceType} · {state.planDraft.direction.proposalMode === 'model' ? '模型综合建议' : '规则建议'}{state.planDraft.direction.sourceVersion ? ` · 版本 ${state.planDraft.direction.sourceVersion}` : ''}</div>
                    <div className="small">假设：{state.planDraft.direction.hypothesis}</div>
                    <div className="tiny muted-2">对照 {state.planDraft.direction.minimalExperiment.baseline} · 变量 {state.planDraft.direction.minimalExperiment.variable} · 固定 {state.planDraft.direction.minimalExperiment.fixed}</div>
                    <div className="tiny muted-2">数据 {state.planDraft.direction.minimalExperiment.dataset} · 指标 {state.planDraft.direction.minimalExperiment.metrics.join(' / ')}</div>
                    {state.planDraft.direction.judgment && <div className="tiny muted-2">判断方式：{state.planDraft.direction.judgment}</div>}
                    {state.planDraft.direction.fitness?.missing?.length ? (
                      <div className="tiny" style={{ color: 'var(--warn, #9a6700)' }}>待补齐：{state.planDraft.direction.fitness.missing.join('；')}</div>
                    ) : null}
                    {state.planDraft.direction.fitness?.research && (
                      <div className="tiny muted-2">研究方案前提：{state.planDraft.direction.fitness.research.status === 'ready' ? '已具体化' : state.planDraft.direction.fitness.research.missing.join('；')}</div>
                    )}
                    {state.planDraft.direction.fitness?.execution && (
                      <div className="tiny muted-2">当前产品执行：{state.planDraft.direction.fitness.execution.status === 'runnable' ? '可执行' : state.planDraft.direction.fitness.execution.missing.join('；')}</div>
                    )}
                    {state.planDraft.direction.caseSource && (
                      <div className="tiny muted-2">案例来源：{state.planDraft.direction.caseSource.caseId} · {state.planDraft.direction.caseSource.generatedAt} · 权重 {Object.values(state.planDraft.direction.caseSource.weights).join(' / ')}</div>
                    )}
                  </div>
                )}
                <div className="row-tight" style={{ marginTop: 6 }}>
                  <button className="btn btn-sm btn-ghost" onClick={() => navigate(state.planDraft?.direction ? '/directions' : '/compare')}>
                    ← 回到来源问题
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => dispatch({ type: 'CLEAR_PLAN_DRAFT' })}
                  >
                    忽略这条来源
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ---------------- 输入（紧凑：一行摘要 + 生成计划；细节展开） ---------------- */}
          <details className="card plan-settings" style={{ marginBottom: 14 }} open={!plan}>
            <summary className="card-head plan-summary">
              <strong>资源与目标</strong>
              <span className="tiny muted-2">
                {DEVICE_TEXT[profile.device]}｜{TIME_TEXT[profile.timeBudget]}
                {profile.dataset ? `｜${profile.dataset}` : ''}｜风险项 {profile.riskIds.length}
              </span>
              <span className="spacer" />
              <span className="tiny muted-2">{selectedPapers.map((p) => p.shortLabel).join('、')}</span>
              <button
                className="btn btn-sm btn-primary"
                onClick={(e) => {
                  e.preventDefault()
                  build(profile)
                }}
              >
                生成验证计划
              </button>
            </summary>
            <div className="card-body">
              <div className="grid-2">
                <div className="stack-sm">
                  <div>
                    <div className="small muted-2" style={{ marginBottom: 4 }}>
                      设备条件
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {(['cpu', 'gpu1', 'custom'] as const).map((d) => (
                        <button
                          key={d}
                          className={`btn btn-sm${profile.device === d ? ' btn-primary' : ''}`}
                          onClick={() => setProfile((p) => ({ ...p, device: d }))}
                        >
                          {DEVICE_TEXT[d]}
                        </button>
                      ))}
                    </div>
                    {profile.device === 'custom' && (
                      <input
                        className="input input-sm"
                        style={{ marginTop: 6 }}
                        placeholder="例如：2 × 24GB / Colab T4 / 只有笔记本"
                        value={profile.deviceNote}
                        onChange={(e) => setProfile((p) => ({ ...p, deviceNote: e.target.value }))}
                      />
                    )}
                  </div>

                  <div>
                    <div className="small muted-2" style={{ marginBottom: 4 }}>
                      可投入时间
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {(['1h', '1d', '3d', '1w'] as const).map((t) => (
                        <button
                          key={t}
                          className={`btn btn-sm${profile.timeBudget === t ? ' btn-primary' : ''}`}
                          onClick={() => setProfile((p) => ({ ...p, timeBudget: t }))}
                        >
                          {TIME_TEXT[t]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="stack-sm">
                  <div>
                    <div className="small muted-2" style={{ marginBottom: 4 }}>
                      目标
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {(['pipeline', 'single-claim', 'fairness'] as const).map((g) => (
                        <button
                          key={g}
                          className={`btn btn-sm${profile.goal === g ? ' btn-primary' : ''}`}
                          onClick={() => setProfile((p) => ({ ...p, goal: g }))}
                        >
                          {GOAL_TEXT[g]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="small muted-2" htmlFor="plan-dataset">
                      目标数据集
                    </label>
                    <select
                      id="plan-dataset"
                      className="input input-sm"
                      value={profile.dataset ?? ''}
                      onChange={(e) => setProfile((p) => ({ ...p, dataset: e.target.value || null, riskIds: [] }))}
                    >
                      <option value="">论文整体口径（不限定）</option>
                      {scopeOptions.map((o) => (
                        <option key={o.name} value={o.name}>
                          {o.name}（{o.paperIds.length}/{o.totalPapers} 篇包含）
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <input
                      className="input input-sm"
                      placeholder="可选：已有代码地址（GitHub / 压缩包路径）"
                      value={profile.codeUrl}
                      onChange={(e) => setProfile((p) => ({ ...p, codeUrl: e.target.value }))}
                      style={{ flex: '1 1 240px' }}
                    />
                    <select
                      className="input input-sm"
                      value={profile.dataReady}
                      onChange={(e) =>
                        setProfile((p) => ({ ...p, dataReady: e.target.value as ResourceProfile['dataReady'] }))
                      }
                    >
                      <option value="ready">数据已准备好</option>
                      <option value="partial">数据只有一部分</option>
                      <option value="none">数据还没准备</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* 风险项 */}
              <div style={{ marginTop: 14 }}>
                <div className="small muted-2" style={{ marginBottom: 6 }}>
                  需要确认的风险（来自实验检查；不勾选时默认取前 2 条）
                </div>
                {risks.length === 0 ? (
                  <div className="small muted-2">
                    当前选择在「{profile.dataset ?? '论文整体口径'}」下没有发现差异或缺口 ——
                    可以换个数据集口径再看看，或直接生成计划（计划会以"流程核对"为主）。
                  </div>
                ) : (
                  <div className="stack-sm">
                    {risks.map((r: RiskOption) => (
                      <label key={r.id} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={profile.riskIds.includes(r.id)}
                          onChange={(e) =>
                            setProfile((p) => ({
                              ...p,
                              riskIds: e.target.checked
                                ? [...p.riskIds, r.id]
                                : p.riskIds.filter((x) => x !== r.id),
                            }))
                          }
                        />
                        <span className="small">
                          <b>{r.label}</b> <Tag tone="plain">{r.ruleId}</Tag>{' '}
                          <Tag tone={r.verdictText === '存在差异' ? 'orange' : r.verdictText === '信息不足' ? 'slate' : 'red'}>
                            {r.verdictText}
                          </Tag>
                          <span className="muted-2"> {r.detail}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="row" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => build(profile)}>
                  重新生成
                </button>
                {SCENARIOS.map((s) => (
                  <button
                    key={s.id}
                    className={`btn${scenarioId === s.id ? ' btn-primary' : ''}`}
                    onClick={() => applyScenario(s)}
                    title={s.hint}
                  >
                    {s.label}
                  </button>
                ))}
                <span className="tiny muted-2" style={{ alignSelf: 'center' }}>
                  带「示例」字样的按钮会填入示例条件，用于快速看输出
                </span>
              </div>
            </div>
          </details>

          {/* ---------------- 输出 ---------------- */}
          {plan ? (
            <>
              <div className="plan-progress-strip"><Icon name="plan" size={19} /><strong>验证进度</strong><progress max={Math.max(1, plan.experiments.length)} value={plan.experiments.filter(e => progress[e.id]?.status === 'done').length} /><span>{plan.experiments.filter(e => progress[e.id]?.status === 'done').length} / {plan.experiments.length} 个任务已记录结果</span></div>
              <div className="card" style={{ marginBottom: 14 }}>
                <div className="card-body tight">
                  <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Tag tone="blue">计划已生成</Tag>
                    <span className="small">
                      {plan.paperLabels.join('、')}｜数据集：{plan.dataset ?? '论文整体口径'}｜
                      {DEVICE_TEXT[plan.profile.device]}
                      {plan.profile.deviceNote ? `（${plan.profile.deviceNote}）` : ''}｜
                      {TIME_TEXT[plan.profile.timeBudget]}｜{GOAL_TEXT[plan.profile.goal]}
                    </span>
                    <div className="spacer" />
                    <span className="tiny muted-2">规则：{plan.ruleIds.join('、') || '（无）'}</span>
                    <button className="btn btn-sm" onClick={copyMarkdown}>
                      复制 Markdown
                    </button>
                    <button className="btn btn-sm btn-primary" onClick={exportMarkdown}>
                      导出 Markdown
                    </button>
                  </div>
                </div>
              </div>

              <div className="plan-steps">
                {plan.experiments.map((exp) => (
                  <ExperimentCard
                  key={exp.id}
                  exp={exp}
                  progress={progress[exp.id]}
                  onToggleStep={(stepId, done) => {
                    const cur: ExperimentProgress =
                      progress[exp.id] ?? { status: 'not_started', steps: {}, actualResult: '', observation: '' }
                    const next: ExperimentProgress = { ...cur, steps: { ...cur.steps, [stepId]: done } }
                    next.status = nextStatus(exp, next)
                    dispatch({ type: 'SET_PLAN_PROGRESS', expId: exp.id, progress: next })
                  }}
                  onResult={(patch) => {
                    const cur: ExperimentProgress =
                      progress[exp.id] ?? { status: 'not_started', steps: {}, actualResult: '', observation: '' }
                    const next: ExperimentProgress = { ...cur, ...patch }
                    next.status = nextStatus(exp, next)
                    dispatch({ type: 'SET_PLAN_PROGRESS', expId: exp.id, progress: next })
                  }}
                  onStatus={(status) => {
                    const cur: ExperimentProgress =
                      progress[exp.id] ?? { status: 'not_started', steps: {}, actualResult: '', observation: '' }
                    dispatch({ type: 'SET_PLAN_PROGRESS', expId: exp.id, progress: { ...cur, status } })
                  }}
                  />
                ))}
              </div>

              {plan.deferredTasks && plan.deferredTasks.length > 0 && (
                <div className="card">
                  <div className="card-head">
                    <strong>暂不适合本轮的任务</strong>
                    <div className="spacer" />
                    <span className="tiny muted-2">等条件满足后重新生成计划，它们会被排进来</span>
                  </div>
                  <div className="card-body">
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {plan.deferredTasks.map((d, i) => (
                        <li key={i} style={{ marginBottom: 6 }}>
                          <b>{d.title}</b>
                          <div className="muted-2">{d.reason}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div className="banner banner-info">
                <span className="banner-icon">ℹ️</span>
                <div>
                  <strong>这份计划不承诺什么</strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    <li>不承诺"某张显卡几分钟能跑完"、"多少显存够用"：设备和时间只用来**缩小规模与排序**。</li>
                    <li>不把小规模验证说成完整复现：最小规模跑通只说明链路可用。</li>
                    <li>不改写论文没写清楚的参数：这些一律进「待确认」，由你回原文或向作者确认。</li>
                    <li>不替你判定成功：只有你填了实际结果后，才会出现「已完成」之外可用的记录。</li>
                  </ul>
                </div>
              </div>
            </>
          ) : (
            <EmptyState
              icon="🧭"
              title="还没有生成计划"
              description="先在上面填写设备与时间（已有默认值），然后点「生成验证计划」。也可以直接点示例场景看输出。"
            />
          )}
        </>
      )}

      <div style={{ marginTop: 12 }}>
        <SupportTag support="rule" />
        <span className="small muted-2" style={{ marginLeft: 6 }}>
          计划里的比较结论来自本工具的**确定性规则**（每条都带规则编号，如 R-02 划分、R-03 跨度与采样间隔），
          规则只判断"能不能比较 / 缺什么"，不会给出方法排名。
        </span>
      </div>
      <ConfirmDialog open={pendingBuild !== null} title="替换当前计划？" message="当前计划已有勾选或实验记录。重新生成会清空这些记录，请先导出 Markdown 保存；取消则保留当前全部内容。" confirmText="已备份，重新生成" onCancel={() => setPendingBuild(null)} onConfirm={() => { if (pendingBuild) build(pendingBuild, true); setPendingBuild(null) }} />
    </div>
  )
}
