import type { Paper } from '@/types'
import { normalizeValue, setOf } from './normalize'

/**
 * 对比口径（共同数据集）
 * ------------------------------------------------------------------
 * 两篇论文用的数据集集合不一样，**不代表它们的共同实验不可比较**。
 * 正确做法是先取「两篇都用到的数据集」，再在这个数据集的口径下逐项比较
 * 划分 / 测试区间 / 预测跨度 / 采样间隔 / 指标 / 预处理 —— 因为论文里的这些设置
 * 经常是「按数据集分别给出」的（例如「ETTh 为 1 小时、ETTm 为 15 分钟」）。
 *
 * 这里的取值裁剪是**确定性文本规则**，不依赖模型：
 * 把字段文本按句子（；。换行）切开，挑出提到目标数据集的那一条；
 * 挑不到就退一步用「其余 / 所有数据集」这类通用条款；
 * 都挑不到就返回 null，表示「这篇论文没有单独说明该数据集上的这项设置」。
 */

/** 数据集的写法归一：去掉分隔符与大小写差异，便于比较 */
function datasetKey(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_\-–—.()（）]/g, '')
}

/**
 * 显式别名表：只有列在这里的写法才允许互相等同。
 * 原则：**不做任何"删掉末尾数字就算同一个"的模糊匹配** ——
 * ETTh1 / ETTh2 / ETTm1 / ETTm2 是四个不同的数据集，永远不能互相等同。
 * 需要新增等价写法时，往这张表里加一行，而不是放宽匹配规则。
 */
const DATASET_ALIAS_GROUPS: string[][] = [
  ['Exchange-Rate', 'Exchange', 'Exchange Rate'],
]

/** 把数据集名解析成它所属的等价组 id（没有别名就用它自己的归一化名） */
function aliasGroupOf(name: string): string {
  const key = datasetKey(name)
  if (!key) return ''
  for (const group of DATASET_ALIAS_GROUPS) {
    if (group.some((g) => datasetKey(g) === key)) return `@alias:${datasetKey(group[0])}`
  }
  return key
}

/** 两个数据集名是否指同一个：**只**允许精确同名或落在同一别名组 */
export function sameDataset(a: string, b: string): boolean {
  const ga = aliasGroupOf(a)
  const gb = aliasGroupOf(b)
  return Boolean(ga) && ga === gb
}

/**
 * 数据集名的匹配层级（**仅用于在字段文本里定位相关句子**，不用于判断身份）：
 * 精确名 → 去掉尾部数字的族名（ETTh1 → ETTh）→ 字母前缀（ETTh → ETT）。
 * 之所以保留族名回退：论文常写「ETTh 为 1 小时、ETTm 为 15 分钟」，
 * 这时 ETTh1/ETTh2 都适用于「ETTh 为 1 小时」。身份判断仍走 sameDataset，不会混淆。
 */
function datasetFamilies(name: string): string[] {
  const raw = String(name || '').trim()
  if (!raw) return []
  const out = [raw]
  const noDigits = raw.replace(/[\d]+$/, '')
  if (noDigits && noDigits !== raw) out.push(noDigits)
  const alpha = (raw.match(/^[A-Za-z]+/) || [''])[0]
  if (alpha && !out.includes(alpha)) out.push(alpha)
  return out
}

function datasetsOf(paper: Paper): string[] {
  const raw = paper.fields.dataset?.value ?? ''
  if (!raw) return []
  return [...setOf(normalizeValue('dataset', raw))]
}

/** 论文里数据集名的**原始写法**（界面展示用，别把 ETTm1 显示成 ETTM1） */
export function rawDatasetsOf(paper: Paper): string[] {
  const raw = paper.fields.dataset?.value ?? ''
  if (!raw) return []
  return raw
    // 括号也要当分隔符：论文常写「ETT（ETTh1、ETTh2、ETTm1、ETTm2）」，
    // 不拆括号会得到 "ETT（ETTh1" 这种残缺名字，导致该数据集在第二篇里匹配不上。
    .split(/[、,，;；/|()（）\[\]【】]+|\s+以及\s+|\s+和\s+|\s+与\s+|\s+及\s+/)
    .map((s) => s.trim().replace(/^[-–—·•（(]+|[-–—·•）)]+$/g, ''))
    .filter((s) => s.length >= 2 && !/^(等|其他|其它|以及|和|与|及)$/.test(s))
}

/** 这篇论文是否用了某个数据集（按写法归一后的等价判断） */
export function paperUsesDataset(paper: Paper, dataset: string): boolean {
  return datasetsOf(paper).some((d) => sameDataset(d, dataset))
}

export interface DatasetOption {
  /** 展示用的名字（取第一篇论文里的写法） */
  name: string
  /** 用到它的论文 id */
  paperIds: string[]
  /** 各论文里的写法（可能不同，例如 Exchange-Rate / Exchange） */
  aliases: string[]
  /** 参与比较的论文总数（用于显示「2/3 篇包含」） */
  totalPapers: number
  /** 没有用到这个数据集的论文 id（这些论文在该项上必须标「信息不足」） */
  missingPaperIds: string[]
}

/**
 * 所选论文里出现的数据集及各自的覆盖情况。
 * 只有**至少 2 篇**用到的数据集才有比较价值，因此默认只返回这些；
 * 但如果传 withSingletons=true，也会返回只被 1 篇用到的数据集（用于界面上说明"只有 1 篇有"）。
 */
