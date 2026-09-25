import type { FieldKey } from '@/types'

/**
 * 取值归一化
 * ------------------------------------------------------------------
 * 检查逻辑全部基于「本地确定性规则」，先把论文里读到的自然语言值归一化成
 * 可比较的规范值，再做判等。这样：
 *  - 检查过程可解释、可追溯，不依赖模型；
 *  - 以后接入真实抽取时，只要仍然输出同一个字段，检查逻辑不用改。
 */

/** 从文本中取出所有数字，支持 1e-3 这类科学计数法 */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)
  if (!matches) return []
  return matches.map((m) => Number(m)).filter((n) => Number.isFinite(n))
}

export function firstNumber(text: string): number | null {
  const nums = extractNumbers(text)
  return nums.length ? nums[0] : null
}

const METRIC_TOKENS = [
  'MSE',
  'MAE',
  'RMSE',
  'SMAPE',
  'MAPE',
  'WAPE',
  'MSIS',
  'CRPS',
  'R2',
]

/** 提取拉丁字母 token（用于数据集名、基线方法名） */
function latinTokens(text: string, minLen = 2): string[] {
  const matches = text.match(/[A-Za-z][A-Za-z0-9_-]+/g) ?? []
  return Array.from(
    new Set(matches.map((m) => m.toUpperCase()).filter((m) => m.length >= minLen)),
  ).sort()
}

/** 数据集：把「ETTm1、Weather」这类写法统一成排序后的集合 */
export function normalizeDataset(text: string): string {
  const stop = new Set([
    'AND',
    'THE',
    'WITH',
    'ON',
    'ALL',
    'DATASETS',
    'DATASET',
  ])
  const tokens = latinTokens(text).filter((t) => !stop.has(t))
  return tokens.join('+')
}

/** 评价指标：只保留已知指标名，排序后作为集合 */
export function normalizeMetrics(text: string): string {
  const upper = text.toUpperCase()
  const found = METRIC_TOKENS.filter((m) => upper.includes(m))
  return found.join('+')
}

/** 划分比例：7:1:2 */
export function normalizeSplit(text: string): string {
  const m = text.match(/(\d+)\s*[:：]\s*(\d+)\s*[:：]\s*(\d+)/)
  if (!m) return ''
  return `${Number(m[1])}:${Number(m[2])}:${Number(m[3])}`
}

/**
 * 预测跨度：可能是单个数字，也可能是一组（论文常同时报告多个跨度）。
 * 只取第一个数字会造成误判，所以这里返回**排序去重后的集合**，
 * 由检查逻辑按集合比较，并在理由里说清共同覆盖了哪些、谁多报了哪些。
 */
export function normalizeHorizon(text: string): string {
  const raw = String(text || '')
  if (!raw.trim()) return ''

  const collected = new Set<number>()

  // 1) 花括号里的枚举最可靠：T ∈ {96, 192, 336, 720}
  const braces = raw.match(/\{[^}]*\}/g) || []
  braces.forEach((b) => {
    extractNumbers(b).forEach((n) => {
      if (n > 0 && n <= 100000) collected.add(n)
    })
  })

  // 2) 关键词后面的数字：跨度 / horizon / T / O / OT
  if (collected.size === 0) {
    const kw = raw.match(/(?:跨度|horizon|T|O|OT|prediction length)\s*(?:∈|=|为|:|：)?\s*([0-9,，、\s\-~到]+)/gi) || []
    kw.forEach((seg) => {
      extractNumbers(seg).forEach((n) => {
        if (n > 0 && n <= 100000) collected.add(n)
      })
    })
  }

  // 3) 兜底：全文数字里的第一个
  if (collected.size === 0) {
    const n = firstNumber(raw)
    if (n !== null) collected.add(n)
  }

  const list = [...collected].sort((a, b) => a - b)
  return list.join(',')
}

/** 跨度集合 → 可读文字 */
export function describeHorizon(normalized: string): string {
  if (!normalized) return '未说明'
  const parts = normalized.split(',').filter(Boolean)
  if (parts.length === 1) return `${parts[0]} 步`
  return `${parts.join(' / ')} 步`
}

/**
 * 划分的时间区间。
 * 相同的划分比例不代表同一段测试数据，所以必须把区间也归一化成可比较的值：
 *  - 有具体日期 → 日期集合（排序后拼接）
 *  - 只有「最后 N%」这类描述 → LAST:N%
 *  - 两者都有 → 日期集合|LAST:N%
 */
