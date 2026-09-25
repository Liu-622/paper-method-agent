/** 打印工具在多个数据集口径下的实际判定（用于核对 gold 与工具谁对） */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'node_modules', '.cache', 'bench-entry.mjs')
await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'bench-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})
const { analyze } = await import(new URL(`file://${out.replace(/\\/g, '/')}`).href)

const load = (n, short) => {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cache', `${n}.json`), 'utf8'))
  return { id: n, shortLabel: short, fileName: j.fileName, title: j.fileName, pages: j.pages, fields: j.extract.fields, coverage: j.extract.coverage }
}
const inputs = [load('dlinear', 'U1'), load('autoformer', 'U2')]
const scopes = [null, 'ETTh1', 'ETTh2', 'ETTm1', 'Traffic', 'Weather', 'ILI']
const t = analyze(inputs, scopes)

console.log('== 各区间的字段取值（结构化实验记录） ==')
for (const p of t.records) {
  console.log(`\n${p.shortLabel}（${p.paperId}）`)
  for (const r of p.records) {
    console.log(
      `  ${r.dataset.padEnd(16)} status=${r.status.padEnd(12)} split=${String(r.split).slice(0, 26).padEnd(26)} interval=${String(r.sampleInterval).slice(0, 24).padEnd(24)} horizon=${String(r.horizon).slice(0, 30)}`,
    )
  }
}

for (const scope of scopes) {
  const key = scope === null ? 'none' : scope
  console.log(`\n== 口径：${scope ?? '（整体）'} ==`)
  for (const f of t.fairnessByScope[key]) {
    if (!['fair-dataset', 'fair-split', 'fair-horizon', 'fair-metrics'].includes(f.id)) continue
    console.log(`  [${f.verdict}] ${f.label}`)
    console.log(`      ${f.reason.slice(0, 150)}`)
  }
}
