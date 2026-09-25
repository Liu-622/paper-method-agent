import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '@/store/AppStore'
import { runFairnessCheck } from '@/services/checks'
import { FIELD_META } from '@/data/fieldSchema'
import type { FieldKey } from '@/types'
import { Icon } from '@/components/Icons'
import { Buddy } from '@/components/Buddy'
import { Tag } from '@/components/StatusTag'
import { LabChart } from '@/components/LabChart'
import { ApplicabilityMap } from '@/components/ApplicabilityMap'
import {
  EVIDENCE_LABEL,
  PERTURBATION_LABEL,
  STOP_REASON_LABEL,
  cancelLabExploration,
  clearLabRuns,
  diffAgainstBase,
  exploreLab,
  fetchLabMeta,
  fetchLabRuns,
  fmt,
  gapText,
  labToMarkdown,
  replicateLabFinding,
  runLabExperiment,
  translateLab,
  checkPaperConsistency,
  explorePaperMethods,
  fetchPaperMethods,
  runPaperMethod,
  type ExploreTraceItem,
  type LabConfig,
  type LabFinding,
  type LabMapCell,
  type LabMeta,
  type LabReplication,
  type LabRun,
  type LabRunsPayload,
  type LabTranslation,
  type LabTranslationPaper,
  type PaperConsistency,
  type PaperMethodsPayload,
  type LabCase,
} from '@/services/lab'
import { PaperMethodPanel } from '@/components/PaperMethodPanel'
import { ReversalCasePanel } from '@/components/ReversalCasePanel'
import { ChallengePanel } from '@/components/ChallengePanel'

type ClaimSource = 'paper' | 'user' | 'teaching'

const SOURCE_LABEL: Record<ClaimSource, string> = {
  paper: '论文原文',
  user: '用户提出',
  teaching: '教学假设',
}