export function normalizeSplitRange(text: string): string {
  const raw = text || ''
  const dates = raw.match(/\d{4}[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?/g) || []
  const dateKeys = Array.from(
    new Set(dates.map((d) => d.replace(/[/年月]/g, '-').replace(/日/g, ''))),
  ).sort()

  const lastMatch = raw.match(/(最后|末尾|last)\s*(\d{1,2})\s*%/)
  const percent = lastMatch ? `LAST:${Number(lastMatch[2])}%` : ''

  const monthCount = raw.match(/(\d{1,2})\s*(个月|months?)/i)
  const monthKey = !dateKeys.length && monthCount ? `MONTHS:${Number(monthCount[1])}` : ''

  const parts = [...dateKeys]
  if (percent) parts.push(percent)
  if (monthKey) parts.push(monthKey)
  return parts.join('|')
}

/** 采样间隔 → 分钟集合（排序去重）；无法确定返回 '' */
export function normalizeSampleInterval(text: string): string {
  const raw = (text || '').toLowerCase()
  if (!raw.trim()) return ''

  const found = new Set<number>()
  const push = (n: number) => {
    if (Number.isFinite(n) && n > 0) found.add(Math.round(n * 100) / 100)
  }

  // 允许「15 分钟」「15-minute」「15min」等写法
  const re =
    /(\d+(?:\.\d+)?)\s*[-–—]?\s*(minutes?|mins?|分钟|hours?|hrs?|小时|days?|天|日|seconds?|secs?|秒|weeks?|周|星期|months?|月)/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const n = Number(m[1])
    const u = m[2]
    if (/^(minutes?|mins?|分钟)$/.test(u)) push(n)
    else if (/^(hours?|hrs?|小时)$/.test(u)) push(n * 60)
    else if (/^(days?|天|日)$/.test(u)) push(n * 1440)
    else if (/^(seconds?|secs?|秒)$/.test(u)) push(n / 60)
    else if (/^(weeks?|周|星期)$/.test(u)) push(n * 10080)
    else if (/^(months?|月)$/.test(u)) push(n * 43200)
  }

  // 纯频率词（中英文都常见，例如「日度」「周频」「hourly」）
  const freqRules: [RegExp, number][] = [
    [/hourly|每小时|小时级|小时频/, 60],
    [/daily|每天|每日|日度|日频|按天/, 1440],
    [/weekly|每周|周度|周频|按周/, 10080],
    [/monthly|每月|月度|月频|按月/, 43200],
    [/quarterly|每季度|季度/, 129600],
    [/yearly|annually|每年|年度|年频/, 518400],
  ]
  freqRules.forEach(([re, minutes]) => {
    if (re.test(raw)) push(minutes)
  })

  if (found.size === 0) return ''
  return [...found].sort((a, b) => a - b).join(',')
}

/** 预测时长（分钟）= 步数 × 采样间隔；只在一对一（各只有一个取值）时才有意义 */
export function horizonDurationMinutes(
  stepsText: string | null | undefined,
  intervalText: string | null | undefined,
): number | null {
  const steps = normalizeHorizon(stepsText || '')
  const interval = normalizeSampleInterval(intervalText || '')
  if (!steps || !interval) return null
  const stepList = steps.split(',')
  const intervalList = interval.split(',')
  if (stepList.length !== 1 || intervalList.length !== 1) return null
  return Number(stepList[0]) * Number(intervalList[0])
}

/** 分钟数 → 人话 */
export function describeDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '无法计算'
  if (minutes < 60) return `${Number(minutes.toFixed(2))} 分钟`
  const hours = minutes / 60
  if (hours < 48) return `${Number(hours.toFixed(hours < 10 ? 1 : 0))} 小时`
  return `${Number((minutes / 1440).toFixed(1))} 天`
}

/** 采样间隔规范值 → 可读文字 */
export function describeInterval(normalized: string): string {
  if (!normalized) return '未说明'
  const parts = normalized
    .split(',')
    .filter(Boolean)
    .map((p) => {
      const mins = Number(p)
      if (mins < 60) return `${Number(mins.toFixed(2))} 分钟`
      if (mins % 1440 === 0) return `${mins / 1440} 天`
      if (mins % 60 === 0) return `${mins / 60} 小时`
      return `${Math.round(mins)} 分钟`
    })
  return parts.join(' / ')
}

/** 比较两个「集合型」规范值，返回共同项与各自多出的项 */
export function compareSets(a: string, b: string): { shared: string[]; onlyA: string[]; onlyB: string[] } {
  const setA = a.split(',').filter(Boolean)
  const setB = b.split(',').filter(Boolean)
  const hasB = new Set(setB)
  const hasA = new Set(setA)
  return {
    shared: setA.filter((x) => hasB.has(x)),
    onlyA: setA.filter((x) => !hasB.has(x)),
    onlyB: setB.filter((x) => !hasA.has(x)),
  }
}

