/**
 * 论文身份核对：核对「ID — 期望标题 — 正文首页」是否一致。
 *
 * 只做轻量判定：把每篇正文首页前 800 字与期望标题的关键词做比对，
 * 命中足够多关键 token 才判「一致」，否则判「疑似错配」。同时计算内容指纹。
 *
 * 输出：docs/results/catalog-identity.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const EXPECT = {
  informer: ['Informer', 'Long', 'Sequence', 'Time-series', 'Forecasting'],
  nbeats: ['N-BEATS', 'basis', 'interpretable', 'forecasting'],
  scinet: ['SCINet', 'Sample', 'Convolution', 'Interaction'],
  etsformer: ['ETSformer', 'Exponential', 'Smoothing', 'Time-series'],
  timesnet: ['TimesNet', 'Temporal', '2D-Variation', 'General'],
  crossformer: ['Crossformer', 'Cross-Dimension', 'Dependency', 'Multivariate'],
  micn: ['MICN', 'Multi-scale', 'Local', 'Global', 'Context'],
  itransformer: ['iTransformer', 'Inverted', 'Transformers', 'Effective'],
  autoformer: ['Autoformer', 'Decomposition', 'Auto-Correlation', 'Long-Term'],
  fedformer: ['FEDformer', 'Frequency', 'Enhanced', 'Decomposed'],
  patchtst: ['Worth', '64', 'Words', 'Long-term', 'Forecasting'],
  dlinear: ['Transformers', 'Effective', 'Forecasting', 'Linear'],
}

const catalog = JSON.parse(fs.readFileSync(path.join(root, 'public', 'catalog-pages.json'), 'utf8'))

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\-\u4e00-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim()
}
function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

const report = []
for (const p of catalog.papers ?? []) {
  const pages = p.pages ?? []
  const head = pages.slice(0, 1).map((x) => x.text).join(' ')
  const nhead = norm(head)
  const tokens = (EXPECT[p.id] ?? []).map((t) => norm(t))
  const hit = tokens.filter((t) => t && nhead.includes(t))
  const status = hit.length >= Math.max(3, Math.ceil(tokens.length * 0.6)) ? 'consistent' : 'suspect'
  report.push({
    id: p.id,
    expectedMethod: tokens[0] ?? '',
    headTokensHit: hit,
    headTokensMiss: tokens.filter((t) => !hit.includes(t)),
    identityStatus: status,
    contentFingerprint: fnv1a(pages.map((x) => `${x.page}:${x.text}`).join('\n')),
    numPages: p.numPages,
    headSnippet: head.slice(0, 160),
  })
}

fs.writeFileSync(
  path.join(root, 'docs', 'results', 'catalog-identity.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), entries: report }, null, 2),
  'utf8',
)

const md = ['# 论文身份核对', '', '| ID | 期望方法 | 命中 | 未命中 | 判定 | 首页片段 |', '| --- | --- | --- | --- | --- | --- |']
for (const r of report) {
  md.push(`| ${r.id} | ${r.expectedMethod} | ${r.headTokensHit.join(',') || '—'} | ${r.headTokensMiss.join(',') || '—'} | ${r.identityStatus} | ${r.headSnippet.slice(0, 60)} |`)
}
fs.writeFileSync(path.join(root, 'docs', 'results', 'catalog-identity.md'), md.join('\n'), 'utf8')

const suspect = report.filter((r) => r.identityStatus === 'suspect')
console.log('总篇数', report.length, '疑似错配', suspect.length)
for (const r of suspect) console.log('  SUSPECT', r.id, '命中', r.headTokensHit.join(','), '未命中', r.headTokensMiss.join(','))
