/**
 * 生成「资源变化 / 风险变化 → 计划变化」的对照输出（验收演示 1 与 2）
 */
import type { ResourceProfile } from '@/types'
import { cloneDemoPapers } from '@/data/demoData'
import { collectRiskOptions, generatePlan } from '@/services/planner'

const SCOPE = 'ETTm1'

function brief(plan: ReturnType<typeof generatePlan>): string[] {
  const lines: string[] = []
  lines.push(`- 实验数量：**${plan.experiments.length}**`)
  plan.experiments.forEach((e) => {
    lines.push(`- 优先级 ${e.priority}｜${e.title}`)
    lines.push(`  - 要确认的问题：${e.question}`)
    lines.push(`  - 为什么选它：${e.whyPriority}`)
    lines.push(`  - 步骤（${e.steps.length} 步）：`)
    e.steps.forEach((s) => lines.push(`    ${s.id}. ${s.text}`))
    lines.push(`  - 保持一致：${e.keepConstant.join('；')}`)
    lines.push(`  - 要改变/确认的变量：${e.variables.join('；') || '（无）'}`)
    lines.push(`  - 应记录的指标：${e.metrics.join('；')}`)
    lines.push(`  - 停止条件：${e.stopIf.join('；')}`)
    lines.push(`  - 规模说明：${e.scaleNote}`)
  })
  if (plan.deferredTasks?.length) {
    lines.push('- **暂不适合本轮的任务：**')
    plan.deferredTasks.forEach((d) => lines.push(`  - ${d.title} —— ${d.reason}`))
  }
  return lines
}

