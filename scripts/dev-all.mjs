/**
 * 一键启动：同时起后端（API）与前端开发服务器。
 * 用法： npm start
 * ------------------------------------------------------------------
 * 后端负责真实字段抽取与真实问答（模型密钥只在后端读取），
 * 前端 dev server 通过 vite 代理把 /api 转发到后端。
 * 只想跑构建产物时：npm run build && node server/index.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const isWin = process.platform === 'win32'
const npm = isWin ? 'npm.cmd' : 'npm'

function run(name, args, extraEnv = {}) {
  const child = spawn(npm, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...extraEnv },
  })
  child.on('exit', (code) => {
    console.log(`[dev-all] ${name} 已退出（code=${code}）`)
    process.exit(code ?? 0)
  })
  return child
}

console.log('[dev-all] 启动后端 API（默认 http://127.0.0.1:8787）…')
const api = run('api', ['run', 'api'])

console.log('[dev-all] 启动前端 dev server…')
const web = run('web', ['run', 'dev'])

const stop = () => {
  api.kill()
  web.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
