/**
 * 全局配置
 * ------------------------------------------------------------------
 * 能力开关集中在 CAPABILITIES；
 * 运行时的真实状态放在 store 的 caps 里（由真实解析成功与后端探测结果决定）。
 */

export const APP_NAME = '论文复现避坑助手'
export const APP_SUBTITLE = '时间序列预测 · 真实解析版'
export const APP_TAGLINE = '读懂论文的方法，找出复现实验前需要确认的问题。'

/** 上传限制 */
export const UPLOAD_RULES = {
  /** 允许的扩展名 */
  allowedExtensions: ['.pdf'],
  /** 单文件大小上限（字节） */
  maxFileSize: 30 * 1024 * 1024,
  maxFileSizeLabel: '30 MB',
  /** 单次最多选择的文件数 */
  maxFilesPerBatch: 10,
}

/**
 * 能力开关的初始值
 * ------------------------------------------------------------------
 * 约定：开关只有「实际接通并成功跑过一次」之后才会被置为 true。
 *  - realPdfParsing：浏览器端真实解析成功后打开；
 *  - realLlmExtract / realLlmQa：后端 /api/health 探测到密钥 + 首次请求成功后打开。
 * 界面展示的是 store 里运行时的 caps，不直接读这里的初始值。
 */
export const CAPABILITIES = {
  realPdfParsing: false,
  realLlmExtract: false,
  realLlmQa: false,
  /** 上传原文件是否成功写入本地（IndexedDB）；成功过一次才算启用 */
  persistOriginalFile: false,
} as const

/** 文件持久化的如实说明（不要写成「浏览器无法保存 PDF」） */
export const FILE_PERSISTENCE_NOTE =
  '本地保存分两部分：解析出的正文文本、字段与证据放在 localStorage（刷新即恢复）；上传的原文件放在 IndexedDB（保存成功后，刷新页面可以直接用原文件重新解析，不必再选文件）。若浏览器处于隐私模式或存储配额不足，原文件会保存失败 —— 此时界面会明确提示，正文与字段仍然照常保留。'

/** 本地持久化 key */
export const STORAGE_KEY = 'paper-repro-guard.state.v1'

/** 问答模拟延迟（毫秒） */
export const QA_LATENCY_MS: [number, number] = [600, 1100]

/** 解析模拟延迟（毫秒） */
export const PARSE_LATENCY_MS: [number, number] = [400, 900]

/**
 * 开发/演示用：强制问答失败，用于演示「失败 + 重新尝试」状态。
 * 也可以在界面的「演示设置」里临时打开。
 */
export const SIMULATE_QA_FAILURE_DEFAULT = false

/** 检查规则版本，便于说明「检查结果来自哪一版规则」 */
export const CHECK_RULE_VERSION =
  '规则 v0.3（共同数据集口径 · 复合判定 · 区分「未找到」与「未检查」）'

/**
 * 抽取/分析结果的版本。
 * 每次改动抽取口径或证据校验标准就 +1；没有版本（或版本落后）的历史结果显示
 * 「可更新分析」，由用户主动触发重新分析才会调用模型 —— **不会后台批量重抽**。
 */
export const ANALYSIS_VERSION = 2

/** 本次分析版本新增了什么（用于提示用户"更新能带来什么"） */
export const ANALYSIS_VERSION_NOTE =
  '新版本会按数据集分别保存划分/采样间隔取值、要求集合字段有「实验用途」证据、并把划分比例与测试时间区间分开判定。'