export function runVariations(): string {
  const papers = cloneDemoPapers()
  const risks = collectRiskOptions(papers, SCOPE)
  const riskSplit = risks.find((r) => r.key === 'split') ?? risks[0]
  const riskSeed = risks.find((r) => r.key === 'randomSeed')
  const riskInterval = risks.find((r) => r.key === 'sampleInterval') ?? risks.find((r) => r.id === 'fair-horizon')

  const base: ResourceProfile = {
    device: 'gpu1',
    deviceNote: '',
    timeBudget: '3d',
    goal: 'fairness',
    dataset: SCOPE,
    riskIds: [riskSplit.id],
    codeUrl: '',
    codeReady: 'ready',
    dataReady: 'ready',
  }

  const lines: string[] = []
  lines.push('# 计划变化对照（验收演示 1 与 2 的实际输出）')
  lines.push('')
  lines.push('> 本文件由 `node scripts/plan-variations.mjs` 直接生成，内容与界面点「生成验证计划」一致（确定性规则，不调用模型）。')
  lines.push(`> 论文：${papers.map((p) => p.shortLabel).join('、')}（演示数据）；数据集口径：${SCOPE}。`)
  lines.push('')
  lines.push(`> 本文件涉及的**风险项**：`)
  risks.forEach((r) => lines.push(`> - ${r.label}（key=${r.key}，规则 ${r.ruleId}，判定：${r.verdictText}）`))
  lines.push('')

  /* ---------- 演示 1：同一风险，资源不同 ---------- */
  const cpu: ResourceProfile = { ...base, device: 'cpu', timeBudget: '1h', goal: 'pipeline' }
  const gpu: ResourceProfile = { ...base, device: 'gpu1', timeBudget: '3d', goal: 'fairness' }
  const planCpu = generatePlan(papers, cpu, SCOPE, risks)
  const planGpu = generatePlan(papers, gpu, SCOPE, risks)

  lines.push('## 演示 1：同一论文、同一风险（' + riskSplit.label + '），只换资源')
  lines.push('')
  lines.push('### 1A 仅 CPU + 1 小时以内 + 目标「先跑通流程」')
  lines.push('')
  lines.push(...brief(planCpu))
  lines.push('')
  lines.push('### 1B 单张 GPU + 3 天 + 目标「检查比较是否公平」')
  lines.push('')
  lines.push(...brief(planGpu))
  lines.push('')
  lines.push('### 1C 两者差在哪（逐项对比）')
  lines.push('')
  lines.push('| 对比项 | 1A（CPU + 1 小时） | 1B（GPU + 3 天） |')
  lines.push('| --- | --- | --- |')
  lines.push(`| 实验数量 | ${planCpu.experiments.length} | ${planGpu.experiments.length} |`)
  lines.push(`| 优先级 1 任务 | ${planCpu.experiments[0]?.title ?? '—'} | ${planGpu.experiments[0]?.title ?? '—'} |`)
  lines.push(
    `| 含训练步骤 | ${
      planCpu.experiments.some((e) => e.steps.some((s) => /跑一次最小训练|训练链路|跑一次对照|同一批次.*训练/.test(s.text)))
        ? '是'
        : '**否**'
    } | ${
      planGpu.experiments.some((e) => e.steps.some((s) => /跑一次最小训练|训练链路|跑一次对照/.test(s.text))) ? '是' : '否'
    } |`,
  )
  lines.push(
    `| 暂不适合本轮 | ${(planCpu.deferredTasks ?? []).map((d) => d.title).join('；') || '（无）'} | ${
      (planGpu.deferredTasks ?? []).map((d) => d.title).join('；') || '（无）'
    } |`,
  )
  lines.push(`| 规模说明 | ${planCpu.experiments[0]?.scaleNote.slice(0, 60)}… | ${planGpu.experiments[0]?.scaleNote.slice(0, 60)}… |`)
  lines.push('')

  /* ---------- 演示 2：同一资源，换风险 ---------- */
  const planSeed = riskSeed
    ? generatePlan(papers, { ...base, riskIds: [riskSeed.id] }, SCOPE, risks)
    : null
  const planInterval = riskInterval
    ? generatePlan(papers, { ...base, riskIds: [riskInterval.id] }, SCOPE, risks)
    : null

  lines.push('## 演示 2：同一资源条件（单张 GPU + 3 天），只换风险')
  lines.push('')
  lines.push(`### 2A 风险 = ${riskSplit.label}`)
  lines.push('')
  lines.push(...brief(generatePlan(papers, { ...base, riskIds: [riskSplit.id] }, SCOPE, risks)))
  lines.push('')
  if (planSeed) {
    lines.push(`### 2B 风险 = ${riskSeed.label}`)
    lines.push('')
    lines.push(...brief(planSeed))
    lines.push('')
  }
  if (planInterval) {
    lines.push(`### 2C 风险 = ${riskInterval.label}`)
    lines.push('')
    lines.push(...brief(planInterval))
    lines.push('')
  }
  lines.push('### 2D 差异点（步骤层面）')
  lines.push('')
  const a = generatePlan(papers, { ...base, riskIds: [riskSplit.id] }, SCOPE, risks).experiments[0]
  lines.push('| | 划分核对 | ' + (riskSeed ? '随机性与重复实验' : '') + ' | ' + (riskInterval ? '时间跨度换算' : '') + ' |')
  lines.push('| --- | --- | --- | --- |')
  const maxSteps = Math.max(
    a.steps.length,
    planSeed?.experiments[0].steps.length ?? 0,
    planInterval?.experiments[0].steps.length ?? 0,
  )
  for (let i = 0; i < maxSteps; i += 1) {
    lines.push(
      `| 步骤 ${i + 1} | ${a.steps[i]?.text ?? '—'} | ${planSeed?.experiments[0].steps[i]?.text ?? '—'} | ${
        planInterval?.experiments[0].steps[i]?.text ?? '—'
      } |`,
    )
  }
  lines.push('')
  lines.push('| 关键项 | 划分核对 | 随机性与重复实验 | 时间跨度换算 |')
  lines.push('| --- | --- | --- | --- |')
  lines.push(
    `| 要改变的变量 | ${a.variables.join('；')} | ${planSeed?.experiments[0].variables.join('；') ?? '—'} | ${
      planInterval?.experiments[0].variables.join('；') ?? '—'
    } |`,
  )
  lines.push(
    `| 应记录的指标 | ${a.metrics.join('；')} | ${planSeed?.experiments[0].metrics.join('；') ?? '—'} | ${
      planInterval?.experiments[0].metrics.join('；') ?? '—'
    } |`,
  )
  lines.push('')

  return lines.join('\n')
}
