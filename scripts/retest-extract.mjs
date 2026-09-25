/**
 * 三篇论文的抽取回归 + 修复前后对照
 * ------------------------------------------------------------------
 * 用法（后端需运行，且带模型凭据）：
 *   node scripts/retest-extract.mjs                 # 只跑「修复后」
 *   node scripts/retest-extract.mjs --before        # 只跑「修复前」（关闭二次检索）
 *   node scripts/retest-extract.mjs --both          # 前后都跑（需要重启后端切换开关）
 *
 * 说明：EXTRACT_SECOND_PASS=0 时后端等价于修复前行为，所以 --before 需要后端以该环境变量启动。
 * 为了不来回重启，本脚本用「同一后端进程 + 请求参数」无法切换，因此：
 *   - --after（默认）在正常后端上跑；
 *   - --before 会先检查后端是否为关闭状态，否则给出明确提示。
 * 结果写入 docs/results/extract-<阶段>.json，并打印字段级对照表。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const API = process.env.API_BASE || 'http://127.0.0.1:8787'
const stage = process.argv.includes('--before') ? 'before' : 'after'

const PAPERS = [
  { id: 'autoformer-nips21', label: 'Autoformer', file: '01_Autoformer_NeurIPS2021.pdf' },
  { id: 'fedformer-icml22', label: 'FEDformer', file: '02_FEDformer_ICML2022.pdf' },
  { id: 'patchtst-iclr23', label: 'PatchTST', file: '03_PatchTST_ICLR2023.pdf' },
]

async function extractPages(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(file))
  const task = pdfjs.getDocument({ data, useSystemFonts: false })
  const doc = await task.promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let text = ''
    let lastY = null
    for (const item of content.items) {
      if (!('str' in item)) continue
      const y = item.transform?.[5]
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) text += '\n'
      text += item.str
      lastY = y
    }
    pages.push({ page: i, text: text.trim() })
  }
  return pages
}

const health = await (await fetch(`${API}/api/health`)).json()
console.log(`后端：hasCredentials=${health.hasCredentials} model=${health.model} style=${health.apiStyle}`)
console.log(`阶段：${stage === 'before' ? '修复前（二次检索关闭）' : '修复后（含定向二次检索）'}\n`)
if (stage === 'before' && process.env.EXTRACT_SECOND_PASS !== '0') {
  console.log('⚠️  要得到真实"修复前"数据，请用 EXTRACT_SECOND_PASS=0 重启后端后再跑 --before。')
  console.log('   本次仍会请求后端，但后端若开着二次检索，结果会与"修复后"一致。\n')
}

const out = {}
for (const p of PAPERS) {
  const file = path.join(root, 'testpapers', p.file)
  if (!fs.existsSync(file)) {
    console.log(`=== ${p.label}：跳过（找不到 ${p.file}）`)
    out[p.id] = { label: p.label, skipped: true, reason: `missing ${p.file}` }
    continue
  }
  process.stdout.write(`=== ${p.label}：读取 PDF … `)
  const pages = await extractPages(file)
  const chars = pages.reduce((n, pg) => n + pg.text.length, 0)
  console.log(`${pages.length} 页 / ${chars.toLocaleString()} 字符`)

  const started = Date.now()
  const res = await fetch(`${API}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pages, fileName: p.file, title: p.label }),
  })
  const json = await res.json()
  if (!json.ok) {
    console.log(`  抽取失败：${json.message}`)
    out[p.id] = { label: p.label, error: json.message }
    continue
  }
  const elapsed = Date.now() - started
  out[p.id] = { label: p.label, pages: pages.length, chars, elapsedMs: elapsed, fields: json.fields, warnings: json.warnings }

  const show = (k) => {
    const f = json.fields[k]
    if (!f) return '（无）'
    const tag = f.checkState === 'retrieval' ? '★漏抽找回' : f.checkState === 'not_reported' ? '未报告' : f.checkState === 'unchecked' ? '未检查' : ''
    return `${f.status}${tag ? `/${tag}` : ''}${f.value ? `：${String(f.value).slice(0, 70)}` : ''}`
  }
  console.log(`  抽取完成 ${elapsed}ms`)
  for (const k of ['dataset', 'split', 'sampleInterval', 'evalProtocol', 'baselines', 'metrics', 'horizon']) {
    console.log(`    ${k.padEnd(14)} ${show(k)}`)
  }
  const per = json.fields.split?.perDataset
  if (per?.perDataset?.length) {
    console.log(`    split 按数据集：${per.perDataset.map((e) => `${e.dataset}=${String(e.value).slice(0, 24)}`).join(' | ')}`)
  }
  const perInt = json.fields.sampleInterval?.perDataset
  if (perInt?.perDataset?.length) {
    console.log(`    间隔 按数据集：${perInt.perDataset.map((e) => `${e.dataset}=${String(e.value).slice(0, 24)}`).join(' | ')}`)
  }
  const recovered = Object.entries(json.fields).filter(([, f]) => f.checkState === 'retrieval').map(([k]) => k)
  if (recovered.length) console.log(`  ★ 初次漏抽并找回：${recovered.join('、')}`)
  console.log('')
}

fs.mkdirSync(path.join(root, 'docs', 'results'), { recursive: true })
const outFile = path.join(root, 'docs', 'results', `extract-${stage}.json`)
fs.writeFileSync(outFile, JSON.stringify(out, null, 2))
console.log(`已写入 ${path.relative(root, outFile)}`)
