/**
 * 不依赖模型的「检索口径」量化（用于说明旧评估的截断问题）
 * ------------------------------------------------------------------
 * 对 A/B 两臂**已缓存**的回答，逐句检查全文里是否存在可检索到的对应片段：
 *   - oldPool：每页只取前 1400 字符（旧 benchmark 的做法）
 *   - newPool：每页切成 1600 字符的块，不丢内容
 * 输出「能检索到依据」的句子数与比例。
 *
 * 注意：**"检索不到"不等于"原文没有支持"** —— 这只是检索层的信号；
 * 判定层的复核（需要模型）在缺少凭据时标为未完成。
 *
 * 用法：node scripts/bench-scope-local.mjs   （不需要后端、不需要密钥）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const load = (n) => JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cache', `${n}.json`), 'utf8'))
const dl = load('dlinear')
const af = load('autoformer')

const pool = (mode) => {
  const out = []
  for (const [key, p] of [
    ['dlinear', dl],
    ['autoformer', af],
  ]) {
    for (const pg of p.pages) {
      const text = String(pg.text || '').replace(/\s+/g, ' ').trim()
      if (text.length < 80) continue
      if (mode === 'old') {
        out.push(text.slice(0, 1400))
      } else {
        const n = Math.ceil(text.length / 1600)
        for (let i = 0; i < n; i += 1) out.push(text.slice(i * 1600, (i + 1) * 1600))
      }
    }
  }
  return out.join('\n')
}
const textOld = pool('old')
const textNew = pool('new')

const splitSentences = (text) =>
  String(text || '')
    .split(/(?<=[。；!?！？])\s*|\n+/)
    .map((s) => s.trim().replace(/^[-*\d.、)\s]+/, ''))
    .filter((s) => s.length >= 12 && s.length <= 400)

/** 用「连续 6 个英文词 / 10 个汉字」是否在全文出现，作为"检索得到"的保守判据 */
function retrievable(sentence, haystack) {
  const s = sentence.replace(/\s+/g, ' ')
  const latin = s.match(/[A-Za-z][A-Za-z0-9\-_ .,%]{12,}/g) || []
  for (const frag of latin) {
    const words = frag.trim().split(/\s+/)
    for (let i = 0; i + 6 <= words.length; i += 1) {
      if (haystack.includes(words.slice(i, i + 6).join(' '))) return true
    }
  }
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i + 10 <= cjk.length; i += 1) {
    if (haystack.includes(cjk.slice(i, i + 10))) return true
  }
  return false
}

const cases = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'cases.json'), 'utf8')).cases
const lines = []
lines.push('# 检索口径量化（不依赖模型）')
lines.push('')
lines.push('> 由 `node scripts/bench-scope-local.mjs` 生成。**只衡量"能不能在全文里检索到对应文字"**，')
lines.push('> 不等于"结论是否正确"：检索不到 ≠ 原文没有支持，判定层的复核见 docs/EVALUATION.md。')
lines.push('')
lines.push('| 用例 | 臂 | 句子数 | 旧池可检索（每页前 1400 字） | 新池可检索（全文分块） | 因截断而丢失的比例 |')
lines.push('| --- | --- | --- | --- | --- | --- |')

const totals = { A: { n: 0, old: 0, new: 0 }, B: { n: 0, old: 0, new: 0 } }
for (const c of cases) {
  for (const arm of ['A', 'B']) {
    const cachePath = path.join(root, 'benchmark', 'cache', `answers-${arm}-${c.id}.json`)
    if (!fs.existsSync(cachePath)) continue
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    const text = arm === 'A' ? raw.text : raw.text
    const sentences = splitSentences(text)
    let oldN = 0
    let newN = 0
    for (const s of sentences) {
      const inOld = retrievable(s, textOld)
      const inNew = retrievable(s, textNew)
      if (inOld) oldN += 1
      if (inNew) newN += 1
    }
    const lost = newN > 0 ? 1 - oldN / newN : 0
    totals[arm].n += sentences.length
    totals[arm].old += oldN
    totals[arm].new += newN
    lines.push(
      `| ${c.id} | ${arm} | ${sentences.length} | ${oldN} | ${newN} | ${(lost * 100).toFixed(1)}% |`,
    )
  }
}
lines.push('')
lines.push('## 证据池覆盖率（模型无关、确定性）')
lines.push('')
const totalChars = [dl, af].reduce(
  (n, p) => n + p.pages.reduce((m, pg) => m + String(pg.text || '').replace(/\s+/g, ' ').trim().length, 0),
  0,
)
const oldChars = textOld.length
const newChars = textNew.length
const droppedPages = []
for (const [key, p] of [
  ['U1', dl],
  ['U2', af],
]) {
  for (const pg of p.pages) {
    const t = String(pg.text || '').replace(/\s+/g, ' ').trim()
    if (t.length > 1400) droppedPages.push(`${key} p.${pg.page}（丢弃 ${t.length - 1400} 字）`)
  }
}
lines.push(`- 两篇论文正文总字符：**${totalChars.toLocaleString()}**`)
lines.push(`- 旧池（每页前 1400 字）：**${oldChars.toLocaleString()}** 字符 → 覆盖率 **${((oldChars / totalChars) * 100).toFixed(1)}%**`)
lines.push(`- 新池（全文分块，无丢弃）：**${newChars.toLocaleString()}** 字符 → 覆盖率 **${((newChars / totalChars) * 100).toFixed(1)}%**`)
lines.push(`- 旧池有内容被丢弃的页：**${droppedPages.length}** 页 / 共 ${dl.pages.length + af.pages.length} 页`)
lines.push('')
lines.push('| 被截断的页（前 8 条） |')
lines.push('| --- |')
droppedPages.slice(0, 8).forEach((d) => lines.push(`| ${d} |`))
lines.push('')
lines.push('## 本地检索启发式（仅供参考，不能替代判定）')
lines.push('')
lines.push('> 下表用"连续 6 个英文词 / 10 个汉字逐字出现"当作检索命中的保守判据。')
lines.push('> **中文回答多为转述，逐字命中率天然很低**，因此这几列只说明"逐字片段有没有被截断丢掉"，')
lines.push('> 不能读成"结论没有依据"。真正的支持判定需要模型复核（本轮缺凭据，见 docs/EVALUATION.md）。')
lines.push('')
lines.push('| 臂 | 句子总数 | 旧池可检索 | 新池可检索 | 提升 |')
lines.push('| --- | --- | --- | --- | --- |')
for (const arm of ['A', 'B']) {
  const t = totals[arm]
  lines.push(
    `| ${arm} | ${t.n} | ${t.old}（${t.n ? ((t.old / t.n) * 100).toFixed(1) : '0'}%） | ${t.new}（${
      t.n ? ((t.new / t.n) * 100).toFixed(1) : '0'
    }%） | +${t.new - t.old} 句 |`,
  )
}
lines.push('')
lines.push('## 结论与边界')
lines.push('')
lines.push('1. 旧链路（每页截 1400 字符）会让**一部分确实写在页面中后部的句子**在检索阶段就找不到依据；')
lines.push('   新链路（全文分块、不丢内容）能把这些句子找回来。')
lines.push('2. 上表的数字**只是检索层**：要判断"结论是否被原文支持"仍需要判定层复核（需要模型凭据）。')
lines.push('3. 因此：**"检索不到"不能写成"原文没有支持"**；本工具在界面上也把这两件事分开显示。')
fs.writeFileSync(path.join(root, 'docs', 'results', 'scope-local.md'), lines.join('\n'))
console.log(lines.join('\n'))
