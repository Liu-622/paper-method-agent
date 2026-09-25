import type { LabMap, LabMapCell } from '@/services/lab'
import { EVIDENCE_LABEL } from '@/services/lab'

/**
 * 证据地图：跨度 × 扰动强度 的网格。
 * 每个格子显示**真实执行**状态 + **证据等级**（由程序判定）；
 * 未测试保持未测试、失败显示原因，绝不插值。
 */
const STATUS_TEXT: Record<LabMapCell['status'], string> = {
  untested: '未测试',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

const LEVEL_CLASS: Record<string, string> = {
  untested: 'lv-untested',
  'exploration-only': 'lv-explore',
  'seed-replicated': 'lv-seed',
  'independent-replicated': 'lv-independent',
  failed: 'lv-failed',
}

export function ApplicabilityMap({
  map,
  selectedKey,
  onSelect,
  onRerun,
}: {
  map: LabMap
  selectedKey: string | null
  onSelect: (cell: LabMapCell) => void
  onRerun: (cell: LabMapCell) => void
}) {
  const horizons = [...new Set(map.cells.map((c) => c.horizon))].sort((a, b) => a - b)
  const strengths = [...new Set(map.cells.map((c) => c.strength))].sort((a, b) => a - b)
  const cellAt = (h: number, s: number) => map.cells.find((c) => c.horizon === h && c.strength === s)

  return (
    <div className="lab-map">
      <div className="lab-map-head">
        <div>
          <div className="lab-map-title">证据地图（原「结论适用地图」）</div>
          <div className="tiny muted-2">
            横轴＝预测跨度，纵轴＝{map.axes.perturbationType === 'noise' ? '输入噪声强度' : '输入缺失比例'}。
            每格显示证据等级：{Object.values(EVIDENCE_LABEL).join(' / ')}。
            「差距较小」按公开阈值（相对差距 &lt; {(map.closeGapThreshold * 100).toFixed(0)}%）判断，不是统计显著。
          </div>
        </div>
      </div>

      <div className="lab-grid" style={{ gridTemplateColumns: `76px repeat(${strengths.length}, minmax(0, 1fr))` }}>
        <div className="lab-grid-corner tiny muted-2">跨度 ＼ 扰动</div>
        {strengths.map((s) => (
          <div className="lab-grid-head tiny" key={`h-${s}`}>
            {s === 0 ? '无扰动' : s}
          </div>
        ))}
        {horizons.map((h) => (
          <div key={`row-${h}`} style={{ display: 'contents' }}>
            <div className="lab-grid-rowlabel tiny">{h}</div>
            {strengths.map((s) => {
              const cell = cellAt(h, s)
              if (!cell) return <div className="lab-cell untested" key={`${h}-${s}`} />
              const level = cell.evidenceLevel ?? 'untested'
              const cls = `lab-cell ${cell.status} ${LEVEL_CLASS[level] ?? ''}${selectedKey === cell.key ? ' selected' : ''}${
                cell.comparison?.closeGap ? ' close' : ''
              }`
              return (
                <button
                  key={cell.key}
                  className={cls}
                  onClick={() => onSelect(cell)}
                  onDoubleClick={() => onRerun(cell)}
                  title={
                    cell.status === 'done' && cell.comparison
                      ? `${STATUS_TEXT[cell.status]}｜证据等级：${EVIDENCE_LABEL[level]}｜${
                          cell.comparison.leader === 'tie' ? '持平' : cell.comparison.leader === 'ridge' ? '岭回归更好' : '季节朴素更好'
                        }｜ΔMAE ${Math.abs(cell.comparison.deltaMae).toFixed(4)}｜样本 ${cell.nSamples}｜跑过 ${cell.doneCount ?? cell.runCount} 次`
                      : cell.error || STATUS_TEXT[cell.status]
                  }
                >
                  <span className="lab-cell-status">{STATUS_TEXT[cell.status]}</span>
                  {cell.status === 'done' && cell.comparison && (
                    <span className="lab-cell-value">
                      Δ {Math.abs(cell.comparison.deltaMae).toFixed(3)}
                      {cell.comparison.closeGap ? ' · 小' : ''}
                    </span>
                  )}
                  {cell.status === 'done' && <span className="lab-cell-level">{EVIDENCE_LABEL[level]}</span>}
                  {cell.status === 'failed' && <span className="lab-cell-flag">!</span>}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <div className="lab-map-foot tiny muted-2">
        单击看这次实验的配置、数据段与曲线；双击换种子重跑。{map.note}
        <div className="lab-legend">
          <span className="lab-legend-item lv-explore">仅探索发现</span>
          <span className="lab-legend-item lv-seed">已换种子复验</span>
          <span className="lab-legend-item lv-independent">已独立时间段复验</span>
          <span className="lab-legend-item lv-untested">未测试</span>
          <span className="lab-legend-item lv-failed">运行失败</span>
        </div>
      </div>
    </div>
  )
}