export function commonDatasets(papers: Paper[], withSingletons = false): DatasetOption[] {
  const usable = papers.filter((p) => p.status === 'parsed' || p.status === 'text-only')
  if (usable.length < 2) return []

  const options: DatasetOption[] = []
  usable.forEach((paper) => {
    for (const name of rawDatasetsOf(paper)) {
      let hit = options.find((o) => sameDataset(o.name, name))
      if (!hit) {
        // 只在第一篇出现时新建；否则说明这个数据集只有部分论文用到
        hit = { name, paperIds: [], aliases: [], totalPapers: usable.length, missingPaperIds: [] }
        options.push(hit)
      }
      if (!hit.paperIds.includes(paper.id)) hit.paperIds.push(paper.id)
      if (!hit.aliases.includes(name)) hit.aliases.push(name)
    }
  })

  options.forEach((o) => {
    o.missingPaperIds = usable.filter((p) => !o.paperIds.includes(p.id)).map((p) => p.id)
  })

  return options
    .filter((o) => (withSingletons ? true : o.paperIds.length >= 2))
    .sort((a, b) => b.paperIds.length - a.paperIds.length || a.name.localeCompare(b.name))
}

/**
 * 「通用子句」的识别：这些说法描述的是**跨数据集的统一设置**，因此适用于任何一个目标数据集。
 * 实测踩过的坑：Autoformer 写「多变量主实验 O ∈ {96,192,336,720}；ILI 为 {24,36,48,60}」，
 * 如果把「主实验」当成"只说了别的东西"，Traffic / ETTm1 就会被误判成"论文没说明"→ 判信息不足。
 * 这类统一表述必须能命中通用子句。
 */
const GENERAL_CLAUSE =
  /其余|其他|其它|所有|全部|每个|各数据集|统一|均如此|都如此|全部数据集|主实验|主要实验|主设置|主要设置|多数数据集|others?|all datasets|every dataset|each dataset|main experiments?|remaining/i

function splitClauses(text: string): string[] {
  return text
    .split(/[；;。\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function splitFine(clause: string): string[] {
  return clause
    .split(/[、，]|,\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 按数据集裁剪字段文本。
 *
 * 三种情况要分清：
 *  a) 文本里明确提到目标数据集（或「其余数据集」这类通用说法）→ 返回相关那一段；
 *  b) 文本提到的是**别的**数据集、没提目标数据集 → 返回 null（这篇没说明该数据集的这一项）；
 *  c) 文本没有提到任何数据集 → 这是论文级的全局设置，各数据集通用 → 原样返回。
 * 不做 (c) 的区分会把「主设置 96 步」这类全局值误判成"该数据集没说明"，从而错误地判成信息不足。
 *
 * @param knownDatasets 这篇论文用到的数据集名（原始写法），用于区分 b 与 c
 * @returns 该数据集相关的文本；null 表示「论文没有单独说明这个数据集」
 */
export function scopedValue(
  raw: string | null | undefined,
  dataset: string | null,
  knownDatasets: string[] = [],
): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  if (!dataset) return text

  const clauses = splitClauses(text)
  if (clauses.length === 0) return text

  const families = datasetFamilies(dataset)
  // 从最精确的写法开始试，避免 "ETT" 把 ETTh1 与 ETTm1 混在一起
  for (const token of families) {
    const needle = token.toLowerCase()
    const hits: string[] = []
    for (const clause of clauses) {
      if (!clause.toLowerCase().includes(needle)) continue
      const parts = splitFine(clause)
      const sub = parts.filter((p) => p.toLowerCase().includes(needle))
      // 一条里同时列了别的数据集 → 只取与目标数据集相关的部分
      if (sub.length > 0 && sub.length < parts.length) hits.push(...sub)
      else hits.push(clause)
    }
    if (hits.length > 0) return [...new Set(hits)].join('；')
  }

  // 退一步：论文用「其余数据集」「主实验」这类说法统一描述的设置同样适用于该数据集。
  // 同时把**没有提到任何具体数据集**的子句也算进来（那同样是全局设置，
  // 例如「主设置 192 步；额外迁移到 96 与 336 步」两句都是全局的，不该只保留前一句）。
  const mentionsAnyDataset = (c: string) =>
    knownDatasets.some((d) => {
      const t = d.toLowerCase()
      return t.length >= 3 && c.toLowerCase().includes(t)
    })
  const general = clauses.filter(
    (c) => GENERAL_CLAUSE.test(c) || (knownDatasets.length > 0 && !mentionsAnyDataset(c)),
  )
  if (general.length > 0) return [...new Set(general)].join('；')

  // 文本里有没有提到这篇论文的**其他**数据集？提到过 → 说明这项是按数据集分别写的，本篇没写目标数据集
  const mentionedOthers = knownDatasets.some((d) => {
    if (sameDataset(d, dataset)) return false
    return families.length > 0 && clauses.some((c) => c.toLowerCase().includes(d.toLowerCase()))
  })
  if (mentionedOthers) return null

  // 什么都没提到 → 全局设置，适用于所有数据集
  return text
}

/** 面向用户的口径说明 */
export function describeScope(dataset: string | null): string {
  return dataset ? `限定在共同数据集「${dataset}」上比较` : '不限定数据集（按论文整体口径）'
}