/** 预处理：分类 + 统计量来源（是否用了测试段数据） */
export function normalizePreprocessing(text: string): string {
  const t = text.toLowerCase()
  let kind = ''
  if (/(z-?\s?score|standard|均值方差|标准分数)/i.test(t)) kind = 'ZSCORE'
  else if (/(min-?\s?max|最大最小|归一化到\s*\[?0\s*,\s*1)/i.test(t)) kind = 'MINMAX'
  else if (/(缩放|rescal|scal)/i.test(t)) kind = 'SCALED-UNSPECIFIED'

  let statSource = ''
  if (/(训练集|training (split|set))/i.test(t)) statSource = 'train'
  else if (/(整个数据集|全量|whole dataset|before splitting|all (the )?data)/i.test(t))
    statSource = 'all'

  if (!kind) return ''
  return statSource ? `${kind}:${statSource}` : kind
}

/** 评估协议：单次 / 滚动 */
export function normalizeEvalProtocol(text: string): string {
  const t = text.toLowerCase()
  if (/(滚动|rolling|逐步|step-?by-?step)/i.test(t)) return 'ROLLING'
  if (/(单次|single-?shot|一次性|direct multi)/i.test(t)) return 'SINGLE'
  return ''
}

/** 学习率：数值化，便于 1e-3 与 0.001 判等 */
export function normalizeLearningRate(text: string): string {
  const raw = String(text || '')
  // 论文里常见三种写法：1e-3 / 10^-3 / 10 −3（Unicode 减号 + 空格），统一成 10^-3 这种形式
  const before = normalizeTextForCompare(raw)
  const pow = before.match(/(\d+(?:\.\d+)?)\s*\^\s*(-?\d+)/)
  if (pow) {
    const mantissa = Number(pow[1])
    const exp = Number(pow[2])
    if (Number.isFinite(mantissa) && Number.isFinite(exp)) return `10^${Math.round(Math.log10(mantissa) + exp)}`
  }
  // "10 −4" 这类：数字 + 空白 + 减号 + 数字，且不是普通的范围（1-5）
  const spaced = raw.match(/(\d+)\s*[\u2212\u2013\u2014-]\s*(\d+)\s*$/)
  if (spaced && Number(spaced[1]) <= 100 && Number(spaced[2]) <= 20) {
    return `10^-${Number(spaced[2])}`
  }
  const m = raw.match(/(\d+(?:\.\d+)?\s*[eE]\s*-?\s*\d+|\d*\.\d+)/)
  if (m) {
    const n = Number(m[0].replace(/\s+/g, ''))
    if (Number.isFinite(n)) {
      // 科学计数法与幂形式统一：1e-3 → 10^-3
      if (/[eE]/.test(m[0])) return `10^${Math.round(Math.log10(n))}`
      return String(Number(n.toPrecision(6)))
    }
  }
  const n = firstNumber(raw)
  return n === null ? '' : String(n)
}

/** 轻量归一：去空格、统一各种减号与上标符号（用于学习率这类数字写法比较） */
function normalizeTextForCompare(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\u2043\ufe63\uff0d]/g, '-')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (ch) => `^${'⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(ch)}`)
    .replace(/\s+/g, '')
    .toLowerCase()
}

/** 随机种子：取出种子数值；明确说明未固定时归一为 'NONE' */
export function normalizeRandomSeed(text: string): string {
  if (/(不固定|未固定|not fix|no fixed|随机运行)/i.test(text)) return 'NONE'
  const n = firstNumber(text)
  return n === null ? '' : String(n)
}

/** 模型参数量：统一换算成百万（M） */
export function normalizeParams(text: string): string {
  const t = text.toLowerCase()
  const m = t.match(/(\d+(?:\.\d+)?)\s*(m|b|k|百万|亿|千)/)
  if (m) {
    const base = Number(m[1])
    const unit = m[2].toLowerCase()
    const scale: Record<string, number> = {
      k: 1e-3,
      千: 1e-3,
      m: 1,
      百万: 1,
      b: 1e3,
      亿: 1e2,
    }
    const factor = scale[unit] ?? 1
    return String(Number((base * factor).toPrecision(4)))
  }
  const n = firstNumber(t)
  if (n === null) return ''
  // 少于 1M / fewer than 1M 这类写法
  if (/(少于|不到|fewer than|less than|不足)/i.test(t)) return `<${n}`
  return String(n)
}

