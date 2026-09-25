/**
 * 验收演示 1 & 2 的实际输出
 * ------------------------------------------------------------------
 * 演示 1：同一论文、同一风险，CPU + 1 小时 与 GPU + 3 天，计划具体差在哪
 * 演示 2：同一资源条件，换一种风险，实验步骤怎么变
 *
 * 用法：node scripts/plan-variations.mjs  → 写入 docs/PLAN-VARIATIONS.md
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'node_modules', '.cache', 'plan-var-entry.mjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'plan-var-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})
const { runVariations } = await import(new URL(`file://${out.replace(/\\/g, '/')}`).href)
const md = runVariations()
fs.writeFileSync(path.join(root, 'docs', 'PLAN-VARIATIONS.md'), md)
console.log(`已写入 docs/PLAN-VARIATIONS.md（${md.length} 字符）`)
