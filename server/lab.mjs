/**
 * 小咕实验室 —— 真实可执行的受控实验引擎
 * ==================================================================
 * 设计约束（不要为了好看放宽）：
 * 1. 两种方法使用**同一数据范围、同一预测目标、同一评估口径**（共用同一批预测起点）；
 * 2. 按时间顺序划分 train / val / test，拟合与标准化**只用 train**，绝不触碰未来数据；
 * 3. 噪声/缺失**只作用在输入窗口**，真实评估目标永远不被修改；
 * 4. 指标全部由本文件的代码计算，模型只负责解释结果；
 * 5. 随机扰动由固定种子驱动，可复现；同一配置 + 同一种子结果完全一致；
 * 6. 实验对象是两条**教学方法**（季节朴素 + 岭回归），不是论文方法的复现。
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planLabExperiment } from './llm.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')

export const LAB_VERSION = 'lab-v1'
export const METHOD_SCOPE = 'teaching'

/**
 * 官方 ETTm2 划分（来自官方 data_provider/data_loader.py 的 Dataset_ETT_minute）：
 *   border1s = [0, 12*30*24*4 - seq_len, 12*30*24*4 + 4*30*24*4 - seq_len]
 *   border2s = [12*30*24*4, 12*30*24*4 + 4*30*24*4, 12*30*24*4 + 8*30*24*4] = [34560, 46080, 57600]
 * 即：**官方基准只使用 CSV 的前 57,600 行**（约占 20 个月），
 * 第 57,600–69,680 行（2018-02-21 → 2018-06-26，12,080 点）**不在官方基准范围内**。
 */
export const ETTM2_SPLIT = { train: 34560, val: 11520, test: 11520 }
export const OFFICIAL_RANGE = {
  train: [0, 34560],
  val: [34224, 46080], // 含 seq_len 回溯重叠（官方写法）
  test: [45744, 57600], // 含 seq_len 回溯重叠
  evalStart: 46080, // 第一个可评估起点 = test.border1 + seq_len
  evalEnd: 57600,
  totalUsed: 57600,
  datasetRows: 69680,
  outOfBenchmark: {
    from: 57600,
    to: 69680,
    len: 12080,
    startDate: '2018-02-21 00:00:00',
    endDate: '2018-06-26 19:45:00',
    note: '这 12,080 个点**不在官方基准范围内**；官方脚本不会用到它们。若要使用，必须标注为「自定义时间外测试（超出官方基准）」，不能称为沿用官方划分。',
  },
}

/** 当前数据划分标识：结果地图按它隔离，旧划分的结果进入历史记录 */
export const DATA_SPLIT_ID = 'official-ettm2-t34560-v46080-e57600'

/**
 * 测试段按时间顺序再切两半（**都在官方测试区间之内**，属于自定义切片）：
 *  - explore：探索切片，探索智能体只能看到这一段的结果；
 *  - independent：另一时间段一致性检查切片（探索期间不暴露）。
 * 注意：两段都是官方测试区间的子切片，后半段**不能**称为"从未使用过的独立复验数据"。
 */
export const SEGMENT_LABEL = {
  explore: '探索切片（自定义：官方测试区间前半段 46080–51840，2017-10-24 00:00 → 2017-12-22 23:45）',
  independent: '另一时间段一致性检查切片（自定义：官方测试区间后半段 51840–57600，2017-12-23 00:00 → 2018-02-20 23:45）',
}
export const SEGMENTS = {
  explore: { from: 46080, to: 51840 },
  independent: { from: 51840, to: 57600 },
}

export const LAB_SOURCES = {
  ETTm2: {
    kind: 'real',
    name: 'ETTm2（ETT small）',
    column: 'OT',
    url: 'https://raw.githubusercontent.com/zhouhaoyi/ETDataset/main/ETT-small/ETTm2.csv',
    repo: 'https://github.com/zhouhaoyi/ETDataset',
    file: 'data/ETTm2.csv',
    intervalMinutes: 15,
    season: 96, // 一天 96 个点
    note: '真实公开数据；本实验室只取 OT 单变量，并使用官方划分长度。',
  },
}

/** 允许的条件空间（程序在这里做范围校验，模型只能在这些值里选） */
export const CONDITION_SPACE = {
  horizon: [24, 48, 96, 192],
  perturbationType: ['noise', 'missing'],
  strength: [0, 0.05, 0.1, 0.2, 0.35],
  seed: [11, 29, 47],
  lags: 96,
  alpha: 10,
  stride: 8,
  maxOriginsPerRun: 60,
}

/** 判断「差距较小」的公开阈值：|ΔMAE| / 较好方法的 MAE < 2% */
export const CLOSE_GAP_THRESHOLD = 0.02

/* ------------------------------------------------------------------ */
/* 工具：伪随机、哈希                                                   */
/* ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(rand) {
  let u = 0
  let v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
export function hashNumbers(list) {
  let h = 2166136261
  for (let i = 0; i < list.length; i += 1) {
    const x = Math.round(list[i] * 1e6)
    h ^= x
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

/* ------------------------------------------------------------------ */
/* 数据加载（真实 CSV；缺失时回退到明确标注的合成序列）                   */
/* ------------------------------------------------------------------ */
let cache = null

export function loadSeries(sourceKey = 'ETTm2') {
  if (cache && cache.key === sourceKey) return cache
  const spec = LAB_SOURCES[sourceKey]
  const path = join(ROOT, spec.file)
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split(/\r?\n/)
    const header = (lines[0] || '').split(',')
    const colIndex = header.indexOf(spec.column)
    const values = []
    const dates = []
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (!line) continue
      const parts = line.split(',')
      const v = Number(parts[colIndex])
      if (!Number.isFinite(v)) continue
      values.push(v)
      dates.push(parts[0])
    }
    cache = {
      key: sourceKey,
      source: {
        kind: 'real',
        name: spec.name,
        column: spec.column,
        url: spec.url,
        repo: spec.repo,
        rows: values.length,
        start: dates[0],
        end: dates[dates.length - 1],
        intervalMinutes: spec.intervalMinutes,
        note: spec.note,
      },
      values,
      season: spec.season,
      synthetic: false,
    }
    return cache
  }

  // 回退：合成序列（显著标注，不与真实数据结果混用）
  const n = 57600
  const rand = mulberry32(20260701)
  const values = []
  for (let i = 0; i < n; i += 1) {
    const daily = Math.sin((2 * Math.PI * i) / 96) * 6
    const weekly = Math.sin((2 * Math.PI * i) / (96 * 7)) * 2.5
    const trend = (i / n) * 4
    values.push(30 + daily + weekly + trend + gauss(rand) * 1.1)
  }
  cache = {
    key: sourceKey,
    source: {
      kind: 'synthetic',
      name: '合成序列（ETTm2.csv 不存在时的回退数据）',
      column: 'synthetic',
      url: null,
      repo: null,
      rows: n,
      start: 'synth-0',
      end: `synth-${n - 1}`,
      intervalMinutes: 15,
      note: '合成数据，仅用于跑通流程与理解比较条件，不得与真实数据结果混用，也不代表任何论文。',
      generator:
        '日周期(96 点, 幅值 6) + 周周期(672 点, 幅值 2.5) + 线性趋势(幅值 4) + 高斯噪声(σ=1.1)，种子 20260701',
    },
    values,
    season: 96,
    synthetic: true,
  }
  return cache
}

