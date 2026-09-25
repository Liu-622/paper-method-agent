/**
 * 标签归一化：把模型自由文本映射到统一标签体系（FAMILY_VOCAB / MECHANISM_VOCAB / TASK_VOCAB）。
 * ------------------------------------------------------------------
 * 原则：
 *  - 支持中英文常见别名（大小写、连字符、空格、常见中文译名）。
 *  - 区分「模型家族 / 技术机制 / 研究任务」三类，各自独立词表，不混用。
 *  - 保留原始表述（rawLabel），归一化结果只用于统计、筛选、关系、方向，不覆盖证据。
 *  - 无法可靠映射时返回 null，由调用方按「其他 / 待确认」处理，绝不硬塞类别。
 *  - 方法名匹配容忍大小写与常见排版标记（如 N-BEATS / NBEATS / N-BEAT），但不把不同方法合并。
 */

export type LabelKind = 'family' | 'mechanism' | 'task'

export interface NormalizedLabel {
  /** 归一化后的规范标签；无法映射时为 null */
  canonical: string | null
  /** 原始表述，保留不动 */
  raw: string
  /** 映射状态 */
  status: 'mapped' | 'unmapped'
  /** 命中的别名键（诊断用） */
  matchedKey?: string
}

/* ------------------------------------------------------------------ */
/* 别名表：键为规范化后的写法（小写、去空白与连字符），值为规范标签    */
/* ------------------------------------------------------------------ */

const FAMILY_ALIASES: Record<string, string> = {
  // Transformer
  transformer: 'Transformer',
  transformerbased: 'Transformer',
  transformerbasedmodel: 'Transformer',
  transformerbasedmodels: 'Transformer',
  transformerarchitecture: 'Transformer',
  attentionbasedmodel: 'Transformer',
  '基于transformer': 'Transformer',
  transformer模型: 'Transformer',
  transformer架构: 'Transformer',
  // Linear
  linear: 'Linear',
  linearmodel: 'Linear',
  linearmodels: 'Linear',
  '线性模型': 'Linear',
  '线性': 'Linear',
  'one-layerlinear': 'Linear',
  // MLP
  mlp: 'MLP',
  multilayerperceptron: 'MLP',
  fullyconnected: 'MLP',
  fullyconnectedlayers: 'MLP',
  '多层感知机': 'MLP',
  '全连接': 'MLP',
  '全连接网络': 'MLP',
  // CNN
  cnn: 'CNN',
  convolutional: 'CNN',
  convolutionalnetwork: 'CNN',
  convolutionalneuralnetwork: 'CNN',
  temporalconvolutional: 'CNN',
  temporalconvolutionalnetwork: 'CNN',
  tcn: 'CNN',
  convolutionbased: 'CNN',
  '卷积神经网络': 'CNN',
  '卷积': 'CNN',
  '时域卷积': 'CNN',
  // RNN
  rnn: 'RNN',
  recurrent: 'RNN',
  recurrentneuralnetwork: 'RNN',
  lstm: 'RNN',
  gru: 'RNN',
  '循环神经网络': 'RNN',
  '循环': 'RNN',
  // 混合架构
  hybrid: '混合架构',
  hybridarchitecture: '混合架构',
  mixed: '混合架构',
  '混合架构': '混合架构',
  '混合': '混合架构',
}

