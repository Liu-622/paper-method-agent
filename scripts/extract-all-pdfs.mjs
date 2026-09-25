/**
 * 批量抽取 testpapers 里 12 篇真实 PDF 的正文（纯 pdfjs 文本抽取，不调用模型），
 * 产出 public/catalog-pages.json 供前端「导入真实正文」使用。
 * 用法：node scripts/extract-all-pdfs.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

const PAPERS = [
  ['informer', '2012.07436', 'testpapers/real/informer.pdf'],
  ['nbeats', '1905.10437', 'testpapers/real/nbeats.pdf'],
  ['scinet', '2106.09305', 'testpapers/real/scinet.pdf'],
  ['etsformer', '2202.01381', 'testpapers/real/etsformer.pdf'],
  ['timesnet', '2210.02186', 'testpapers/real/timesnet.pdf'],
  ['crossformer', '2211.14729', 'testpapers/real/crossformer.pdf'],
  ['micn', '2212.05520', 'testpapers/real/micn.pdf'],
  ['itransformer', '2310.06625', 'testpapers/real/itransformer.pdf'],
  ['autoformer', '2106.13008', 'testpapers/01_Autoformer_NeurIPS2021.pdf'],
  ['fedformer', '2201.12740', 'testpapers/02_FEDformer_ICML2022.pdf'],
  ['patchtst', '2211.14730', 'testpapers/03_PatchTST_ICLR2023.pdf'],
  ['dlinear', '2205.13504', 'testpapers/DLinear-Are-Transformers-Effective.pdf'],
]

async function extract(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const doc = await pdfjs.getDocument({ data }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let text = ''
    let lastY = null
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue
      const y = item.transform?.[5]
      if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 2) text += '\n'
      text += item.str
      if (item.hasEOL) text += '\n'
      if (typeof y === 'number') lastY = y
    }
    pages.push({ page: i, text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() })
  }
  return { numPages: doc.numPages, pages }
}

const out = { extractedAt: new Date().toISOString(), papers: [] }
for (const [id, arxiv, pdfPath] of PAPERS) {
  if (!fs.existsSync(pdfPath)) {
    console.log(`SKIP ${id}: 缺文件 ${pdfPath}`)
    continue
  }
  const { numPages, pages } = await extract(pdfPath)
  const chars = pages.reduce((s, p) => s + p.text.length, 0)
  out.papers.push({ id, arxiv, fileName: path.basename(pdfPath), numPages, chars, pages })
  console.log(`${id}: ${numPages} 页 / ${chars} 字符`)
}

fs.mkdirSync('public', { recursive: true })
fs.writeFileSync('public/catalog-pages.json', JSON.stringify(out))
console.log(`已写 public/catalog-pages.json（${(JSON.stringify(out).length / 1024 / 1024).toFixed(2)} MB，${out.papers.length} 篇）`)
