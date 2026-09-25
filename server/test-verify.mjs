/**
 * 引用校验 / 集合型核验 的单元自测（不调用模型，秒级完成）
 * 用法：node server/test-verify.mjs
 */
import { normalizeText, verifyAggregateValue, verifyQuote } from './llm.mjs'

const pages = [
  {
    page: 4,
    text: [
      'Datasets. We evaluate on nine real-world datasets: ETT (Electricity Transformer',
      'Temperature) [30] (ETTh1, ETTh2, ETTm1, ETTm2), Traffic, Electricity, Weather, ILI and Exchange-',
      'Rate [15]. All of them are multivariate time series.',
    ].join('\n'),
  },
  {
    page: 7,
    text: 'Implementation details. Our method is trained with the L2 loss, using the ADAM [22] optimizer with an initial learning rate of 10 \u22124 . Batch size is set to 32.',
  },
]

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  [PASS] ${name}`)
  } else {
    fail += 1
    console.log(`  [FAIL] ${name}${extra ? `  ${extra}` : ''}`)
  }
}

console.log('== 1. 逐字引用校验 ==')
check('整句一致 → 通过', verifyQuote(pages, 4, 'ETTh1, ETTh2, ETTm1, ETTm2), Traffic, Electricity, Weather, ILI and Exchange-').ok === true)
check(
  'Unicode 减号与空格（10 −4）能被识别',
  verifyQuote(pages, 7, 'an initial learning rate of 10 \u22124 . Batch size is set to 32.').ok === true,
)
check(
  '写成 10^-4 也能匹配到原文',
  verifyQuote(pages, 7, 'an initial learning rate of 10^-4. Batch size is set to 32.').ok === true,
)
check('跨行断词 Exchange-\\nRate 能匹配', (() => {
  const r = verifyQuote(pages, 4, 'Weather, ILI and Exchange-\nRate [15]. All of them are multivariate time series.')
  return r.ok === true && r.page === 4
})())
check('页码标错 → 自动修正到实际页', (() => {
  const r = verifyQuote(pages, 99, 'ETTh1, ETTh2, ETTm1, ETTm2), Traffic, Electricity, Weather, ILI and Exchange-')
  return r.ok === true && r.page === 4 && r.corrected === true
})())
check('编造的句子 → 拒绝', verifyQuote(pages, 4, 'The dataset was collected from a nuclear power plant in 2015.').ok === false)
check('过短引用 → 拒绝', verifyQuote(pages, 4, 'Datasets').ok === false)

console.log('== 2. 集合型字段核验（数据集/指标/基线） ==')
const agg = verifyAggregateValue(
  pages,
  'ETTh1、ETTh2、ETTm1、ETTm2、Traffic、Electricity、Weather、ILI、Exchange-Rate',
)
check('名字全部能在正文找到 → 通过', agg.ok === true, `hitRatio=${agg.hitRatio}`)
check('证据取自正文原句（不是模型写的句子）', agg.evidence.length > 0 && (() => {
  return agg.evidence.every((e) => {
    const page = pages.find((p) => p.page === e.page)
    return page && normalizeText(page.text).includes(normalizeText(e.quote))
  })
})())
check(
  '片段起止落在词边界（不出现断头断尾）',
  agg.evidence.every((e) => {
    const page = pages.find((p) => p.page === e.page)
    if (!page) return false
    const flatRaw = page.text.replace(/\s+/g, ' ')
    const flat = e.quote.replace(/\s+/g, ' ')
    const at = flatRaw.indexOf(flat)
    if (at < 0) return false
    const okStart = at === 0 || flatRaw[at - 1] === ' '
    const okEnd = at + flat.length >= flatRaw.length || /[\s.,;:)\]]/.test(flatRaw[at + flat.length])
    return okStart && okEnd
  }),
)
agg.evidence.forEach((e) => console.log(`      · p.${e.page}: ${e.quote.replace(/\n/g, ' / ')}`))

const bogus = verifyAggregateValue(pages, 'ETTh1、ETTh2、Traffic、Chernobyl、Fukushima')
check('有编造的名字 → 命中率不足，拒绝', bogus.ok === false, `hitRatio=${bogus.hitRatio}`)

console.log('\n== 3. 边界情况 ==')
check('空值 → 拒绝', verifyAggregateValue(pages, '').ok === false)
check('单一名字（不足 2 个）→ 拒绝', verifyAggregateValue(pages, 'Traffic').ok === false)

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
