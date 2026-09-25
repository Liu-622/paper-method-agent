/**
 * 生成两个示例场景的**实际输出**（确定性，不调用模型）
 * ------------------------------------------------------------------
 * 场景 A：仅 CPU + 1 小时以内 + 先跑通流程
 * 场景 B：单张 GPU + 1 天 + 检查比较是否公平
 *
 * 论文用的是项目里的演示论文（虚构，界面处处标注为演示数据）。
 * 输出写入 docs/PLAN-EXAMPLES.md，作为"计划长什么样"的可核对证据。
 *
 * 用法：node scripts/plan-demo.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const out = path.join(root, 'node_modules', '.cache', 'plan-demo-entry.mjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'plan-demo-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { '@': path.join(root, 'src') },
  logLevel: 'warning',
})
const { runDemo } = await import(new URL(`file://${out.replace(/\\/g, '/')}`).href)
const result = runDemo()
fs.writeFileSync(path.join(root, 'docs', 'PLAN-EXAMPLES.md'), result.markdown)
console.log(`已写入 docs/PLAN-EXAMPLES.md（${result.markdown.length} 字符）`)
console.log(result.summary)
