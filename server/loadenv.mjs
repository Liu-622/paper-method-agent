/**
 * 统一启动方案的唯一配置入口。
 * ------------------------------------------------------------------
 * 开发启动（npm run api / node server/index.mjs）、开发脚本
 * （scripts/start-local.ps1、scripts/restart-local.ps1）与便携版入口
 * （start.ps1）都**不再各自注入环境变量**，一律由本模块读取。
 * 这样「配置存在但没被注入」这类问题不会再因为启动方式不同而复现。
 *
 * 明确的优先级（高 → 低），前面的命中后不再被后面的覆盖：
 *   1. 进程环境变量（外部注入 / 系统已设置）—— 始终优先，便于 CI 与临时覆盖
 *   2. .env.local   （本地开发与便携版的标准配置文件，被 gitignore）
 *   3. .env         （通用兜底）
 *   4. config.env   （旧版便携包遗留的文件名，继续兼容）
 *   5. 内置默认值（在 llm.mjs 里：anthropic 风格、deepseek-chat 等）
 *
 * 安全约定：本模块只在进程内读写；不打印任何密钥内容，
 * envReport() 也只回传「键名与来源」，不含取值。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

/** 受支持的本地配置文件，按优先级从高到低。 */
export const CONFIG_FILES = ['.env.local', '.env', 'config.env']

/** 关心的配置键（仅用于报告来源，不读值）。 */
const WATCHED = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_STYLE', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'PORT']

const appliedByFile = {}
const filesPresent = []

for (const name of CONFIG_FILES) {
  const file = path.join(root, name)
  if (!fs.existsSync(file)) continue
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  filesPresent.push(name)
  const applied = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/^\uFEFF/, '').trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 1) continue
    const key = t.slice(0, eq).trim()
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    // 高优先级的来源已经设过，就不再覆盖 —— 进程环境变量永远赢。
    if (process.env[key] === undefined) {
      process.env[key] = val
      applied.push(key)
    }
  }
  appliedByFile[name] = applied
}

/**
 * 启动配置报告：说明「配置从哪来、有没有」。
 * 绝不含密钥取值 —— 只回传键名、来源文件名与凭据是否存在。
 */
export function envReport() {
  const fromProcess = WATCHED.filter((k) => process.env[k] !== undefined && !Object.values(appliedByFile).some((list) => list.includes(k)))
  const fromFile = Object.entries(appliedByFile)
    .filter(([, keys]) => keys.length > 0)
    .map(([file, keys]) => ({ file, keys }))
  return {
    priority: ['process-env', ...CONFIG_FILES, 'built-in-defaults'],
    filesPresent,
    fromProcess,
    fromFile,
    hasCredentials: Boolean(process.env.LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    guidance: Boolean(process.env.LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
      ? '模型能力可用：真实论文抽取、方法分析、带出处问答与模型探索都走真实调用。'
      : '未检测到模型密钥：页面、示例、已有分析结果与离线实验可用；真实论文抽取 / 方法分析 / 带出处问答会明确返回「未配置模型」，不会用规则结果冒充模型结果。',
  }
}
