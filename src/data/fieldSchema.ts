import type { FieldGroup, FieldKey } from '@/types'

/** 字段元信息：标签、分组、说明 */
export interface FieldMeta {
  key: FieldKey
  label: string
  group: FieldGroup
  /** 字段说明，展示在标签旁的小问号或副标题 */
  hint: string
}

export const FIELD_META: Record<FieldKey, FieldMeta> = {
  researchProblem: {
    key: 'researchProblem',
    label: '研究问题',
    group: 'overview',
    hint: '这篇论文想解决什么问题',
  },
  method: {
    key: 'method',
    label: '核心方法',
    group: 'overview',
    hint: '提出的模型 / 框架及其关键设计',
  },
  dataset: {
    key: 'dataset',
    label: '数据集',
    group: 'overview',
    hint: '实验使用的数据来源',
  },
  split: {
    key: 'split',
    label: '训练 / 验证 / 测试划分',
    group: 'overview',
    hint: '时间轴的切分比例',
  },
  splitRange: {
    key: 'splitRange',
    label: '划分的时间区间',
    group: 'overview',
    hint: '训练集与测试集具体覆盖哪一段时间（起止）',
  },
  sampleInterval: {
    key: 'sampleInterval',
    label: '采样间隔',
    group: 'overview',
    hint: '数据点之间的时间间隔（15 分钟 / 1 小时 / 1 天）',
  },
  horizon: {
    key: 'horizon',
    label: '预测跨度',
    group: 'overview',
    hint: '一次向前预测多少步',
  },
  metrics: {
    key: 'metrics',
    label: '评价指标',
    group: 'overview',
    hint: '论文报告的误差指标',
  },
  baselines: {
    key: 'baselines',
    label: '对比基线',
    group: 'overview',
    hint: '比较了哪些已有方法',
  },
  conclusion: {
    key: 'conclusion',
    label: '主要结论',
    group: 'overview',
    hint: '论文自己声称的结果',
  },
  limitations: {
    key: 'limitations',
    label: '局限',
    group: 'overview',
    hint: '作者承认的适用范围与不足',
  },
  evalProtocol: {
    key: 'evalProtocol',
    label: '评估协议',
    group: 'experiment',
    hint: '单次预测还是滚动预测',
  },
  preprocessing: {
    key: 'preprocessing',
    label: '数据预处理',
    group: 'experiment',
    hint: '缺失值处理、标准化 / 归一化方式',
  },
  learningRate: {
    key: 'learningRate',
    label: '学习率',
    group: 'repro',
    hint: '优化时的步长设置',
  },
  optimizer: {
    key: 'optimizer',
    label: '优化器',
    group: 'repro',
    hint: 'Adam / AdamW / SGD 等',
  },
  randomSeed: {
    key: 'randomSeed',
    label: '随机种子',
    group: 'repro',
    hint: '是否固定随机性来源',
  },
  epochs: {
    key: 'epochs',
    label: '训练轮数',
    group: 'repro',
    hint: '训练多少轮、是否早停',
  },
  batchSize: {
    key: 'batchSize',
    label: '批大小',
    group: 'repro',
    hint: '每个 batch 的样本数',
  },
  params: {
    key: 'params',
    label: '模型参数量',
    group: 'repro',
    hint: '用于判断容量是否可比',
  },
  codeAvailability: {
    key: 'codeAvailability',
    label: '代码 / 数据可获得性',
    group: 'repro',
    hint: '官方代码与数据是否公开',
  },
}

export const FIELD_ORDER: FieldKey[] = [
  'researchProblem',
  'method',
  'dataset',
  'split',
  'splitRange',
  'sampleInterval',
  'horizon',
  'metrics',
  'baselines',
  'conclusion',
  'limitations',
  'evalProtocol',
  'preprocessing',
  'learningRate',
  'optimizer',
  'randomSeed',
  'epochs',
  'batchSize',
  'params',
  'codeAvailability',
]

/** 论文详情页展示的字段顺序（按分组） */
export const DETAIL_GROUPS: { group: FieldGroup; title: string; subtitle: string }[] = [
  {
    group: 'overview',
    title: '论文概况',
    subtitle: '研究问题、方法与主要结论',
  },
  {
    group: 'experiment',
    title: '实验设置',
    subtitle: '影响结果可比性的关键设置',
  },
  {
    group: 'repro',
    title: '复现所需信息',
    subtitle: '只影响能否复现，不影响结果可比性',
  },
]

/**
 * 公平性检查项定义。
 * whyItMatters 说明「为什么这个条件不同会导致成绩不可直接比较」。
 * keys 里第一个是主字段，其余是必须一起核对的辅助字段（复合项）。
 */