/** 代码可获得性 */
export function normalizeCodeAvailability(text: string): string {
  const t = text.toLowerCase()
  if (/(未提供|未公开|没有公开|计划|plan to|not (yet )?(released|available)|no code)/i.test(t))
    return 'NOT_AVAILABLE'
  if (/(已公开|公开|开源|released|available at|open-?source)/i.test(t)) return 'AVAILABLE'
  return ''
}

/** 统一入口 */
export function normalizeValue(key: FieldKey, value: string | null): string {
  if (!value) return ''
  switch (key) {
    case 'dataset':
      return normalizeDataset(value)
    case 'metrics':
      return normalizeMetrics(value)
    case 'split':
      return normalizeSplit(value)
    case 'splitRange':
      return normalizeSplitRange(value)
    case 'sampleInterval':
      return normalizeSampleInterval(value)
    case 'horizon':
      return normalizeHorizon(value)
    case 'baselines':
      return latinTokens(value).join('+')
    case 'preprocessing':
      return normalizePreprocessing(value)
    case 'evalProtocol':
      return normalizeEvalProtocol(value)
    case 'learningRate':
      return normalizeLearningRate(value)
    case 'randomSeed':
      return normalizeRandomSeed(value)
    case 'params':
      return normalizeParams(value)
    case 'codeAvailability':
      return normalizeCodeAvailability(value)
    case 'epochs':
    case 'batchSize': {
      const n = firstNumber(value)
      return n === null ? '' : String(n)
    }
    default:
      return value.trim()
  }
}

/** 判断两个规范化值在「集合意义」上是否等价（顺序无关） */
export function normalizedEqual(a: string, b: string, key: FieldKey): boolean {
  if (a === b) return true
  if (key === 'dataset' || key === 'metrics' || key === 'baselines') {
    const sa = a.split('+').filter(Boolean).sort().join('+')
    const sb = b.split('+').filter(Boolean).sort().join('+')
    return sa === sb
  }
  return false
}

/** 把规范化值翻译成人能看懂的说法，用于检查理由 */
export function describeNormalized(key: FieldKey, normalized: string): string {
  if (!normalized) return '无法识别'
  switch (key) {
    case 'preprocessing': {
      const [kind, src] = normalized.split(':')
      const kindText: Record<string, string> = {
        ZSCORE: 'z-score 标准化',
        MINMAX: 'min-max 归一化',
        'SCALED-UNSPECIFIED': '仅说明做过缩放，方式未说明',
      }
      const srcText: Record<string, string> = {
        train: '统计量取自训练集',
        all: '统计量取自全量数据（含测试段）',
      }
      return [kindText[kind] ?? kind, src ? srcText[src] ?? src : '']
        .filter(Boolean)
        .join('，')
    }
    case 'evalProtocol':
      return normalized === 'ROLLING' ? '滚动预测' : normalized === 'SINGLE' ? '单次预测' : normalized
    case 'split':
      return `划分比例 ${normalized}`
    case 'splitRange': {
      const parts = normalized.split('|')
      const dates = parts.filter((p) => /^\d{4}/.test(p))
      const others = parts.filter((p) => !/^\d{4}/.test(p)).map((p) => p.replace('LAST:', '最后 '))
      const text = [dates.length ? `${dates[0]} 至 ${dates[dates.length - 1]}` : '', ...others]
        .filter(Boolean)
        .join('，')
      return `测试区间 ${text || normalized}`
    }
    case 'horizon':
      return `预测跨度 ${describeHorizon(normalized)}`
    case 'sampleInterval':
      return `采样间隔 ${describeInterval(normalized)}`
    case 'params':
      return normalized.startsWith('<')
        ? `参数量少于 ${normalized.slice(1)}M`
        : `参数量约 ${normalized}M`
    case 'randomSeed':
      return normalized === 'NONE' ? '未固定随机种子' : `种子 ${normalized}`
    case 'codeAvailability':
      return normalized === 'AVAILABLE' ? '代码/数据已公开' : '代码/数据未公开'
    case 'metrics':
      return `指标集合 {${normalized.split('+').join(', ')}}`
    case 'dataset':
      return `数据集 {${normalized.split('+').join(', ')}}`
    case 'baselines':
      return `基线 {${normalized.split('+').join(', ')}}`
    case 'learningRate':
      return `学习率 ${normalized}`
    case 'epochs':
      return `训练 ${normalized} 轮`
    case 'batchSize':
      return `批大小 ${normalized}`
    default:
      return normalized
  }
}

export function setOf(normalized: string): Set<string> {
  return new Set(normalized.split('+').filter(Boolean))
}
