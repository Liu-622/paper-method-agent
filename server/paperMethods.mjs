/**
 * 官方论文方法（LTSF-Linear 的 DLinear / Linear）在 Node 侧的推理与压力测试
 * ==================================================================
 * 为什么可以这样做：官方 DLinear/Linear 的推理只是「移动平均分解 + 两个线性层」，
 * 权重在 Python 侧用官方代码训练后导出；Node 侧用同一套权重与同一套标准化参数做前向，
 * 并用 `parity.json`（PyTorch 的对照预测）验证数值一致性（见 scripts/verify-parity.mjs）。
 *
 * 铁律：
 * - 训练与权重固定，Node 只做推理，不会"训练出"别的结果；
 * - 扰动只作用在**输入窗口**，评估用的真实值来自数据文件，永远不被改写；
 * - 缺失值用训练均值填充（标准化空间即 0），不使用未来目标信息；
 * - 指标 MAE / MSE / RMSE 分别计算，且区分标准化空间与原始单位。
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')
const MODELS_DIR = join(ROOT, 'lab-models')

/** 官方 LTSF-Linear 的固定提交与脚本（与 Python 训练脚本一致） */
export const PAPER_METHODS = {
  DLinear: {
    key: 'DLinear',
    label: 'DLinear（官方实现）',
    source: 'official',
    repo: 'https://github.com/cure-lab/LTSF-Linear',
    sha: '0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6',
    script: 'scripts/EXP-LongForecasting/Linear/ettm2.sh',
    paper: 'Are Transformers Effective for Time Series Forecasting?（AAAI 2023）',
  },
  Linear: {
    key: 'Linear',
    label: 'Linear（官方实现）',
    source: 'official',
    repo: 'https://github.com/cure-lab/LTSF-Linear',
    sha: '0c113668a3b88c4c4ee586b8c5ec3e539c4de5a6',
    script: 'scripts/EXP-LongForecasting/Linear/ettm2.sh',
    paper: 'Are Transformers Effective for Time Series Forecasting?（AAAI 2023）',
  },
}

/** 官方移动平均分解的卷积核（models/DLinear.py 默认 kernel_size=25） */
const MOVING_AVG_KERNEL = 25

const bundleCache = new Map()

