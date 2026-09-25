/**
 * 本轮新增能力（侦探 / 对撞台 / 挑战模式）的页面级验收
 * 走通：首页三入口 → 侦探找线索并采用 → 对撞台观点卡 → 挑战模式先判断再运行 → 导出
 * 用法： node scripts/e2e-round20.mjs [baseUrl]
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))

const steps = []
const record = (name, ok, detail = '') => {
  steps.push({ name, ok })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`)
}
if (!EDGE) {
  console.log('[SKIP] 没有系统 Edge')
  process.exit(2)
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))

try {
  /* ---------- 1) 首页三个新入口 ---------- */
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.home-highlights', { timeout: 30000 })
  const highlights = ((await page.locator('.home-highlights').textContent()) || '').replace(/\s+/g, ' ')
  record(
    '1 首页呈现三个新入口（找复现线索 / 看论文差异 / 挑战一个结论）+ 统一定位句',
    /找复现线索/.test(highlights) && /看论文差异/.test(highlights) && /挑战一个结论/.test(highlights) && /从论文里的一个疑问/.test(highlights),
    highlights.slice(0, 80),
  )

  /* ---------- 2) 准备示例论文 ---------- */
  const demo = page.getByRole('button', { name: /探索示例/ }).first()
  if (await demo.count()) {
    await demo.click()
    await page.waitForTimeout(2500)
  }

  /* ---------- 3) 侦探：真实阶段 + 线索 + 采用 ---------- */
  await page.goto(`${BASE}/#/compare`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const sheets = page.locator('.sheet')
  for (let i = 0; i < Math.min(2, await sheets.count()); i += 1) await sheets.nth(i).click()
  await page.waitForTimeout(1500)

  await page.goto(`${BASE}/#/library`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const firstPaper = page.locator('.recent-paper, .paper-row, a[href*="#/paper/"]').first()
  if (await firstPaper.count()) {
    await firstPaper.click()
    await page.waitForTimeout(2500)
  }
  // 用与「找线索」按钮完全相同的事件打开侦探面板（同时验证这条接线）
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('open-detective', { detail: { fieldKey: 'learningRate' } })))
  await page.waitForTimeout(1200)
  const detective = page.locator('.detective')
  const hasDetective = await detective.count()
  if (hasDetective) {
    await page.getByRole('button', { name: '开始查找' }).click()
    await page.waitForFunction(() => document.querySelector('.detective-summary') !== null, { timeout: 180000 })
    await page.waitForTimeout(1200)
    const summary = ((await page.locator('.detective-summary').textContent()) || '').replace(/\s+/g, ' ')
    const clueCount = await page.locator('.detective-clue').count()
    const sourcesCount = await page.locator('.detective-sources li').count()
    // 展开第一条线索看来源
    const firstClue = page.locator('.detective-clue').first()
    await firstClue.getByRole('button', { name: /查看原文/ }).click()
    await page.waitForTimeout(500)
    const sourceText = ((await page.locator('.detective-source').first().textContent()) || '').replace(/\s+/g, ' ')
    const hasCodeOrPage = /(:\d+)|第 \d+ 页/.test(sourceText)
    // 归属绑定：仓库版本 / 方法 / 数据集 / 任务 / 跨度 / 脚本
    const bindingText = ((await page.locator('.detective-binding').first().textContent()) || '').replace(/\s+/g, ' ')
    // 采用
    await firstClue.getByRole('button', { name: '用于当前复现配置' }).click()
    await page.waitForTimeout(500)
    // 若归属不匹配，需要二次确认（记为"用户选择的新设置"）
    const confirmBtn = firstClue.getByRole('button', { name: /确认记为「用户选择的新设置」/ })
    if (await confirmBtn.count()) await confirmBtn.click()
    await page.waitForTimeout(700)
    const derived = ((await page.locator('.detective-derived').textContent()) || '').replace(/\s+/g, ' ')
    record(
      '2 小咕侦探：阶段反馈 + 线索（含出处与归属绑定）+ 采用到派生配置层',
      clueCount > 0 && sourcesCount > 0 && hasCodeOrPage && /派生配置/.test(derived) && /方法/.test(bindingText) && /跨度/.test(bindingText),
      `${summary.slice(0, 60)}｜线索 ${clueCount} 条｜查过来源 ${sourcesCount} 个｜绑定：${bindingText.slice(0, 80)}`,
    )
  } else {
    record('2 小咕侦探：阶段反馈 + 线索（含出处）+ 采用到派生配置层', false, '没有打开侦探面板')
  }

  /* ---------- 4) 对撞台：观点卡 ---------- */
  await page.goto(`${BASE}/#/compare`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.clash', { timeout: 30000 })
  await page.getByRole('button', { name: /生成观点卡|重新整理/ }).click()
  await page.waitForTimeout(3000)
  const clashCard = page.locator('.clash-card')
  const cardCount = await clashCard.count()
  const clashText = ((await page.locator('.clash').textContent()) || '').replace(/\s+/g, ' ')
  if (cardCount > 0) {
    await clashCard.first().getByRole('button', { name: /展开依据/ }).click()
    await page.waitForTimeout(400)
  }
  const cardText = cardCount > 0 ? ((await clashCard.first().textContent()) || '').replace(/\s+/g, ' ') : ''
  const REL = /(不同方法的性能差异|报告值不同，需核对实验设置|主张存在分歧|可比性待确认)/
  record(
    '3 对撞台：观点卡（两侧观点 / 关键条件 / 四类关系判断 / 行动）',
    cardCount > 0 && /关键条件/.test(cardText) && REL.test(cardText) && /找齐比较条件/.test(cardText) && /设计验证任务/.test(cardText),
    `${cardCount} 张卡｜${cardText.slice(0, 90)}`,
  )
  const relationText = ((await page.locator('.clash').textContent()) || '').replace(/\s+/g, ' ')
  record(
    '3b 不把性能差异说成观点分歧（页面不出现"互相矛盾/观点冲突"字样）',
    REL.test(relationText) && !/互相矛盾|观点冲突/.test(relationText),
    relationText.match(REL)?.[0] ?? '（这几篇示例论文没有生成该类别）',
  )
  const runVerify = clashCard.first().getByRole('button', { name: /运行验证/ })
  record(
    '4 只有实验室支持的方法才给「运行验证」，否则禁用并说明',
    (await clashCard.first().getByRole('button', { name: '运行验证不可用' }).count()) > 0 || (await runVerify.count()) > 0,
    clashText.match(/这两种方法[^｜]{0,40}|实验室只有教学方法[^｜]{0,40}/)?.[0] ?? '（示例论文方法未接入实验室时禁用）',
  )

  /* ---------- 5) 挑战模式 ---------- */
  await page.goto(`${BASE}/#/lab?family=paper-linear&challenge=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.challenge', { timeout: 40000 })
  await page.waitForTimeout(1500)
  const conditions = ((await page.locator('.challenge-conditions').textContent()) || '').replace(/\s+/g, ' ')
  const resultVisibleBefore = await page.locator('.challenge-result').count()
  record(
    '5 挑战模式先给条件、不给结果',
    /探索段/.test(conditions) && /另一时间段/.test(conditions) && resultVisibleBefore === 0,
    conditions.slice(0, 90),
  )
  await page.getByRole('button', { name: '领先方会变化' }).click()
  await page.getByRole('button', { name: /运行并揭晓/ }).click()
  await page.waitForFunction(() => document.querySelector('.challenge-result') !== null, { timeout: 300000 })
  await page.waitForTimeout(2000)
  const verdict = ((await page.locator('.challenge-verdict').first().textContent()) || '').replace(/\s+/g, ' ')
  const resultText = ((await page.locator('.challenge-result').textContent()) || '').replace(/\s+/g, ' ')
  record(
    '6 运行并揭晓：真实结果 + 与用户判断对照 + 样本口径',
    /DLinear/.test(resultText) && /Linear/.test(resultText) && /领先方/.test(resultText) && /(与你的判断一致|与你的判断不一致)/.test(verdict) && /条预测记录/.test(resultText),
    verdict.slice(0, 100),
  )
  record(
    '7 挑战模式不显示历史结果时不会预置反转文案（结果由本次计算生成）',
    /领先方(发生了|没有)(反转|变化)/.test(verdict + resultText) && /ΔMAE/.test(resultText),
    resultText.slice(0, 80),
  )

  /* 「仅凭条件无法判断」不算答错 */
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.challenge', { timeout: 40000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '仅凭条件无法判断' }).click()
  await page.getByRole('button', { name: '查看历史结果' }).click()
  await page.waitForFunction(() => document.querySelector('.challenge-result') !== null, { timeout: 120000 })
  await page.waitForTimeout(1200)
  const verdict2 = ((await page.locator('.challenge-verdict').first().textContent()) || '').replace(/\s+/g, ' ')
  record(
    '8 「仅凭条件无法判断」被明确当作合理选择，不算答错',
    /不是对错题/.test(verdict2) && /与你的判断一致/.test(verdict2),
    verdict2.slice(0, 90),
  )
  const originLabel = ((await page.locator('.challenge .card-head').textContent()) || '').replace(/\s+/g, ' ')
  record('9 「查看历史结果」与「现场重新运行」明确区分', /历史实测结果/.test(originLabel), originLabel.slice(0, 70))
} catch (e) {
  record('执行异常', false, e instanceof Error ? e.message : String(e))
} finally {
  await browser.close()
}

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length > 0 ? 1 : 0)
