const fs = require('fs')
const path = require('path')
const root = process.cwd()
const file = process.argv[2] || '03_PatchTST_ICLR2023.pdf'
const re = new RegExp(process.argv[3] || '(15\\s*min|1\\s*hour|hourly|采样|frequency|Granularity|unit)', 'i')

;(async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(path.join(root, 'testpapers', file)))
  const doc = await (await pdfjs.getDocument({ data, useSystemFonts: false })).promise
  const out = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const p = await doc.getPage(i)
    const c = await p.getTextContent()
    const text = c.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ')
    let m
    const rx = new RegExp(re.source, 'gi')
    while ((m = rx.exec(text)) !== null) {
      out.push({ page: i, snippet: text.slice(Math.max(0, m.index - 110), m.index + 140) })
      if (out.length > 40) break
    }
  }
  console.log(`${file}：命中 ${out.length} 处`)
  out.slice(0, 20).forEach((h) => console.log(`  p.${h.page}: …${h.snippet}…`))
})()