const MECHANISM_ALIASES: Record<string, string> = {
  // 序列分解
  decomposition: '序列分解',
  decompose: '序列分解',
  decomposed: '序列分解',
  seasonal: '序列分解',
  trendseasonal: '序列分解',
  '序列分解': '序列分解',
  '分解': '序列分解',
  // 频域处理
  frequency: '频域处理',
  frequencyenhanced: '频域处理',
  fourier: '频域处理',
  spectral: '频域处理',
  '频域': '频域处理',
  '频域处理': '频域处理',
  '傅里叶': '频域处理',
  // Patch 表示
  patch: 'Patch 表示',
  patching: 'Patch 表示',
  patchembedding: 'Patch 表示',
  'patch表示': 'Patch 表示',
  '分块': 'Patch 表示',
  '补丁': 'Patch 表示',
  // 通道独立
  channelindependent: '通道独立',
  channelindependence: '通道独立',
  '通道独立': '通道独立',
  // 注意力
  attention: '注意力',
  selfattention: '注意力',
  sparseselfattention: '注意力',
  probsparseselfattention: '注意力',
  '注意力': '注意力',
  '自注意力': '注意力',
  // 卷积
  convolution: '卷积',
  conv1d: '卷积',
  downsampleconvolution: '卷积',
  downsampleconv: '卷积',
  '卷积': '卷积',
  // 多尺度
  multiscale: '多尺度',
  multiscalehybrid: '多尺度',
  '多尺度': '多尺度',
  // 残差连接
  residual: '残差连接',
  residualconnection: '残差连接',
  residuallinks: '残差连接',
  '残差': '残差连接',
  '残差连接': '残差连接',
  // 归一化去漂移
  revin: '归一化去漂移',
  reversibleinstancenorm: '归一化去漂移',
  instancenorm: '归一化去漂移',
  '归一化去漂移': '归一化去漂移',
  '去漂移': '归一化去漂移',
  // 自相关
  autocorrelation: '自相关',
  autocorrelationmechanism: '自相关',
  '自相关': '自相关',
}

const TASK_ALIASES: Record<string, string> = {
  'long-term': '长时预测',
  longterm: '长时预测',
  longtermforecasting: '长时预测',
  longsequence: '长时预测',
  longsequencetimeseries: '长时预测',
  lstf: '长时预测',
  '长时': '长时预测',
  '长时预测': '长时预测',
  '长期预测': '长时预测',
  'short-term': '短时预测',
  shortterm: '短时预测',
  shorttermforecasting: '短时预测',
  '短时': '短时预测',
  '短时预测': '短时预测',
  '短期预测': '短时预测',
  univariate: '单变量',
  '单变量': '单变量',
  multivariate: '多变量',
  '多变量': '多变量',
}

const TABLES: Record<LabelKind, Record<string, string>> = {
  family: FAMILY_ALIASES,
  mechanism: MECHANISM_ALIASES,
  task: TASK_ALIASES,
}

/** 规范化键：小写 + NFKC + 去掉空白/连字符/常见标点，保留数字与字母（含中文）。 */
function normKey(s: string): string {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u2010-\u2015\u2212\-_/·.,，。()（）\[\]【】]+/g, '')
}

// 按别名键长度从长到短排序，保证「更具体的写法」优先命中（如 'fullyconnectedlayers' 先于 'fully'）
const SORTED_KEYS: Record<LabelKind, string[]> = {
  family: Object.keys(FAMILY_ALIASES).sort((a, b) => b.length - a.length),
  mechanism: Object.keys(MECHANISM_ALIASES).sort((a, b) => b.length - a.length),
  task: Object.keys(TASK_ALIASES).sort((a, b) => b.length - a.length),
}

/**
 * 把一条自由文本标签归一化到对应词表。
 * 命中顺序：先整体匹配（key === norm），再子串匹配（norm 包含 key）。
 */
export function normalizeLabel(kind: LabelKind, raw: string): NormalizedLabel {
  const table = TABLES[kind]
  const r = String(raw ?? '').trim()
  if (!r) return { canonical: null, raw: r, status: 'unmapped' }
  const n = normKey(r)
  if (!n) return { canonical: null, raw: r, status: 'unmapped' }

  // 1) 整体匹配
  for (const key of SORTED_KEYS[kind]) {
    if (n === key) return { canonical: table[key], raw: r, status: 'mapped', matchedKey: key }
  }
  // 2) 子串匹配（键足够长才做，避免 'cnn' 这种短键误命中长词）
  for (const key of SORTED_KEYS[kind]) {
    if (key.length >= 4 && n.includes(key)) {
      return { canonical: table[key], raw: r, status: 'mapped', matchedKey: key }
    }
  }
  return { canonical: null, raw: r, status: 'unmapped' }
}

/**
 * 方法名归一化（用于对象名出现判断）：容忍大小写与常见排版标记，
 * 但不把不同方法合并 —— 只做「去标记 + 小写」的保守等价，不做词典替换。
 */
export function normalizeMethodName(s: string): string {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u2010-\u2015\u2212\-_/·]+/g, '')
    .replace(/[†‡*∗]/g, '')
}