export function LabPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { state, dispatch, selectedPapers, toast } = useApp()

  const [meta, setMeta] = useState<LabMeta | null>(null)
  const [runs, setRuns] = useState<LabRun[]>([])
  const [map, setMap] = useState<LabRunsPayload['map'] | null>(null)
  const [summary, setSummary] = useState<LabRunsPayload['summary'] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [claimText, setClaimText] = useState('')
  const [claimSource, setClaimSource] = useState<ClaimSource>('teaching')
  const [perturbationType, setPerturbationType] = useState<'noise' | 'missing'>('noise')

  const [draft, setDraft] = useState<LabConfig>({ horizon: 96, perturbationType: 'noise', strength: 0.1, seed: 11 })
  const [baseConfig, setBaseConfig] = useState<LabConfig | null>(null)
  const [running, setRunning] = useState(false)
  const [exploring, setExploring] = useState<{ id: string; budget: number; used: number } | null>(null)
  const [trace, setTrace] = useState<ExploreTraceItem[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null)
  const [showClaimPicker, setShowClaimPicker] = useState(false)
  const pollTimer = useRef<number | null>(null)

  /* ---------------- 结论转译 / 模式 ---------------- */
  const [mode, setMode] = useState<'proxy' | 'repro'>('proxy')
  const [translation, setTranslation] = useState<LabTranslation | null>(null)
  const [translationBusy, setTranslationBusy] = useState(false)
  const [findings, setFindings] = useState<LabFinding[]>([])
  const [replication, setReplication] = useState<LabReplication | null>(null)
  const [replicating, setReplicating] = useState(false)
  const [reproRequirements, setReproRequirements] = useState<string[]>([])
  const [lastStop, setLastStop] = useState<{ code?: string | null; text: string } | null>(null)

  /* ---------------- 官方论文方法家族 ---------------- */
  const [family, setFamily] = useState<'teaching' | 'paper-linear'>('teaching')
  const [paperMeta, setPaperMeta] = useState<PaperMethodsPayload | null>(null)
  const [paperConsistency, setPaperConsistency] = useState<PaperConsistency | null>(null)
  const [paperBusy, setPaperBusy] = useState(false)
  const [caseData, setCaseData] = useState<LabCase | null>(null)
  const [paperConsistencyBusy, setPaperConsistencyBusy] = useState(false)

  const loadPaper = useCallback(async () => {
    try {
      setPaperMeta(await fetchPaperMethods())
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '官方论文方法信息加载失败')
    }
  }, [])

  useEffect(() => {
    void loadPaper()
  }, [loadPaper])

  const paperRun = useMemo(() => runs.filter((r) => r.family === 'paper-linear').slice(-1)[0] ?? null, [runs])

  const runPaperBaseline = async () => {
    if (paperBusy) return
    setPaperBusy(true)
    try {
      const res = await runPaperMethod({
        perturbationType,
        strength: draft.strength,
        seed: draft.seed,
        sliceKey: 'explore',
        claim: claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
      })
      setSelectedRunId(res.record.id)
      await loadAll('paper-linear')
      if (res.record.status === 'done') {
        toast(
          'success',
          '官方方法实验完成（真实推理）',
          `DLinear MAE ${res.record.methods?.DLinear?.metrics?.mae?.toFixed(4)}｜Linear MAE ${res.record.methods?.Linear?.metrics?.mae?.toFixed(4)}｜ΔMAE(Linear−DLinear) ${res.record.comparison?.deltaMae.toFixed(4)}`,
        )
      } else {
        toast('error', '这次实验失败了', res.record.error || '已保留之前的记录')
      }
    } catch (e) {
      toast('error', '实验请求失败', e instanceof Error ? e.message : '后端可能不可用')
    } finally {
      setPaperBusy(false)
    }
  }

  const runPaperConsistency = async () => {
    if (paperConsistencyBusy) return
    setPaperConsistencyBusy(true)
    try {
      const res = await checkPaperConsistency({
        perturbationType,
        strengths: [0, 0.1, 0.2],
        seed: draft.seed,
        claim: claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
      })
      setPaperConsistency(res)
      await loadAll('paper-linear')
      toast(res.leaderStable ? 'info' : 'warning', res.leaderStable ? '另一时间段检查：领先方稳定' : '另一时间段检查：领先方发生翻转', res.note)
    } catch (e) {
      toast('error', '一致性检查失败', e instanceof Error ? e.message : '后端可能不可用')
    } finally {
      setPaperConsistencyBusy(false)
    }
  }

  const startPaperExplore = async (budget: number) => {
    if (running || exploring || paperBusy) return
    const id = `paper-exp-${Date.now()}`
    setExploring({ id, budget, used: 0 })
    setTrace([])
    setLastStop(null)
    try {
      const res = await explorePaperMethods({
        budget,
        perturbationType,
        explorationId: id,
        claim: claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
      })
      setTrace(res.trace)
      setFindings(res.findings ?? [])
      setLastStop({ code: res.stopCode, text: res.stoppedReason ?? '' })
      await loadAll('paper-linear')
      toast(
        res.mode === 'model' ? 'success' : 'info',
        res.mode === 'model' ? `小咕用了 ${res.used} 次机会（官方方法）` : `规则探索完成（${res.used} 次）`,
        res.stoppedReason ?? '',
      )
    } catch (e) {
      toast('error', '探索没有完成', e instanceof Error ? e.message : '已保留之前的记录')
    } finally {
      setExploring(null)
    }
  }

  /** 把已抽取的论文字段整理成转译器输入（只做结构化搬运，不做解释） */
  const papersPayload = useMemo<LabTranslationPaper[]>(() => {
    return selectedPapers.map((p) => {
      const f = p.fields
      const horizonText = String(f.horizon?.value ?? '')
      const horizons = [...horizonText.matchAll(/\d+/g)]
        .map((m) => Number(m[0]))
        .filter((n) => [24, 36, 48, 96, 192, 336, 720].includes(n))
      const ev = (key: FieldKey) =>
        (f[key]?.evidenceIds ?? [])
          .map((id) => state.evidence.find((e) => e.id === id))
          .filter((e): e is NonNullable<typeof e> => Boolean(e))
          .map((e) => ({ page: e.page, quote: e.text }))
      const conclusionEv = ev('conclusion')
      const methodEv = ev('method')
      return {
        shortLabel: p.shortLabel,
        method: String(f.method?.value ?? '') || '（未读到）',
        datasets: String(f.dataset?.value ?? '')
          .split(/[、,，;；/]/)
          .map((s) => s.trim())
          .filter(Boolean),
        metrics: String(f.metrics?.value ?? '')
          .split(/[、,，;；/]/)
          .map((s) => s.trim())
          .filter(Boolean),
        horizons,
        result: f.conclusion?.value ? String(f.conclusion.value).slice(0, 300) : null,
        split: f.split?.value ? String(f.split.value) : null,
        splitRange: f.splitRange?.value ? String(f.splitRange.value) : null,
        conditions: [
          f.dataset?.value ? `数据集 ${f.dataset.value}` : null,
          f.horizon?.value ? `跨度 ${f.horizon.value}` : null,
          f.metrics?.value ? `指标 ${f.metrics.value}` : null,
        ]
          .filter(Boolean)
          .join('｜'),
        codeAvailability: f.codeAvailability?.value ? String(f.codeAvailability.value) : null,
        // 没有官方实现与权重 → 复现模式不开放（不假运行）
        hasRunnableImpl: false,
        evidence: [...conclusionEv, ...methodEv].slice(0, 3),
      }
    })
  }, [selectedPapers, state.evidence])

  const runTranslate = useCallback(
    async (cfg?: LabConfig) => {
      if (selectedPapers.length === 0 && !claimText) return
      setTranslationBusy(true)
      try {
        const res = await translateLab({
          papers: papersPayload,
          claim: claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
          config: { ...(cfg ?? draft), perturbationType },
          dataSource: meta?.source ?? null,
        })
        setTranslation(res.card)
      } catch (e) {
        toast('warning', '结论转译没有生成', e instanceof Error ? e.message : '后端可能不可用；手动实验仍可使用。')
      } finally {
        setTranslationBusy(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [papersPayload, claimText, claimSource, meta, perturbationType, draft, toast],
  )

  useEffect(() => {
    if (!meta) return
    void runTranslate()
    // 只在元数据就绪与说法/论文变化时重算转译卡
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, claimText, claimSource, selectedPapers.length])

  const runReplication = async (finding: LabFinding) => {
    if (replicating || running || exploring) return
    setReplicating(true)
    try {
      const res = await replicateLabFinding({
        findingId: finding.id,
        claim: claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
      })
      setReplication(res)
      await loadAll()
      if (res.ok) {
        toast(
          res.sameDirection ? 'success' : 'warning',
          res.sameDirection ? '独立时间段复验完成：方向一致' : '独立时间段复验完成：方向不一致',
          res.conclusion || '',
        )
      } else {
        toast('warning', '复验没有完成', res.error || '先跑够两个跨度的探索结果再复验。')
      }
    } catch (e) {
      toast('error', '复验请求失败', e instanceof Error ? e.message : '已保留原有记录。')
    } finally {
      setReplicating(false)
    }
  }

  /* ---------------- 载入 ---------------- */
  const loadAll = useCallback(
    async (which: 'teaching' | 'paper-linear' = 'teaching') => {
      try {
        const [m, r] = await Promise.all([
          fetchLabMeta(),
          fetchLabRuns(perturbationType, which === 'paper-linear' ? 'paper-linear' : 'teaching'),
        ])
        setMeta(m)
        setRuns(r.runs)
        setMap(r.map)
        setSummary(r.summary)
        setFindings(r.findings ?? [])
        if (r.reproRequirements) setReproRequirements(r.reproRequirements)
        setLoadError(null)
        return r
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : '实验室数据加载失败')
        return null
      }
    },
    [perturbationType],
  )

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // 从对比页/检查页带过来的说法
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const text = params.get('claim')
    const source = params.get('source') as ClaimSource | null
    const key = params.get('key')
    const paper = params.get('paper')
    if (text) {
      setClaimText(decodeURIComponent(text))
      setClaimSource(source ?? 'paper')
    } else if (key && FIELD_META[key as FieldKey]) {
      setClaimText(`两份实验在「${FIELD_META[key as FieldKey].label}」上的条件不同时，哪种方法在该数据上误差更低？`)
      setClaimSource('paper')
    }
    if (paper && !state.selectedIds.includes(paper)) {
      dispatch({ type: 'TOGGLE_SELECT', id: paper })
    }
    // 首页「挑战一个结论」直接进入官方论文方法家族
    if (params.get('family') === 'paper-linear') {
      setFamily('paper-linear')
      void loadAll('paper-linear')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  // 有运行中的实验 → 轮询真实状态（刷新后可恢复）
  useEffect(() => {
    const hasRunning = runs.some((r) => r.status === 'running')
    if (!hasRunning) {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
      pollTimer.current = null
      return
    }
    if (pollTimer.current) return
    pollTimer.current = window.setInterval(() => {
      void loadAll()
    }, 2500)
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [runs, loadAll])

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? runs.find((r) => r.status === 'done') ?? null,
    [runs, selectedRunId],
  )
  const initialRun = useMemo(() => runs.find((r) => r.origin === 'manual' || !r.replicatedOf) ?? null, [runs])

  const paperClaims = useMemo(() => {
    if (selectedPapers.length < 2) return []
    const items = runFairnessCheck(selectedPapers, state.datasetScope ?? null).filter(
      (f) => f.key !== 'method' && f.verdict !== 'consistent',
    )
    return items.slice(0, 4).map((f) => ({
      key: f.key as FieldKey,
      text: `${selectedPapers.map((p) => p.shortLabel).join(' 与 ')} 在「${FIELD_META[f.key as FieldKey].label}」上的条件${
        f.verdict === 'different' ? '不同' : '尚未读全'
      }：这种情况下，把一个条件改掉会不会改变"哪种方法更好"的结论？`,
    }))
  }, [selectedPapers, state.datasetScope])

  /* ---------------- 手动实验 ---------------- */
  const previewConfig = (patch: Partial<LabConfig>) => {
    // 拖动控件只预览配置，不触发计算
    setDraft((d) => ({ ...d, ...patch, perturbationType }))
  }

  const runOnce = async (config: LabConfig, originLabel: string) => {
    if (running || exploring) return
    setRunning(true)
    try {
      const res = await runLabExperiment({ ...config, perturbationType }, claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : undefined)
      if (!baseConfig) setBaseConfig({ ...config, perturbationType })
      setSelectedRunId(res.record.id)
      await loadAll()
      if (res.record.status === 'done') {
        toast('success', `实验完成（${originLabel}）`, `跨度 ${config.horizon}｜${PERTURBATION_LABEL[perturbationType]} ${config.strength}｜${gapText(res.record)}`)
      } else {
        toast('error', '这次实验失败了', res.record.error || '可以检查条件后重试；已保留之前的记录。')
      }
      return res.record
    } catch (e) {
      toast('error', '实验请求没有成功', e instanceof Error ? e.message : '未知错误')
      return null
    } finally {
      setRunning(false)
    }
  }

  /* ---------------- 小咕探索 ---------------- */
  const startExplore = async (budget: number) => {
    if (running || exploring) return
    const id = `exp-${Date.now()}`
    setExploring({ id, budget, used: 0 })
    setTrace([])
    setLastStop(null)
    try {
      const res = await exploreLab({
        claim: claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
        budget,
        perturbationType,
        explorationId: id,
      })
      setTrace(res.trace)
      setFindings(res.findings ?? [])
      setLastStop({ code: res.stopCode ?? null, text: res.stoppedReason ?? '' })
      await loadAll()
      toast(
        res.mode === 'model' ? 'success' : 'info',
        res.mode === 'model' ? `小咕用了 ${res.used} 次实验机会` : `规则探索完成（${res.used} 次）`,
        res.mode === 'model'
          ? res.stoppedReason || '已按结果选择下一组条件。'
          : `模型不可用，本轮按规则选择条件。${res.stoppedReason ?? ''}`,
      )
      if (res.trace.length) setSelectedRunId(res.trace[res.trace.length - 1].runId)
    } catch (e) {
      toast('error', '探索没有完成', e instanceof Error ? e.message : '未知错误。已保留之前的实验记录。')
    } finally {
      setExploring(null)
    }
  }

  const cancelExplore = async () => {
    if (!exploring) return
    await cancelLabExploration(exploring.id)
    toast('info', '已请求取消', '当前这一步会跑完，之后不再发起新的实验；已完成的记录会保留。')
  }

  /* ---------------- 导出 / 加入计划 ---------------- */
  const download = (name: string, text: string, type = 'text/markdown') => {
    const blob = new Blob([text], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportRecords = () => {
    const md = labToMarkdown(
      runs,
      meta,
      claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
      summary,
      { translation, findings, replication },
    )
    download('小咕实验室-实验记录.md', md)
    toast('success', '实验记录已导出', `包含转译卡（${translation?.level ?? '未生成'}）、${runs.length} 次实验（含失败与复验）、发现卡与独立复验结论。`)
  }

  const exportConfig = () => {
    if (!selectedRun) return
    download(
      `lab-config-${selectedRun.id}.json`,
      JSON.stringify(
        {
          labVersion: meta?.labVersion,
          methodScope: 'teaching',
          claim: claimText ? { text: claimText, source: SOURCE_LABEL[claimSource] } : null,
          dataSource: selectedRun.dataSource,
          split: selectedRun.split,
          config: selectedRun.config,
          seed: selectedRun.config.seed,
          rerunHint: '在实验室页面填入同样的跨度/扰动/强度/种子即可复现（服务端使用固定种子的确定性扰动）。',
        },
        null,
        2,
      ),
      'application/json',
    )
  }

  const addToPlan = () => {
    const interesting = runs
      .filter((r) => r.status === 'done' && r.comparison)
      .sort((a, b) => Math.abs(b.comparison!.deltaMae) - Math.abs(a.comparison!.deltaMae))[0]
    dispatch({
      type: 'SET_PLAN_DRAFT',
      draft: {
        fromProblem: claimText
          ? `实验室发现：${claimText.slice(0, 60)}`
          : '实验室的探索发现（待复验）',
        paperIds: selectedPapers.map((p) => p.id),
        dataset: state.datasetScope ?? null,
        createdAt: new Date().toISOString(),
      },
    })
    toast(
      'success',
      '已加入验证计划',
      interesting
        ? `带上发现：跨度 ${interesting.config.horizon}、${PERTURBATION_LABEL[interesting.config.perturbationType]} ${interesting.config.strength}。计划页可以看到来源并可撤销。`
        : '还没有可带上的发现，计划页会显示来自实验室的来源标记。',
    )
    navigate('/plan')
  }

  /* ---------------- 渲染 ---------------- */
  const done = runs.filter((r) => r.status === 'done')
  const failed = runs.filter((r) => r.status === 'failed' || r.status === 'interrupted')

  return (
    <div className="page lab-page">
      <header className="page-heading">
        <div>
          <div className="eyebrow">MINI LAB</div>
          <h1>这条结论，经得住你改一个条件吗？</h1>
          <p>选一条说法，改实验条件，看真实计算结果；也可以给小咕几次机会，让它自己找边界。</p>
        </div>
        <span className="workspace-label">
          <span className="status-dot ok" /> 真实计算 · 本地执行
        </span>
      </header>

      {/* -------- 方法家族切换 -------- */}
      <div className="lab-modebar">
        <div className="seg" role="tablist" aria-label="方法家族">
          <button role="tab" aria-selected={family === 'teaching'} className={family === 'teaching' ? 'active' : ''} onClick={() => setFamily('teaching')}>
            教学实验（季节朴素 + 岭回归）
          </button>
          <button
            role="tab"
            aria-selected={family === 'paper-linear'}
            className={family === 'paper-linear' ? 'active' : ''}
            onClick={() => {
              setFamily('paper-linear')
              setTrace([])
              setFindings([])
              setLastStop(null)
              void loadAll('paper-linear')
            }}
          >
            官方论文方法（DLinear + Linear）
          </button>
        </div>
        <span className="spacer" />
        <span className="tiny muted-2">
          {family === 'paper-linear' ? '方法来自 AAII 2023 论文的官方实现，CPU 训练 + 真实推理' : '教学方法，用于理解比较条件'}
        </span>
      </div>

      {family === 'paper-linear' && paperMeta && (
        <>
          <ChallengePanel
            toast={toast}
            onCarryOn={() => {
              setClaimText('换个评估时间段会不会改变 DLinear 与 Linear 的领先方？（挑战模式带入）')
              setClaimSource('teaching')
              void startPaperExplore(5)
            }}
          />
          <ReversalCasePanel
            caseData={caseData}
            paperMeta={paperMeta}
            onCaseData={setCaseData}
            onCarryOn={() => {
              setClaimText(
                `在 ETTm2 上，换一个评估时间段会不会改变 DLinear 与 Linear 的领先方？（探索段 ${caseData?.slices.explore.dates.start?.slice(0, 10) ?? ''} 起 vs 另一时间段 ${caseData?.slices.consistency.dates.start?.slice(0, 10) ?? ''} 起）`,
              )
              setClaimSource('teaching')
              void startPaperExplore(5)
            }}
            toast={toast}
          />
          <PaperMethodPanel
          payload={paperMeta}
          claim={claimText}
          onRunBaseline={() => void runPaperBaseline()}
          onConsistency={() => void runPaperConsistency()}
          consistency={paperConsistency}
          busy={paperBusy}
          consistencyBusy={paperConsistencyBusy}
          perturbationLabel={
            perturbationType === 'missing' ? '缺失值用训练均值填充（不使用未来目标）' : '噪声加在标准化空间'
          }
        />
        </>
      )}

      {/* -------- 模式切换：复现模式（需材料，当前不开放假运行） / 代理实验模式 -------- */}
      {family === 'teaching' ? (
        <>
          <div className="lab-modebar">
        <div className="seg" role="tablist" aria-label="实验模式">
          <button role="tab" aria-selected={mode === 'repro'} className={mode === 'repro' ? 'active' : ''} onClick={() => setMode('repro')}>
            复现模式
          </button>
          <button role="tab" aria-selected={mode === 'proxy'} className={mode === 'proxy' ? 'active' : ''} onClick={() => setMode('proxy')}>
            代理实验模式
          </button>
        </div>
        {mode === 'repro' ? (
          <Tag tone="orange">复现模式未开放</Tag>
        ) : (
          <Tag tone="slate">代理验证 / 教学演示级</Tag>
        )}
        <span className="spacer" />
        <span className="tiny muted-2">
          {mode === 'repro'
            ? '缺少论文方法实现与权重，不允许假运行'
            : '用教学方法检查「实验条件变化时规律是否稳定」'}
        </span>
      </div>

      {mode === 'repro' ? (
        <div className="card lab-repro-gate">
          <div className="card-head">
            <strong>复现模式需要这些材料才能开放</strong>
            <span className="spacer" />
            <span className="tiny muted-2">当前检测结果：不可用</span>
          </div>
          <div className="card-body">
            <ul className="tight-list">
              {(reproRequirements.length > 0
                ? reproRequirements
                : [
                    '论文方法的官方实现（Autoformer / FEDformer / PatchTST 任一的仓库快照）',
                    '与实现匹配的模型权重文件',
                    '原论文的完整配置（层数、宽度、学习率、批大小、训练轮数、随机种子策略）',
                    '原论文使用的数据切分脚本',
                    '可运行环境（当前机器无 GPU）',
                  ]
              ).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="small muted" style={{ marginTop: 8 }}>
              在补齐这些材料之前，这个模式不会执行任何“像复现”的运算 —— 只会告诉你还缺什么。
              想继续做真实计算，请切到<b>代理实验模式</b>。
            </div>
          </div>
        </div>
      ) : (
        <div className="lab-disclaimer">
          <Icon name="info" size={15} />
          <span>这是教学方法实验：可以检查「条件变化时方法间差距是否稳定」，但不能用来给论文方法排名。</span>
        </div>
      )}
        </>
      ) : null}

      {loadError && (
        <div className="banner banner-warn" style={{ marginBottom: 12 }}>
          <Icon name="alert" size={15} />
          <div>
            实验室数据没加载出来：{loadError}
            {loadError.includes('后端') || loadError.includes('fetch') ? ' —— 后端可能没启动，请确认 8787 端口在运行。' : ''}
          </div>
        </div>
      )}

      {meta && (
        <div className="lab-source-strip">
          <Tag tone={meta.source.kind === 'real' ? 'green' : 'orange'}>
            {meta.source.kind === 'real' ? '真实公开数据' : '合成数据（仅跑通流程）'}
          </Tag>
          <span className="small">
            {meta.source.name}｜变量 {meta.source.column}｜{meta.source.rows.toLocaleString('zh-CN')} 点｜
            采样 {meta.source.intervalMinutes} 分钟
          </span>
          {meta.source.url && (
            <a className="tiny" href={meta.source.url} target="_blank" rel="noreferrer">
              数据来源 ↗
            </a>
          )}
          <span className="spacer" />
          <span className="tiny muted-2">
            方法范围：教学方法（季节朴素 / 岭回归），<b>不是</b>论文方法复现
          </span>
        </div>
      )}

      {/* -------- 结论转译卡 + 可验证范围矩阵（教学方法家族） -------- */}
      {family === 'teaching' && translation && (
        <div className="card lab-translation">
          <div className="card-head row">
            <strong>结论转译卡</strong>
            <Tag tone={translation.levelKey === 'proxy' ? 'blue' : translation.levelKey === 'demo' ? 'orange' : 'green'}>
              {translation.level}
            </Tag>
            <span className="tiny muted-2">{translation.levelReason}</span>
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" disabled={translationBusy} onClick={() => void runTranslate()}>
              <Icon name="refresh" size={14} /> {translationBusy ? '正在生成…' : '按当前条件重新生成'}
            </button>
          </div>
          <div className="card-body">
            <div className="lab-verdict">
              <Icon name="check-circle" size={15} />
              <span>{translation.verdict}</span>
            </div>

            <div className="lab-translation-grid">
              <section className="lab-tr-block">
                <h4>1. 论文原始结论</h4>
                <div className="small">
                  <b>原文说法：</b>
                  {translation.claim?.text || '（未指定）'}
                </div>
                {translation.paperConclusion.evidence.length > 0 ? (
                  <ul className="lab-quote-list">
                    {translation.paperConclusion.evidence.map((e, i) => (
                      <li key={i}>
                        <span className="tiny mono">{e.paper} · 第 {e.page ?? '—'} 页</span>
                        <div className="lab-quote">{e.quote}</div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="tiny muted-2" style={{ marginTop: 6 }}>
                    没有可引用的原文片段（可能这一项还没抽取到证据）。
                  </div>
                )}
                <div className="lab-tr-list">
                  {translation.paperConclusion.structured.map((s) => (
                    <div key={s.paper} className="tiny muted">
                      <b>{s.paper}</b>｜方法 {s.method}｜数据集 {s.datasets.join('/') || '—'}｜指标 {s.metrics.join('/') || '—'}｜跨度{' '}
                      {s.horizons.join('/') || '—'}｜原文结果 {s.result}
                    </div>
                  ))}
                </div>
                <div className="tiny muted-2" style={{ marginTop: 6 }}>
                  {translation.paperConclusion.note}
                </div>
              </section>

              <section className="lab-tr-block">
                <h4>2. 原论文实验</h4>
                <div className="small">
                  <b>论文方法：</b>
                  {translation.paperExperiment.method}
                </div>
                <div className="small">
                  <b>数据集：</b>
                  {translation.paperExperiment.datasets.join(' / ') || '（未读到）'}
                </div>
                <ul className="tight-list small" style={{ marginTop: 6 }}>
                  {translation.paperExperiment.reported.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                <div className="lab-assets">
                  <Tag tone={translation.paperExperiment.assets.hasRunnableImpl ? 'green' : 'orange'}>
                    {translation.paperExperiment.assets.hasRunnableImpl ? '有可执行实现' : '没有可执行实现'}
                  </Tag>
                  <span className="tiny muted-2">
                    {translation.paperExperiment.assets.codeAvailability.join('；') || '代码可得性：未读到'}
                  </span>
                </div>
                {!translation.paperExperiment.assets.hasRunnableImpl && (
                  <div className="tiny muted-2" style={{ marginTop: 6 }}>
                    因此复现模式不开放；需要补齐：{translation.paperExperiment.assets.missing.slice(0, 3).join('；')} 等。
                  </div>
                )}
              </section>

              <section className="lab-tr-block">
                <h4>3. 当前可执行实验</h4>
                <div className="small">
                  <b>实际运行：</b>
                  {translation.currentExperiment.methods.join(' / ')}
                  <span className="tiny muted-2">（{translation.currentExperiment.methodScope}）</span>
                </div>
                <div className="small">
                  <b>数据与条件：</b>
                  {translation.currentExperiment.data}｜{translation.currentExperiment.conditions}
                </div>
                <div className="lab-diff">
                  <div>
                    <span className="tiny muted-2">与原论文相同</span>
                    <ul className="tight-list tiny">
                      {translation.currentExperiment.sameAsPaper.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                      {translation.currentExperiment.sameAsPaper.length === 0 && <li>（没有完全对应的项）</li>}
                    </ul>
                  </div>
                  <div>
                    <span className="tiny muted-2">与原论文不同</span>
                    <ul className="tight-list tiny">
                      {translation.currentExperiment.differentFromPaper.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="tiny muted-2" style={{ marginTop: 6 }}>
                  <b>能验证：</b>
                  {translation.currentExperiment.canVerify.join('；')}
                </div>
                <div className="tiny muted-2">
                  <b>不能验证：</b>
                  {translation.currentExperiment.cannotVerify.join('；')}
                </div>
              </section>
            </div>

            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="data lab-matrix">
                <thead>
                  <tr>
                    <th>维度</th>
                    <th>论文原实验</th>
                    <th>当前实验</th>
                    <th>是否匹配</th>
                  </tr>
                </thead>
                <tbody>
                  {translation.matrix.map((m) => (
                    <tr key={m.dimension}>
                      <td className="row-label">{m.dimension}</td>
                      <td>{m.paper}</td>
                      <td>{m.current}</td>
                      <td>
                        <Tag
                          tone={
                            m.match === '匹配'
                              ? 'green'
                              : m.match === '不匹配' || m.match === '条件外压力测试'
                                ? 'orange'
                                : 'slate'
                          }
                        >
                          {m.match}
                        </Tag>
                        <div className="tiny muted-2" style={{ marginTop: 3 }}>
                          {m.note}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="lab-layout">
        {/* -------- 左：实验条件 -------- */}
        <aside className="lab-conditions card">
          <div className="card-head">
            <strong>实验条件</strong>
          </div>
          <div className="card-body">
            <label className="lab-field">
              <span className="lab-field-label">要验证的说法</span>
              <textarea
                className="textarea"
                style={{ minHeight: 64 }}
                value={claimText}
                placeholder="例如：在 ETTm2 上，预测跨度变大时，两种方法的差距会不会缩小？"
                onChange={(e) => setClaimText(e.target.value)}
              />
            </label>
            <div className="row-tight" style={{ marginBottom: 10, gap: 6, flexWrap: 'wrap' }}>
              {(['paper', 'user', 'teaching'] as ClaimSource[]).map((s) => (
                <button key={s} className={`chip${claimSource === s ? ' active' : ''}`} onClick={() => setClaimSource(s)}>
                  {SOURCE_LABEL[s]}
                </button>
              ))}
              {paperClaims.length > 0 && (
                <button className="btn btn-sm btn-ghost" onClick={() => setShowClaimPicker((v) => !v)}>
                  从论文结论中选
                </button>
              )}
            </div>
            {showClaimPicker && (
              <div className="lab-claim-picker">
                {paperClaims.map((c) => (
                  <button
                    key={c.key}
                    className="lab-claim-item"
                    onClick={() => {
                      setClaimText(c.text)
                      setClaimSource('paper')
                      setShowClaimPicker(false)
                    }}
                  >
                    {c.text}
                  </button>
                ))}
                {paperClaims.length === 0 && <div className="tiny muted-2">还没选够 2 篇论文，先到方法对比里选论文。</div>}
              </div>
            )}

            <div className="lab-field">
              <span className="lab-field-label">预测跨度</span>
              {family === 'paper-linear' ? (
                <div className="tiny muted-2">
                  官方脚本对 ETTm2 使用 pred_len=96；<b>换跨度需要重新训练</b>（本轮不做），因此这里固定 96。
                </div>
              ) : (
                <div className="row-tight" style={{ gap: 6 }}>
                  {meta?.conditionSpace.horizon.map((h) => (
                    <button key={h} className={`chip${draft.horizon === h ? ' active' : ''}`} onClick={() => previewConfig({ horizon: h })}>
                      {h}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lab-field">
              <span className="lab-field-label">扰动类型</span>
              <div className="row-tight" style={{ gap: 6 }}>
                {(['noise', 'missing'] as const).map((t) => (
                  <button
                    key={t}
                    className={`chip${perturbationType === t ? ' active' : ''}`}
                    onClick={() => {
                      setPerturbationType(t)
                      setDraft((d) => ({ ...d, perturbationType: t }))
                    }}
                  >
                    {PERTURBATION_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>

            <label className="lab-field">
              <span className="lab-field-label">
                {PERTURBATION_LABEL[perturbationType]}：<b>{draft.strength}</b>
              </span>
              <input
                type="range"
                min={0}
                max={0.35}
                step={0.05}
                value={draft.strength}
                onChange={(e) => previewConfig({ strength: Number(e.target.value) })}
              />
              <span className="tiny muted-2">
                扰动只作用在**输入窗口**上，真实评估目标永远不改；拖动只是预览，点「运行这次实验」才会真正计算。
              </span>
            </label>

            <div className="lab-field">
              <span className="lab-field-label">随机种子</span>
              <div className="row-tight" style={{ gap: 6 }}>
                {meta?.conditionSpace.seed.map((s) => (
                  <button key={s} className={`chip${draft.seed === s ? ' active' : ''}`} onClick={() => previewConfig({ seed: s })}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="lab-actions">
              <button
                className="btn btn-primary"
                disabled={running || Boolean(exploring)}
                onClick={() => (family === 'paper-linear' ? void runPaperBaseline() : void runOnce(draft, '手动运行'))}
              >
                <Icon name="rocket" size={15} /> {running ? '正在计算…' : '运行这次实验'}
              </button>
              {baseConfig && (
                <button className="btn btn-sm btn-ghost" onClick={() => setDraft(baseConfig)}>
                  回到初始条件
                </button>
              )}
            </div>

            <div className="lab-split tiny muted-2">
              {meta && (
                <>
                  数据划分（按时间）：训练 0–{meta.split.train[1]}｜验证 {meta.split.val[0]}–{meta.split.val[1]}｜
                  测试 {meta.split.test[0]}–{meta.split.test[1]}。拟合与标准化只用训练段；输入窗口全部落在测试段内。
                </>
              )}
            </div>
          </div>
        </aside>

        {/* -------- 中：图表 -------- */}
        <main className="lab-main">
          <div className="card">
            <div className="card-head row">
              <strong>本次实验</strong>
              {selectedRun && (
                <>
                  <Tag tone="slate">
                    跨度 {selectedRun.config.horizon}｜{PERTURBATION_LABEL[selectedRun.config.perturbationType]} {selectedRun.config.strength}
                  </Tag>
                  {selectedRun.replicatedOf && <Tag tone="blue">复验</Tag>}
                  {selectedRun.status === 'interrupted' && <Tag tone="red">已中断</Tag>}
                  {selectedRun.status === 'failed' && <Tag tone="red">失败</Tag>}
                </>
              )}
              <span className="spacer" />
              {selectedRun && <span className="tiny muted-2">{new Date(selectedRun.createdAt).toLocaleString('zh-CN')}</span>}
            </div>
            <div className="card-body">
              {selectedRun?.status === 'failed' && (
                <div className="banner banner-warn" style={{ marginBottom: 10 }}>
                  <Icon name="alert" size={15} />
                  <div>
                    这次实验失败了：{selectedRun.error}
                    <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => void runOnce(selectedRun.config, '重试')}>
                      用同样条件重试
                    </button>
                  </div>
                </div>
              )}
              {selectedRun?.status === 'interrupted' && (
                <div className="banner banner-warn" style={{ marginBottom: 10 }}>
                  <Icon name="alert" size={15} />
                  <div>
                    {selectedRun.interruptedReason}
                    <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => void runOnce(selectedRun.config, '重试')}>
                      重试同一组条件
                    </button>
                  </div>
                </div>
              )}
              <LabChart run={family === 'paper-linear' ? paperRun : selectedRun} />
              {selectedRun && (
                <div className="lab-run-detail">
                  <div className="tiny muted-2">这次实验改变了什么</div>
                  <ul className="tight-list">
                    {diffAgainstBase(baseConfig ?? initialRun?.config ?? null, selectedRun.config).map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                    {diffAgainstBase(baseConfig ?? initialRun?.config ?? null, selectedRun.config).length === 0 && (
                      <li>与初始条件相同（可作为复现检查）</li>
                    )}
                  </ul>
                  <div className="row-tight" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
                    <Tag tone="slate">
                      数据区间 {selectedRun.split ? `${selectedRun.split.testRange[0]}–${selectedRun.split.testRange[1]}` : '—'}
                    </Tag>
                    <Tag tone="slate">样本 {selectedRun.evaluation?.nSamples ?? '—'}</Tag>
                    <Tag tone="slate">种子 {selectedRun.config.seed}</Tag>
                    <Tag tone="slate">{selectedRun.replicatedOf ? '经过复验' : '未复验'}</Tag>
                    <Tag tone="slate">预测哈希 {selectedRun.methods?.ridge?.predictionsHash}</Tag>
                  </div>
                </div>
              )}
            </div>
          </div>

          {map && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-body">
                <ApplicabilityMap
                  map={map}
                  selectedKey={selectedCellKey}
                  onSelect={(cell) => {
                    setSelectedCellKey(cell.key)
                    if (cell.runId) setSelectedRunId(cell.runId)
                  }}
                  onRerun={(cell) => {
                    const run = runs.find((r) => r.id === cell.runId)
                    if (!run) {
                      toast('info', '这一格还没跑过', '先点「运行这次实验」或让小咕探索。')
                      return
                    }
                    void runOnce({ ...run.config, seed: run.config.seed === 11 ? 29 : 11 }, '重跑（换种子）')
                  }}
                />
              </div>
            </div>
          )}

          {/* -------- 发现卡 + 独立时间段复验 -------- */}
          {(family === 'paper-linear' || mode === 'proxy') && findings.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-head row">
                <strong>发现卡</strong>
                <Tag tone="slate">探索段（测试段前一半）</Tag>
                <span className="spacer" />
                <span className="tiny muted-2">独立复验段在探索期间不可见</span>
              </div>
              <div className="card-body">
                {findings.map((f) => {
                  const rep = replication && replication.findingId === f.id ? replication : null
                  return (
                    <div className="lab-finding" key={f.id}>
                      <div className="lab-finding-title">{f.title}</div>
                      <div className="tiny muted-2">
                        方法 {f.methods.join(' / ')}｜数据段 {f.segmentLabel}｜扰动{' '}
                        {f.perturbationType === 'noise' ? '输入噪声' : '输入缺失'} {f.strength}｜探索 {f.exploreCount} 次
                      </div>
                      <ul className="tight-list small" style={{ marginTop: 6 }}>
                        {f.conditions.map((c) => (
                          <li key={c.horizon}>
                            跨度 {c.horizon}（种子 {c.seed}）：|ΔMAE| {c.absDeltaMae.toFixed(4)}，领先{' '}
                            {c.leader === 'ridge' ? '岭回归' : c.leader === 'seasonal_naive' ? '季节朴素' : '持平'}，样本 {c.nSamples ?? '—'}
                          </li>
                        ))}
                      </ul>
                      <div className="small" style={{ marginTop: 6 }}>
                        <b>能支持的最小结论：</b>
                        {f.minConclusion}
                      </div>
                      <div className="tiny muted-2">
                        <b>不能外推到：</b>
                        {f.notExtrapolateTo.join('；')}
                      </div>
                      <div className="row-tight" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
                        <Tag tone={f.replicated ? 'green' : 'orange'}>{f.replicated ? '已独立复验' : '尚未独立复验'}</Tag>
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={replicating || running || Boolean(exploring)}
                          onClick={() => void runReplication(f)}
                        >
                          <Icon name="lab" size={14} /> {replicating ? '正在复验…' : '在独立时间段复验这个发现'}
                        </button>
                        <span className="tiny muted-2">会在测试段后一半重跑同一组条件（方法、指标、扰动保持一致）</span>
                      </div>

                      {rep?.ok && (
                        <div className="lab-replication">
                          <div className="tiny muted-2">探索段趋势</div>
                          <div className="small mono">
                            {(rep.exploreTrend ?? []).map((c) => `${c.horizon}:${c.absDeltaMae.toFixed(4)}`).join(' → ')}
                          </div>
                          <div className="tiny muted-2" style={{ marginTop: 6 }}>
                            独立复验段趋势（{String((rep as LabReplication).ranCount)} 次运行）
                          </div>
                          <div className="small mono">
                            {(rep.independentTrend ?? []).map((c) => `${c.horizon}:${c.absDeltaMae.toFixed(4)}`).join(' → ') || '—'}
                          </div>
                          <div className="row-tight" style={{ marginTop: 6, gap: 6 }}>
                            <Tag tone={rep.sameDirection ? 'green' : 'orange'}>
                              {rep.sameDirection ? '两段方向一致' : '两段方向不一致'}
                            </Tag>
                            <Tag tone="slate">仍不足以判断</Tag>
                          </div>
                          <div className="small" style={{ marginTop: 6 }}>
                            {rep.conclusion}
                          </div>
                          <div className="tiny muted-2">{rep.note}</div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {summary && summary.observed.length > 0 && (
            <div className="card" style={{ marginTop: 14 }}>
              <div className="card-head">
                <strong>已观察到的现象（程序汇总）</strong>
                <span className="spacer" />
                <span className="tiny muted-2">{summary.note}</span>
              </div>
              <div className="card-body">
                <ul className="tight-list">
                  {summary.observed.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
                <div className="tiny muted-2" style={{ marginTop: 8 }}>
                  探索中发现的现象，在独立数据复验前一律标为「待复验」；没有观察到边界时如实写「尚未观察到优势反转」，不扩大成普遍结论。
                </div>
              </div>
            </div>
          )}
        </main>

      </div>

      {/* -------- 下方：小咕记录（放在布局网格外，避免被粘性条件卡滚动时覆盖） -------- */}
      <aside className="lab-buddy card">
          <div className="card-head row">
            <Buddy size="sm" px={34} mood={exploring ? 'thinking' : running ? 'thinking' : 'idle'} title="小咕" />
            <strong>小咕的实验记录</strong>
          </div>
          <div className="card-body">
            <div className="lab-budget">
              <div className="small">
                实验预算：
                {[3, 5].map((b) => (
                  <button
                    key={b}
                    className="btn btn-sm"
                    style={{ marginLeft: 6 }}
                    disabled={running || Boolean(exploring) || paperBusy}
                    onClick={() => void (family === 'paper-linear' ? startPaperExplore(b) : startExplore(b))}
                  >
                    给小咕 {b} 次机会
                  </button>
                ))}
              </div>
              {exploring ? (
                <div className="lab-budget-state">
                  <span className="small">
                    正在探索：预算 {exploring.budget} 次，已完成 {runs.filter((r) => r.origin === 'explore' || r.origin === 'replication').length} 次
                  </span>
                  <button className="btn btn-sm btn-ghost" onClick={() => void cancelExplore()}>
                    取消
                  </button>
                </div>
              ) : (
                <div className="tiny muted-2" style={{ marginTop: 6 }}>
                  一次实验 = 在一组条件与指定种子下，同时跑两种方法并比较（计数含初始、探索与复验；失败也占一次，每次最多重试 1 回）。
                </div>
              )}
            </div>

            {trace.length > 0 && (
              <ol className="lab-trace">
                {trace.map((t) => (
                  <li key={t.runId}>
                    <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap' }}>
                      <Tag tone={t.planner === 'model' ? 'blue' : 'slate'}>
                        {t.planner === 'model' ? '模型提条件' : t.planner === 'program-replication' ? '程序安排复验' : '规则探索'}
                      </Tag>
                      <Tag tone="slate">探索段</Tag>
                      {t.replicatedOf && <Tag tone="violet">换种子复验</Tag>}
                      <span className="tiny muted-2">
                        跨度 {t.config?.horizon}｜{t.config?.perturbationType === 'missing' ? '缺失' : '噪声'} {t.config?.strength}｜种子{' '}
                        {t.config?.seed}
                      </span>
                    </div>
                    <div className="lab-trace-fields">
                      {t.observation && (
                        <div>
                          <span className="lt-key">观察到</span>
                          {t.observation}
                        </div>
                      )}
                      {t.choice && (
                        <div>
                          <span className="lt-key">下一步</span>
                          {t.choice}
                        </div>
                      )}
                      <div>
                        <span className="lt-key">为什么</span>
                        {t.reason}
                      </div>
                      {t.result && (
                        <div>
                          <span className="lt-key">结果</span>
                          {t.result}
                        </div>
                      )}
                      {t.judgmentChange && (
                        <div>
                          <span className="lt-key">改变判断</span>
                          {t.judgmentChange}
                        </div>
                      )}
                    </div>
                    {t.plannerNote && <div className="tiny muted-2">备注：{t.plannerNote}</div>}
                    {t.comparison && (
                      <div className="tiny muted-2">
                        ΔMAE {Math.abs(t.comparison.deltaMae).toFixed(4)}（样本 {t.nSamples}）
                        {t.comparison.closeGap ? ' · 差距较小' : ''}
                      </div>
                    )}
                    {t.error && <div className="tiny" style={{ color: 'var(--danger)' }}>失败：{t.error}</div>}
                  </li>
                ))}
              </ol>
            )}

            {lastStop && (
              <div className="tiny muted-2" style={{ marginTop: 8 }}>
                <Tag tone={lastStop.code === 'budget' ? 'slate' : 'orange'}>{STOP_REASON_LABEL[lastStop.code ?? ''] ?? '已停止'}</Tag>{' '}
                {lastStop.text}
              </div>
            )}

            {trace.length === 0 && (
              <div className="tiny muted-2" style={{ marginTop: 8 }}>
                {done.length > 0
                  ? `已经有 ${done.length} 条真实记录。让小咕探索时，它会先读这些结果，再决定下一组条件。`
                  : '还没有实验记录。先手动跑一次，或者直接让小咕开始探索。'}
              </div>
            )}

            <div className="lab-next">
              <div className="tiny muted-2">下一步建议</div>
              <ul className="tight-list">
                {done.length === 0 && <li>先跑一次基准条件（无扰动），确认两种方法都能跑通。</li>}
                {done.length > 0 && failed.length > 0 && <li>有 {failed.length} 条失败/中断记录，可以先用同样条件重试。</li>}
                {done.length > 0 && (
                  <li>
                    当前最好/最差结果的差距区间：
                    {(() => {
                      const gaps = done.filter((r) => r.comparison).map((r) => Math.abs(r.comparison!.deltaMae))
                      if (!gaps.length) return '—'
                      return `${Math.min(...gaps).toFixed(4)} – ${Math.max(...gaps).toFixed(4)}`
                    })()}
                    ；想让结论更稳，把差距最小那组换个种子复验一次。
                  </li>
                )}
                <li>把值得继续检查的发现加入验证计划，或导出全部实验记录（含失败与复验）。</li>
              </ul>
            </div>

            <div className="lab-actions" style={{ marginTop: 12 }}>
              <button className="btn btn-sm" onClick={addToPlan} disabled={done.length === 0}>
                <Icon name="plan" size={14} /> 加入验证计划
              </button>
              <button className="btn btn-sm" onClick={exportRecords} disabled={runs.length === 0}>
                <Icon name="export" size={14} /> 导出实验记录
              </button>
              <button className="btn btn-sm btn-ghost" onClick={exportConfig} disabled={!selectedRun}>
                导出复跑配置
              </button>
            </div>
            <div className="row-tight" style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  await clearLabRuns()
                  await loadAll()
                  setTrace([])
                  toast('info', '已清空实验室记录', '这些记录与论文库、验证计划互不影响。')
                }}
                disabled={runs.length === 0}
              >
                清空实验室记录
              </button>
              <span className="tiny muted-2">共 {runs.length} 条（含失败 {failed.length} 条）</span>
            </div>
          </div>
        </aside>
    </div>
  )
}
