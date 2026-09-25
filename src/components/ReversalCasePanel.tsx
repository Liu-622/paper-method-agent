import { useState } from 'react'
import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import { caseExplanations, caseExportUrl, fetchReversalCase, type LabCase, type PaperMethodsPayload } from '@/services/lab'

/**
 * 核心案例：换个时间段，领先者会变吗？
 * · 先展示固定设置、时间序列全貌与两个评估区间；
 * · 一个主操作「运行两个时间段」；已有实测结果与重新运行分开；
 * · 结果用同一坐标与统一口径展示，领先方与差距由真实结果决定（无预设反转动画）。
 */
export function ReversalCasePanel({
  caseData,
  paperMeta,
  onCaseData,
  onCarryOn,
  toast,
}: {
  caseData: LabCase | null
  paperMeta: PaperMethodsPayload | null
  onCaseData: (c: LabCase) => void
  onCarryOn: () => void
  toast: (kind: 'info' | 'success' | 'warning' | 'error', title: string, detail?: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState<'explore' | 'consistency'>('explore')
  const [showExplain, setShowExplain] = useState<null | 'what' | 'next'>(null)
  const [showParams, setShowParams] = useState(false)

  const load = async (cached: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetchReversalCase(cached)
      if (!res.ok || !res.case) {
        toast('warning', cached ? '还没有实测结果' : '运行没有完成', res.message || '请先点「运行两个时间段」。')
        return
      }
      onCaseData(res.case)
      toast(
        cached ? 'info' : 'success',
        cached ? '已载入已有的实测结果' : '两个时间段都跑完了',
        `${res.case.slices.explore.leader} / ${res.case.slices.consistency.leader}：${res.case.reversal ? '领先方发生了反转' : '领先方一致'}`,
      )
    } catch (e) {
      toast('error', '请求失败', e instanceof Error ? e.message : '后端可能不可用')
    } finally {
      setBusy(false)
    }
  }

  const s = caseData ? caseData.slices[active] : null
  const expl = caseData ? caseExplanations(caseData) : null

  return (
    <div className="card lab-case">
      <div className="card-head row">
        <Icon name="lab" size={16} />
        <strong>核心案例：{caseData?.title ?? '换个时间段，领先者会变吗？'}</strong>
        <Tag tone="blue">官方论文方法</Tag>
        {caseData && <Tag tone={caseData.reversal ? 'orange' : 'green'}>{caseData.reversal ? '领先方发生反转' : '领先方一致'}</Tag>}
        <span className="spacer" />
        {caseData && <span className="tiny muted-2">实测于 {new Date(caseData.generatedAt).toLocaleString('zh-CN')}</span>}
      </div>
      <div className="card-body">
        {/* 固定设置 */}
        <div className="lab-case-settings">
          {paperMeta && (
            <>
              <span className="tiny muted-2">实际运行：</span>
              <b>DLinear</b> 与 <b>Linear</b>
              <span className="tiny muted-2">（官方实现 {paperMeta.paper.sha.slice(0, 8)}，同一对权重）</span>
              <button className="expand-toggle" onClick={() => setShowParams((v) => !v)}>
                {showParams ? '收起设置 ▴' : '查看固定设置 ▾'}
              </button>
            </>
          )}
        </div>
        {showParams && paperMeta && (
          <div className="lab-case-params tiny muted-2">
            <div>数据：ETTm2 · 目标列 OT · 7 通道输入</div>
            <div>输入长度 seq_len=336｜预测跨度 pred_len=96｜无扰动｜种子 11｜采样起点间隔 8</div>
            <div>指标：MAE / MSE / RMSE（原始单位，窗口 × 预测步平均）</div>
            <div>
              评估区间（都在官方测试区间 45744–57600 内）：探索段 {paperMeta.split.customSlices.explore.usedStart}–{paperMeta.split.customSlices.explore.usedEnd}；
              另一时间段 {paperMeta.split.customSlices.consistency.usedStart}–{paperMeta.split.customSlices.consistency.usedEnd}
            </div>
          </div>
        )}

        {/* 时间序列全貌 + 两个评估区间标记 */}
        {paperMeta && <SeriesOverview meta={paperMeta} />}

        {/* 主操作 */}
        <div className="lab-case-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void load(false)}>
            <Icon name="rocket" size={15} /> {busy ? '正在运行两个时间段…' : '运行两个时间段'}
          </button>
          <button className="btn" disabled={busy} onClick={() => void load(true)}>
            查看已有实测结果
          </button>
          {caseData && (
            <>
              <a className="btn btn-sm" href={caseExportUrl('md')}>
                <Icon name="export" size={14} /> 导出案例报告（Markdown）
              </a>
              <a className="btn btn-sm" href={caseExportUrl('json')}>
                导出配置与预测（JSON）
              </a>
            </>
          )}
          <span className="tiny muted-2">「重新运行」会真的重新计算；导出文件不含任何密钥</span>
        </div>

        {!caseData ? (
          <div className="lab-chart-empty" style={{ marginTop: 12 }}>
            <p className="small muted">点「运行两个时间段」，会用同一对权重、同一设置各跑一次，只改变评估时间段。</p>
          </div>
        ) : (
          <>
            {/* 关键数字 */}
            <div className="lab-case-key">
              {(['explore', 'consistency'] as const).map((k) => {
                const c = caseData.slices[k]
                return (
                  <button
                    key={k}
                    className={`lab-case-keycell${active === k ? ' active' : ''}`}
                    onClick={() => setActive(k)}
                    title="点击切换查看这一段的曲线与结果"
                  >
                    <div className="tiny muted-2">{k === 'explore' ? '探索段' : '另一时间段'}｜{c.dates.start.slice(0, 10)} → {c.dates.end.slice(0, 10)}</div>
                    <div className="lab-case-nums">
                      <span>
                        DLinear <b>{c.metrics.DLinear.mae !== null ? c.metrics.DLinear.mae.toFixed(4) : '—'}</b>
                      </span>
                      <span>
                        Linear <b>{c.metrics.Linear.mae !== null ? c.metrics.Linear.mae.toFixed(4) : '—'}</b>
                      </span>
                    </div>
                    <div className="tiny">
                      领先方 <b>{c.leader}</b>｜ΔMAE(Linear−DLinear) <b>{c.deltaMae.toFixed(4)}</b>
                      {c.closeGap ? '（差距较小）' : ''}
                    </div>
                  </button>
                )
              })}
            </div>

            {/* 两段曲线（同一坐标、统一口径） */}
            {s && (
              <div className="lab-case-chart">
                <div className="row-tight" style={{ marginBottom: 6 }}>
                  <span className="small">
                    <b>{active === 'explore' ? '探索段' : '另一时间段'}</b> 的预测对比
                  </span>
                  <span className="tiny muted-2">
                    {s.windows} 个窗口 × {s.metricsSpec.predLen ?? 96} 步 = <b>{s.windows * (s.metricsSpec.predLen ?? 96)}</b> 条预测记录｜
                    去重后覆盖 <b>{s.targetPoints}</b> 个不同目标时间点｜{s.metricsSpec.metrics.join(' / ')}
                  </span>
                </div>
                <CaseChart slice={s} />
              </div>
            )}

            <div className="lab-case-verdict">
              <Tag tone={caseData.reversal ? 'orange' : 'green'}>{caseData.reversal ? '观察到反转' : '未观察到反转'}</Tag>
              <span className="small">{caseData.verdict}</span>
            </div>

            {/* 论文侧 vs 工具侧 */}
            <div className="lab-case-paper">
              <div className="tiny muted-2">论文说过的 / 本工具提出的 / 本工具跑出来的 —— 三者分开</div>
              <ul className="tight-list tiny">
                <li>
                  <b>论文（{caseData.methodSource.paperPdf}）</b>：方法定义与 Table 2 的报告值，见下方「与论文报告值的同口径对照」。
                </li>
                <li>
                  <b>本工具提出的问题</b>：{caseData.paper.question.text}
                </li>
                <li>
                  <b>本工具得到的观察</b>：{caseData.paper.observation.text}
                </li>
                <li className="muted-2">{caseData.paper.note}</li>
              </ul>
            </div>

            {/* 小咕的三个操作 */}
            <div className="lab-case-buddy">
              <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={() => setShowExplain(showExplain === 'what' ? null : 'what')}>
                  <Icon name="qa" size={14} /> 这能说明什么？
                </button>
                <button className="btn btn-sm" onClick={() => setShowExplain(showExplain === 'next' ? null : 'next')}>
                  <Icon name="search" size={14} /> 下一步查什么？
                </button>
                <button className="btn btn-sm btn-primary" onClick={onCarryOn}>
                  <Icon name="plus" size={14} /> 带上这个案例继续探索
                </button>
                <span className="tiny muted-2">解释由程序根据当前真实结果组织，不夸大、不编造；模型解释按运行设置启用</span>
              </div>
              {showExplain === 'what' && <div className="lab-case-explain">{expl?.whatItMeans}</div>}
              {showExplain === 'next' && (
                <ul className="tight-list small lab-case-explain">
                  {expl?.nextChecks.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* 适用范围（必须一起展示） */}
            <div className="lab-case-caveats">
              <div className="tiny muted-2">适用范围与限制</div>
              <ul className="tight-list tiny">
                {caseData.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 时间序列全貌 + 两段评估区间标记（缩略图，仅用于说明位置） */
function SeriesOverview({ meta }: { meta: PaperMethodsPayload }) {
  const preview = meta.split
  const total = preview.datasetRows
  const x = (i: number) => (i / total) * 100
  return (
    <div className="lab-case-overview">
      <svg viewBox="0 0 100 14" preserveAspectRatio="none" width="100%" height="46" aria-label="数据划分示意">
        <rect x={0} y={0} width={100} height={14} fill="var(--surface-2)" />
        <rect x={x(preview.train.usedStart)} y={0} width={x(preview.train.usedEnd) - x(preview.train.usedStart)} height={14} fill="#e6e6eb" />
        <rect x={x(preview.val.usedStart)} y={0} width={x(preview.val.usedEnd) - x(preview.val.usedStart)} height={14} fill="#dfe4ea" />
        <rect
          x={x(preview.customSlices.explore.usedStart)}
          y={0}
          width={x(preview.customSlices.explore.usedEnd) - x(preview.customSlices.explore.usedStart)}
          height={14}
          fill="#0071e3"
          opacity="0.75"
        />
        <rect
          x={x(preview.customSlices.consistency.usedStart)}
          y={0}
          width={x(preview.customSlices.consistency.usedEnd) - x(preview.customSlices.consistency.usedStart)}
          height={14}
          fill="#9a6700"
          opacity="0.8"
        />
        <rect x={x(preview.outOfBenchmark.from)} y={0} width={x(preview.outOfBenchmark.to) - x(preview.outOfBenchmark.from)} height={14} fill="#b42318" opacity="0.18" />
      </svg>
      <div className="tiny muted-2">
        数据全貌：训练 0–{preview.train.usedEnd}｜验证 {preview.val.usedStart}–{preview.val.usedEnd}｜
        <span style={{ color: 'var(--accent)' }}> 探索段 {preview.customSlices.explore.usedStart}–{preview.customSlices.explore.usedEnd}</span>｜
        <span style={{ color: 'var(--warn)' }}> 另一时间段 {preview.customSlices.consistency.usedStart}–{preview.customSlices.consistency.usedEnd}</span>｜
        <span style={{ color: 'var(--danger)' }}> 超出官方基准 {preview.outOfBenchmark.from}–{preview.outOfBenchmark.to}（未使用）</span>
      </div>
    </div>
  )
}

/** 案例用的小图：真实值 + 两条方法曲线（同一坐标） */
function CaseChart({ slice }: { slice: LabCase['slices']['explore'] }) {
  const truth = slice.chart?.truth ?? []
  const d = slice.chart?.DLinear ?? []
  const l = slice.chart?.Linear ?? []
  const n = truth.length
  if (n < 2) return <div className="tiny muted-2">（这一段还没有可展示的曲线数据）</div>
  const w = 720
  const h = 190
  const pad = 28
  // 用循环求极值：数组可能有上万点，展开成参数会爆调用栈
  let mn = Infinity
  let mx = -Infinity
  for (const arr of [truth, d, l]) {
    for (let i = 0; i < arr.length; i += 1) {
      const v = arr[i]
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
  }
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return <div className="tiny muted-2">（这一段没有可用的曲线数据）</div>
  const X = (i: number) => pad + (i / Math.max(1, n - 1)) * (w - pad * 2)
  const Y = (v: number) => 10 + (1 - (v - mn) / Math.max(1e-9, mx - mn)) * (h - 24)
  const path = (arr: number[]) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="两段之一的预测对比">
      <path d={path(d)} fill="none" stroke="#0071e3" strokeWidth="1.4" />
      <path d={path(l)} fill="none" stroke="#8a6a2f" strokeWidth="1.4" />
      <path d={path(truth)} fill="none" stroke="#1d1d1f" strokeWidth="1.6" />
      <text x={pad} y={h - 6} fontSize="9" fill="var(--text-3)">
        真实值（黑）｜DLinear（蓝）｜Linear（棕）
      </text>
    </svg>
  )
}