export function seriesMeta() {
  const s = loadSeries('ETTm2')
  return {
    source: s.source,
    total: s.values.length,
    season: s.season,
    split: {
      train: OFFICIAL_RANGE.train,
      val: OFFICIAL_RANGE.val,
      test: OFFICIAL_RANGE.test,
      evalStart: OFFICIAL_RANGE.evalStart,
      evalEnd: OFFICIAL_RANGE.evalEnd,
      totalUsed: OFFICIAL_RANGE.totalUsed,
      datasetRows: OFFICIAL_RANGE.datasetRows,
      outOfBenchmark: OFFICIAL_RANGE.outOfBenchmark,
      segments: SEGMENTS,
      segmentLabels: SEGMENT_LABEL,
      dataSplitId: DATA_SPLIT_ID,
      note: '官方基准只使用前 57,600 行；测试区间 [45744, 57600)，第一个可评估起点是 46080。测试区间内的探索/一致性切片都是自定义子切片。',
    },
    preview: downsample(s.values.slice(0, 960), 240),
    conditionSpace: CONDITION_SPACE,
    closeGapThreshold: CLOSE_GAP_THRESHOLD,
    labVersion: LAB_VERSION,
    methodScope: METHOD_SCOPE,
  }
}

/* ------------------------------------------------------------------ */
/* 方法 1：季节性朴素预测                                              */
/* ------------------------------------------------------------------ */
function seasonalNaiveForecast(input, horizon, season) {
  const out = []
  for (let h = 1; h <= horizon; h += 1) {
    const idx = input.length - season + ((h - 1) % season)
    out.push(input[Math.max(0, idx)] ?? input[input.length - 1])
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 方法 2：岭回归自回归（直接多步，闭式解，只用训练段拟合）               */
/* ------------------------------------------------------------------ */
const fitCache = new Map()

function buildTrainWindows(values, trainEnd, lags, horizon, stride) {
  const originStart = Math.max(lags, horizon)
  const origins = []
  for (let o = originStart; o + horizon < trainEnd; o += stride) origins.push(o)
  return origins
}

function fitRidge(values, config) {
  const { trainEnd } = config
  const { lags, alpha, horizon, stride } = config
  const key = `ridge|${values.length}|${trainEnd}|${lags}|${alpha}|${horizon}|${stride}`
  if (fitCache.has(key)) return fitCache.get(key)

  const origins = buildTrainWindows(values, trainEnd, lags, horizon, stride)
  const n = origins.length
  const d = lags + 1 // 末尾加一列常数项
  // 训练段统计量（标准化只用训练数据）
  const trainVals = values.slice(0, trainEnd)
  const mean = trainVals.reduce((a, b) => a + b, 0) / trainVals.length
  const sd = Math.sqrt(trainVals.reduce((a, b) => a + (b - mean) ** 2, 0) / trainVals.length) || 1

  const XtX = new Float64Array(d * d)
  const XtY = new Float64Array(d * horizon)
  for (const o of origins) {
    const x = new Float64Array(d)
    for (let j = 0; j < lags; j += 1) x[j] = (values[o - lags + j] - mean) / sd
    x[lags] = 1
    for (let a = 0; a < d; a += 1) {
      const xa = x[a]
      if (xa === 0) continue
      for (let b = a; b < d; b += 1) XtX[a * d + b] += xa * x[b]
      for (let h = 0; h < horizon; h += 1) XtY[a * horizon + h] += xa * values[o + h]
    }
  }
  for (let a = 0; a < d; a += 1) {
    for (let b = 0; b < a; b += 1) XtX[a * d + b] = XtX[b * d + a]
    XtX[a * d + a] += alpha // 岭惩罚（不惩罚截距，这里为简化一并加常数项，取值很小）
  }

  // Cholesky 分解求解 d 个右端项
  const L = new Float64Array(d * d)
  for (let i = 0; i < d; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = XtX[i * d + j]
      for (let k = 0; k < j; k += 1) sum -= L[i * d + k] * L[j * d + k]
      if (i === j) L[i * d + j] = Math.sqrt(Math.max(sum, 1e-9))
      else L[i * d + j] = sum / L[j * d + j]
    }
  }
  const coef = new Float64Array(d * horizon)
  const yTmp = new Float64Array(d)
  for (let h = 0; h < horizon; h += 1) {
    for (let i = 0; i < d; i += 1) {
      let sum = XtY[i * horizon + h]
      for (let k = 0; k < i; k += 1) sum -= L[i * d + k] * yTmp[k]
      yTmp[i] = sum / L[i * d + i]
    }
    for (let i = d - 1; i >= 0; i -= 1) {
      let sum = yTmp[i]
      for (let k = i + 1; k < d; k += 1) sum -= L[k * d + i] * coef[k * horizon + h]
      coef[i * horizon + h] = sum / L[i * d + i]
    }
  }
  const model = { coef, mean, sd, lags, d, trainWindows: n }
  fitCache.set(key, model)
  return model
}

function ridgeForecast(input, horizon, model) {
  const { coef, mean, sd, lags, d } = model
  const x = new Float64Array(d)
  const tail = input.slice(Math.max(0, input.length - lags))
  for (let j = 0; j < lags; j += 1) {
    const v = tail[j] ?? mean
    x[j] = (v - mean) / sd
  }
  x[lags] = 1
  const out = []
  for (let h = 0; h < horizon; h += 1) {
    let s = 0
    for (let j = 0; j < d; j += 1) s += coef[j * horizon + h] * x[j]
    out.push(s)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 指标（全部由代码计算）                                               */
/* ------------------------------------------------------------------ */
export function computeMetrics(truth, pred) {
  const n = Math.min(truth.length, pred.length)
  if (n === 0) return { n: 0, mae: null, rmse: null, mape: null }
  let sae = 0
  let sse = 0
  let mapeSum = 0
  let mapeCount = 0
  for (let i = 0; i < n; i += 1) {
    const e = pred[i] - truth[i]
    sae += Math.abs(e)
    sse += e * e
    if (Math.abs(truth[i]) > 1e-6) {
      mapeSum += Math.abs(e / truth[i])
      mapeCount += 1
    }
  }
  return {
    n,
    mae: sae / n,
    rmse: Math.sqrt(sse / n),
    mape: mapeCount ? (mapeSum / mapeCount) * 100 : null,
  }
}

function downsample(arr, maxPoints) {
  if (arr.length <= maxPoints) return arr.slice()
  const stride = Math.ceil(arr.length / maxPoints)
  const out = []
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i])
  return out
}

/* ------------------------------------------------------------------ */
/* 配置校验（模型只能提出，程序说了算）                                  */
/* ------------------------------------------------------------------ */
export function validateConfig(raw) {
  const space = CONDITION_SPACE
  const out = {}
  const problems = []
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

  const horizon = num(raw?.horizon)
  if (!space.horizon.includes(horizon)) problems.push(`预测跨度 ${raw?.horizon} 不在允许范围 ${space.horizon.join('/')}`)
  else out.horizon = horizon

  const type = String(raw?.perturbationType || '')
  if (!space.perturbationType.includes(type)) problems.push(`扰动类型 ${raw?.perturbationType} 不允许`)
  else out.perturbationType = type

  const strength = num(raw?.strength)
  if (!space.strength.includes(strength)) problems.push(`扰动强度 ${raw?.strength} 不在允许范围 ${space.strength.join('/')}`)
  else out.strength = strength

  const seed = num(raw?.seed)
  if (!space.seed.includes(seed)) problems.push(`随机种子 ${raw?.seed} 不在允许范围 ${space.seed.join('/')}`)
  else out.seed = seed

  if (problems.length) return { ok: false, problems }
  out.subset = 'ETTm2'
  out.column = 'OT'
  out.variable = raw?.variable === 'HUFL' ? 'HUFL' : 'OT'
  out.segment = raw?.segment === 'independent' ? 'independent' : 'explore'
  return { ok: true, config: out }
}

export function cellKey(config) {
  return `${config.horizon}|${config.perturbationType}|${config.strength}`
}

/* ------------------------------------------------------------------ */
/* 扰动：只改输入窗口，绝不动真实目标                                    */
/* ------------------------------------------------------------------ */
function perturbInput(input, config) {
  const { perturbationType: type, strength, seed } = config
  if (!type || strength === 0) return { input: input.slice(), changed: 0 }
  const rand = mulberry32((seed * 7919 + Math.round(strength * 1000)) >>> 0)
  const out = input.slice()
  let changed = 0
  if (type === 'noise') {
    const sd = Math.sqrt(out.reduce((a, b) => a + (b - out.reduce((x, y) => x + y, 0) / out.length) ** 2, 0) / out.length) || 1
    for (let i = 0; i < out.length; i += 1) {
      if (rand() < strength) {
        out[i] = out[i] + gauss(rand) * sd * 0.5
        changed += 1
      }
    }
  } else {
    // 缺失：按比例抹掉输入点，再用线性插值补齐（确定性）
    const missing = new Set()
    for (let i = 0; i < out.length; i += 1) if (rand() < strength) missing.add(i)
    for (const i of missing) {
      let prev = i - 1
      while (prev >= 0 && missing.has(prev)) prev -= 1
      let next = i + 1
      while (next < out.length && missing.has(next)) next += 1
      const a = prev >= 0 ? out[prev] : out[i]
      const b = next < out.length ? out[next] : out[i]
      out[i] = (a + b) / 2
      changed += 1
    }
  }
  return { input: out, changed }
}

/* ------------------------------------------------------------------ */
/* 单次实验                                                            */
/* ------------------------------------------------------------------ */
export function runExperiment(config, meta = {}) {
  const check = validateConfig(config)
  if (!check.ok) {
    const err = new Error(`配置不合法：${check.problems.join('；')}`)
    err.code = 'BAD_CONFIG'
    throw err
  }
  const cfg = check.config
  const started = Date.now()
  const series = loadSeries(cfg.subset)
  const values = series.values
  const split = ETTM2_SPLIT
  const testStart = OFFICIAL_RANGE.test[0]
  const testEnd = Math.min(values.length, OFFICIAL_RANGE.evalEnd) // 不越过官方基准范围
  const horizon = cfg.horizon
  const lags = CONDITION_SPACE.lags

  // 起点：落在指定数据段内，且 origin + horizon 不超过该段末尾
  const segment = cfg.segment === 'independent' ? 'independent' : 'explore'
  const seg = SEGMENTS[segment]
  const origins = []
  const stride = CONDITION_SPACE.stride
  for (let o = seg.from + lags; o + horizon <= seg.to; o += stride) origins.push(o)
  const maxOrigins = CONDITION_SPACE.maxOriginsPerRun
  const picked = origins.length <= maxOrigins ? origins : sampleEvenly(origins, maxOrigins)

  const model = fitRidge(values, {
    trainEnd: split.train,
    lags,
    alpha: CONDITION_SPACE.alpha,
    horizon,
    stride: 4,
  })

  const seasonalErrors = []
  const ridgeErrors = []
  const truth = []
  const seasonalPred = []
  const ridgePred = []
  let perturbedPoints = 0

  for (const o of picked) {
    const rawInput = values.slice(o - lags, o) // 只用 origin 之前的真实历史
    const { input, changed } = perturbInput(rawInput, cfg)
    perturbedPoints += changed
    const yTrue = values.slice(o, o + horizon)
    const sn = seasonalNaiveForecast(input, horizon, series.season)
    const rg = ridgeForecast(input, horizon, model)
    truth.push(...yTrue)
    seasonalPred.push(...sn)
    ridgePred.push(...rg)
  }

  const seasonalMetrics = computeMetrics(truth, seasonalPred)
  const ridgeMetrics = computeMetrics(truth, ridgePred)
  seasonalErrors.push(...[])
  ridgeErrors.push(...[])

  const ds = Math.max(1, Math.ceil(truth.length / 240))
  const chart = {
    stride: ds,
    truth: downsample(truth, 240),
    seasonal: downsample(seasonalPred, 240),
    ridge: downsample(ridgePred, 240),
  }

  const deltaMae = seasonalMetrics.mae - ridgeMetrics.mae
  const best = Math.min(seasonalMetrics.mae, ridgeMetrics.mae)
  const relGap = best > 0 ? Math.abs(deltaMae) / best : null
  const leader = Math.abs(deltaMae) < 1e-9 ? 'tie' : deltaMae > 0 ? 'ridge' : 'seasonal_naive'

  const record = {
    id: meta.id || `lab-${started}-${Math.floor(Math.random() * 1e4)}`,
    createdAt: new Date(started).toISOString(),
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    status: 'done',
    origin: meta.origin || 'manual',
    claim: meta.claim || null,
    replicatedOf: meta.replicatedOf || null,
    attempts: meta.attempts || 1,
    dataSource: series.source,
    split: {
      trainSize: split.train,
      valSize: split.val,
      testSize: testEnd - testStart,
      testRange: [testStart, testEnd],
    },
    config: cfg,
    segment,
    segmentLabel: SEGMENT_LABEL[segment],
    dataSplitId: DATA_SPLIT_ID,
    benchmark: {
      scope: 'official',
      officialRange: OFFICIAL_RANGE,
      note: '探索段与一致性检查段都在官方测试区间（45744–57600，评估起点 46080）之内，属于官方的子切片；本轮**没有**使用超出官方基准的 12,080 个点。',
    },
    seed: cfg.seed,
    perturbationPoints: perturbedPoints,
    evaluation: {
      nSamples: truth.length,
      origins: picked.length,
      originRange: [picked[0], picked[picked.length - 1]],
      horizon,
      target: `${cfg.column}@${cfg.subset}`,
    },
    methods: {
      seasonal_naive: { label: '季节性朴素预测', metrics: seasonalMetrics, predictionsHash: hashNumbers(seasonalPred.slice(0, 400)) },
      ridge: { label: '岭回归自回归', metrics: ridgeMetrics, predictionsHash: hashNumbers(ridgePred.slice(0, 400)) },
    },
    comparison: { deltaMae, leader, relGap, closeGap: relGap !== null && relGap < CLOSE_GAP_THRESHOLD },
    chart,
    // 仅供测试/审计：完整预测序列（可据此独立复算指标）
    raw: meta.includeFull ? { truth, seasonal: seasonalPred, ridge: ridgePred } : undefined,
    checks: {
      sameEvaluationSamples: seasonalMetrics.n === ridgeMetrics.n,
      targetUntouchedByPerturbation: true,
      fitOnTrainOnly: true,
      chronologicalSplit: true,
      seedsRecorded: true,
    },
    provenance: {
      methodScope: METHOD_SCOPE,
      labVersion: LAB_VERSION,
      note: '两条曲线是教学方法，不是 Autoformer / FEDformer / PatchTST 的复现，不能据此判断论文方法优劣。',
    },
  }
  return record
}

function sampleEvenly(list, count) {
  const out = []
  const step = (list.length - 1) / (count - 1)
  for (let i = 0; i < count; i += 1) out.push(list[Math.round(i * step)])
  return [...new Set(out)]
}

/* ------------------------------------------------------------------ */
/* 实验记录存储（服务端文件，刷新/重启后可恢复）                          */
/* ------------------------------------------------------------------ */
const STORE_DIR = process.env.LAB_STORE_DIR
  ? join(ROOT, process.env.LAB_STORE_DIR)
  : join(ROOT, 'lab')
const STORE_FILE = join(STORE_DIR, 'runs.json')
const RUNNING_TIMEOUT_MS = 5 * 60 * 1000
export const cancelled = new Set()

function readStore() {
  try {
    if (!existsSync(STORE_FILE)) return { runs: [] }
    const raw = readFileSync(STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { runs: Array.isArray(parsed.runs) ? parsed.runs : [] }
  } catch {
    return { runs: [] }
  }
}

function writeStore(data) {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    const tmp = `${STORE_FILE}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 0), 'utf8')
    renameSync(tmp, STORE_FILE)
  } catch {
    // 落盘失败不影响本次结果返回
  }
}

/** 读取全部记录；把「过期的 running」标成 interrupted（服务重启导致的中断） */
export function listRuns() {
  const data = readStore()
  const now = Date.now()
  let dirty = false
  for (const r of data.runs) {
    if (r.status === 'running' && now - new Date(r.startedAt).getTime() > RUNNING_TIMEOUT_MS) {
      r.status = 'interrupted'
      r.interruptedReason = '运行过程中服务被重启或长时间没有心跳，任务已中断；可以重试同一组条件。'
      r.finishedAt = new Date().toISOString()
      dirty = true
    }
  }
  if (dirty) writeStore(data)
  return data.runs
}

export function saveRun(record) {
  const data = readStore()
  const idx = data.runs.findIndex((r) => r.id === record.id)
  if (idx >= 0) data.runs[idx] = record
  else data.runs.push(record)
  writeStore(data)
  return record
}

export function patchRun(id, patch) {
  const data = readStore()
  const idx = data.runs.findIndex((r) => r.id === id)
  if (idx < 0) return null
  data.runs[idx] = { ...data.runs[idx], ...patch }
  writeStore(data)
  return data.runs[idx]
}

export function clearRuns() {
  writeStore({ runs: [] })
  return []
}

/* ------------------------------------------------------------------ */
/* 运行入口（手动 / 探索都走这里，统一记账、可取消、失败留痕）             */
/* ------------------------------------------------------------------ */
export async function executeRun(rawConfig, meta = {}) {
  const check = validateConfig(rawConfig)
  if (!check.ok) {
      const failed = {
        id: meta.id || `lab-fail-${Date.now()}`,
        status: 'failed',
        origin: meta.origin || 'manual',
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        claim: meta.claim || null,
        error: check.problems.join('；'),
        config: rawConfig,
        dataSplitId: DATA_SPLIT_ID,
        provenance: { methodScope: METHOD_SCOPE, labVersion: LAB_VERSION },
        dataSource: loadSeries('ETTm2').source,
      }
    saveRun(failed)
    return failed
  }
  const id = meta.id || `lab-${Date.now()}-${Math.floor(Math.random() * 1e4)}`
  const queued = {
    id,
    status: 'running',
    origin: meta.origin || 'manual',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    claim: meta.claim || null,
    replicatedOf: meta.replicatedOf || null,
    config: check.config,
    dataSplitId: DATA_SPLIT_ID,
    provenance: { methodScope: METHOD_SCOPE, labVersion: LAB_VERSION },
    dataSource: loadSeries('ETTm2').source,
  }
  saveRun(queued)
  if (cancelled.has(id)) {
    cancelled.delete(id)
    return patchRun(id, { status: 'cancelled', finishedAt: new Date().toISOString(), note: '用户在开始前取消了这次实验。' })
  }
  try {
    const record = runExperiment(check.config, { ...meta, id })
    saveRun(record)
    return record
  } catch (e) {
    return patchRun(id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: e instanceof Error ? e.message : '实验执行失败',
    })
  }
}

/* ------------------------------------------------------------------ */
/* 地图：只用真实记录，绝不插值                                        */
/* ------------------------------------------------------------------ */
export function buildMap(runs, perturbationType, family = 'teaching') {
  const space = CONDITION_SPACE
  const cells = []
  // 证据地图按「方法家族」隔离：教学实验与官方论文方法实验**不混在同一张地图里**
  // 同时按数据划分 id 隔离：划分改变后旧结果进入历史记录，不再参与地图推导
  const scoped = runs.filter((r) => (r.family ?? 'teaching') === family && (r.dataSplitId ?? DATA_SPLIT_ID) === DATA_SPLIT_ID)
  const legacy = runs.filter((r) => (r.family ?? 'teaching') === family && (r.dataSplitId ?? '') !== DATA_SPLIT_ID)
  for (const h of space.horizon) {
    for (const s of space.strength) {
      const key = `${h}|${perturbationType}|${s}`
      const list = scoped
        .filter((r) => r.config && cellKey(r.config) === key && r.dataSource?.kind === scoped[0]?.dataSource?.kind)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      const doneRuns = list.filter((r) => r.status === 'done')
      const last = list[list.length - 1]
      const seeds = new Set(doneRuns.map((r) => r.config?.seed))
      const hasIndependent = doneRuns.some((r) => (r.segment ?? 'explore') === 'independent')
      // 证据等级：由程序按"实际跑过什么"判定，不依赖任何模型说法
      const evidenceLevel = hasIndependent
        ? 'independent-replicated'
        : seeds.size > 1
          ? 'seed-replicated'
          : doneRuns.length > 0
            ? 'exploration-only'
            : 'failed'
      cells.push({
        horizon: h,
        strength: s,
        key,
        status: !last
          ? 'untested'
          : last.status === 'running'
            ? 'running'
            : last.status === 'failed'
              ? 'failed'
              : last.status === 'cancelled'
                ? 'cancelled'
                : last.status === 'interrupted'
                  ? 'interrupted'
                  : 'done',
        evidenceLevel: !last ? 'untested' : evidenceLevel,
        independentRunId: doneRuns.find((r) => (r.segment ?? 'explore') === 'independent')?.id ?? null,
        runId: last?.id ?? null,
        runCount: list.length,
        doneCount: doneRuns.length,
        replicated: hasIndependent || seeds.size > 1,
        error: last?.status === 'failed' ? last.error : last?.status === 'interrupted' ? last.interruptedReason : null,
        comparison: last?.status === 'done' ? last.comparison : null,
        metrics: last?.status === 'done'
          ? {
              seasonal: last.methods?.seasonal_naive?.metrics ?? null,
              ridge: last.methods?.ridge?.metrics ?? null,
            }
          : null,
        nSamples: last?.evaluation?.nSamples ?? null,
        segment: last?.segment ?? null,
      })
    }
  }
  return {
    axes: { x: 'horizon', y: 'strength', perturbationType },
    cells,
    closeGapThreshold: CLOSE_GAP_THRESHOLD,
    family,
    dataSplitId: DATA_SPLIT_ID,
    legacyCount: legacy.length,
    legacyRuns: legacy.slice(-40).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      status: r.status,
      family: r.family ?? 'teaching',
      dataSplitId: r.dataSplitId ?? '(旧划分：含超出官方基准的数据)',
      config: r.config ?? null,
      deltaMae: r.comparison?.deltaMae ?? null,
      leader: r.comparison?.leader ?? null,
    })),
    note: '未测试的格子保持未测试；失败格子显示原因，不会填成 0 误差。划分 id 不同的历史结果只出现在历史记录里，不参与地图推导。',
  }
}

export function summarizeRuns(runs) {
  const done = runs.filter((r) => r.status === 'done')
  const failed = runs.filter((r) => r.status === 'failed')
  const observed = []
  const byHorizon = new Map()
  for (const r of done) {
    if (r.perturbationPoints === 0) {
      const arr = byHorizon.get(r.config.horizon) || []
      arr.push(r)
      byHorizon.set(r.config.horizon, arr)
    }
  }
  const trend = [...byHorizon.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([h, list]) => {
      const r = list[list.length - 1]
      return { horizon: h, deltaMae: r.comparison.deltaMae, leader: r.comparison.leader, nSamples: r.evaluation.nSamples }
    })
  if (trend.length >= 2) {
    const first = trend[0]
    const last = trend[trend.length - 1]
    observed.push(
      `在无扰动条件下，跨度从 ${first.horizon} 增加到 ${last.horizon} 时，MAE 差距从 ${first.deltaMae.toFixed(4)} 变为 ${last.deltaMae.toFixed(4)}（正数表示岭回归误差更大）。`,
    )
    const flip = trend.find((t) => t.leader !== trend[0].leader)
    observed.push(
      flip
        ? `领先方在跨度 ${flip.horizon} 处发生变化（${trend[0].leader} → ${flip.leader}），这一点值得复验。`
        : '在本次已测试的跨度范围内，未观察到领先方变化。',
    )
  }
  return {
    total: runs.length,
    done: done.length,
    failed: failed.length,
    observed,
    trend,
    note: '以上只是对已执行记录的机械汇总，不代表统计显著性。',
  }
}

/* ------------------------------------------------------------------ */
/* 规则探索（模型不可用时的明确标注后备）                                */
/* ------------------------------------------------------------------ */
export function pickNextByRule(runs, perturbationType, budgetLeft, { reserveForReplication }) {
  const tested = new Set(runs.filter((r) => r.status === 'done' || r.status === 'failed').map((r) => cellKey(r.config)).filter(Boolean))
  const space = CONDITION_SPACE
  const ordered = []
  for (const s of space.strength) for (const h of space.horizon) ordered.push({ horizon: h, perturbationType, strength: s })

  if (reserveForReplication && budgetLeft <= 1) {
    const done = runs.filter((r) => r.status === 'done' && r.comparison)
    const interesting = done
      .slice()
      .sort((a, b) => Math.abs(b.comparison.deltaMae) - Math.abs(a.comparison.deltaMae))[0]
    if (interesting) {
      const seeds = space.seed.filter((s) => s !== interesting.config.seed)
      return {
        kind: 'replicate',
        config: { ...interesting.config, seed: seeds[0] ?? interesting.config.seed },
        replicatedOf: interesting.id,
        reason: `已用 ${done.length} 组条件；最后一步留给复验：对跨度 ${interesting.config.horizon}／扰动 ${interesting.config.strength} 的这次结果换个种子重跑，确认不是随机扰动造成的偶然差异。`,
      }
    }
  }
  // 优先找「相邻条件」：从已测点向上下左右扩一格
  const done = runs.filter((r) => r.status === 'done').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const last = done[0]
  if (last) {
    const hs = space.horizon
    const i = hs.indexOf(last.config.horizon)
    const nbr = [hs[i + 1], hs[i - 1]].filter(Boolean).map((h) => ({ horizon: h, perturbationType, strength: last.config.strength }))
    const cand = nbr.find((c) => !tested.has(cellKey(c)))
    if (cand) {
      const smaller = last.comparison.deltaMae < 0
      return {
        kind: 'probe',
        config: { ...cand, seed: last.config.seed },
        reason: smaller
          ? `上一轮跨度 ${last.config.horizon} 时差距缩小到 ${Math.abs(last.comparison.deltaMae).toFixed(4)}，因此本轮检查相邻跨度 ${cand.horizon}。`
          : `上一轮跨度 ${last.config.horizon} 时差距为 ${Math.abs(last.comparison.deltaMae).toFixed(4)}，本轮检查相邻跨度 ${cand.horizon} 看趋势是否单调。`,
      }
    }
  }
  const next = ordered.find((c) => !tested.has(cellKey(c)))
  if (!next) return null
  return { kind: 'fill', config: { ...next, seed: space.seed[0] }, reason: '已测条件的邻近格子都跑过了，本轮补一个尚未测试的强度。' }
}

/* ------------------------------------------------------------------ */
/* 预算化探索：模型提条件 → 程序校验 → 受控执行 → 依据真实结果继续        */
/* ------------------------------------------------------------------ */
export const activeExplorations = new Map()

export function cancelExploration(explorationId) {
  const e = activeExplorations.get(explorationId)
  if (!e) return false
  e.cancelled = true
  return true
}

export async function exploreBudget({ claim, budget, perturbationType = 'noise', explorationId }) {
  const space = CONDITION_SPACE
  const total = Math.max(1, Math.min(Number(budget) || 3, 8))
  const id = explorationId || `explore-${Date.now()}`
  const state = { cancelled: false }
  activeExplorations.set(id, state)

  const trace = []
  let used = 0
  let plannerMode = null
  let stoppedReason = null
  let stopCode = null
  let consecutiveFailures = 0
  const runsSnapshot = () => listRuns()
  /** 探索只能看到探索段的结果：独立复验段对探索过程不可见 */
  const visibleRuns = () =>
    runsSnapshot().filter((r) => (r.segment ?? 'explore') === 'explore')

  const push = (entry) => {
    trace.push(entry)
    used += 1
  }

  try {
    // 第 1 次：基准实验（无扰动 + 第一档跨度），保证探索起点可比较
    const baselineConfig = {
      horizon: space.horizon[0],
      perturbationType,
      strength: 0,
      seed: space.seed[0],
      segment: 'explore',
    }
    const base = await executeRun(baselineConfig, { origin: 'explore', claim, id: `${id}-0` })
    if (base.status !== 'done') consecutiveFailures += 1
    push({
      step: 1,
      kind: 'baseline',
      planner: 'program',
      config: base.config,
      runId: base.id,
      status: base.status,
      reason: '先跑一组基准条件（无扰动、最小跨度），作为后续对比的参照。',
      comparison: base.comparison ?? null,
      nSamples: base.evaluation?.nSamples ?? null,
      segment: 'explore',
      observation: '还没有任何可比的结果，先建立参照点。',
      choice: `跨度 ${space.horizon[0]}、无扰动、种子 ${space.seed[0]}`,
      result: base.status === 'done'
        ? `两种方法的绝对 MAE 差距 ${Math.abs(base.comparison.deltaMae).toFixed(4)}，样本 ${base.evaluation?.nSamples}`
        : `执行失败：${base.error ?? '未知原因'}`,
      judgmentChange: base.status === 'done'
        ? `建立基准：${base.comparison.leader === 'ridge' ? '岭回归' : base.comparison.leader === 'seasonal_naive' ? '季节朴素' : '两者'}在该条件下误差更低。`
        : '基准没有跑成，后续判断暂不可用。',
    })

    while (used < total) {
      if (state.cancelled) {
        stoppedReason = '用户取消了这次探索'
        stopCode = 'cancelled'
        break
      }
      if (consecutiveFailures >= 2) {
        stoppedReason = '连续 2 次实验失败（配置被拒绝或执行出错），已停止探索以避免继续浪费预算。'
        stopCode = 'consecutive-failures'
        break
      }
      const runs = visibleRuns()
      const history = runs
        .filter((r) => r.status === 'done' && cellKey(r.config))
        .map((r) => ({
          horizon: r.config.horizon,
          perturbationType: r.config.perturbationType,
          strength: r.config.strength,
          seed: r.config.seed,
          mae: r.methods?.seasonal_naive?.metrics?.mae,
          ridgeMae: r.methods?.ridge?.metrics?.mae,
          deltaMae: r.comparison?.deltaMae,
          nSamples: r.evaluation?.nSamples,
        }))

      let plan = null
      let planner = 'rule'
      let plannerNote = null

      // 预算充足时留一次给复验
      const reserveForReplication = total >= 3
      const remaining = total - used
      const needReplicate = reserveForReplication && remaining === 1

      if (needReplicate) {
        plan = pickNextByRule(runs, perturbationType, remaining, { reserveForReplication: true })
        planner = 'program-replication'
      } else {
        const modelPlan = await planLabExperiment({ claim, history, options: space, budgetLeft: remaining })
        if (modelPlan.ok && modelPlan.stop) {
          stoppedReason = `模型判断继续试探已无必要：${modelPlan.reason}`
          plannerMode = plannerMode ?? 'model'
          break
        }
        if (modelPlan.ok && modelPlan.proposal) {
          const check = validateConfig({ ...modelPlan.proposal, perturbationType: modelPlan.proposal.perturbationType })
          const dup = runs.some(
            (r) => r.config && cellKey(r.config) === cellKey(check.config ?? {}) && r.config.seed === (check.config ?? {}).seed,
          )
          if (check.ok && !dup) {
            plan = { kind: 'model', config: check.config, reason: modelPlan.proposal.reason }
            planner = 'model'
          } else {
            plannerNote = check.ok ? '模型给的条件与已跑过的完全重复，改用规则选择。' : `模型给的条件不合法（${check.problems.join('；')}），改用规则选择。`
          }
        } else {
          plannerNote = `模型不可用或未给出可用建议（${modelPlan.reason || modelPlan.code || '未知原因'}），本轮改为规则探索。`
        }
        if (!plan) plan = pickNextByRule(runs, perturbationType, remaining, { reserveForReplication: false })
      }

      if (!plan) {
        stoppedReason = '没有合理的下一组条件可测（条件空间已覆盖）。'
        stopCode = 'no-conditions'
        break
      }
      if (state.cancelled) {
        stoppedReason = '用户取消了这次探索'
        stopCode = 'cancelled'
        break
      }

      const record = await executeRun(
        { ...plan.config, segment: 'explore' },
        {
          origin: plan.replicatedOf ? 'replication' : 'explore',
          claim,
          replicatedOf: plan.replicatedOf ?? null,
          id: `${id}-${used}`,
        },
      )
      if (record.status !== 'done') consecutiveFailures += 1
      else consecutiveFailures = 0
      plannerMode = plannerMode ?? null
      const prevRun = trace.length >= 2 ? history[history.length - 1] : null
      push({
        step: used + 1,
        kind: plan.kind,
        planner,
        plannerNote,
        config: record.config ?? plan.config,
        runId: record.id,
        status: record.status,
        reason: plan.reason,
        comparison: record.comparison ?? null,
        nSamples: record.evaluation?.nSamples ?? null,
        replicatedOf: plan.replicatedOf ?? null,
        error: record.error ?? null,
        segment: 'explore',
        observation: prevRun
          ? `上一轮：跨度 ${prevRun.horizon}、差距 ${Math.abs(prevRun.deltaMae).toFixed(4)}`
          : '只有基准结果可用。',
        choice: `跨度 ${record.config?.horizon}、${record.config?.perturbationType === 'missing' ? '输入缺失' : '输入噪声'} ${record.config?.strength}、种子 ${record.config?.seed}`,
        result: record.status === 'done'
          ? `绝对 MAE 差距 ${Math.abs(record.comparison.deltaMae).toFixed(4)}，样本 ${record.evaluation?.nSamples}，领先方 ${
              record.comparison.leader === 'ridge' ? '岭回归' : record.comparison.leader === 'seasonal_naive' ? '季节朴素' : '持平'
            }`
          : `执行失败：${record.error ?? '未知原因'}`,
        judgmentChange: (() => {
          if (record.status !== 'done') return '这次失败没有改变判断，只是消耗了一次预算。'
          const doneRuns = visibleRuns().filter((r) => r.status === 'done' && r.comparison)
          const gaps = [...new Set(doneRuns.map((r) => Math.abs(r.comparison.deltaMae)))]
          const leaders = new Set(doneRuns.map((r) => r.comparison.leader))
          if (leaders.size > 1) return '已观察到领先方发生变化，这一点需要在独立时间段复验。'
          return `目前 ${doneRuns.length} 组条件下领先方一致；差距范围 ${Math.min(...gaps).toFixed(4)}–${Math.max(...gaps).toFixed(4)}，还需要更多跨度才能判断趋势。`
        })(),
      })
    }

    if (!stoppedReason && used >= total) {
      stoppedReason = `已达到本次预算（${total} 次）。`
      stopCode = 'budget'
    }
    if (trace.some((t) => t.replicatedOf)) {
      stopCode = stopCode ?? 'replicated'
    }
  } finally {
    activeExplorations.delete(id)
  }

  const runs = runsSnapshot()
  return {
    explorationId: id,
    budget: total,
    used,
    remaining: Math.max(0, total - used),
    stoppedReason,
    stopCode,
    // 只用模型提出条件且实际采纳过，才算「模型探索」
    mode: plannerMode === 'model' || trace.some((t) => t.planner === 'model') ? 'model' : 'rule',
    trace,
    findings: buildFindings(runs),
    summary: summarizeRuns(runs),
    map: buildMap(runs, perturbationType),
    visibleSegment: 'explore',
    hiddenSegment: 'independent',
    note: '探索过程只读取探索段（测试段前一半）的结果；独立复验段（测试段后一半）在探索期间不可见。',
  }
}

/* ------------------------------------------------------------------ */
/* 结论转译器：论文结论 → 可执行代理实验 → 适用边界                      */
/* 等级由程序按匹配项判定，模型不能自己抬高                            */
/* ------------------------------------------------------------------ */
export const LEVELS = {
  full: '原论文复现',
  partial: '局部复现',
  proxy: '代理验证',
  demo: '教学演示',
}

/** 复现模式需要哪些材料（当前没有，所以不开放假运行） */
export const REPRO_REQUIREMENTS = [
  '论文方法的官方实现（Autoformer / FEDformer / PatchTST 任一的仓库快照）',
  '与实现匹配的模型权重文件',
  '原论文的完整配置（层数、宽度、学习率、批大小、训练轮数、随机种子策略）',
  '原论文使用的数据切分脚本（保证与本文的 train/val/test 完全一致）',
  '可运行的运行环境（当前机器无 GPU，需要 CPU 可跑的等价设置或云端算力）',
]

function norm(s) {
  return String(s ?? '').toLowerCase()
}

/**
 * 生成「结论转译卡」：三段内容 + 可验证范围矩阵 + 严格结论 + 等级。
 * papersNew: 客户端从抽取字段整理出的论文侧事实（不做解释，只做结构化搬运）。
 */
export function buildTranslation({ papers = [], claim = null, config = null, dataSource = null, runs = [] }) {
  const cfg = config || { horizon: 96, perturbationType: 'noise', strength: 0.1, seed: 11 }
  const paperMethods = papers.map((p) => p.method).filter(Boolean)
  const paperDatasets = [...new Set(papers.flatMap((p) => p.datasets ?? []))]
  const paperMetrics = [...new Set(papers.flatMap((p) => p.metrics ?? []))]
  const paperHorizons = [...new Set(papers.flatMap((p) => p.horizons ?? []))]

  const dataName = dataSource?.name ?? 'ETTm2（ETT small）'
  const dataIsReal = (dataSource?.kind ?? 'real') === 'real'
  const datasetMatches = paperDatasets.some((d) => norm(d).includes('ettm2') || norm(d).includes('ett'))
  const metricMatches = paperMetrics.some((m) => /mae|mse|rmse/i.test(m))
  const horizonKnown = paperHorizons.length > 0
  const horizonMatches = horizonKnown && paperHorizons.includes(cfg.horizon)
  const splitKnown = papers.some((p) => p.split || p.splitRange)

  // 可执行的论文方法实现：当前一律为否（没有仓库快照与权重）
  const runnableImpl = papers.some((p) => p.hasRunnableImpl === true)

  // 等级：程序判定
  let levelKey = 'demo'
  if (runnableImpl && datasetMatches && metricMatches && splitKnown) levelKey = 'full'
  else if (runnableImpl && datasetMatches && metricMatches) levelKey = 'partial'
  else if (datasetMatches && metricMatches) levelKey = 'proxy'
  else levelKey = 'demo'

  const matrix = [
    {
      dimension: '方法',
      paper: paperMethods.length ? paperMethods.join(' / ') : '（未读到方法名）',
      current: '季节性朴素预测 / 岭回归',
      match: '不匹配',
      note: '运行的不是论文方法，因此任何结果都不能用来给这些方法排名',
    },
    {
      dimension: '数据',
      paper: paperDatasets.length ? paperDatasets.join(' / ') : '（未读到数据集）',
      current: `${dataName}${dataIsReal ? '（真实公开数据）' : '（合成数据）'} · OT 单变量`,
      match: datasetMatches && dataIsReal ? '匹配' : dataIsReal ? '部分匹配' : '不匹配',
      note: datasetMatches ? '数据集同名，但只用了单变量子集，不是论文的完整多变量设置' : '数据集与论文不同，结论不可迁移',
    },
    {
      dimension: '指标',
      paper: paperMetrics.length ? paperMetrics.join(' / ') : '（未读到指标）',
      current: 'MAE / RMSE（代码计算）',
      match: metricMatches ? '匹配' : '不匹配',
      note: metricMatches ? '指标口径一致（MAE 为主）' : '指标口径不一致，数字不可直接对照',
    },
    {
      dimension: '预测跨度',
      paper: horizonKnown ? paperHorizons.join(' / ') : '（未读到）',
      current: `${cfg.horizon}`,
      match: !horizonKnown ? '无法判断' : horizonMatches ? '匹配' : '不匹配',
      note: !horizonKnown ? '论文侧没有读到跨度信息' : horizonMatches ? '与论文报告的某个跨度一致' : '当前跨度不在论文报告的跨度里（属于条件外压力测试）',
    },
    {
      dimension: '数据划分',
      paper: papers.map((p) => p.split || p.splitRange).filter(Boolean).join(' / ') || '（未读到划分）',
      current: `按时间顺序；训练 0–34560，测试段再切探索段/独立复验段`,
      match: splitKnown ? '根据证据判断' : '无法判断',
      note: splitKnown
        ? '划分方式不一定与论文脚本完全一致，只对齐了顺序与大致比例'
        : '论文侧没有读到划分信息，无法核对',
    },
    {
      dimension: '输入扰动',
      paper: '未报告',
      current: cfg.perturbationType === 'noise' ? `输入噪声强度 ${cfg.strength}` : `输入缺失比例 ${cfg.strength}`,
      match: '条件外压力测试',
      note: '论文没有报告这一条件，因此它只能说明"条件变化时规律是否稳定"，不能用于评价论文',
    },
  ]

  const checkable = []
  if (datasetMatches) checkable.push('同一数据集上的方法间差距是否随条件变化')
  if (metricMatches) checkable.push('MAE 口径下两种教学方法的相对表现')
  checkable.push('预测跨度变化时差距是否稳定；输入缺失/噪声下两种方法是否同等退化')

  const notVerifiable = [
    `原论文方法的表现（本实验运行的不是 ${paperMethods.length ? paperMethods.join('、') : '论文方法'}）`,
    '论文结论是否正确（本实验不是原论文实验的复现）',
    paperMethods.length ? `给 ${paperMethods.join('、')} 排名` : '给论文方法排名',
  ]

  const verboten = paperMethods.length ? paperMethods.join('、') : '论文方法'
  const verdict = paperDatasets.length
    ? `本实验可以检查「${checkable[0]}」，但由于运行的季节朴素与岭回归并不是 ${verboten}，不能据此判断这些论文方法谁更好；输入扰动属于论文未报告的条件外压力测试。`
    : `本实验可以检查「条件变化时两种教学方法的差距是否稳定」，但它既不是原论文实验的复现，也不涉及论文方法本身，不能用来评价任何论文结论。`

  return {
    level: LEVELS[levelKey],
    levelKey,
    levelReason:
      levelKey === 'proxy'
        ? '数据集与指标口径与论文一致，但方法不同 → 只能作为代理验证'
        : levelKey === 'demo'
          ? '数据集或指标口径与论文不一致 → 只能作为教学演示'
          : levelKey === 'partial'
            ? '只对应论文的一部分实验条件'
            : '方法、数据与关键设置均对应',
    claim,
    paperConclusion: {
      text: claim?.text ?? '（未指定：默认检查"方法间差距是否随条件变化"）',
      source: claim?.source ?? 'user',
      evidence: papers.flatMap((p) =>
        (p.evidence ?? []).map((e) => ({ paper: p.shortLabel, page: e.page, quote: e.quote })),
      ).slice(0, 6),
      structured: papers.map((p) => ({
        paper: p.shortLabel,
        method: p.method ?? '（未读到）',
        datasets: p.datasets ?? [],
        metrics: p.metrics ?? [],
        horizons: p.horizons ?? [],
        result: p.result ?? '（未读到原文报告的结果）',
        split: p.split ?? null,
        splitRange: p.splitRange ?? null,
      })),
      note: '「原文说法 + 页码 + 逐字引用」来自抽取字段的证据；结构化整理（数据集/指标/跨度）是系统对字段的归类，不是原文原句。',
    },
    paperExperiment: {
      method: paperMethods.join(' / ') || '（未读到）',
      datasets: paperDatasets,
      conditions: papers.map((p) => `${p.shortLabel}：${p.conditions ?? '（未读到条件）'}`),
      reported: papers.map((p) => `${p.shortLabel}：${p.result ?? '（未读到原文报告的结果）'}`),
      assets: {
        hasRunnableImpl: runnableImpl,
        codeAvailability: papers.map((p) => `${p.shortLabel}：${p.codeAvailability ?? '（未读到代码可得性字段）'}`),
        missing: runnableImpl ? [] : REPRO_REQUIREMENTS,
      },
    },
    currentExperiment: {
      methods: ['季节性朴素预测（seasonal_naive）', '岭回归自回归（ridge）'],
      methodScope: METHOD_SCOPE,
      data: `${dataName} · ${dataSource?.column ?? 'OT'}${dataIsReal ? '（真实公开数据）' : '（合成数据）'}`,
      conditions: `预测跨度 ${cfg.horizon}｜扰动 ${cfg.perturbationType === 'noise' ? '输入噪声' : '输入缺失'} ${cfg.strength}｜种子 ${cfg.seed}｜数据段 ${
        cfg.segment === 'independent' ? SEGMENT_LABEL.independent : SEGMENT_LABEL.explore
      }`,
      sameAsPaper: [
        datasetMatches ? '数据集（同名公开数据）' : null,
        metricMatches ? '指标口径（MAE/RMSE）' : null,
        horizonMatches ? '预测跨度取值' : null,
      ].filter(Boolean),
      differentFromPaper: [
        '使用的方法（教学用轻量方法，不是论文方法）',
        '只使用 OT 单变量，不是论文的完整变量设置',
        horizonKnown && !horizonMatches ? '预测跨度不在论文报告范围内' : null,
        '没有训练论文模型，也没有使用论文的权重与配置',
      ].filter(Boolean),
      canVerify: checkable,
      cannotVerify: notVerifiable,
    },
    matrix,
    verdict,
    disclaimer: '这不是论文方法复现，结果不能用于给 Autoformer、FEDformer 或 PatchTST 排名。',
    runsSeen: runs.length,
  }
}

/* ------------------------------------------------------------------ */
/* 发现卡 + 独立时间段复验                                              */
/* ------------------------------------------------------------------ */
export function buildFindings(runs) {
  const exploreDone = runs
    .filter((r) => r.status === 'done' && (r.segment ?? 'explore') === 'explore' && r.comparison)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  const out = []
  if (exploreDone.length < 2) return out

  const byStrength = new Map()
  for (const r of exploreDone) {
    const key = `${r.config.perturbationType}|${r.config.strength}`
    if (!byStrength.has(key)) byStrength.set(key, [])
    byStrength.get(key).push(r)
  }
  for (const [key, list] of byStrength.entries()) {
    const uniqHorizon = [...new Set(list.map((r) => r.config.horizon))].sort((a, b) => a - b)
    if (uniqHorizon.length < 2) continue
    const picks = uniqHorizon.map((h) => list.filter((r) => r.config.horizon === h).slice(-1)[0])
    const gaps = picks.map((r) => Math.abs(r.comparison.deltaMae))
    const decreasing = gaps.every((g, i) => i === 0 || g <= gaps[i - 1] + 1e-9)
    const increasing = gaps.every((g, i) => i === 0 || g >= gaps[i - 1] - 1e-9)
    const leaders = new Set(picks.map((r) => r.comparison.leader))
    const [type, strength] = key.split('|')
    const sameDirection = decreasing || increasing
    const trendWord = decreasing ? '缩小' : increasing ? '扩大' : '没有单调变化'
    const id = `finding-${key}`
    out.push({
      id,
      title: sameDirection
        ? `在本次代理实验中，跨度增加时两种教学方法的误差差距${trendWord}。`
        : '在本次代理实验中，跨度增加时两种教学方法的误差差距没有单调变化。',
      claim: '预测跨度变化时，方法之间的误差差距是否稳定',
      methods: ['seasonal_naive', 'ridge'],
      segment: 'explore',
      segmentLabel: SEGMENT_LABEL.explore,
      perturbationType: type,
      strength: Number(strength),
      conditions: picks.map((r) => ({ horizon: r.config.horizon, seed: r.config.seed, absDeltaMae: Math.abs(r.comparison.deltaMae), leader: r.comparison.leader, nSamples: r.evaluation?.nSamples })),
      exploreCount: picks.length,
      leaderStable: leaders.size === 1,
      leadChanged: leaders.size > 1,
      monotonic: sameDirection,
      trendDirection: decreasing ? 'decreasing' : increasing ? 'increasing' : 'none',
      replicated: false,
      minConclusion: sameDirection
        ? `在 ${type === 'noise' ? '输入噪声' : '输入缺失'} ${strength} 条件下，跨度 ${uniqHorizon[0]} → ${uniqHorizon[uniqHorizon.length - 1]} 时，两种教学方法的绝对 MAE 差距从 ${gaps[0].toFixed(4)} 变为 ${gaps[gaps.length - 1].toFixed(4)}；${leaders.size === 1 ? '领先方未变' : '领先方发生变化'}。`
        : `在已测跨度上，绝对 MAE 差距没有单调变化（${gaps.map((g) => g.toFixed(4)).join(' → ')}）。`,
      notExtrapolateTo: [
        '不能外推到论文方法（Autoformer / FEDformer / PatchTST）',
        '不能外推到其它数据集或其它变量（本实验只用 ETTm2 的 OT 单变量）',
        '不能外推到论文未报告的条件（输入扰动是条件外压力测试）',
        '不能当作统计显著性结论（这里只是固定条件下的误差差值）',
      ],
      needsIndependentReplication: sameDirection,
    })
  }
  return out
}

/** 在独立复验段重跑同一组条件，比较两段趋势方向 */
export async function replicateFinding({ finding, claim = null }) {
  if (!finding) return { ok: false, error: '没有可复验的发现' }
  const before = listRuns().length
  const base = validateConfig({
    horizon: finding.conditions[0]?.horizon ?? 24,
    perturbationType: finding.perturbationType,
    strength: finding.strength,
    seed: finding.conditions[0]?.seed ?? 11,
    segment: 'independent',
  })
  if (!base.ok) return { ok: false, error: base.problems.join('；') }

  const replay = []
  for (const c of finding.conditions) {
    const record = await executeRun(
      {
        horizon: c.horizon,
        perturbationType: finding.perturbationType,
        strength: finding.strength,
        seed: c.seed,
        segment: 'independent',
      },
      { origin: 'replication', claim, id: `${finding.id}-ind-${c.horizon}` },
    )
    replay.push(record)
  }
  const runs = listRuns()
  const independent = replay
    .filter((r) => r.status === 'done' && r.comparison)
    .map((r) => ({
      horizon: r.config.horizon,
      seed: r.config.seed,
      absDeltaMae: Math.abs(r.comparison.deltaMae),
      leader: r.comparison.leader,
      nSamples: r.evaluation?.nSamples,
      runId: r.id,
      status: r.status,
      error: r.error ?? null,
    }))
  const gaps = independent.map((r) => r.absDeltaMae)
  const decreasing = gaps.length >= 2 && gaps.every((g, i) => i === 0 || g <= gaps[i - 1] + 1e-9)
  const increasing = gaps.length >= 2 && gaps.every((g, i) => i === 0 || g >= gaps[i - 1] - 1e-9)
  const indDirection = decreasing ? 'decreasing' : increasing ? 'increasing' : 'none'
  const sameDirection = independent.length >= 2 && indDirection === finding.trendDirection
  const failed = replay.filter((r) => r.status !== 'done')

  return {
    ok: true,
    findingId: finding.id,
    exploreTrend: finding.conditions,
    independentTrend: independent,
    exploreDirection: finding.trendDirection,
    independentDirection: indDirection,
    sameDirection,
    ranCount: replay.length,
    failedCount: failed.length,
    newRuns: runs.length - before,
    conclusion:
      independent.length < 2
        ? '独立复验段的可用记录不足 2 个跨度，无法比较趋势方向 —— 不能说这次发现被复验，也不能说它被推翻。'
        : sameDirection
          ? `独立复验段（${SEGMENT_LABEL.independent}）的差距变化方向与探索段一致（都是${
              indDirection === 'decreasing' ? '随跨度增加而缩小' : indDirection === 'increasing' ? '随跨度增加而扩大' : '无单调变化'
            }），但这只是同一个数据集上的第二段时间，仍不足以判断该规律在其它数据或论文方法上是否成立。`
          : `独立复验段的方向与探索段**不一致**：探索段为「${
              finding.trendDirection === 'decreasing' ? '缩小' : finding.trendDirection === 'increasing' ? '扩大' : '无单调变化'
            }」，独立复验段为「${indDirection === 'decreasing' ? '缩小' : indDirection === 'increasing' ? '扩大' : '无单调变化'}」。如实记录：这次发现没有得到独立时间段的同向支持，不应作为结论使用。`,
    stillInsufficient: true,
    note: '独立复验只换数据时间段，方法、指标与扰动设置与探索段保持一致；不一致时如实展示，不挑选有利的一段。',
  }
}
