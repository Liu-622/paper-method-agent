/**
 * 最小真实模型调用自检：确认"服务起来了"不等于"模型可用"
 * 用法：node scripts/probe-minimal-llm.mjs
 * 说明：不需要凭据也能跑 —— 没有凭据时它会如实报错，这正是我们要看到的结果。
 */
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8787'
const post = async (p, body) => {
  const res = await fetch(`${API_BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text }
}

const paper = {
  id: 'probe',
  shortLabel: 'X1',
  title: 'probe.pdf',
  pages: [
    {
      page: 1,
      text: 'This is a probe paper. The sampling interval is 15 minutes. The prediction horizon is 96 steps. The dataset is ETTm1.',
    },
  ],
}

console.log('== 1) 健康检查（只看能力，不代表模型可用）==')
const healthRes = await fetch(`${API_BASE}/api/health`)
const healthJson = await healthRes.json().catch(() => null)
console.log(
  '  status=' +
    healthRes.status +
    ' capabilities=' +
    JSON.stringify(healthJson?.capabilities || {}) +
    ' hasCredentials=' +
    String(healthJson?.hasCredentials) +
    ' baseUrlHost="' +
    String(healthJson?.baseUrlHost || '') +
    '"',
)

console.log('\n== 2) 最小真实模型调用 1：裸问答 /api/bench/raw-ask ==')
const raw = await post('/api/bench/raw-ask', { question: '这句话里的采样间隔是多少？', papers: [paper] })
if (raw.json?.ok) {
  console.log('  ✅ 模型可用，返回：' + String(raw.json.text || '').slice(0, 80))
} else {
  console.log('  ❌ 模型不可用（如实报告，不视为成功）：')
  console.log('     status=' + raw.status + ' code=' + (raw.json?.code || '') + ' message=' + (raw.json?.message || raw.text).slice(0, 200))
}

console.log('\n== 3) 最小真实模型调用 2：应用问答 /api/ask ==')
const ask = await post('/api/ask', {
  question: '这句话里的采样间隔是多少？',
  papers: [paper],
  context: { paperCount: 1, datasetScope: null, checks: [] },
})
if (ask.json?.ok && (ask.json.paragraphs?.length || ask.json.bullets?.length)) {
  console.log('  ✅ 应用问答可用：' + [...(ask.json.paragraphs || []), ...(ask.json.bullets || [])].join(' ').slice(0, 80))
} else {
  console.log('  ❌ 应用问答不可用：')
  console.log('     status=' + ask.status + ' message=' + (ask.json?.message || ask.text).slice(0, 200))
  if (ask.json?.notice) console.log('     notice=' + ask.json.notice)
}

console.log('\n== 4) 抽取入口 /api/extract ==')
// 注意：/api/extract 的入参是【顶层 pages】+ fileName/title，不是 { paper: {...} }
const ex = await post('/api/extract', { pages: paper.pages, fileName: 'probe.pdf', title: 'probe.pdf' })
if (ex.json?.ok) {
  const keys = Object.keys(ex.json.fields || {})
  console.log('  ✅ 抽取可用：返回字段数=' + keys.length + '，页数=' + (ex.json.pagesReceived || 0))
  console.log('     字段示例：' + keys.slice(0, 6).join(', '))
} else {
  console.log('  ❌ 抽取不可用：status=' + ex.status + ' code=' + (ex.json?.code || '') + ' message=' + (ex.json?.message || ex.text).slice(0, 200))
}
