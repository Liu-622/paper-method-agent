const fs = require('fs')
const path = require('path')
const root = process.cwd()
const load = (n) => JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cache', `${n}.json`), 'utf8'))
const papers = [
  ['U1 DLinear', load('dlinear')],
  ['U2 Autoformer', load('autoformer')],
]

const probes = [
  ['GPU / 显卡型号', /(TITAN|V100|A100|RTX|GTX|Tesla|GPU|graphics card)/i],
  ['GPU 数量', /(\b1\b|\bone\b|\bsingle\b|\btwo\b|\b4\b|\beight\b)[^.\n]{0,40}(GPU|GPUs)/i],
  ['训练总时长 / wall time', /(training time|wall[\s-]?clock|hours of training|trained for|training cost|total time)/i],
  ['训练代价 / 成本', /(computational cost|training cost|flops|gpu[\s-]hours|gpu hours)/i],
  ['随机种子', /(random seed|seed\b)/i],
  ['学习率', /(learning rate|\blr\b\s*=|AdamW|Adam\b)/i],
  ['批大小', /(batch size|\bbatch\b\s*=)/i],
]

for (const [label, p] of papers) {
  console.log('=== ' + label + '（' + p.pages.length + ' 页）')
  for (const [name, re] of probes) {
    const hits = []
    for (const pg of p.pages) {
      const text = String(pg.text || '')
      const m = text.match(re)
      if (m) {
        const idx = text.indexOf(m[0])
        hits.push({ page: pg.page, snippet: text.slice(Math.max(0, idx - 70), idx + 90).replace(/\s+/g, ' ') })
      }
    }
    console.log(`- ${name}: 命中 ${hits.length} 页` + (hits.length ? ` → p.${hits.map((h) => h.page).join(',p.')}` : ''))
    hits.slice(0, 2).forEach((h) => console.log(`    p.${h.page}: …${h.snippet}…`))
  }
}
