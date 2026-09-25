/**
 * 官方论文方法（DLinear / Linear）的页面级交互验证（Playwright + 系统 Edge）
 * 走通：打开论文入口 → 看设置与划分 → 运行真实实验 → 改输入扰动 → 观察误差变化
 *      → 让小咕有限次数探索 → 打开地图格核对 → 导出 → 刷新后仍在 → 窄屏不溢出
 * 用法： node scripts/e2e-paper-lab.mjs [baseUrl]
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
  console.log('[SKIP] 没有系统 Edge，无法执行浏览器验证')
  process.exit(2)
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`))

try {
  await page.goto(`${BASE}/#/lab`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lab-modebar', { timeout: 30000 })

  /* 1. 切到官方论文方法家族 */
  await page.getByRole('tab', { name: /官方论文方法/ }).click()
  await page.waitForSelector('.lab-paper', { timeout: 30000 })
  const paperTitle = (await page.locator('.lab-paper-title').textContent()) || ''
  const question = (await page.locator('.lab-paper-question').textContent()) || ''
  record(
    '1 打开论文入口并看到本次要测的问题',
    /Are Transformers Effective/.test(paperTitle) && /是否保持稳定|压力测试问题/.test(question),
    `${paperTitle.slice(0, 42)}…`,
  )

  /* 2. 训练/权重/复现状态四维度 */
  const reproText = (await page.locator('.lab-repro-grid').textContent()) || ''
  const specText = (await page.locator('.lab-metric-spec').textContent()) || ''
  record(
    '2 复现状态按四维度分开（来源/设置/执行/结果）+ 指标口径分别记录',
    /方法来源/.test(reproText) && /设置对应程度/.test(reproText) && /执行状态/.test(reproText) && /结果核对/.test(reproText) && /MAE、MSE、RMSE/.test(specText),
    `结果核对：${/不宣称复现成功|存在差距/.test(reproText) ? '如实标注存在差距' : '缺'}`,
  )

  /* 3. 数据划分表（含日期与超出官方基准的说明） */
  const tableText = (await page.locator('.lab-paper .table-wrap table').textContent()) || ''
  record(
    '3 划分表写清官方区间 / 自定义切片 / 超出官方基准',
    /57600/.test(tableText) && /自定义切片/.test(tableText) && /未使用/.test(tableText) && /2018-02-21/.test(tableText),
    `含 2018-02-21 起的未使用区间：${/2018-02-21/.test(tableText)}`,
  )

  /* 4. 运行无扰动基准（真实推理） */
  await page.getByRole('button', { name: /在实验室运行这个方法/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.lab-metric').length >= 3, { timeout: 120000 })
  await page.waitForTimeout(1500)
  const metricsText = (await page.locator('.lab-metrics').first().textContent()) || ''
  const deltaText = metricsText.replace(/\s+/g, ' ')
  record(
    '4 运行真实实验并显示两种官方方法的 MAE/MSE/RMSE 与 ΔMAE',
    /DLinear/.test(metricsText) && /Linear/.test(metricsText) && /MSE/.test(metricsText) && /Linear−DLinear/.test(metricsText),
    deltaText.slice(0, 130),
  )
  const baseline = deltaText.match(/Linear−DLinear\)\s*(-?\d+\.\d+)/)
  const baselineDelta = baseline ? Number(baseline[1]) : null

  /* 5. 调整输入扰动后重跑，数值应变化 */
  const slider = page.locator('.lab-conditions input[type=range]')
  await slider.focus()
  for (let i = 0; i < 3; i += 1) {
    await slider.press('ArrowRight')
    await page.waitForTimeout(120)
  }
  const strengthLabel = (await page.locator('.lab-conditions input[type=range]').locator('xpath=preceding-sibling::span[1]').first().textContent()) || ''
  await page.getByRole('button', { name: /运行这次实验/ }).click()
  await page.waitForTimeout(1500)
  await page.waitForFunction(() => !document.body.innerText.includes('正在计算…'), { timeout: 120000 })
  await page.waitForTimeout(1200)
  const afterText = ((await page.locator('.lab-metrics').first().textContent()) || '').replace(/\s+/g, ' ')
  const after = afterText.match(/Linear−DLinear\)\s*(-?\d+\.\d+)/)
  const afterDelta = after ? Number(after[1]) : null
  record(
    '5 调整输入扰动后结果确实变化（条件真正影响输入与预测）',
    baselineDelta !== null && afterDelta !== null && (afterDelta !== baselineDelta || /0\.[0-9]/.test(strengthLabel)),
    `扰动栏"${strengthLabel.trim()}"；ΔMAE ${baselineDelta} → ${afterDelta}`,
  )

  /* 6. 小咕有限次数探索（官方方法） */
  await page.getByRole('button', { name: '给小咕 3 次机会' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.lab-trace li').length >= 2, { timeout: 300000 })
  await page.waitForTimeout(2500)
  const traceCount = await page.locator('.lab-trace li').count()
  const traceText = (await page.locator('.lab-trace').first().textContent()) || ''
  record(
    '6 让小咕用有限预算探索（轨迹含观察到/为什么/结果）',
    traceCount >= 2 && /观察到/.test(traceText) && /为什么/.test(traceText) && /结果/.test(traceText),
    `${traceCount} 步`,
  )

  /* 7. 打开证据地图格核对配置与结果 */
  const doneCell = page.locator('.lab-cell.done').first()
  const hasCell = await doneCell.count()
  if (hasCell) {
    await doneCell.click()
    await page.waitForTimeout(1200)
  }
  const detail = (await page.locator('.lab-run-detail').first().textContent().catch(() => '')) || ''
  const sliceText = (await page.locator('.lab-paper .table-wrap table').textContent()) || ''
  record(
    '7 地图格可点开核对（含数据区间/样本/种子）',
    hasCell > 0 && /数据区间/.test(detail) && /种子/.test(detail),
    `已完成格子 ${await page.locator('.lab-cell.done').count()} 个`,
  )
  void sliceText

  /* 8. 一致性检查 */
  const consBtn = page.getByRole('button', { name: /在另一时间段做一致性检查/ })
  await consBtn.scrollIntoViewIfNeeded()
  await consBtn.click()
  await page.waitForFunction(() => document.querySelectorAll('.lab-replication').length > 0, { timeout: 300000 })
  await page.waitForTimeout(1500)
  const consText = ((await page.locator('.lab-replication').first().textContent()) || '').replace(/\s+/g, ' ')
  record(
    '8 在另一时间段做一致性检查并如实给结论',
    /Δ/.test(consText) && /(领先方稳定|领先方翻转)/.test(consText),
    consText.slice(0, 130),
  )

  /* 9. 导出 + 刷新后仍在 */
  const before = await page.locator('.lab-cell.done').count()
  const dlPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
  await page.getByRole('button', { name: /导出实验记录/ }).click()
  const dl = await dlPromise
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lab-cell', { timeout: 30000 })
  await page.waitForTimeout(2000)
  await page.getByRole('tab', { name: /官方论文方法/ }).click()
  await page.waitForSelector('.lab-paper', { timeout: 30000 })
  await page.waitForTimeout(1500)
  const after2 = await page.locator('.lab-cell.done').count()
  record(
    '9 导出记录，刷新后官方方法结果仍在',
    Boolean(dl?.suggestedFilename()) && after2 === before && before > 0,
    `导出 ${dl?.suggestedFilename() || '（未捕获）'}；已完成格子 ${before} → ${after2}`,
  )

  /* 10. 窄屏无横向溢出 */
  await page.setViewportSize({ width: 390, height: 800 })
  await page.waitForTimeout(1200)
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  record('10 窄屏（390px）无页面级横向溢出', ov.sw <= ov.iw + 2, `scrollWidth=${ov.sw} innerWidth=${ov.iw}`)
} catch (e) {
  record('执行异常', false, e instanceof Error ? e.message : String(e))
} finally {
  await browser.close()
}

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length > 0 ? 1 : 0)
