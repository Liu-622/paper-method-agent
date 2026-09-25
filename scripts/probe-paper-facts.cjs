const fs = require('fs')
const path = require('path')
const root = process.cwd()

async function pages(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(path.join(root, 'testpapers', file)))
  const doc = await (await pdfjs.getDocument({ data, useSystemFonts: false })).promise
  const out = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const p = await doc.getPage(i)
    const c = await p.getTextContent()
    out.push({ page: i, text: c.items.map((it) => ('str' in it ? it.str : '')).join(' ') })
  }
  return out
}

const probes = [
  ['评估协议 single-shot / rolling', /(single[\s-]?(?:shot|step)|multi[\s-]?step|roll(?:ing)?|autoregressive|auto-regressive|one[\s-]?(?:shot|pass)|iterat(?:ive|ively)|directly predict)/i],
  ['数据集名称出现', /(ETTh1|ETTm1|Traffic|Electricity|Weather|ILI|Exchange)/],
  ['数据集集合句', /(datasets?|benchmarks?)/i],
]

;(async () => {
  for (const [file, label] of [
    ['01_Autoformer_NeurIPS2021.pdf', 'Autoformer'],
    ['02_FEDformer_ICML2022.pdf', 'FEDformer'],
    ['03_PatchTST_ICLR2023.pdf', 'PatchTST'],
  ]) {
    const ps = await pages(file)
    console.log('=== ' + label + '（' + ps.length + ' 页）')
    for (const [name, re] of probes) {
      const hits = []
      for (const p of ps) {
        const m = p.text.match(re)
        if (m) {
          const i = p.text.indexOf(m[0])
          hits.push({ page: p.page, snippet: p.text.slice(Math.max(0, i - 80), i + 120).replace(/\s+/g, ' ') })
        }
      }
      console.log(`- ${name}: 命中 ${hits.length} 页` + (hits.length ? ` → p.${hits.map((h) => h.page).join(',p.')}` : ''))
      hits.slice(0, 3).forEach((h) => console.log(`    p.${h.page}: …${h.snippet}…`))
    }
  }
})()