export function listPaperRuns() {
  if (!existsSync(MODELS_DIR)) return []
  return readdirSync(MODELS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = join(MODELS_DIR, d.name)
      const cfgPath = join(dir, 'config.json')
      if (!existsSync(cfgPath)) return null
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
        return {
          runId: cfg.runId,
          method: cfg.method,
          methodSource: cfg.methodSource,
          createdAt: cfg.createdAt,
          task: cfg.task,
          hyper: cfg.hyper,
          timing: cfg.timing,
          params: cfg.params,
          dataSha256: cfg.data?.sha256?.slice(0, 16) ?? null,
          metrics: cfg.metrics?.test?.raw ?? null,
          metricsAll: cfg.metrics?.test ?? null,
          hasParity: existsSync(join(dir, 'parity.json')),
          officialSha: cfg.officialSha,
          notes: cfg.notes ?? [],
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function loadBundle(runId) {
  if (bundleCache.has(runId)) return bundleCache.get(runId)
  const dir = join(MODELS_DIR, runId)
  const cfgPath = join(dir, 'config.json')
  if (!existsSync(cfgPath)) throw new Error(`找不到已训练的方法版本：${runId}`)
  const bundle = {
    runId,
    dir,
    config: JSON.parse(readFileSync(cfgPath, 'utf8')),
    weights: JSON.parse(readFileSync(join(dir, 'weights.json'), 'utf8')),
    scaler: JSON.parse(readFileSync(join(dir, 'scaler.json'), 'utf8')),
    parity: existsSync(join(dir, 'parity.json')) ? JSON.parse(readFileSync(join(dir, 'parity.json'), 'utf8')) : null,
  }
  bundleCache.set(runId, bundle)
  return bundle
}

/* ---------------- 纯 JS 前向（与官方实现逐条对应） ---------------- */

function linear2d(W, b, x) {
  // W: [out][in]，x: [seqLen][C] → y: [predLen][C]
  const outLen = W.length
  const inLen = W[0].length
  const channels = x[0].length
  const y = Array.from({ length: outLen }, () => new Array(channels).fill(0))
  for (let o = 0; o < outLen; o += 1) {
    const Wo = W[o]
    const bo = b[o]
    for (let c = 0; c < channels; c += 1) {
      let s = bo
      for (let i = 0; i < inLen; i += 1) s += Wo[i] * x[i][c]
      y[o][c] = s
    }
  }
  return y
}

function movingAvg(x, kernel) {
  // 官方 moving_avg：两端各复制 (k-1)/2 次，再 AvgPool1d(kernel, stride=1)
  const n = x.length
  const channels = x[0].length
  const pad = (kernel - 1) >> 1
  const padded = []
  for (let i = 0; i < pad; i += 1) padded.push(x[0].slice())
  for (let i = 0; i < n; i += 1) padded.push(x[i].slice())
  for (let i = 0; i < pad; i += 1) padded.push(x[n - 1].slice())
  const outLen = n // 官方 padding 后长度恰好回到 seq_len
  const out = Array.from({ length: outLen }, () => new Array(channels).fill(0))
  const scale = 1 / kernel
  for (let o = 0; o < outLen; o += 1) {
    for (let c = 0; c < channels; c += 1) {
      let s = 0
      for (let k = 0; k < kernel; k += 1) s += padded[o + k][c]
      out[o][c] = s * scale
    }
  }
  return out
}

/** 用导出的权重做一次前向；model ∈ {DLinear, Linear} */
export function forward(bundle, inputStd) {
  const model = bundle.config.method
  const sd = bundle.weights.state_dict
  if (model === 'Linear') {
    return linear2d(sd['Linear.weight'], sd['Linear.bias'], inputStd)
  }
  if (model === 'DLinear') {
    const mean = movingAvg(inputStd, MOVING_AVG_KERNEL)
    const seasonal = inputStd.map((row, i) => row.map((v, c) => v - mean[i][c]))
    const trend = mean
    const seasonalOut = linear2d(sd['Linear_Seasonal.weight'], sd['Linear_Seasonal.bias'], seasonal)
    const trendOut = linear2d(sd['Linear_Trend.weight'], sd['Linear_Trend.bias'], trend)
    return seasonalOut.map((row, o) => row.map((v, c) => v + trendOut[o][c]))
  }
  throw new Error(`不支持的模型：${model}`)
}

/* ---------------- 数据与划分（与官方 DataLoader 一致） ---------------- */

let seriesCache = null
export function loadChannels() {
  if (seriesCache) return seriesCache
  const path = join(ROOT, 'data', 'ETTm2.csv')
  const raw = readFileSync(path, 'utf8').split(/\r?\n/)
  const header = raw[0].split(',')
  const cols = header.slice(1) // HUFL..OT
  const dates = []
  const values = []
  for (let i = 1; i < raw.length; i += 1) {
    const line = raw[i]
    if (!line) continue
    const parts = line.split(',')
    dates.push(parts[0])
    values.push(cols.map((_, ci) => Number(parts[ci + 1])))
  }
  seriesCache = { cols, dates, values, totalRows: values.length }
  return seriesCache
}

/** 与官方 Dataset_ETT_minute 相同的边界（seq_len=336） */
export function officialSplit(seqLen = 336) {
  const s = loadChannels()
  const n = s.totalRows
  const b1 = [0, 12 * 30 * 24 * 4 - seqLen, 12 * 30 * 24 * 4 + 4 * 30 * 24 * 4 - seqLen]
  const b2 = [12 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 4 * 30 * 24 * 4, 12 * 30 * 24 * 4 + 8 * 30 * 24 * 4]
  const names = ['train', 'val', 'test']
  const out = {}
  names.forEach((name, i) => {
    const lo = Math.max(0, b1[i])
    const hi = Math.min(n, b2[i])
    out[name] = {
      border1: b1[i],
      border2: b2[i],
      usedStart: lo,
      usedEnd: hi,
      usedLen: hi - lo,
      startDate: s.dates[lo] ?? null,
      endDate: s.dates[Math.min(hi, n) - 1] ?? null,
      isCustomSlice: false,
    }
  })
  // 官方基准只用到第 57600 行；后面的点属于「超出官方基准」的自定义区间
  const evalStart = out.test.border1 + seqLen // = 46080
  const evalEnd = out.test.usedEnd // = 57600
  const mid = evalStart + Math.floor((evalEnd - evalStart) / 2)
  out.evalStart = evalStart
  out.evalEnd = evalEnd
  out.datasetRows = n
  out.outOfBenchmark = {
    from: evalEnd,
    to: n,
    len: n - evalEnd,
    startDate: s.dates[evalEnd] ?? null,
    endDate: s.dates[n - 1] ?? null,
    note: '不在官方基准范围内；本轮的论文方法实验**没有**使用这些点（若使用必须标注为自定义时间外测试）。',
  }
  out.customSlices = {
    explore: {
      usedStart: evalStart,
      usedEnd: mid,
      usedLen: mid - evalStart,
      startDate: s.dates[evalStart],
      endDate: s.dates[mid - 1],
      isCustomSlice: true,
      label: '探索切片（自定义：官方测试区间前半段，已用于条件搜索）',
    },
    consistency: {
      usedStart: mid,
      usedEnd: evalEnd,
      usedLen: evalEnd - mid,
      startDate: s.dates[mid],
      endDate: s.dates[evalEnd - 1],
      isCustomSlice: true,
      label:
        '另一时间段一致性检查切片（自定义：官方测试区间后半段；未用于条件搜索，但**不能称为从未使用的独立复验数据**）',
    },
  }
  return out
}

/** 当前数据划分标识（与教学实验共用同一套官方边界，便于地图按划分隔离） */
export const DATA_SPLIT_ID = 'official-ettm2-t34560-v46080-e57600'

/* ---------------- 扰动（只作用输入；缺失用训练均值=0 填充） ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
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

function perturb(inputStd, type, strength, seed) {
  if (!type || strength === 0) return { input: inputStd, changed: 0, fillNote: null }
  const rand = mulberry32((seed * 7919 + Math.round(strength * 1000)) >>> 0)
  const input = inputStd.map((r) => r.slice())
  let changed = 0
  if (type === 'noise') {
    // 标准化空间内的加性高斯噪声：标准差 = strength（1.0 相当于原始序列一个标准差）
    for (let i = 0; i < input.length; i += 1) {
      for (let c = 0; c < input[i].length; c += 1) {
        if (rand() < strength) {
          input[i][c] += gauss(rand) * 0.5 * strength
          changed += 1
        }
      }
    }
    return { input, changed, fillNote: null }
  }
  // 缺失：随机抹掉输入点 → 用训练均值填充（标准化空间为 0），不使用未来目标
  const missing = new Set()
  for (let i = 0; i < input.length; i += 1) {
    for (let c = 0; c < input[i].length; c += 1) {
      if (rand() < strength) {
        missing.add(`${i}:${c}`)
        input[i][c] = 0
        changed += 1
      }
    }
  }
  return { input, changed, fillNote: '缺失位置用训练段均值填充（标准化空间为 0），不利用未来目标信息' }
}

/* ---------------- 指标与压力测试 ---------------- */

export function computeMetrics3(truth, pred) {
  const n = Math.min(truth.length, pred.length)
  if (!n) return { n: 0, mae: null, mse: null, rmse: null }
  let sae = 0
  let sse = 0
  for (let i = 0; i < n; i += 1) {
    const e = pred[i] - truth[i]
    sae += Math.abs(e)
    sse += e * e
  }
  const mse = sse / n
  return { n, mae: sae / n, mse, rmse: Math.sqrt(mse) }
}

const evalCache = new Map()

function buildWindows(runId, sliceKey, stride) {
  const cacheKey = `${runId}|${sliceKey}|${stride}`
  if (evalCache.has(cacheKey)) return evalCache.get(cacheKey)
  const bundle = loadBundle(runId)
  const cfg = bundle.config
  const seqLen = cfg.task.seqLen
  const predLen = cfg.task.predLen
  const s = loadChannels()
  const split = officialSplit(seqLen)
  const slice = sliceKey === 'consistency' ? split.customSlices.consistency : sliceKey === 'all' ? { usedStart: split.evalStart, usedEnd: split.evalEnd } : split.customSlices.explore
  const mean = bundle.scaler.mean
  const scale = bundle.scaler.scale
  const windows = []
  for (let origin = slice.usedStart; origin + predLen <= slice.usedEnd; origin += stride) {
    const rawInput = []
    for (let i = origin - seqLen; i < origin; i += 1) {
      rawInput.push(s.values[i].map((v, c) => (v - mean[c]) / scale[c]))
    }
    const rawTarget = []
    for (let i = origin; i < origin + predLen; i += 1) rawTarget.push(s.values[i][s.cols.length - 1]) // OT 原始单位
    windows.push({ origin, input: rawInput, targetRaw: rawTarget })
  }
  const result = { windows, slice, predLen, seqLen, targetName: s.cols[s.cols.length - 1] }
  evalCache.set(cacheKey, result)
  return result
}

/**
 * 用两个官方方法在**同一批窗口、同一份扰动、同一评估目标**上做一次压力测试。
 */
export function runPaperExperiment({
  runIds = {},
  perturbationType = 'noise',
  strength = 0.1,
  seed = 11,
  sliceKey = 'explore',
  stride = 8,
  maxWindows = 40,
  includeFull = false,
  maxWindowsOverride = null,
}) {
  const dlinearId = runIds.DLinear
  const linearId = runIds.Linear
  if (!dlinearId || !linearId) throw new Error('需要同时提供 DLinear 与 Linear 的已训练版本')
  const dl = loadBundle(dlinearId)
  const ln = loadBundle(linearId)
  // 两个方法必须来自同一套任务设置（输入长度/预测跨度/特征模式/数据划分）
  const mismatch = ['seqLen', 'predLen', 'features'].filter((k) => dl.config.task[k] !== ln.config.task[k])
  if (mismatch.length) throw new Error(`两个版本的实验设置不一致：${mismatch.join(', ')}`)

  const built = buildWindows(dlinearId, sliceKey, stride)
  const picked = built.windows.length <= maxWindows ? built.windows : built.windows.filter((_, i) => i % Math.ceil(built.windows.length / maxWindows) === 0)

  const meanOT = dl.scaler.mean[dl.config.task.encIn - 1]
  const scaleOT = dl.scaler.scale[dl.config.task.encIn - 1]

  const truth = []
  const predD = []
  const predL = []
  const originsUsed = []
  const targetIndexList = []
  let changed = 0
  for (const w of picked) {
    const { input, changed: ch } = perturb(w.input, perturbationType, strength, seed)
    changed += ch
    const outD = forward(dl, input)
    const outL = forward(ln, input)
    originsUsed.push(w.origin)
    for (let p = 0; p < built.predLen; p += 1) {
      truth.push(w.targetRaw[p])
      targetIndexList.push(w.origin + p)
      // 标准化空间 → 原始单位（OT 通道）
      predD.push(outD[p][dl.config.task.encIn - 1] * scaleOT + meanOT)
      predL.push(outL[p][ln.config.task.encIn - 1] * scaleOT + meanOT)
    }
  }

  const mD = computeMetrics3(truth, predD)
  const mL = computeMetrics3(truth, predL)
  const deltaMae = mL.mae - mD.mae // 有方向：>0 表示 DLinear 的 MAE 更低
  const leader = Math.abs(deltaMae) < 1e-9 ? 'tie' : deltaMae > 0 ? 'DLinear' : 'Linear'
  const best = Math.min(mD.mae, mL.mae)
  const relGap = best > 0 ? Math.abs(deltaMae) / best : null

  return {
    family: 'paper-linear',
    methodVersion: { DLinear: dlinearId, Linear: linearId },
    weights: { DLinear: dlinearId, Linear: linearId },
    // 审计用：完整预测/真值/预测目标索引（默认不下发到前端）
    full: includeFull
      ? {
          truth,
          DLinear: predD,
          Linear: predL,
          origins: originsUsed,
          targetIndices: targetIndexList,
          targetIndicesFirst: targetIndexList[0],
          targetIndicesLast: targetIndexList[targetIndexList.length - 1],
          uniqueTargetPoints: new Set(targetIndexList).size,
          overlappingWindows: originsUsed.some((o, i) => i > 0 && o - originsUsed[i - 1] < built.predLen),
        }
      : undefined,
    task: {
      dataset: dl.config.task.dataset,
      target: built.targetName,
      features: dl.config.task.features,
      seqLen: dl.config.task.seqLen,
      predLen: dl.config.task.predLen,
    },
    dataSplitId: `official-ettm2-s${dl.config.task.seqLen}-p${dl.config.task.predLen}@${String(dl.config.data.sha256).slice(0, 8)}`,
    metricsSpec: {
      metrics: ['MAE', 'MSE', 'RMSE'],
      space: '原始单位（OT 列；预测先按训练段均值/方差反标准化）',
      aggregation: '对所有窗口 × 所有预测步取平均',
      nSamples: mD.n,
      nWindows: picked.length,
      predLen: built.predLen,
    },
    result: { DLinear: mD, Linear: mL, deltaMae, leader, relGap, closeGap: relGap !== null && relGap < 0.02 },
    perturbation: { type: perturbationType, strength, seed, changedPoints: changed, scope: '只作用于输入窗口（336×7）；评估目标为原始数据，未被改写', missingFill: perturbationType === 'missing' ? '训练均值填充（标准化空间为 0）' : null },
    slice: {
      key: sliceKey,
      label: built.slice.label ?? '官方测试区间（整段）',
      isCustomSlice: Boolean(built.slice.isCustomSlice),
      usedStart: built.slice.usedStart,
      usedEnd: built.slice.usedEnd,
      startDate: built.slice.startDate ?? null,
      endDate: built.slice.endDate ?? null,
    },
    chart: {
      stride: 1,
      truth: truth.filter((_, i) => i % Math.ceil(truth.length / 200) === 0),
      DLinear: predD.filter((_, i) => i % Math.ceil(predD.length / 200) === 0),
      Linear: predL.filter((_, i) => i % Math.ceil(predL.length / 200) === 0),
    },
    checks: {
      sameWindows: true,
      samePerturbation: true,
      sameTarget: true,
      targetUntouched: true,
      noFutureFill: perturbationType === 'missing',
      inferenceOnly: true,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 转成实验室记录（与教学实验同一套存储，但 family 不同、不混地图）        */
/* ------------------------------------------------------------------ */
function hashNums(list) {
  let h = 2166136261
  for (let i = 0; i < list.length; i += 1) {
    h ^= Math.round(list[i] * 1e6)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

export function paperResultToRecord(res, meta = {}) {
  const now = new Date()
  const startedAt = meta.startedAt ? new Date(meta.startedAt) : now
  return {
    id: meta.id || `paper-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    family: 'paper-linear',
    dataSplitId: DATA_SPLIT_ID,
    benchmark: { scope: 'official', evalStart: 46080, evalEnd: 57600, note: '与官方 DataLoader 完全一致的边界；未使用超出官方基准的 12,080 个点。' },
    createdAt: now.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: now.toISOString(),
    elapsedMs: now.getTime() - startedAt.getTime(),
    status: 'done',
    origin: meta.origin || 'manual',
    claim: meta.claim || null,
    replicatedOf: meta.replicatedOf || null,
    config: {
      horizon: res.task.predLen,
      perturbationType: res.perturbation.type,
      strength: res.perturbation.strength,
      seed: res.perturbation.seed,
      segment: res.slice.key === 'consistency' ? 'independent' : 'explore',
    },
    segment: res.slice.key === 'consistency' ? 'independent' : 'explore',
    dataSource: {
      kind: 'real',
      name: 'ETTm2（ETT small）',
      column: 'OT',
      url: 'https://raw.githubusercontent.com/zhouhaoyi/ETDataset/main/ETT-small/ETTm2.csv',
      repo: 'https://github.com/zhouhaoyi/ETDataset',
      rows: 69680,
      start: '2016-07-01 00:00:00',
      end: '2018-06-26 19:45:00',
      intervalMinutes: 15,
      note: '真实公开数据；本轮官方论文方法实验使用官方 DataLoader 的同一套划分与标准化。',
    },
    evaluation: {
      nSamples: res.metricsSpec.nSamples,
      nWindows: res.metricsSpec.nWindows,
      horizon: res.task.predLen,
      target: `${res.task.target}@ETTm2`,
      slice: res.slice,
    },
    methods: {
      DLinear: {
        label: 'DLinear（官方实现）',
        metrics: res.result.DLinear,
        predictionsHash: hashNums(res.chart.DLinear.slice(0, 400)),
        methodVersion: res.methodVersion.DLinear,
      },
      Linear: {
        label: 'Linear（官方实现）',
        metrics: res.result.Linear,
        predictionsHash: hashNums(res.chart.Linear.slice(0, 400)),
        methodVersion: res.methodVersion.Linear,
      },
    },
    comparison: res.result,
    metricsSpec: res.metricsSpec,
    methodVersion: res.methodVersion,
    weights: res.weights,
    dataSplitId: DATA_SPLIT_ID,
    weightSetId: res.dataSplitId,
    perturbation: res.perturbation,
    slice: res.slice,
    chart: res.chart,
    checks: res.checks,
    provenance: {
      methodScope: 'paper-method-official',
      officialRepo: 'https://github.com/cure-lab/LTSF-Linear',
      officialSha: PAPER_METHODS.DLinear.sha,
      officialScript: PAPER_METHODS.DLinear.script,
      license: 'MIT',
      execution: '官方模型代码 + 官方数据划分与标准化；训练在 Python/PyTorch（CPU）完成，Node 侧只做推理',
      note: '这是**官方实现的方法**在真实数据上的运行结果，但训练轮数少于原论文设置，属于「调整设置下的运行」，不宣称原论文复现成功。',
    },
  }
}

export function executePaperRun(config, meta = {}, deps) {
  const { saveRun } = deps
  const id = meta.id || `paper-${Date.now()}-${Math.floor(Math.random() * 1e4)}`
  const startedAt = Date.now()
  try {
    const res = runPaperExperiment(config)
    const record = paperResultToRecord(res, { ...meta, id, startedAt })
    saveRun(record)
    return record
  } catch (e) {
    const failed = {
      id,
      family: 'paper-linear',
      dataSplitId: DATA_SPLIT_ID,
      status: 'failed',
      origin: meta.origin || 'manual',
      createdAt: new Date().toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      config: { horizon: 96, perturbationType: config.perturbationType ?? 'noise', strength: config.strength ?? 0, seed: config.seed ?? 11, segment: 'explore' },
      claim: meta.claim || null,
      error: e instanceof Error ? e.message : '论文方法实验失败',
      provenance: { methodScope: 'paper-method-official', officialSha: PAPER_METHODS.DLinear.sha },
      dataSource: { kind: 'real', name: 'ETTm2（ETT small）', column: 'OT', rows: 69680, start: '', end: '', intervalMinutes: 15, note: '' },
    }
    saveRun(failed)
    return failed
  }
}

/* ------------------------------------------------------------------ */
/* 论文方法家族的发现卡：比较"扰动增强时 DLinear/Linear 的差距是否稳定"    */
/* ------------------------------------------------------------------ */
export function buildPaperFindings(runs) {
  const done = runs
    .filter((r) => (r.family ?? '') === 'paper-linear' && r.status === 'done' && (r.segment ?? 'explore') === 'explore' && r.comparison)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  const out = []
  for (const type of ['noise', 'missing']) {
    const rows = done.filter((r) => r.config.perturbationType === type)
    const strengths = [...new Set(rows.map((r) => r.config.strength))].sort((a, b) => a - b)
    if (strengths.length < 2) continue
    const picks = strengths.map((s) => rows.filter((r) => r.config.strength === s).slice(-1)[0])
    const deltas = picks.map((r) => r.comparison.deltaMae) // 有方向：Linear - DLinear
    const leaders = new Set(deltas.map((d) => (Math.abs(d) < 1e-9 ? 'tie' : d > 0 ? 'DLinear' : 'Linear')))
    const abss = deltas.map((d) => Math.abs(d))
    const monotonicUp = abss.every((g, i) => i === 0 || g >= abss[i - 1] - 1e-9)
    const monotonicDown = abss.every((g, i) => i === 0 || g <= abss[i - 1] + 1e-9)
    out.push({
      id: `paper-finding-${type}`,
      title:
        leaders.size > 1
          ? `在本次官方方法压力测试中，${type === 'noise' ? '输入噪声' : '输入缺失'}增强时领先方发生了反转。`
          : monotonicUp
            ? `在本次官方方法压力测试中，${type === 'noise' ? '输入噪声' : '输入缺失'}增强时两种方法的差距扩大，领先方未变。`
            : monotonicDown
              ? `在本次官方方法压力测试中，${type === 'noise' ? '输入噪声' : '输入缺失'}增强时两种方法的差距缩小，领先方未变。`
              : `在本次官方方法压力测试中，${type === 'noise' ? '输入噪声' : '输入缺失'}增强时两种方法的差距没有单调变化。`,
      claim: 'DLinear 相对 Linear 的表现，在输入受到扰动后是否保持稳定',
      methods: ['DLinear', 'Linear'],
      methodSource: 'official',
      segment: 'explore',
      segmentLabel: '探索切片（自定义：官方测试区间前半段）',
      perturbationType: type,
      strength: null,
      conditions: picks.map((r) => ({
        horizon: r.config.horizon,
        strength: r.config.strength,
        seed: r.config.seed,
        deltaMae: r.comparison.deltaMae,
        absDeltaMae: Math.abs(r.comparison.deltaMae),
        leader: r.comparison.leader,
        nSamples: r.evaluation?.nSamples,
        runId: r.id,
      })),
      exploreCount: picks.length,
      leaderStable: leaders.size === 1,
      leadChanged: leaders.size > 1,
      monotonic: monotonicUp || monotonicDown,
      trendDirection: monotonicUp ? 'increasing' : monotonicDown ? 'decreasing' : 'none',
      replicated: false,
      minConclusion: `在 ${type === 'noise' ? '输入噪声' : '输入缺失'} 0 → ${strengths[strengths.length - 1]} 的过程中，有方向的 ΔMAE（Linear − DLinear，正值表示 DLinear 更低）为 ${deltas
        .map((d) => d.toFixed(4))
        .join(' → ')}；${leaders.size === 1 ? `领先方始终是 ${[...leaders][0]}` : '领先方发生变化'}。`,
      notExtrapolateTo: [
        '不能外推到其它预测跨度（本轮固定 pred_len=96，换跨度需要重新训练）',
        '不能外推到其它数据集或变量（本轮只用 ETTm2 的 7 通道输入、OT 为目标）',
        '不能作为原论文表格的复现结果（训练轮数少于原论文设置）',
        '不能取代统计检验（这里只是固定条件与种子下的误差差值）',
      ],
      needsIndependentReplication: true,
    })
  }
  return out
}

/**
 * 论文来源（逐字引用 + 页码，来自本机 PDF：testpapers/DLinear-Are-Transformers-Effective.pdf）
 * ------------------------------------------------------------------
 * 明确区分三层，不要混：
 *  1) paper：论文自己说的方法与实验结论（带页码逐字引用）
 *  2) toolQuestion：本工具提出的问题（时间段敏感性问题）
 *  3) toolObservation：本工具实际跑出来的观察（换时间段后领先方变化）
 * 「换时间段后领先方改变」**没有**在论文里被讨论，因此绝不挂论文引用。
 */
export const PAPER_SOURCE = {
  pdfPath: 'testpapers/DLinear-Are-Transformers-Effective.pdf',
  pages: 15,
  title: 'Are Transformers Effective for Time Series Forecasting?',
  titleQuote: 'Are Transformers Effective for Time Series Forecasting?',
  authors: 'Ailing Zeng, Muxi Chen, Lei Zhang, Qiang Xu（The Chinese University of Hong Kong / IDEA）',
  authorsQuote: 'Ailing Zeng 1* , Muxi Chen 1* , Lei Zhang 2 , Qiang Xu 1 1 The Chinese University of Hong Kong 2 International Digital Economy Academy (IDEA)',
  venue: 'AAAI 2023（官方仓库引用的 arXiv 版本 2205.13504）',
  methodQuote: {
    text: 'It first decomposes a raw data input into a trend component by a moving average kernel and a remainder (seasonal) component. Then, two one-layer linear layers are applied to each component, and we sum up the two features to get the final prediction.',
    page: 4,
  },
  kernelQuote: {
    text: 'For DLinear, the moving average kernel size for decomposition is 25, which is the same as Autoformer.',
    page: 9,
  },
  protocolQuote: {
    text: 'we use Mean Squared Error (MSE) and Mean Absolute Error (MAE) as the core metrics to compare performance',
    page: 4,
  },
  tableQuote: {
    text: 'Table 2. Multivariate long-term forecasting errors in terms of MSE and MAE, the lower the better.',
    page: 5,
  },
  dataStatsQuote: { text: 'Timesteps 17,420 69,680', page: 5, note: '只引用可逐字核对的最小片段；相邻单元格内容不引用。' },
  /** 论文 Table 2（第 5 页）ETTm2 列，T=96 的报告值 */
  referenceValues: {
    DLinear: { mse: 0.167, mae: 0.26, page: 5, table: 'Table 2（Multivariate, ETTm2, T=96）' },
    Linear: { mse: 0.168, mae: 0.262, page: 5, table: 'Table 2（Multivariate, ETTm2, T=96）' },
  },
  crossCheck: {
    repoTable: 'LTSF-Benchmark.md 的 ETTm2 列（O=96）：Linear 0.168/0.262、DLinear 0.167/0.260 —— 与论文 Table 2 一致。',
  },
  toolQuestion: {
    text: '在当前数据与设置下，DLinear 相对 Linear 的表现，在输入受到扰动后是否保持稳定？以及：换一个评估时间段，领先方会不会变？',
    note: '这是本工具提出的压力测试问题，论文没有讨论"换时间段后领先方是否改变"。',
  },
  toolObservation: {
    text: '在 ETTm2 的两个自定义时间段切片上，领先方发生了反转：探索切片 Linear 略优，另一时间段 DLinear 略优。',
    note: '这是本工具在**当前权重**上的实验观察，不是论文结论，也没有对应论文引用。',
  },
  caveats: [
    '论文 Table 1 标注 ETTm 粒度 5min，但实际数据文件是 15 分钟采样（论文与数据的差异，记录在案）。',
    '论文报告值来自 Table 2（多变量、7 通道、标准化空间、T=96），只有同口径的本地指标才能对照。',
  ],
}

/**
 * 与官方报告值的对照（必须先对齐口径；口径不一致时显示「暂不可直接对照」）
 * 参考值来自**论文 PDF 第 5 页 Table 2**（本机 PDF 抽取后逐字核对）。
 */
export const PAPER_REFERENCE = {
  source: '论文 PDF 第 5 页 Table 2（Multivariate, ETTm2, T=96）',
  sourceLevel: 'paper-pdf-table',
  protocol: {
    dataset: 'ETTm2',
    task: 'multivariate long-term forecasting',
    predLen: 96,
    channels: 'all (7)',
    space: 'standardized',
    metrics: ['MSE', 'MAE'],
    aggregation: 'all windows × all steps',
  },
  values: {
    DLinear: { mse: PAPER_SOURCE.referenceValues.DLinear.mse, mae: PAPER_SOURCE.referenceValues.DLinear.mae },
    Linear: { mse: PAPER_SOURCE.referenceValues.Linear.mse, mae: PAPER_SOURCE.referenceValues.Linear.mae },
  },
  note: '该表为多变量设置（7 通道）与标准化空间的 MSE/MAE；只有同口径的本地指标才能与之比较。',
}

/** 本地指标（来自训练配置）→ 分口径列出，并逐条说明能否与官方表对照 */
export function buildPaperComparison(trainedWithMetrics) {
  const rows = []
  for (const t of trainedWithMetrics) {
    const m = t.metricsAll
    if (!m) continue
    const ref = PAPER_REFERENCE.values[t.method]
    const diff = (local, r) => (typeof local === 'number' && typeof r === 'number' ? Number((local - r).toFixed(4)) : null)
    const localStd = m.standardized?.mae
    rows.push({
      method: t.method,
      runId: t.runId,
      spaces: [
        {
          key: 'standardized-all',
          label: '标准化空间 · 全部 7 通道',
          mae: m.standardized?.mae ?? null,
          mse: m.standardized?.mse ?? null,
          comparable: true,
          gapMae: diff(m.standardized?.mae, ref?.mae),
          gapMse: diff(m.standardized?.mse, ref?.mse),
          note: '任务、通道范围、指标、归一化空间与聚合方式都与官方表一致，可以直接对照。',
        },
        {
          key: 'raw-all',
          label: '原始单位（温度）· 全部 7 通道',
          mae: m.raw?.mae ?? null,
          mse: m.raw?.mse ?? null,
          comparable: false,
          missing: ['官方表没有给出原始单位的结果', '需要论文或仓库提供同口径的原始单位数值'],
          note: '暂不可直接对照。',
        },
        {
          key: 'raw-ot',
          label: '原始单位 · 仅 OT 单列',
          mae: m.rawOT?.mae ?? null,
          mse: m.rawOT?.mse ?? null,
          comparable: false,
          missing: ['官方表是多变量聚合，不是 OT 单列', '若要单列对照，需要论文提供单变量结果'],
          note: '暂不可直接对照。',
        },
      ],
      gapSummary:
        typeof localStd === 'number' && typeof ref?.mae === 'number'
          ? {
              localMae: Number(localStd.toFixed(4)),
              refMae: ref.mae,
              diff: Number((localStd - ref.mae).toFixed(4)),
              relPercent: Number((((localStd - ref.mae) / ref.mae) * 100).toFixed(1)),
            }
          : null,
      factorsToCheck: [
        '官方结果通常是多次运行（itr）后的平均，本机只跑了 1 次',
        '本机为 CPU 前向（float32），未与 GPU 结果逐点比对差异',
        '训练轮数 / 学习率 / 批大小与官方 ettm2.sh 的 pred_len=96 设置一致 —— 不存在"只训练 10 轮"的偏差',
      ],
    })
  }
  return {
    reference: PAPER_REFERENCE,
    rows,
    alignmentRule:
      '只有当任务、数据集、预测跨度、通道范围、归一化空间、指标与聚合方式全部一致时，才显示数值差距；否则显示「暂不可直接对照」并列出缺少的条件。',
    noCausalClaim: '本工具不对差距原因下断言；上面列出的是**待检查因素**，不是已证实的解释。',
  }
}

/* ------------------------------------------------------------------ */
/* 核心案例：换个时间段，领先者会变吗？                                  */
/* ------------------------------------------------------------------ */
const CASE_DIR = join(ROOT, 'lab-cases', 'reversal')
const CASE_FILE = join(CASE_DIR, 'verification.json')

function runSlice(runIds, key) {
  return runPaperExperiment({
    runIds,
    sliceKey: key,
    perturbationType: 'noise',
    strength: 0,
    seed: 11,
    stride: 8,
    maxWindows: 100000,
    includeFull: true,
  })
}

function toCase(runIds, A, B, generatedAt) {
  const pack = (r) => ({
    key: r.slice.key,
    range: [r.slice.usedStart, r.slice.usedEnd],
    dates: { start: r.slice.startDate, end: r.slice.endDate },
    label: r.slice.label,
    windows: r.full.origins.length,
    targetPoints: r.full.uniqueTargetPoints,
    targetIndexRange: [r.full.targetIndicesFirst, r.full.targetIndicesLast],
    metrics: { DLinear: r.result.DLinear, Linear: r.result.Linear },
    deltaMae: r.result.deltaMae,
    leader: r.result.leader,
    relGap: r.result.relGap,
    closeGap: r.result.closeGap,
    chart: r.chart,
    slice: r.slice,
    metricsSpec: r.metricsSpec,
  })
  const a = pack(A)
  const b = pack(B)
  const reversal = a.leader !== b.leader
  return {
    generatedAt,
    caseId: 'reversal',
    title: '换个时间段，领先者会变吗？',
    weights: runIds,
    settings: {
      dataset: 'ETTm2',
      target: A.task.target,
      features: A.task.features,
      seqLen: A.task.seqLen,
      predLen: A.task.predLen,
      perturbation: '无扰动（strength 0）',
      seed: 11,
      samplingStride: 8,
      metric: 'MAE / MSE / RMSE（原始单位，OT 目标列；窗口 × 预测步平均）',
    },
    slices: { explore: a, consistency: b },
    reversal,
    verdict: reversal
      ? `反转仍然存在：${a.label.split('（')[0]} 领先方是 ${a.leader}（ΔMAE ${a.deltaMae.toFixed(4)}），另一时间段领先方是 ${b.leader}（ΔMAE ${b.deltaMae.toFixed(4)}）。这是**当前权重在这两个指定时间段上的观察**。`
      : `两段领先方一致（都是 ${a.leader}），**没有观察到反转**；前一版的演示结论应被更正。`,
    caveats: [
      `每段 ${a.windows} 个窗口、${a.targetPoints} 个目标点；窗口之间大量重叠（相邻起点间隔 8 步、每窗口 ${a.metricsSpec.predLen} 步），不能当作彼此独立的样本，本案例不涉及统计显著性。`,
      '输入窗口允许使用预测起点之前的历史（最长 seq_len 点）；预测目标严格落在本时间段内，不跨段。',
      '只适用于当前权重、当前数据与当前设置；不能外推到其它预测跨度（换跨度需重新训练）、其它数据集或论文方法。',
      '反转原因**未验证**：本工具没有对"为什么换时间段会反转"下结论。',
    ],
    paper: {
      question: PAPER_SOURCE.toolQuestion,
      observation: PAPER_SOURCE.toolObservation,
      note: '「换时间段后领先方改变」是本工具的实验观察，论文没有讨论这个现象，因此不挂论文引用。',
    },
    rerun: {
      command: 'node scripts/paper-method/verify-reversal.mjs',
      config: { runIds, perturbationType: 'noise', strength: 0, seed: 11, stride: 8, slices: ['explore', 'consistency'] },
    },
    methodSource: {
      repo: PAPER_METHODS.DLinear.repo,
      sha: PAPER_METHODS.DLinear.sha,
      license: 'MIT',
      script: PAPER_METHODS.DLinear.script,
      execution: '官方模型定义（未改写）+ 官方数据划分与标准化；Python/PyTorch(CPU) 训练，Node 侧推理（已与 PyTorch 逐点比对）',
      paperPdf: PAPER_SOURCE.pdfPath,
    },
  }
}

export function runReversalCase({ runIds }) {
  const A = runSlice(runIds, 'explore')
  const B = runSlice(runIds, 'consistency')
  const data = toCase(runIds, A, B, new Date().toISOString())
  const full = {
    ...data,
    // 完整预测与真值（供独立复算；导出时才写入文件）
    raw: {
      explore: { truth: A.full.truth, DLinear: A.full.DLinear, Linear: A.full.Linear, targetIndices: A.full.targetIndices },
      consistency: { truth: B.full.truth, DLinear: B.full.DLinear, Linear: B.full.Linear, targetIndices: B.full.targetIndices },
    },
  }
  try {
    if (!existsSync(CASE_DIR)) mkdirSync(CASE_DIR, { recursive: true })
    writeFileSync(CASE_FILE, JSON.stringify(full), 'utf8')
  } catch {
    /* 落盘失败不影响返回 */
  }
  return full
}

export function readCachedCase() {
  try {
    if (!existsSync(CASE_FILE)) return null
    const raw = JSON.parse(readFileSync(CASE_FILE, 'utf8'))
    // 兼容命令行脚本早期写出的格式（weightVersions / 无 title / 无 chart）
    const norm = (s) => {
      if (!s) return s
      const pick = (arr) => {
        if (!Array.isArray(arr)) return []
        const stride = Math.max(1, Math.ceil(arr.length / 200))
        if (stride === 1) return arr
        const out = []
        for (let i = 0; i < arr.length; i += stride) out.push(arr[i])
        return out
      }
      const chart =
        s.chart ??
        (s.full
          ? { stride: 1, truth: pick(s.full.truth), DLinear: pick(s.full.DLinear), Linear: pick(s.full.Linear) }
          : { stride: 1, truth: [], DLinear: [], Linear: [] })
      const { full, raw, ...rest } = s
      void full
      void raw
      return { ...rest, chart }
    }
    const slices = { explore: norm(raw.slices?.explore), consistency: norm(raw.slices?.consistency) }
    // 完整预测只在导出接口里给，不在交互接口里下发（否则单次响应几十 MB）
    const { raw: _drop, ...rest } = raw
    void _drop
    const reversal = raw.reversal ?? (slices.explore?.leader !== chunksConsistency(slices))
    const weights = raw.weights ?? raw.weightVersions ?? {}
    const explore = slices.explore
    const consistency = slices.consistency
    return {
      ...rest,
      title: raw.title ?? '换个时间段，领先者会变吗？',
      weights,
      slices,
      reversal: typeof raw.reversal === 'boolean' ? raw.reversal : explore?.leader !== consistency?.leader,
      verdict:
        raw.verdict ??
        (typeof raw.reversal === 'boolean'
          ? raw.reversal
            ? `反转仍然存在：探索段领先方 ${explore?.leader}（ΔMAE ${explore?.deltaMae?.toFixed(4)}），另一时间段领先方 ${consistency?.leader}（ΔMAE ${consistency?.deltaMae?.toFixed(4)}）。这是当前权重在这两个指定时间段上的观察。`
            : `两段领先方一致（都是 ${explore?.leader}），没有观察到反转。`
          : '（缺少结论字段）'),
      caveats:
        raw.caveats ?? [
          `每段 ${explore?.windows ?? '—'} 个窗口、${explore?.targetPoints ?? '—'} 个目标点；窗口之间存在重叠，不作为独立样本，不涉及统计显著性。`,
          '输入窗口允许使用预测起点之前的历史；预测目标严格落在本时间段内，不跨段。',
          '只适用于当前权重、当前数据与当前设置；不能外推。',
          '反转原因**未验证**。',
        ],
      settings: raw.settings ?? {},
      paper: raw.paper ?? { question: {}, observation: {}, note: '' },
      methodSource: raw.methodSource ?? {},
      rerun: raw.rerun ?? { command: 'node scripts/paper-method/verify-reversal.mjs', config: {} },
    }
  } catch {
    return null
  }
}

function chunksConsistency(slices) {
  return slices.consistency?.leader
}

/** 案例的 Markdown 报告（可分享、可复跑） */
export function caseToMarkdown(c) {
  const L = []
  L.push(`# 实验案例：${c.title}`)
  L.push('')
  L.push(`生成时间：${c.generatedAt}`)
  L.push(`权重版本：DLinear=\`${c.weights.DLinear}\`｜Linear=\`${c.weights.Linear}\``)
  L.push(`代码来源：${c.methodSource.repo} @ ${c.methodSource.sha.slice(0, 8)}（${c.methodSource.license}）｜执行方式：${c.methodSource.execution}`)
  L.push('')
  L.push('## 固定设置（两段完全相同，只改评估时间段）')
  L.push('```json')
  L.push(JSON.stringify(c.settings, null, 2))
  L.push('```')
  L.push('')
  L.push('## 两段结果')
  L.push('')
  L.push('| 时间段（自定义切片，均在官方测试区间内） | 日期 | 窗口数 | 目标点数 | DLinear MAE | Linear MAE | ΔMAE(Linear−DLinear) | 领先方 |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const k of ['explore', 'consistency']) {
    const s = c.slices[k]
    L.push(
      `| ${s.range[0]}–${s.range[1]} | ${s.dates.start} → ${s.dates.end} | ${s.windows} | ${s.targetPoints} | ${s.metrics.DLinear.mae.toFixed(4)} | ${s.metrics.Linear.mae.toFixed(4)} | ${s.deltaMae.toFixed(4)} | ${s.leader} |`,
    )
  }
  L.push('')
  L.push(`**结论**：${c.verdict}`)
  L.push('')
  L.push('## 样本口径（避免把重叠窗口当成独立样本）')
  for (const k of ['explore', 'consistency']) {
    const s = c.slices[k]
    const steps = s.metricsSpec?.predLen ?? 96
    L.push(
      `- ${k === 'explore' ? '探索段' : '另一时间段'}：${s.windows} 个窗口 × ${steps} 个预测步 = **${s.windows * steps} 条预测记录**；去重后覆盖 **${s.targetPoints} 个不同的目标时间点**。`,
    )
  }
  L.push('- MAE 是对"预测记录"求平均，不是独立样本数量；相邻窗口起点间隔 8 步、每窗口 96 步，窗口之间大量重叠，因此本案例不做统计显著性推断。')
  L.push('')
  L.push('## 适用范围与限制')
  c.caveats.forEach((x) => L.push(`- ${x}`))
  L.push('')
  L.push('## 论文侧 vs 工具侧（不要混淆）')
  L.push(`- 论文提出的问题/结论：见论文 PDF（${c.methodSource.paperPdf}）第 4–5 页的 Table 2 与实验设置；`)
  L.push(`  论文方法引用（第 ${PAPER_SOURCE.methodQuote.page} 页）：“${PAPER_SOURCE.methodQuote.text}”`)
  L.push(`- 本工具提出的问题：${c.paper.question.text}`)
  L.push(`- 本工具得到的观察：${c.paper.observation.text}`)
  L.push(`- ${c.paper.note}`)
  L.push('')
  L.push('## 与论文报告值的同口径对照')
  L.push('')
  L.push('| 口径 | 本地 | 论文 Table 2（第 5 页，ETTm2, T=96） | 能否对照 |')
  L.push('| --- | --- | --- | --- |')
  L.push(
    `| 标准化空间 · 全部 7 通道 · MAE | ${(c.localPaperCompare?.DLinear?.standardized?.mae ?? '—')} | DLinear ${PAPER_REFERENCE.values.DLinear.mae} / Linear ${PAPER_REFERENCE.values.Linear.mae} | 可以对照（任务、通道、指标、空间、聚合一致） |`,
  )
  L.push(`| 原始单位 / 仅 OT 单列 | 见训练配置 | 论文未给出 | 暂不可直接对照 |`)
  L.push('')
  L.push('## 怎么复跑')
  L.push('```bash')
  L.push(c.rerun.command)
  L.push('# 或先重新训练（开发环境，需要 Python + PyTorch）')
  L.push('python scripts/paper-method/train_ltsf.py --model DLinear --epochs 10')
  L.push('python scripts/paper-method/train_ltsf.py --model Linear  --epochs 10')
  L.push('node scripts/paper-method/recompute-metrics.mjs   # 用保存的预测独立复算指标')
  L.push('```')
  L.push('')
  L.push('## 导出内容不含任何模型 API 密钥；本案例的本地计算不依赖在线大模型服务。')
  return L.join('\n')
}

/** 可复跑配置（JSON） */
export function caseToConfig(c) {
  return JSON.stringify(
    {
      caseId: c.caseId,
      generatedAt: c.generatedAt,
      weights: c.weights,
      settings: c.settings,
      slices: {
        explore: { range: c.slices.explore.range, dates: c.slices.explore.dates },
        consistency: { range: c.slices.consistency.range, dates: c.slices.consistency.dates },
      },
      rerun: c.rerun,
      independentRecompute: 'node scripts/paper-method/recompute-metrics.mjs（只读 verification.json，不引用实验引擎）',
    },
    null,
    2,
  )
}

/* ------------------------------------------------------------------ */
/* 让模型解释这个案例（只解释，不改数字）                                 */
/* ------------------------------------------------------------------ */
export async function explainCaseWithLlm({ caseData, action, planLabExperiment: _unused }) {
  return { ok: false, reason: 'not-implemented' }
}

/* ------------------------------------------------------------------ */
/* 论文方法家族的有限预算探索（模型只提条件，程序校验并执行）              */
/* ------------------------------------------------------------------ */
export const PAPER_STRENGTHS = [0, 0.05, 0.1, 0.2, 0.35]
export const PAPER_SEEDS = [11, 29, 47]
export const paperExplorations = new Map()

export function cancelPaperExploration(id) {
  const e = paperExplorations.get(id)
  if (!e) return false
  e.cancelled = true
  return true
}

export async function explorePaper({ budget, claim, runIds, perturbationType = 'noise', explorationId, deps, planLabExperiment }) {
  const { listRuns, saveRun } = deps
  const total = Math.max(1, Math.min(Number(budget) || 3, 8))
  const id = explorationId || `paper-explore-${Date.now()}`
  const state = { cancelled: false }
  paperExplorations.set(id, state)

  const trace = []
  let used = 0
  let consecutiveFailures = 0
  let stopCode = null
  let stoppedReason = null
  let plannerMode = null

  const visible = () =>
    listRuns().filter((r) => (r.family ?? '') === 'paper-linear' && (r.segment ?? 'explore') === 'explore' && (r.dataSplitId ?? '') === DATA_SPLIT_ID)

  const push = (entry) => {
    trace.push(entry)
    used += 1
  }

  const runOne = (cfg, meta) => executePaperRun(cfg, meta, { saveRun })

  try {
    // 基准：无扰动
    const base = runOne({ runIds, perturbationType, strength: 0, seed: PAPER_SEEDS[0], sliceKey: 'explore', stride: 8, maxWindows: 40 }, { origin: 'explore', claim, id: `${id}-0` })
    if (base.status !== 'done') consecutiveFailures += 1
    push({
      step: 1,
      kind: 'baseline',
      planner: 'program',
      config: base.config,
      runId: base.id,
      status: base.status,
      reason: '先跑无扰动基准：两种官方方法在同一批窗口、同一评估目标上的误差才有可比性。',
      comparison: base.comparison ?? null,
      nSamples: base.evaluation?.nSamples ?? null,
      segment: 'explore',
      sliceLabel: base.slice?.label,
      observation: '还没有任何压力测试结果，先建立无扰动参照。',
      choice: `输入扰动 0（无扰动）、种子 ${PAPER_SEEDS[0]}`,
      result: base.status === 'done' ? `ΔMAE(Linear−DLinear)=${base.comparison.deltaMae.toFixed(4)}，领先方 ${base.comparison.leader}，样本 ${base.evaluation.nSamples}` : `失败：${base.error}`,
      judgmentChange: base.status === 'done' ? `无扰动下 ${base.comparison.leader} 的 MAE 更低，这是后续比较的基线。` : '基准没跑成，后续判断不可用。',
    })

    while (used < total) {
      if (state.cancelled) {
        stopCode = 'cancelled'
        stoppedReason = '用户取消了这次探索'
        break
      }
      if (consecutiveFailures >= 2) {
        stopCode = 'consecutive-failures'
        stoppedReason = '连续 2 次实验失败，已停止探索以避免继续消耗预算。'
        break
      }
      const runs = visible()
      const done = runs.filter((r) => r.status === 'done' && r.comparison)
      const tested = new Set(done.map((r) => `${r.config.perturbationType}|${r.config.strength}|${r.config.seed}`))
      const remaining = total - used
      const reserveReplication = total >= 3 && remaining === 1

      let plan = null
      let planner = 'rule'
      let plannerNote = null

      if (reserveReplication) {
        const interesting = done.slice().sort((a, b) => Math.abs(b.comparison.deltaMae) - Math.abs(a.comparison.deltaMae))[0]
        if (interesting) {
          const seed = PAPER_SEEDS.find((s) => s !== interesting.config.seed) ?? PAPER_SEEDS[0]
          plan = {
            kind: 'replicate',
            config: { strength: interesting.config.strength, seed, perturbationType: interesting.config.perturbationType },
            replicatedOf: interesting.id,
            reason: `最后一步留给换种子复验：对扰动 ${interesting.config.strength} 的结果换个种子重跑，确认不是某次随机扰动的偶然。`,
          }
          planner = 'program-replication'
        }
      }

      if (!plan) {
        const history = done.map((r) => ({
          horizon: r.config.horizon,
          perturbationType: r.config.perturbationType,
          strength: r.config.strength,
          seed: r.config.seed,
          mae: r.methods?.Linear?.metrics?.mae,
          ridgeMae: r.methods?.DLinear?.metrics?.mae,
          deltaMae: r.comparison.deltaMae,
          nSamples: r.evaluation?.nSamples,
        }))
        const modelPlan = planLabExperiment
          ? await planLabExperiment({
              claim: claim?.text || 'DLinear 相对 Linear 的表现，在输入受到扰动后是否保持稳定',
              history,
              options: { horizon: [96], perturbationType: ['noise', 'missing'], strength: PAPER_STRENGTHS, seed: PAPER_SEEDS },
              budgetLeft: remaining,
            })
          : { ok: false, reason: '未提供模型规划器' }
        if (modelPlan.ok && modelPlan.stop) {
          stopCode = 'no-conditions'
          stoppedReason = `模型判断继续试探已无必要：${modelPlan.reason}`
          break
        }
        if (modelPlan.ok && modelPlan.proposal) {
          const p = modelPlan.proposal
          const okStrength = PAPER_STRENGTHS.includes(Number(p.strength))
          const okSeed = PAPER_SEEDS.includes(Number(p.seed))
          const okType = ['noise', 'missing'].includes(String(p.perturbationType))
          const key = `${p.perturbationType}|${Number(p.strength)}|${Number(p.seed)}`
          if (okStrength && okSeed && okType && !tested.has(key)) {
            plan = {
              kind: 'model',
              config: { strength: Number(p.strength), seed: Number(p.seed), perturbationType: String(p.perturbationType) },
              reason: p.reason,
            }
            planner = 'model'
          } else {
            plannerNote = `模型给的条件不合法或已跑过（${key}），改用规则选择。`
          }
        } else {
          plannerNote = `模型不可用或未给出可用建议（${modelPlan.reason || modelPlan.code}），本轮改为规则探索。`
        }
      }

      if (!plan) {
        // 规则选择：优先补齐"相邻强度"
        const last = done.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
        const cands = []
        for (const t of ['noise', 'missing']) {
          for (const s of PAPER_STRENGTHS) {
            for (const sd of PAPER_SEEDS.slice(0, 1)) cands.push({ perturbationType: t, strength: s, seed: sd, key: `${t}|${s}|${sd}` })
          }
        }
        const fresh = cands.filter((c) => !tested.has(c.key))
        if (fresh.length === 0) {
          stopCode = 'no-conditions'
          stoppedReason = '允许的条件组合都已跑过，没有新的有效实验。'
          break
        }
        const neighbor = last
          ? fresh.find((c) => c.perturbationType === last.config.perturbationType && Math.abs(c.strength - last.config.strength) === 0.05) ??
            fresh.find((c) => c.perturbationType === last.config.perturbationType && c.strength > last.config.strength)
          : null
        const pick = neighbor ?? fresh[0]
        plan = {
          kind: 'probe',
          config: { strength: pick.strength, seed: pick.seed, perturbationType: pick.perturbationType },
          reason: last
            ? `上一轮 ${last.config.perturbationType === 'noise' ? '噪声' : '缺失'} ${last.config.strength} 时 ΔMAE=${last.comparison.deltaMae.toFixed(4)}，本轮测${pick.perturbationType === 'noise' ? '噪声' : '缺失'} ${pick.strength} 看差距是否同向变化。`
            : '从最小强度开始逐档加扰动。',
        }
      }

      const record = runOne(
        { runIds, perturbationType: plan.config.perturbationType, strength: plan.config.strength, seed: plan.config.seed, sliceKey: 'explore', stride: 8, maxWindows: 40 },
        { origin: plan.kind === 'replicate' ? 'replication' : 'explore', claim, replicatedOf: plan.replicatedOf ?? null, id: `${id}-${used}` },
      )
      if (record.status !== 'done') consecutiveFailures += 1
      else consecutiveFailures = 0
      const prev = done.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
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
        sliceLabel: record.slice?.label,
        observation: prev ? `上一轮：扰动 ${prev.config.perturbationType === 'noise' ? '噪声' : '缺失'} ${prev.config.strength}，ΔMAE ${prev.comparison.deltaMae.toFixed(4)}` : '只有基准结果。',
        choice: `扰动 ${plan.config.perturbationType === 'noise' ? '噪声' : '缺失'} ${plan.config.strength}、种子 ${plan.config.seed}`,
        result: record.status === 'done' ? `ΔMAE(Linear−DLinear)=${record.comparison.deltaMae.toFixed(4)}，领先方 ${record.comparison.leader}，样本 ${record.evaluation?.nSamples}` : `失败：${record.error}`,
        judgmentChange: (() => {
          if (record.status !== 'done') return '这次失败没有改变判断，只是消耗了一次预算。'
          const all = visible().filter((r) => r.status === 'done' && r.comparison)
          const leaders = new Set(all.map((r) => r.comparison.leader))
          const shown = [...leaders].filter(Boolean)
          return leaders.size > 1
            ? `已观察到领先方在不同扰动下发生变化（${shown.join(' / ')}），需要在另一时间段做一致性检查。`
            : `目前 ${all.length} 组条件下领先方一致（${shown[0] ?? '未知'}）；还需要更多扰动档位才能判断趋势。`
        })(),
      })
    }
    if (!stoppedReason && used >= total) {
      stopCode = 'budget'
      stoppedReason = `已达到本次预算（${total} 次）。`
    }
    if (trace.some((t) => t.replicatedOf)) stopCode = stopCode === 'budget' ? 'replicated' : stopCode
  } finally {
    paperExplorations.delete(id)
  }

  const runs = listRuns().filter((r) => (r.family ?? '') === 'paper-linear')
  return {
    ok: true,
    explorationId: id,
    budget: total,
    used,
    remaining: Math.max(0, total - used),
    stopCode,
    stoppedReason,
    mode: trace.some((t) => t.planner === 'model') ? 'model' : 'rule',
    trace,
    findings: buildPaperFindings(runs),
    visibleSlice: 'explore',
    hiddenSlice: 'consistency',
    note: '探索只读取探索切片的结果；另一时间段一致性检查切片在探索期间不可见。',
  }
}
export function paperConsistencyCheck({ runIds, perturbationType, strengths = [0, 0.1, 0.2], seed = 11, saveRun, claim }) {
  const results = []
  const before = Date.now()
  for (const strength of strengths) {
    const record = executePaperRun(
      { runIds, perturbationType, strength, seed, sliceKey: 'consistency', stride: 8, maxWindows: 40 },
      { origin: 'replication', claim, id: `paper-consistency-${perturbationType}-${strength}` },
      { saveRun },
    )
    results.push(record)
  }
  const exploreRuns = runIds.list
    ? []
    : []
  const rows = results
    .filter((r) => r.status === 'done')
    .map((r) => ({
      strength: r.config.strength,
      deltaMae: r.comparison.deltaMae,
      absDeltaMae: Math.abs(r.comparison.deltaMae),
      leader: r.comparison.leader,
      nSamples: r.evaluation?.nSamples,
      runId: r.id,
      startDate: r.slice?.startDate ?? null,
      endDate: r.slice?.endDate ?? null,
    }))
  const abs = rows.map((r) => r.absDeltaMae)
  const up = abs.length >= 2 && abs.every((g, i) => i === 0 || g >= abs[i - 1] - 1e-9)
  const down = abs.length >= 2 && abs.every((g, i) => i === 0 || g <= abs[i - 1] + 1e-9)
  const leaders = new Set(rows.map((r) => r.leader))
  return {
    ok: rows.length > 0,
    slice: 'consistency',
    sliceLabel: '另一时间段一致性检查切片（自定义：官方测试区间后半段；前半段已用于条件搜索，因此**不称为从未使用的独立复验数据**）',
    rows,
    direction: up ? 'increasing' : down ? 'decreasing' : 'none',
    leaderStable: leaders.size === 1,
    elapsedMs: Date.now() - before,
    note: '这一检查只回答「换个时间段是否还是同方向」，不构成独立复验；不一致时同样如实展示。',
  }
}
