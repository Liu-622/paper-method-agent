import { useEffect, useState } from 'react'
import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import { caseExplanations, fetchReversalCase, type LabCase } from '@/services/lab'
import { fetchChallengeSetup, type ChallengeSetup } from '@/services/detective'

type Guess = 'change' | 'same' | 'unknown'

const GUESS_LABEL: Record<Guess, string> = {
  change: '领先方会变化',
  same: '领先方不会变化',
  unknown: '仅凭条件无法判断',
}

/**
 * 挑战模式：先判断，再运行揭晓。
 * 说明：用户的选择**只用于互动**，不影响实验配置与结果；"仅凭条件无法判断"不算答错。
 * 结果一律由真实计算生成（没有预设反转动画），并提供"查看历史结果"与"现场重新运行"两条明确路径。
 */
export function ChallengePanel({
  onCarryOn,
  toast,
}: {
  onCarryOn: () => void
  toast: (kind: 'info' | 'success' | 'warning' | 'error', title: string, detail?: string) => void
}) {
  const [setup, setSetup] = useState<ChallengeSetup | null>(null)
  const [guess, setGuess] = useState<Guess | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ caseData: LabCase; origin: 'fresh' | 'cached' } | null>(null)
  const [showExplain, setShowExplain] = useState(false)

  useEffect(() => {
    let alive = true
    fetchChallengeSetup()
      .then((s) => alive && setSetup(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const load = async (cached: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetchReversalCase(cached)
      if (!res.ok || !res.case) {
        toast('warning', cached ? '还没有历史实测结果' : '运行没有完成', res.message || '可以先点「运行并揭晓」。')
        return
      }
      setOutcome({ caseData: res.case, origin: cached ? 'cached' : 'fresh' })
      toast(
        'success',
        cached ? '已载入历史实测结果' : '运行完成，结果已揭晓',
        `${res.case.slices.explore.leader} / ${res.case.slices.consistency.leader}：${res.case.reversal ? '领先方发生了反转' : '领先方没有变化'}`,
      )
    } catch (e) {
      toast('error', '请求失败', e instanceof Error ? e.message : '后端可能不可用')
    } finally {
      setBusy(false)
    }
  }

  const verdict = (() => {
    if (!outcome || !guess) return null
    const changed = outcome.caseData.reversal
    if (guess === 'unknown') {
      return {
        ok: true,
        text: '你选择"仅凭条件无法判断"。这不是对错题：本案例只说明这一次在两个时间段上的观察，先验无法判断同样合理。',
        tone: 'slate' as const,
      }
    }
    const matched = (guess === 'change' && changed) || (guess === 'same' && !changed)
    return {
      ok: matched,
      text: matched
        ? `你的判断与本次观察一致：领先方${changed ? '发生了变化' : '没有变化'}。`
        : `你的判断与本次观察不一致：领先方${changed ? '发生了变化' : '没有变化'}。这只是一个案例，不代表普遍规律。`,
      tone: matched ? ('green' as const) : ('orange' as const),
    }
  })()

  return (
    <div className="card challenge">
      <div className="card-head row">
        <Icon name="rocket" size={16} />
        <strong>挑战一下：换个时间段，领先者会变吗？</strong>
        <Tag tone="blue">先判断，再运行</Tag>
        <span className="spacer" />
        {outcome && <span className="tiny muted-2">{outcome.origin === 'cached' ? '历史实测结果' : '现场计算'}</span>}
      </div>
      <div className="card-body">
        {setup ? (
          <>
            <div className="challenge-conditions">
              <div className="tiny muted-2">条件（不显示任何结果）</div>
              <div className="small">
                {setup.weights.DLinear ? '官方 DLinear' : 'DLinear'} 与 {setup.weights.Linear ? '官方 Linear' : 'Linear'}
                （同一对训练权重）｜{setup.settings.dataset} · 目标 {setup.settings.target}｜seq_len {setup.settings.seqLen}｜
                pred_len {setup.settings.predLen}｜{setup.settings.perturbation}｜seed {setup.settings.seed}
              </div>
              <div className="small">
                两个时间段：探索段 {setup.slices.explore.range[0]}–{setup.slices.explore.range[1]}（{setup.slices.explore.dates.start.slice(0, 10)} 起）；
                另一时间段 {setup.slices.consistency.range[0]}–{setup.slices.consistency.range[1]}（{setup.slices.consistency.dates.start.slice(0, 10)} 起）
              </div>
              <div className="tiny muted-2">{setup.note}</div>
            </div>

            <div className="challenge-guess">
              <div className="small">
                <b>你的判断是？</b>
                <span className="tiny muted-2">（只用于互动，不会影响实验配置与结果）</span>
              </div>
              <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {(['change', 'same', 'unknown'] as Guess[]).map((g) => (
                  <button key={g} className={`chip${guess === g ? ' active' : ''}`} onClick={() => setGuess(g)} disabled={busy}>
                    {GUESS_LABEL[g]}
                  </button>
                ))}
              </div>
            </div>

            <div className="challenge-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void load(false)}>
                <Icon name="rocket" size={15} /> {busy ? '正在运行真实计算…' : '运行并揭晓'}
              </button>
              <button className="btn" disabled={busy} onClick={() => void load(true)}>
                查看历史结果
              </button>
              <span className="tiny muted-2">「运行并揭晓」会真的重新计算；「查看历史结果」读取之前跑过的记录</span>
            </div>
          </>
        ) : (
          <div className="tiny muted-2">正在读取挑战条件…</div>
        )}

        {outcome && (
          <>
            {verdict && (
              <div className="challenge-verdict">
                <Tag tone={verdict.tone}>{verdict.ok ? '与你的判断一致' : '与你的判断不一致'}</Tag>
                <span className="small">{verdict.text}</span>
                {guess && <span className="tiny muted-2">你选的是：{GUESS_LABEL[guess]}</span>}
              </div>
            )}
            <div className="challenge-result">
              {(['explore', 'consistency'] as const).map((k) => {
                const s = outcome.caseData.slices[k]
                return (
                  <div className="challenge-cell" key={k}>
                    <div className="tiny muted-2">
                      {k === 'explore' ? '探索段' : '另一时间段'}｜{s.dates.start.slice(0, 10)} → {s.dates.end.slice(0, 10)}
                    </div>
                    <div className="challenge-nums">
                      <span>
                        DLinear <b>{s.metrics.DLinear.mae !== null ? s.metrics.DLinear.mae.toFixed(4) : '—'}</b>
                      </span>
                      <span>
                        Linear <b>{s.metrics.Linear.mae !== null ? s.metrics.Linear.mae.toFixed(4) : '—'}</b>
                      </span>
                    </div>
                    <div className="tiny">
                      领先方 <b>{s.leader}</b>｜ΔMAE(Linear−DLinear) <b>{s.deltaMae.toFixed(4)}</b>
                    </div>
                    <div className="tiny muted-2">
                      {s.windows} 个窗口 × {s.metricsSpec.predLen ?? 96} 步 = {s.windows * (s.metricsSpec.predLen ?? 96)} 条预测记录｜
                      去重后覆盖 {s.targetPoints} 个不同目标时间点｜{s.metricsSpec.metrics.join('/')}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="challenge-verdict" style={{ marginTop: 10 }}>
              <Tag tone={outcome.caseData.reversal ? 'orange' : 'green'}>
                {outcome.caseData.reversal ? '领先方发生了反转' : '领先方没有变化'}
              </Tag>
              <span className="small">{outcome.caseData.verdict}</span>
            </div>

            <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              <button className="btn btn-sm" onClick={() => setShowExplain((v) => !v)}>
                <Icon name="qa" size={14} /> {showExplain ? '收起小咕解释' : '小咕解释一下'}
              </button>
              <button className="btn btn-sm btn-primary" onClick={onCarryOn}>
                <Icon name="plus" size={14} /> 继续探索（带入方法、权重与两个时间段）
              </button>
              <span className="tiny muted-2">
                {outcome.origin === 'cached' ? '这是历史结果（实测时间见上），不是现场计算' : '这是本次现场计算的结果'}
              </span>
            </div>
            {showExplain && (
              <div className="challenge-explain">{caseExplanations(outcome.caseData).whatItMeans}</div>
            )}
            <ul className="tight-list tiny" style={{ marginTop: 8 }}>
              {outcome.caseData.caveats.slice(0, 2).map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
