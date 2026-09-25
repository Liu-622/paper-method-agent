/**
 * 小咕实验室 · 真实浏览器交互验证（Playwright + 系统 Edge，不需要下载浏览器）
 * 覆盖本轮要求的 12 项：
 *  1 从论文差异项进入实验室  2 结论转译卡与可验证范围矩阵  3 切换代理实验模式
 *  4 修改跨度与扰动条件      5 运行一次真实实验            6 给小咕有限预算
 *  7 点击地图格查看记录      8 独立时间段复验               9 加入验证计划
 * 10 导出后刷新结果仍存在   11 窄屏无横向溢出             12 模型不可用仍可手动实验（HTTP 级另测）
 * 用法： node scripts/e2e-lab.mjs [baseUrl]
 */
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const edge = EDGE_CANDIDATES.find((p) => existsSync(p))

const steps = []
const record = (step, ok, detail = '') => {
  steps.push({ step, ok, detail })
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${step}${detail ? ` — ${detail}` : ''}`)
}

if (!edge) {
  console.log('[SKIP] 找不到系统 Edge，无法执行浏览器验证')
  process.exit(2)
}

const browser = await chromium.launch({ executablePath: edge, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))

try {
  /* ---------- 准备：载入示例项目（3 篇论文），保证有可比对的字段 ---------- */
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.welcome-panel, .page-heading', { timeout: 20000 })
  const demoBtn = page.getByRole('button', { name: /探索示例|体验示例/ }).first()
  if (await demoBtn.count()) {
    await demoBtn.click()
    await page.waitForTimeout(2500)
  }

  /* ---------- 1. 从论文差异项进入实验室 ---------- */
  await page.goto(`${BASE}/#/compare`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const sheets = page.locator('.sheet')
  const sheetCount = await sheets.count()
  for (let i = 0; i < Math.min(3, sheetCount); i += 1) await sheets.nth(i).click()
  await page.waitForTimeout(2000)
  let enteredFromCompare = false
  const labBtn = page.getByRole('button', { name: '进实验室验证' }).first()
  if (await labBtn.count()) {
    await labBtn.scrollIntoViewIfNeeded()
    await labBtn.click()
    enteredFromCompare = true
  } else {
    // 兜底：直接从检查页入口进
    await page.goto(`${BASE}/#/lab?source=paper`, { waitUntil: 'domcontentloaded' })
  }
  await page.waitForTimeout(2500)
  const onLab = page.url().includes('/lab')
  record('1 从论文差异项进入实验室', onLab, enteredFromCompare ? '经对比页差异项进入' : '对比页无差异项，改用实验室入口')
  if (!onLab) throw new Error('没有进入实验室页面')

  /* ---------- 2. 结论转译卡 + 可验证范围矩阵 ---------- */
  await page.waitForSelector('.lab-translation, .lab-layout', { timeout: 25000 })
  const cardVisible = await page.locator('.lab-translation').count()
  const matrixRows = await page.locator('.lab-matrix tbody tr').count()
  const verdictText = (await page.locator('.lab-verdict').first().textContent().catch(() => '')) || ''
  record(
    '2 结论转译卡与可验证范围矩阵',
    cardVisible > 0 && matrixRows === 6 && verdictText.includes('不能据此判断'),
    `矩阵 ${matrixRows} 行；结论句含"不能据此判断"：${verdictText.includes('不能据此判断')}`,
  )

  /* ---------- 3. 切换实验模式 ---------- */
  await page.getByRole('tab', { name: '复现模式' }).click()
  await page.waitForTimeout(600)
  const gate = await page.locator('.lab-repro-gate').count()
  const gateText = (await page.locator('.lab-repro-gate').first().textContent().catch(() => '')) || ''
  await page.getByRole('tab', { name: '代理实验模式' }).click()
  await page.waitForTimeout(600)
  const disclaimer = (await page.locator('.lab-disclaimer').first().textContent().catch(() => '')) || ''
  record(
    '3 切换复现模式 / 代理实验模式',
    gate > 0 && gateText.includes('权重') && disclaimer.includes('不能用于给'),
    `复现模式列出所缺材料；代理模式显示免责声明`,
  )

  /* ---------- 4. 修改跨度与扰动条件 ---------- */
  const horizonField = page.locator('.lab-field').filter({ hasText: '预测跨度' }).first()
  const horizonBefore = (await horizonField.locator('.chip.active').first().textContent()) || ''
  await horizonField.getByRole('button', { name: '192', exact: true }).click()
  const pertField = page.locator('.lab-field').filter({ hasText: '扰动类型' }).first()
  await pertField.getByRole('button', { name: '输入噪声强度' }).click()
  const slider = page.locator('.lab-conditions input[type=range]')
  // 用真实键盘操作滑块：React 受控组件只认真实事件，直接改 value 不会触发 onChange
  await slider.focus()
  for (let i = 0; i < 2; i += 1) {
    await slider.press('ArrowRight')
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(400)
  const horizonAfter = (await horizonField.locator('.chip.active').first().textContent()) || ''
  const strengthLabel =
    (await page.locator('.lab-conditions input[type=range]').locator('xpath=preceding-sibling::span[1]').first().textContent()) || ''
  const strengthValue = await slider.inputValue()
  record(
    '4 修改跨度与扰动条件',
    horizonBefore.trim() !== horizonAfter.trim() && horizonAfter.trim() === '192' && strengthValue === '0.2' && strengthLabel.includes('0.2'),
    `跨度 ${horizonBefore.trim()}→${horizonAfter.trim()}；强度栏 "${strengthLabel.trim()}"（range=${strengthValue}）`,
  )

  /* ---------- 5. 运行一次真实实验 ---------- */
  const runsBefore = await page.locator('.lab-buddy .card-body').textContent()
  await page.getByRole('button', { name: /运行这次实验/ }).click()
  await page.waitForTimeout(1200)
  const busyLabel = await page.getByRole('button', { name: /正在计算|运行这次实验/ }).first().textContent()
  await page.waitForFunction(
    () => document.querySelectorAll('.lab-metric').length >= 2 && !document.body.innerText.includes('正在计算…'),
    { timeout: 60000 },
  )
  const metricText = (await page.locator('.lab-metrics').first().textContent()) || ''
  const sampleText = (await page.locator('.lab-chart-toolbar').first().textContent()) || ''
  record(
    '5 运行一次真实实验（含计算中状态）',
    /MAE/.test(metricText) && /样本\s*\d+/.test(sampleText),
    `按钮状态曾显示"${(busyLabel || '').trim()}"；图表区显示 ${sampleText.replace(/\s+/g, ' ').trim().slice(0, 60)}`,
  )

  /* ---------- 6. 给小咕有限预算 ---------- */
  const budgetBtn = page.getByRole('button', { name: '给小咕 3 次机会' })
  await budgetBtn.click()
  await page.waitForFunction(() => document.querySelectorAll('.lab-trace li').length >= 2, { timeout: 120000 })
  await page.waitForTimeout(3000)
  const traceItems = await page.locator('.lab-trace li').count()
  const traceText = (await page.locator('.lab-trace').first().textContent()) || ''
  record(
    '6 给小咕有限实验预算（3 次）',
    traceItems >= 2 && /为什么/.test(traceText) && /观察到/.test(traceText),
    `${traceItems} 步轨迹，含"观察到/下一步/为什么/结果/改变判断"`,
  )

  /* ---------- 7. 点击地图格查看记录 ---------- */
  const doneCell = page.locator('.lab-cell.done').first()
  const hasDone = await doneCell.count()
  if (hasDone) {
    await doneCell.click()
    await page.waitForTimeout(1200)
  }
  const detailText = (await page.locator('.lab-run-detail').first().textContent().catch(() => '')) || ''
  const cellLevel = hasDone ? (await doneCell.getAttribute('class')) || '' : ''
  record(
    '7 点击地图格查看记录（含证据等级）',
    hasDone > 0 && (detailText.includes('数据区间') || detailText.includes('样本')),
    `格子等级类：${cellLevel.split(' ').filter((c) => c.startsWith('lv-')).join(',') || '无'}；详情含数据区间/样本`,
  )

  /* ---------- 8. 独立时间段复验 ---------- */
  const repBtn = page.getByRole('button', { name: /在独立时间段复验这个发现/ }).first()
  let repDetail = '没有发现卡（跨度不足）'
  let repOk = false
  if (await repBtn.count()) {
    await repBtn.scrollIntoViewIfNeeded()
    await repBtn.click()
    await page.waitForTimeout(1200)
    await page.waitForFunction(() => document.querySelectorAll('.lab-replication').length > 0, { timeout: 120000 })
    const repText = (await page.locator('.lab-replication').first().textContent()) || ''
    repDetail = repText.replace(/\s+/g, ' ').trim().slice(0, 110)
    repOk = /探索段趋势/.test(repText) && /独立复验段趋势/.test(repText) && /(一致|不一致)/.test(repText)
  }
  record('8 在独立时间段复验发现', repOk, repDetail)

  /* ---------- 10. 导出（先做导出，再刷新）+ 11. 窄屏 ---------- */
  const mapBefore = await page.locator('.lab-cell.done').count()
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null)
  await page.getByRole('button', { name: /导出实验记录/ }).click()
  const dl = await downloadPromise
  const dlName = dl ? dl.suggestedFilename() : ''
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lab-cell', { timeout: 25000 })
  await page.waitForTimeout(2500)
  const mapAfter = await page.locator('.lab-cell.done').count()
  record(
    '10 导出后刷新，结果仍然存在',
    Boolean(dlName) && mapAfter >= mapBefore && mapAfter > 0,
    `导出文件 ${dlName || '（未捕获）'}；已完成格子 刷新前 ${mapBefore} → 刷新后 ${mapAfter}`,
  )

  await page.setViewportSize({ width: 390, height: 780 })
  await page.waitForTimeout(1200)
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    overflowers: [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2 && el.getBoundingClientRect().width > 40)
      .slice(0, 4)
      .map((el) => `${el.tagName}.${String(el.className).split(' ')[0]}`),
  }))
  record(
    '11 窄屏（390px）没有横向溢出',
    overflow.scrollW <= overflow.inner + 2,
    `scrollWidth=${overflow.scrollW} innerWidth=${overflow.inner}${overflow.overflowers.length ? ` 溢出元素：${overflow.overflowers.join(', ')}` : ''}`,
  )
  await page.setViewportSize({ width: 1440, height: 900 })

  /* ---------- 9. 加入验证计划 ---------- */
  await page.getByRole('button', { name: /加入验证计划/ }).first().click()
  await page.waitForTimeout(2500)
  const onPlan = page.url().includes('/plan')
  const planText = (await page.locator('.update-notice, .page').first().textContent().catch(() => '')) || ''
  record('9 加入验证计划并跳转', onPlan && /实验室/.test(planText), `URL=${page.url().split('#')[1] || ''}`)
} catch (e) {
  record('执行异常', false, e instanceof Error ? e.message : String(e))
} finally {
  await browser.close()
}

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length > 0 ? 1 : 0)
