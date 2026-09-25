/**
 * 检查逻辑回归测试（Node 直接跑，不调用模型）
 * ------------------------------------------------------------------
 * 覆盖三件容易出错的事：
 *  1. 共同数据集口径：集合不同 ≠ 共同实验不可比较；按数据集裁剪字段文本；
 *  2. 未检查 vs 未找到：有页面未处理时不能声称「论文没写」；
 *  3. 复合判定：划分（比例+区间）、跨度（步数集合+采样间隔集合）。
 *
 * 用法：npm run test:logic
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const outfile = path.join(root, 'node_modules', '.cache', 'logic-test.mjs')
fs.mkdirSync(path.dirname(outfile), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(root, 'scripts', 'logic-test-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  alias: { '@': path.join(root, 'src'), '@server': path.join(root, 'server') },
  logLevel: 'warning',
})

const { run } = await import(pathToFileUrl(outfile))
const result = run()
console.log(result.text)
process.exit(result.failed === 0 ? 0 : 1)

function pathToFileUrl(p) {
  return new URL(`file://${p.replace(/\\/g, '/')}`).href
}
