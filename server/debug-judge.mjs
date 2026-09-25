/**
 * 排查脚本：单独观察两个复核步骤与裸模型问答的真实返回
 * 用法：node server/debug-judge.mjs
 */
import { judgeClaims, judgeSupport, rawAsk, classifyClaim } from './llm.mjs'

const claims = [
  { id: 'p0', kind: 'paragraph', text: 'DLinear 在 ETTm1 上使用 15 分钟采样间隔。' },
  { id: 'b0', kind: 'bullet', text: '两篇论文的采样间隔不同，因此不能直接比较它们的 MSE。' },
  { id: 'b1', kind: 'bullet', text: '本次只提供了 1 篇论文正文，无法进行跨论文比较。' },
]
const evidence = [
  {
    id: 'e0',
    evidenceId: 'ev-u1-sampleInterval-0',
    shortLabel: 'U1',
    page: 5,
    quote: 'ETTm1 is recorded every 15 minutes, while Weather is sampled every 10 minutes.',
  },
]

console.log('--- classifyClaim ---')
claims.forEach((c) => console.log(`  ${c.id}: ${classifyClaim(c.text, { paperCount: 2 })}`))

console.log('\n--- judgeClaims（行格式） ---')
const jc = await judgeClaims({ claims, evidence })
console.log(JSON.stringify(jc, null, 2))

console.log('\n--- judgeSupport（字段级） ---')
const js = await judgeSupport([
  { id: 'dataset', claim: 'dataset = ETTm1、Weather', page: 5, quote: evidence[0].quote },
  { id: 'horizon', claim: 'horizon = 96 步', page: 5, quote: evidence[0].quote },
])
console.log(JSON.stringify(js, null, 2))

console.log('\n--- rawAsk（裸模型） ---')
const raw = await rawAsk({
  question: '这两篇论文的实验结果能直接比较吗？',
  papers: [
    {
      id: 'u1',
      shortLabel: 'U1',
      title: 'test',
      pages: [
        {
          page: 1,
          text:
            'We evaluate on ETTm1 and Weather. ETTm1 is recorded every 15 minutes. The test set is the final 20% of the series. We use default hyper-parameters, see our code for details.',
        },
        { page: 2, text: 'Our model achieves an MSE of 0.4 on ETTm1 with a prediction length of 96.' },
      ],
    },
  ],
})
console.log(`  返回长度 ${raw.text.length}｜前 200 字：${raw.text.slice(0, 200)}`)
