/**
 * 排查某条引用为什么无法在原文中定位
 * 用法：node server/debug-quote.mjs <pdf> "<quote>"
 */
import fs from 'node:fs'
import { normalizeText } from './llm.mjs'

const [, , pdfPath, quote] = process.argv
if (!pdfPath || !quote) {
  console.error('用法：node server/debug-quote.mjs <pdf> "<quote>"')
  process.exit(1)
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const data = new Uint8Array(fs.readFileSync(pdfPath))
const task = pdfjs.getDocument({ data, useSystemFonts: false })
const doc = await task.promise

const needle = normalizeText(quote.replace(/\s+/g, ' '))
console.log('归一化后的引用：')
console.log(`  ${needle.slice(0, 160)}${needle.length > 160 ? ' …' : ''}`)
console.log('')

let hit = null
const pages = []
for (let i = 1; i <= doc.numPages; i += 1) {
  const page = await doc.getPage(i)
  const content = await page.getTextContent()
  let text = ''
  let lastY = null
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue
    const y = item.transform?.[5]
    if (lastY !== null && typeof y === 'number' && Math.abs(y - lastY) > 2) text += '\n'
    text += item.str
    if (item.hasEOL) text += '\n'
    if (typeof y === 'number') lastY = y
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  pages.push({ page: i, text })
  const hay = normalizeText(text)
  if (hay.includes(needle) && !hit) hit = i
  page.cleanup()
}
try {
  await task.destroy()
} catch {
  /* ignore */
}

if (hit) {
  console.log(`✅ 能在第 ${hit} 页找到（说明校验函数与这份文本是一致的）`)
} else {
  console.log('❌ 在整篇文本里都找不到。逐段诊断：')
  // 找出最长能匹配的前缀长度，定位断点
  const frags = needle.split(/\s+/)
  let lo = 0
  let hi = frags.length
  const hayAll = pages.map((p) => normalizeText(p.text)).join(' \u0001 ')
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (hayAll.includes(frags.slice(0, mid).join(' '))) lo = mid
    else hi = mid - 1
  }
  console.log(`  能连续匹配到第 ${lo} 个词：${frags.slice(0, lo).join(' ')}`)
  if (lo < frags.length) {
    console.log(`  断点在：…${frags.slice(Math.max(0, lo - 3), lo).join(' ')} >>> ${frags[lo]} <<< ${frags.slice(lo + 1, lo + 4).join(' ')}…`)
    const key = frags[Math.max(0, lo - 1)]
    pages.forEach((p) => {
      const idx = normalizeText(p.text).indexOf(normalizeText(key))
      if (idx >= 0) {
        const raw = normalizeText(p.text)
        console.log(`  第 ${p.page} 页该处的实际文本： …${raw.slice(Math.max(0, idx - 60), idx + 160)}…`)
      }
    })
  }
}
