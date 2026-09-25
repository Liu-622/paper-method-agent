import type { FairnessItem, ReproVerdict } from '@/types'

/**
 * 检查规则目录
 * ------------------------------------------------------------------
 * 规则编号用于**可追溯**：界面上每条"规则推导"都要能指回一个编号，
 * 并且这个编号对应的规则必须是**程序真的执行过**的（由 checks.ts 产出，
 * 输入字段与证据都来自已校验的字段值）。
 *
 * 不允许把"模型自己提出来的推论"标成规则推导 —— 那种情况显示为「建议 / 待验证」。
 */

export interface RuleMeta {
  id: string
  name: string
  /** 这条规则判断什么 */
  checks: string
  /** 判定所需的输入字段 */
  inputs: string[]
  /** 规则执行主体（在代码里的位置，便于核对） */
  where: string
}

export const RULE_CATALOG: Record<string, RuleMeta> = {
  'R-01': {
    id: 'R-01',
    name: '数据集身份与集合',
    checks: '两篇论文的数据集集合是否相同；只被部分论文包含的数据集会标出「x/y 篇包含」',
    inputs: ['dataset'],
    where: 'src/services/scope.ts（sameDataset / commonDatasets）',
  },
  'R-02': {
    id: 'R-02',
    name: '训练/测试划分',
    checks: '划分比例是否相同；比例相同时是否覆盖同一测试区间（缺区间判信息不足）',
    inputs: ['split', 'splitRange'],
    where: 'src/services/checks.ts（compareSplit）',
  },
  'R-03': {
    id: 'R-03',
    name: '预测跨度与采样间隔',
    checks: '步数集合与采样间隔集合是否相同；步数相同但间隔不同判存在差异',
    inputs: ['horizon', 'sampleInterval'],
    where: 'src/services/checks.ts（compareHorizon）',
  },
  'R-04': {
    id: 'R-04',
    name: '评价指标集合',
    checks: '指标集合是否一致；一方多报告指标时判存在差异',
    inputs: ['metrics'],
    where: 'src/services/checks.ts（compareSingle / metrics）',
  },
  'R-05': {
    id: 'R-05',
    name: '预处理与归一化',
    checks: '归一化方式与统计量来源是否一致（用全量数据统计量会引入信息泄漏）',
    inputs: ['preprocessing'],
    where: 'src/services/checks.ts（compareSingle / preprocessing）',
  },
  'R-06': {
    id: 'R-06',
    name: '评估协议',
    checks: '单次多步预测与滚动预测不可直接比较',
    inputs: ['evalProtocol'],
    where: 'src/services/checks.ts（compareSingle / evalProtocol）',
  },
  'R-07': {
    id: 'R-07',
    name: '基线集合',
    checks: '基线集合不同时"相对提升"的分母不同，提升百分比不可跨论文比较',
    inputs: ['baselines'],
    where: 'src/services/checks.ts（compareSingle / baselines）',
  },
  'R-10': {
    id: 'R-10',
    name: '字段未找到',
    checks: '正文所有页面都已处理、仍没有读到该字段',
    inputs: ['（全部页面）'],
    where: 'src/services/checks.ts（runReproCheck / effectiveFieldStatus）',
  },
  'R-11': {
    id: 'R-11',
    name: '字段未检查',
    checks: '有页面未被处理（正文截断 / 页面抽不出文字），不能声称论文没写',
    inputs: ['coverage.skippedPages', 'coverage.emptyPages'],
    where: 'src/services/checks.ts（unprocessedPages）',
  },
  'R-12': {
    id: 'R-12',
    name: '字段需要确认',
    checks: '论文写了该字段，但表述不足以确定取值',
    inputs: ['（字段 note）'],
    where: 'src/services/checks.ts（runReproCheck / verdictOf）',
  },
}

export function ruleMetaOf(id: string | undefined): RuleMeta | null {
  if (!id) return null
  return RULE_CATALOG[id] ?? null
}

/** 公平性检查项 → 规则编号（与 checks.ts 里的判定一一对应） */
export function ruleIdOfFairness(item: FairnessItem): string {
  if (item.id === 'fair-dataset') return 'R-01'
  if (item.id === 'fair-split') return 'R-02'
  if (item.id === 'fair-horizon') return 'R-03'
  if (item.key === 'metrics') return 'R-04'
  if (item.key === 'preprocessing') return 'R-05'
  if (item.key === 'evalProtocol') return 'R-06'
  if (item.key === 'baselines') return 'R-07'
  return 'R-08'
}

/** 复现缺项 → 规则编号 */
export function reproRuleId(verdict: ReproVerdict): string {
  if (verdict === 'unchecked') return 'R-11'
  if (verdict === 'need_confirm') return 'R-12'
  return 'R-10'
}
