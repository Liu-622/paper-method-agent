/**
 * 核心案例（换个时间段，领先者会变吗？）的页面级验收
 * 覆盖：案例入口 → 运行两段 → 切换图表 → 查看条件 → 小咕解释/无模型提示 → 导出 → 刷新恢复
 * 用法： node scripts/e2e-case.mjs [baseUrl]
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
  await page.goto(`${BASE}/#/lab`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lab-modebar', { timeout: 30000 })
  await page.getByRole('tab', { name: /官方论文方法/ }).click()
  await page.waitForSelector('.lab-case', { timeout: 30000 })

  /* 1. 案例入口：标题 + 固定设置 + 全貌 + 一个主操作 */
  const title = (await page.locator('.lab-case .card-head').textContent()) || ''
  const settingsLine = (await page.locator('.lab-case-settings').textContent()) || ''
  const overview = (await page.locator('.lab-case-overview').textContent()) || ''
  const runBtn = page.getByRole('button', { name: '运行两个时间段' })
  record(
    '1 案例入口（实际方法 + 固定设置 + 数据全貌 + 两段标记 + 主操作）',
    /换个时间段，领先者会变吗/.test(title) &&
      /DLinear/.test(settingsLine) &&
      /探索段/.test(overview) &&
      /另一时间段/.test(overview) &&
      /超出官方基准/.test(overview) &&
      (await runBtn.count()) === 1,
    overview.replace(/\s+/g, ' ').slice(0, 90),
  )

  /* 2. 查看固定设置 */
  await page.getByRole('button', { name: /查看固定设置/ }).click()
  await page.waitForTimeout(300)
  const params = (await page.locator('.lab-case-params').textContent()) || ''
  record(
    '2 固定设置可展开查看（seq_len/pred_len/无扰动/种子/指标/区间）',
    /seq_len=336/.test(params) && /pred_len=96/.test(params) && /无扰动/.test(params) && /MAE \/ MSE \/ RMSE/.test(params),
    params.replace(/\s+/g, ' ').slice(0, 100),
  )

  /* 3. 已有实测结果（缓存）与重新运行分开 */
  await page.getByRole('button', { name: '查看已有实测结果' }).click()
  await page.waitForTimeout(4000)
  const cachedOk = (await page.locator('.lab-case-keycell').count()) === 2
  const stampText = (await page.locator('.lab-case .card-head').textContent()) || ''
  record('3「查看已有实测结果」载入缓存并标注时间', cachedOk && /实测于/.test(stampText), stampText.replace(/\s+/g, ' ').slice(0, 80))

  /* 4. 运行两个时间段（真实计算） */
  await runBtn.click()
  await page.waitForFunction(() => !document.body.innerText.includes('正在运行两个时间段'), { timeout: 300000 })
  await page.waitForTimeout(2500)
  const cells = await page.locator('.lab-case-keycell').count()
  const keyText = ((await page.locator('.lab-case-key').textContent()) || '').replace(/\s+/g, ' ')
  const verdict = ((await page.locator('.lab-case-verdict').textContent()) || '').replace(/\s+/g, ' ')
  record(
    '4 运行两个时间段：两段指标 + 有方向的差值 + 领先方',
    cells === 2 && /DLinear/.test(keyText) && /Linear/.test(keyText) && /ΔMAE\(Linear−DLinear\)/.test(keyText),
    verdict.slice(0, 120),
  )

  /* 5. 切换时间段，图表与结果同步变化 */
  await page.locator('.lab-case-keycell').nth(1).click()
  await page.waitForTimeout(600)
  const chartActive = await page.locator('.lab-case-keycell.active').nth(0).textContent()
  const chartLabel = ((await page.locator('.lab-case-chart').textContent()) || '').replace(/\s+/g, ' ')
  await page.locator('.lab-case-keycell').nth(0).click()
  await page.waitForTimeout(600)
  const chartLabel2 = ((await page.locator('.lab-case-chart').textContent()) || '').replace(/\s+/g, ' ')
  record(
    '5 在两个时间段之间切换：图表与结果同步变化',
    /另一时间段/.test(chartActive) && chartLabel !== chartLabel2 && /DLinear/.test(chartLabel2),
    `${chartLabel.slice(0, 46)} ⟷ ${chartLabel2.slice(0, 46)}`,
  )

  /* 6. 小咕三问 */
  await page.getByRole('button', { name: /这能说明什么/ }).click()
  await page.waitForTimeout(400)
  const what = ((await page.locator('.lab-case-explain').first().textContent()) || '').replace(/\s+/g, ' ')
  await page.getByRole('button', { name: /下一步查什么/ }).click()
  await page.waitForTimeout(400)
  const next = ((await page.locator('.lab-case-explain').first().textContent()) || '').replace(/\s+/g, ' ')
  record(
    '6 小咕：「这能说明什么」与「下一步查什么」都基于真实数字，且不夸大',
    /时间段敏感|对评估时间段敏感/.test(what) && /不能外推|不能扩大/.test(what) && /种子|异常窗口|波动/.test(next),
    `说明：${what.slice(0, 70)}…`,
  )

  /* 7. 论文侧 / 工具侧分开 */
  const paperBlock = ((await page.locator('.lab-case-paper').textContent()) || '').replace(/\s+/g, ' ')
  const quoteBlock = ((await page.locator('.lab-paper-quotes').textContent()) || '').replace(/\s+/g, ' ')
  record(
    '7 论文原句（含页码）与工具自己的观察分开显示',
    /本工具提出的问题/.test(paperBlock) && /本工具得到的观察/.test(paperBlock) && /第 4 页/.test(quoteBlock) && /moving average kernel/.test(quoteBlock),
    quoteBlock.slice(0, 80),
  )

  /* 8. 同口径对照表 */
  const compareText = ((await page.locator('.lab-compare').textContent()) || '').replace(/\s+/g, ' ')
  record(
    '8 与论文报告值的同口径对照（可对照 vs 暂不可直接对照）',
    /可以对照/.test(compareText) && /暂不可直接对照/.test(compareText) && /待检查因素/.test(compareText),
    compareText.slice(0, 110),
  )

  /* 9. 导出 + 刷新恢复 */
  const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null)
  await page.getByRole('link', { name: /导出案例报告/ }).click()
  const file = await dl
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lab-modebar', { timeout: 30000 })
  await page.getByRole('tab', { name: /官方论文方法/ }).click()
  await page.waitForSelector('.lab-case', { timeout: 30000 })
  await page.getByRole('button', { name: '查看已有实测结果' }).click()
  await page.waitForTimeout(4000)
  const restored = await page.locator('.lab-case-keycell').count()
  record(
    '9 导出案例报告，刷新后可从缓存恢复实测结果',
    Boolean(file?.suggestedFilename()) && restored === 2,
    `导出 ${file?.suggestedFilename() || '（未捕获）'}；刷新后格数 ${restored}`,
  )
} catch (e) {
  record('执行异常', false, e instanceof Error ? e.message : String(e))
} finally {
  await browser.close()
}

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length > 0 ? 1 : 0)