export const FAIRNESS_SPEC: {
  id: string
  label: string
  key: FieldKey
  keys: FieldKey[]
  whyItMatters: string
}[] = [
  {
    id: 'fair-dataset',
    label: '数据集',
    key: 'dataset',
    keys: ['dataset'],
    whyItMatters:
      '不同数据集的序列长度、变量数和周期性强度差别很大，同一模型在不同数据集上的误差水平没有可比性。',
  },
  {
    id: 'fair-split',
    label: '训练 / 测试划分',
    key: 'split',
    keys: ['split', 'splitRange'],
    whyItMatters:
      '相同的划分比例不代表使用同一段测试数据：测试区间的起止不同，外推难度就不同，误差也不可直接对照。',
  },
  {
    id: 'fair-horizon',
    label: '预测跨度与时长',
    key: 'horizon',
    keys: ['horizon', 'sampleInterval'],
    whyItMatters:
      '相同的预测步数不代表相同的预测时长：采样间隔不同（15 分钟与 1 小时）时，「96 步」分别是 24 小时与 96 小时，任务难度完全不同。',
  },
  {
    id: 'fair-metrics',
    label: '评价指标',
    key: 'metrics',
    keys: ['metrics'],
    whyItMatters:
      'MSE 对大误差更敏感，MAE 更关注平均偏差，SMAPE 还会归一化量纲；指标集合不同，数值之间不存在可换算关系。',
  },
  {
    id: 'fair-protocol',
    label: '评估协议',
    key: 'evalProtocol',
    keys: ['evalProtocol'],
    whyItMatters:
      '滚动预测每一步都使用真实历史值，单次预测需要一次性输出整段跨度，后者难度更高，两者误差通常不可直接比较。',
  },
  {
    id: 'fair-preprocessing',
    label: '数据预处理',
    key: 'preprocessing',
    keys: ['preprocessing'],
    whyItMatters:
      'z-score 与 min-max 会改变序列幅值和分布，若标准化统计量取自全量数据还会引入信息泄漏，直接影响误差数值。',
  },
  {
    id: 'fair-baselines',
    label: '对比基线',
    key: 'baselines',
    keys: ['baselines'],
    whyItMatters:
      '基线集合不同意味着「相对提升」的分母不同，提升百分比不能跨论文比较，也不能直接作为方法优劣的依据。',
  },
]

/** 复现缺项检查项定义 + 对复现的影响说明 */
export const REPRO_SPEC: {
  id: string
  label: string
  key: FieldKey
  impact: string
}[] = [
  {
    id: 'repro-preprocessing',
    label: '数据预处理',
    key: 'preprocessing',
    impact:
      '预处理方式决定输入分布。不清楚是否标准化、用谁的统计量，自己实现时误差区间经常和论文差一个量级。',
  },
  {
    id: 'repro-split-range',
    label: '划分的时间区间',
    key: 'splitRange',
    impact:
      '只知道比例不知道区间，就无法确定测试段到底是哪一段时间。数据集版本或区间不同，误差会系统性偏移。',
  },
  {
    id: 'repro-interval',
    label: '采样间隔',
    key: 'sampleInterval',
    impact:
      '采样间隔决定「一步」是多长时间。间隔不一致时，同样的 96 步对应完全不同的预测时长，指标数字无法对齐。',
  },
  {
    id: 'repro-lr',
    label: '学习率',
    key: 'learningRate',
    impact:
      '学习率影响收敛速度与最终精度。同一模型换学习率，MSE 波动 5%～15% 很常见，缺失时只能自己搜索。',
  },
  {
    id: 'repro-optimizer',
    label: '优化器',
    key: 'optimizer',
    impact:
      'Adam / AdamW / SGD 在同样学习率下收敛行为不同，优化器缺失时无法对齐训练策略。',
  },
  {
    id: 'repro-seed',
    label: '随机种子',
    key: 'randomSeed',
    impact:
      '种子决定参数初始化与数据打乱顺序。没有固定种子时，结果本身有随机波动，很难判断差异来自方法还是随机性。',
  },
  {
    id: 'repro-epochs',
    label: '训练轮数',
    key: 'epochs',
    impact:
      '轮数决定模型是否训练充分。缺失时无法区分「方法更好」和「训练更久 / 已过拟合」。',
  },
  {
    id: 'repro-batch',
    label: '批大小',
    key: 'batchSize',
    impact:
      '批大小改变梯度噪声，等效于改变有效学习率，缺失时需要重新调节学习率才能对齐。',
  },
  {
    id: 'repro-params',
    label: '模型参数量',
    key: 'params',
    impact:
      '参数量反映模型容量。缺失时无法判断提升是否只是模型更大带来的，而不是方法设计带来的。',
  },
  {
    id: 'repro-code',
    label: '代码 / 数据可获得性',
    key: 'codeAvailability',
    impact:
      '官方代码与数据未公开时需要自行实现，数据版本、划分边界等细节容易出现偏差，复现结果会系统性偏离。',
  },
]

export function fieldLabel(key: FieldKey): string {
  return FIELD_META[key]?.label ?? key
}
