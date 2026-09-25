/**
 * 两个示例场景的实际输出（构建计划 + 模拟一次用户记录）
 * 被 scripts/plan-demo.mjs 打包执行。
 */
import type { ExperimentProgress, ResourceProfile } from '@/types'
import { cloneDemoPapers } from '@/data/demoData'
import { collectRiskOptions, generatePlan, nextStatus, planToMarkdown } from '@/services/planner'
import { DEMO_BADGE_TEXT } from '@/data/demoData'

const SCENARIOS: { key: string; title: string; profile: Partial<ResourceProfile>; note: string }[] = [
  {
    key: 'A',
    title: '示例 A：仅 CPU、1 小时以内 —— 先检查数据处理与评估流程',
    profile: { device: 'cpu', timeBudget: '1h', goal: 'pipeline' },
    note: '目标：先把数据划分、采样间隔、指标口径对齐，不训练模型。',
  },
  {
    key: 'B',
    title: '示例 B：单张 GPU、1 天 —— 优先核对一项影响公平比较的实验条件',
    profile: { device: 'gpu1', timeBudget: '1d', goal: 'fairness' },
    note: '目标：先确认两篇论文在同一数据集上到底哪些条件不同，再决定要不要跑训练。',
  },
]

export function runDemo(): { markdown: string; summary: string } {
  const papers = cloneDemoPapers()
  const scope = 'ETTm1' // 三篇演示论文都用到 ETTm1（2/3 篇包含的检查见界面）
  const datasets = [
    ...new Set(papers.flatMap((p) => (p.fields.dataset?.value ?? '').split(/[、,，]/).map((s) => s.trim()))),
  ]

  const lines: string[] = []
  lines.push('# 验证计划示例（两个场景的实际输出）')
  lines.push('')
  lines.push(`> ${DEMO_BADGE_TEXT}。下面的计划由 \`node scripts/plan-demo.mjs\` 直接生成，`)
  lines.push('> 内容与界面里点「示例场景」按钮得到的完全一致（同一套确定性规则，不调用模型）。')
  lines.push('')
  lines.push(
    `论文：${papers.map((p) => p.shortLabel).join('、')}（演示数据）；数据集取值：${
      datasets.filter(Boolean).join('、')
    }`,
  )
  lines.push('')
  lines.push('---')
  lines.push('')

  const summary: string[] = []

  for (const s of SCENARIOS) {
    const profile: ResourceProfile = {
      device: 'gpu1',
      deviceNote: '',
      timeBudget: '1d',
      goal: 'fairness',
      dataset: scope,
      riskIds: [],
      codeUrl: '',
      codeReady: 'partial',
      dataReady: 'partial',
      ...s.profile,
    }
    const risks = collectRiskOptions(papers, scope)
    profile.riskIds = risks.slice(0, 2).map((r) => r.id)
    const plan = generatePlan(papers, profile, scope, risks)

    lines.push(`# ${s.title}`)
    lines.push('')
    lines.push(`${s.note}`)
    lines.push('')
    lines.push(
      `本次勾选的待确认风险：${
        risks
          .filter((r) => profile.riskIds.includes(r.id))
          .map((r) => `${r.label}（规则 ${r.ruleId}，${r.verdictText}）`)
          .join('；') || '（无）'
      }`,
    )
    lines.push('')
    lines.push(`共生成 ${plan.experiments.length} 个实验，优先级 1 是：${plan.experiments[0].title}`)
    lines.push('')
    lines.push('---')
    lines.push('')

    // 模拟用户走完优先级 1 的步骤并记录结果（> 只勾步骤时不填结果，用来说明状态机）
    const progress: Record<string, ExperimentProgress> = {}
    const first = plan.experiments[0]
    progress[first.id] = {
      status: 'not_started',
      steps: Object.fromEntries(first.steps.map((st) => [st.id, true])),
      actualResult: '',
      observation: '',
    }
    progress[first.id].status = nextStatus(first, progress[first.id])
    summary.push(`${s.key}：勾完优先级 1 全部步骤后状态 = ${progress[first.id].status}（未填结果，不是"验证成功"）`)

    lines.push(planToMarkdown(plan, progress))
    lines.push('')
    lines.push(
      `> 上面这份是**勾完优先级 1 的全部步骤、但没有填实际结果**时的导出效果：状态停在「待确认」，`,
    )
    lines.push('> 文档里明确写着「步骤勾完 ≠ 假设成立」，不会出现"验证成功"这类结论。')
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return { markdown: lines.join('\n'), summary: summary.join('\n') }
}
