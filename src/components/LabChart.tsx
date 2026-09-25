import { useMemo, useState } from 'react'
import type { LabRun } from '@/services/lab'

/**
 * 实验室主图：真实值 + 两条方法曲线。
 * 支持两个方法家族：
 *  - 教学实验：季节性朴素预测 / 岭回归
 *  - 官方论文方法：DLinear / Linear（官方实现）
 * 只画真实执行结果，不做平滑、不插值、不造假。
 */
type Series = { id: string; label: string; color: string }

/* 系列配色统一走设计令牌，保证跨页面一致（真实值=深色，方法 A/B/C） */
const TEACHING_SERIES: Series[] = [
  { id: 'truth', label: '真实值', color: 'var(--series-truth)' },
  { id: 'seasonal', label: '季节性朴素', color: 'var(--series-c)' },
  { id: 'ridge', label: '岭回归', color: 'var(--series-a)' },
]

const PAPER_SERIES: Series[] = [
  { id: 'truth', label: '真实值（OT）', color: 'var(--series-truth)' },
  { id: 'DLinear', label: 'DLinear（官方）', color: 'var(--series-a)' },
  { id: 'Linear', label: 'Linear（官方）', color: 'var(--series-b)' },
]

export function LabChart({ run, height = 260 }: { run: LabRun | null; height?: number }) {
  const isPaper = run?.family === 'paper-linear'
  const SERIES = isPaper ? PAPER_SERIES : TEACHING_SERIES
  const [visible, setVisible] = useState<Record<string, boolean>>({
    truth: true,
    seasonal: true,
    ridge: true,
    DLinear: true,
    Linear: true,
  })
  const [hover, setHover] = useState<number | null>(null)

  const data = (run?.chart ?? null) as unknown as (Record<string, number[]> & { stride?: number }) | null
  const w = 720
  const h = height
  const pad = { l: 46, r: 14, t: 12, b: 26 }

  const { min, max, n } = useMemo(() => {
    if (!data) return { min: 0, max: 1, n: 0 }
    const all: number[] = []
    for (const s of SERIES) if (visible[s.id] && Array.isArray(data[s.id])) all.push(...data[s.id])
    const n0 = (data.truth ?? []).length
    if (!all.length) return { min: 0, max: 1, n: n0 }
    const mn = Math.min(...all)
    const mx = Math.max(...all)
    const padY = (mx - mn) * 0.08 || 1
    return { min: mn - padY, max: mx + padY, n: n0 }
  }, [data, visible, SERIES])

  if (!run || !data) {
    return (
      <div className="lab-chart-empty">
        <p className="small muted">
          还没有实验结果。调好左边的条件，点「运行这次实验」；或者让小咕自己探索几轮。
        </p>
      </div>
    )
  }

  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - min) / Math.max(1e-9, max - min)) * (h - pad.t - pad.b)
  const path = (arr: number[]) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const hoverIndex = hover === null ? null : Math.max(0, Math.min(n - 1, hover))
  const metrics = run.methods ?? {}
  const labelFor = (key: string) => SERIES.find((s) => s.id === key)?.label ?? metrics[key]?.label ?? key

  return (
    <div className="lab-chart">
      <div className="lab-chart-toolbar">
        <div className="row-tight" style={{ gap: 4 }}>
          {SERIES.map((s) => (
            <button key={s.id} className={`chip${visible[s.id] ? ' active' : ''}`} onClick={() => setVisible((v) => ({ ...v, [s.id]: !v[s.id] }))}>
              <span className="lab-dot" style={{ background: s.color }} />
              {s.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="tiny muted-2">
          {isPaper ? `样本 ${run.evaluation?.nSamples ?? '—'}（${run.evaluation?.nWindows ?? '—'} 窗口 × ${run.evaluation?.horizon ?? '—'} 步）` : `样本 ${run.evaluation?.nSamples ?? '—'}`}
          ｜跨度 {run.config.horizon}｜种子 {run.config.seed}
          {data.stride && data.stride > 1 ? `｜图上每 ${data.stride} 点取 1 点` : ''}
        </span>
      </div>

      <div
        className="lab-chart-plot"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const ratio = (e.clientX - box.left - (pad.l / w) * box.width) / (((w - pad.l - pad.r) / w) * box.width)
          setHover(Math.round(ratio * (n - 1)))
        }}
      >
        <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="预测曲线对比">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => {
            const v = min + t * (max - min)
            return (
              <g key={t}>
                <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--divider)" strokeWidth="1" />
                <text x={pad.l - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)">
                  {v.toFixed(2)}
                </text>
              </g>
            )
          })}
          {SERIES.filter((s) => s.id !== 'truth').map((s) =>
            visible[s.id] && Array.isArray(data[s.id]) ? (
              <path key={s.id} d={path(data[s.id])} fill="none" stroke={s.color} strokeWidth="1.5" opacity="0.92" />
            ) : null,
          )}
          {visible.truth && Array.isArray(data.truth) && <path d={path(data.truth)} fill="none" stroke="#1d1d1f" strokeWidth="1.8" />}
          {hoverIndex !== null && (
            <g>
              <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={pad.t} y2={h - pad.b} stroke="var(--border-strong)" strokeDasharray="3 3" />
              {SERIES.map((s) =>
                visible[s.id] && data[s.id] ? <circle key={s.id} cx={x(hoverIndex)} cy={y(data[s.id][hoverIndex])} r="3" fill={s.color} /> : null,
              )}
            </g>
          )}
          <line x1={pad.l} x2={w - pad.r} y1={h - pad.b} y2={h - pad.b} stroke="var(--border)" />
        </svg>

        {hoverIndex !== null && (
          <div className="lab-tooltip">
            <div className="tiny muted-2">预测点 #{hoverIndex + 1}</div>
            {SERIES.map((s) =>
              visible[s.id] && data[s.id] ? (
                <div key={s.id}>
                  {s.label} <b>{data[s.id][hoverIndex]?.toFixed(3)}</b>
                  {s.id !== 'truth' && (
                    <span className="muted-2"> 误差 {Math.abs(data[s.id][hoverIndex] - data.truth[hoverIndex]).toFixed(3)}</span>
                  )}
                </div>
              ) : null,
            )}
          </div>
        )}
      </div>

      <div className="lab-metrics">
        {Object.keys(metrics).map((k) => {
          const m = metrics[k]?.metrics
          return (
            <div className="lab-metric" key={k}>
              <div className="tiny muted-2">{metrics[k]?.label ?? labelFor(k)}</div>
              <div className="lab-metric-row">
                <span>
                  MAE <b>{m?.mae !== null && m?.mae !== undefined ? m.mae.toFixed(4) : '—'}</b>
                </span>
                <span>
                  MSE <b>{m?.mse !== null && m?.mse !== undefined ? m.mse.toFixed(4) : '—'}</b>
                </span>
                <span>
                  RMSE <b>{m?.rmse !== null && m?.rmse !== undefined ? m.rmse.toFixed(4) : '—'}</b>
                </span>
              </div>
            </div>
          )
        })}
        <div className="lab-metric">
          <div className="tiny muted-2">本次结论（按有方向的差值）</div>
          <div className="small">
            {run.comparison
              ? `${run.comparison.leader === 'tie' ? '两者持平' : `${labelFor(run.comparison.leader)} 的误差更低`}${
                  run.comparison.closeGap ? '（差距较小）' : ''
                }｜ΔMAE ${
                  isPaper
                    ? `(Linear−DLinear) ${run.comparison.deltaMae.toFixed(4)}`
                    : run.comparison.deltaMae.toFixed(4)
                }`
              : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}
