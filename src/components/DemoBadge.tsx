import { DEMO_BADGE_TEXT } from '@/data/demoData'

/** 明确标注「演示数据」，避免和用户上传的文件混淆 */
export function DemoBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className="tag tag-violet" title="这是预置的虚构示例数据，不是真实论文分析结果">
      <span className="dot" />
      {compact ? '演示数据' : DEMO_BADGE_TEXT}
    </span>
  )
}

export function DemoBanner({ children }: { children?: React.ReactNode }) {
  return (
    <div className="banner banner-demo">
      <span className="banner-icon">🧪</span>
      <div>
        <strong>{DEMO_BADGE_TEXT}</strong>
        {children ?? (
          <>
            ：当前项目里的 3 篇论文、原文片段、实验设置与检查结果全部为虚构示例，用于演示完整交互，
            不代表任何真实论文的结论。
          </>
        )}
      </div>
    </div>
  )
}
