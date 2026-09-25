/** 直接探测裸问答接口（用真实论文正文），确认返回长度与报错 */
import fs from 'node:fs'

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const names = process.argv.slice(2)
const papers = []
for (const n of names.length ? names : ['dlinear', 'autoformer']) {
  const j = JSON.parse(fs.readFileSync(`benchmark/cache/${n}.json`, 'utf8'))
  papers.push({ id: n, shortLabel: n === 'dlinear' ? 'U1' : 'U2', title: j.fileName, pages: j.pages })
}
console.log(`论文：${papers.map((p) => `${p.shortLabel}(${p.pages.length}页)`).join('、')}`)

const res = await fetch(`${API_BASE}/api/bench/raw-ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    question: '这两篇论文的实验结果能直接比较吗？如果不完全能，请说明在什么条件下可以比较。',
    papers,
  }),
})
const json = await res.json()
console.log('状态：', res.status, 'ok=', json.ok, '耗时=', json.elapsedMs, 'ms')
if (!json.ok) console.log('错误：', JSON.stringify(json).slice(0, 400))
console.log('返回长度：', (json.text || '').length)
console.log('前 300 字：', (json.text || '').slice(0, 300))
