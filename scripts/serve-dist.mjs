/**
 * 极简静态服务器：用于本地预览构建产物（dist/），或部署到任意支持静态托管的平台。
 * 用法：node scripts/serve-dist.mjs [port]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..', 'dist')
const port = Number(process.argv[2] || process.env.PORT || 4173)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

if (!fs.existsSync(root)) {
  console.error(`[serve-dist] 没有找到构建产物目录：${root}`)
  console.error('[serve-dist] 请先执行：npm run build')
  process.exit(1)
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  let filePath = path.join(root, url === '/' ? 'index.html' : url)

  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // 单页应用：未知路径回退到 index.html
    filePath = path.join(root, 'index.html')
  }

  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(filePath).pipe(res)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[serve-dist] 本地预览已启动： http://127.0.0.1:${port}/`)
})
