/**
 * 端到端自测（服务端跑，不依赖浏览器）
 * ------------------------------------------------------------------
 * 1) 用 pdfjs-dist 读取真实 PDF，按页得到正文（和浏览器端同一套库）
 * 2) 调用后端 /api/extract 做真实字段抽取
 * 3) 调用后端 /api/ask 做真实问答
 * 4) 校验：引用是否都能在对应页里逐字找到
 *
 * 用法：node server/test-e2e.mjs [pdf路径] [问题]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const API = process.env.API_BASE || 'http://127.0.0.1:8787'

const pdfPath =
  process.argv[2] || path.join(root, 'testpapers', 'DLinear-Are-Transformers-Effective.pdf')
const question = process.argv[3] || '这篇论文用了什么数据集、预测跨度和评价指标？训练细节（学习率、批大小、训练轮数、随机种子）写清楚了吗？'

/** 独立校验用的归一化：只做「同义写法」层面的统一，不放松逐字要求 */
function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/\u00ad/g, '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/[\u2010-\u2015\u2212\u2043\ufe63\uff0d]/g, '-')
    .replace(/(\d)\s*-\s*(?=\d)/g, '$1-')
    .replace(/\s+([.,;:!?)\]])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

async function extractPages(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(file))
  const task = pdfjs.getDocument({ data, useSystemFonts: false })
  const doc = await task.promise
  const pages = []
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let out = ''
      let lastY = null
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        const y = item.transform?.[5]
        if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 2) out += '\n'
        out += item.str
        if (item.hasEOL) out += '\n'
        if (typeof y === 'number') lastY = y
      }
      pages.push({
        page: i,
        text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
      })
      page.cleanup()
    }
  } finally {
    try {
      await task.destroy()
    } catch {
      /* ignore */
    }
  }
  return pages
}

async function post(pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`非 JSON 响应（${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}：${json.message || text.slice(0, 200)}${json.detail ? `\n   detail: ${String(json.detail).slice(0, 400)}` : ''}`)
  return json
}

function verifyCitations(pages, citations) {
  const bad = []
  citations.forEach((c, idx) => {
    const p = pages.find((x) => x.page === c.page)
    if (!p || !normalize(p.text).includes(normalize(c.quote))) {
      bad.push(`#${idx + 1} p.${c.page} :: ${String(c.quote).slice(0, 80)}`)
    }
  })
  return bad
}

async function main() {
  console.log('=== 0. 健康检查 ===')
  const health = await (await fetch(`${API}/api/health`)).json()
  console.log(JSON.stringify(health, null, 2))
  if (!health.hasCredentials) {
    console.log('!! 后端没有模型密钥，后续请求会失败')
  }

  console.log('\n=== 1. 读取 PDF ===')
  const pages = await extractPages(pdfPath)
  const totalChars = pages.reduce((n, p) => n + p.text.length, 0)
  console.log(`文件：${path.basename(pdfPath)}`)
  console.log(`页数：${pages.length}，字符数：${totalChars}`)
  console.log(`第 1 页前 160 字：${pages[0].text.slice(0, 160).replace(/\n/g, ' ')}`)

  console.log('\n=== 2. 真实字段抽取 ===')
  const t0 = Date.now()
  const ex = await post('/api/extract', {
    fileName: path.basename(pdfPath),
    title: 'Are Transformers Effective for Time Series Forecasting?',
    pages,
  })
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，使用页：${ex.pagesUsed.join(',')}`)
  if (ex.warnings?.length) ex.warnings.forEach((w) => console.log(`  ⚠️ ${w}`))

  const keys = Object.keys(ex.fields || {})
  const byStatus = { found: [], missing: [], uncertain: [] }
  keys.forEach((k) => {
    const s = ex.fields[k].status
    ;(byStatus[s] || byStatus.missing).push(k)
  })
  console.log(`字段数：${keys.length}；已找到 ${byStatus.found.length} / 未找到 ${byStatus.missing.length} / 需确认 ${byStatus.uncertain.length}`)
  keys.forEach((k) => {
    const f = ex.fields[k]
    const ev = f.evidence?.[0]
    console.log(
      `  [${f.status}] ${k}${ev ? ` (p.${ev.page})` : ''}${
        f.note ? ` 说明：${String(f.note).slice(0, 60)}` : ''
      }`,
    )
  })
  console.log(`  · 已找到：${byStatus.found.join(', ')}`)
  console.log(`  · 未找到：${byStatus.missing.join(', ')}`)
  console.log(`  · 需确认：${byStatus.uncertain.join(', ')}`)

  // 引用校验
  const exCitations = []
  keys.forEach((k) => {
    ;(ex.fields[k].evidence || []).forEach((e) => exCitations.push({ page: e.page, quote: e.quote }))
  })
  const badEx = verifyCitations(pages, exCitations)
  console.log(`抽取引用共 ${exCitations.length} 条，无法在对应页定位的：${badEx.length}`)
  badEx.forEach((b) => console.log(`  ✗ ${b}`))

  console.log('\n=== 3. 真实问答 ===')
  const t1 = Date.now()
  const ask = await post('/api/ask', {
    question,
    papers: [
      {
        id: 'u1',
        shortLabel: 'U1',
        title: 'Are Transformers Effective for Time Series Forecasting?',
        pages,
      },
    ],
  })
  console.log(`耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  if (ask.warnings?.length) ask.warnings.forEach((w) => console.log(`  ⚠️ ${w}`))
  ask.paragraphs.forEach((p, i) => console.log(`  P${i + 1}: ${p}`))
  ask.bullets.forEach((b) => console.log(`  · ${b}`))
  console.log(`引用 ${ask.citations.length} 条：`)
  ask.citations.forEach((c) => console.log(`  p.${c.page}: ${String(c.quote).slice(0, 90)}…`))
  const badAsk = verifyCitations(pages, ask.citations)
  console.log(`无法定位的引用：${badAsk.length}`)
  badAsk.forEach((b) => console.log(`  ✗ ${b}`))

  console.log('\n=== 结果 ===')
  const pass = badEx.length === 0 && badAsk.length === 0 && exCitations.length > 0 && ask.citations.length > 0
  console.log(pass ? '✅ 引用全部可在原文中定位' : '❌ 存在无法定位的引用')

  fs.writeFileSync(
    path.join(root, '_e2e-result.json'),
    JSON.stringify(
      { pdf: path.basename(pdfPath), pages: pages.length, totalChars, extract: ex, ask },
      null,
      1,
    ),
    'utf8',
  )
  console.log('详细结果已写入 _e2e-result.json')
}

main().catch((e) => {
  console.error('测试失败：', e.message)
  process.exit(1)
})
