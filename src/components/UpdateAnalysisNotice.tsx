import { useApp } from '@/store/AppStore'
import { ANALYSIS_VERSION, ANALYSIS_VERSION_NOTE } from '@/config'
import { Icon } from '@/components/Icons'
import type { Paper } from '@/types'

/**
 * 「可更新分析」提示：历史抽取结果没有版本或版本落后时出现。
 * 只有用户点「重新分析」才会调用模型，**不会后台自动重抽**。
 */
export function UpdateAnalysisNotice({ papers, compact = false }: { papers: Paper[]; compact?: boolean }) {
  const { reextract, toast } = useApp()
  const stale = papers.filter((p) => p.source !== 'demo' && p.status === 'parsed' && (p.analysisVersion ?? 0) < ANALYSIS_VERSION)
  if (stale.length === 0) return null

  return (
    <div className={compact ? 'update-notice compact' : 'update-notice'}>
      <Icon name="refresh" size={15} />
      <div style={{ minWidth: 0 }}>
        <div>
          有 <strong>{stale.length}</strong> 篇的分析结果来自旧版本（{stale.map((p) => p.shortLabel).join('、')}），
          可以更新分析。
        </div>
        {!compact && <div className="tiny muted-2" style={{ marginTop: 2 }}>{ANALYSIS_VERSION_NOTE}</div>}
      </div>
      <span className="spacer" />
      <button
        className="btn btn-sm"
        onClick={async () => {
          const target = stale[0]
          await reextract(target.id)
          toast(
            'info',
            '已重新分析一篇，结果会就地更新',
            '剩余论文可逐篇点「重新分析」。旧结果在新结果写入前一直保留；若失败，原有取值与证据不受影响。',
          )
        }}
      >
        重新分析这 {stale.length > 1 ? '一篇' : '篇'}
      </button>
    </div>
  )
}
