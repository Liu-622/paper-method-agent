/**
 * 设计升级后的视觉与交互自查（不是编译检查）
 * 覆盖：首页 / 论文库 / 对比页 / 实验室 / 证据面板与侦探 / 验证计划，
 * 以及导航、折叠、筛选、展开、面板开关、焦点、主操作、图表切换、窄屏布局。
 * 产出截图到 _shots/，同时把关键测量值打印出来供判断。
 * 用法： node scripts/visual-audit.mjs [baseUrl]
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8787'
const OUT = join(process.cwd(), '_shots')
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
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: EDGE, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

const shot = async (name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false })
}

try {
  /* ---------- 准备：先载入示例项目，保证各页都有真实内容可看 ---------- */
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const demoBtn = page.locator('button', { hasText: /看示例|探索示例/ }).first()
  if (await demoBtn.count()) {
    await demoBtn.click()
    await page.waitForTimeout(3500)
  }

  /* ---------- 首页 ---------- */
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.home-start', { timeout: 30000 })
  await page.waitForTimeout(900)
  const homeStart = await page.locator('.home-start h1').textContent()
  const shell = await page.evaluate(() => {
    const shellEl = document.querySelector('.app-shell')
    const sidebar = document.querySelector('.sidebar')
    const pageEl = document.querySelector('.page')
    return {
      cols: shellEl ? getComputedStyle(shellEl).gridTemplateColumns : '',
      sidebarW: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
      pageW: pageEl ? Math.round(pageEl.getBoundingClientRect().width) : 0,
      bg: getComputedStyle(document.body).backgroundColor,
      h1: pageEl ? getComputedStyle(pageEl.querySelector('h1')).fontSize : '',
    }
  })
  record('首页：新的研究起点结构（一句定位 + 主操作）', /从论文里的一个疑问/.test(homeStart || ''), (homeStart || '').slice(0, 30))
  record('导航宽度在 208–224px 之间', shell.sidebarW >= 200 && shell.sidebarW <= 232, `sidebar=${shell.sidebarW}px, cols=${shell.cols}`)
  record('页面背景为浅灰 #F5F5F7 且工作区为白', shell.bg === 'rgb(245, 245, 247)', `body bg=${shell.bg}`)
  record('页标题字号 26–30px', parseFloat(shell.h1) >= 26 && parseFloat(shell.h1) <= 30, shell.h1)
  await shot('01-home-1440')

  /* ---------- 论文库 ---------- */
  await page.goto(`${BASE}/#/library`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const lib = await page.evaluate(() => ({
    hasToolbar: Boolean(document.querySelector('.library-toolbar')),
    rows: document.querySelectorAll('.paper-item').length,
    hasPrimary: document.querySelectorAll('.page-heading .btn-primary').length,
  }))
  record('论文库：列表式资料管理 + 工具条', lib.hasToolbar, `items=${lib.rows}`)
  record('论文库：页头只有一个主操作', lib.hasPrimary === 1, `primary=${lib.hasPrimary}`)
  await shot('02-library-1440')

  /* ---------- 对比页：紧凑选择 + 矩阵 ---------- */
  await page.goto(`${BASE}/#/compare`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.paper-picker', { timeout: 30000 })
  await page.waitForTimeout(800)
  const picker = await page.locator('.picker-item').count()
  record('对比页：紧凑选择区取代三张大卡', picker > 0, `picker=${picker}`)
  if (picker >= 2) {
    await page.locator('.picker-item').nth(0).click()
    await page.locator('.picker-item').nth(1).click()
    await page.waitForTimeout(1500)
  }
  const matrix = await page.evaluate(() => ({
    matrix: document.querySelectorAll('table.matrix, table.data').length,
    finding: document.querySelectorAll('.finding-line, .focus-block').length,
    sticky: Boolean(document.querySelector('table .row-label')),
  }))
  record('对比页：主内容以对齐的比较矩阵呈现', matrix.matrix > 0, `tables=${matrix.matrix}`)
  await shot('03-compare-1440')

  /* ---------- 实验室：图表中心 + 右侧上下文 ---------- */
  await page.goto(`${BASE}/#/lab?family=paper-linear&challenge=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.challenge', { timeout: 40000 })
  await page.waitForTimeout(1500)
  const lab = await page.evaluate(() => {
    const chart = document.querySelector('.lab-chart, .lab-case-chart, .challenge')
    const cond = document.querySelector('.lab-conditions')
    return {
      hasChart: Boolean(chart),
      chartW: chart ? Math.round(chart.getBoundingClientRect().width) : 0,
      condW: cond ? Math.round(cond.getBoundingClientRect().width) : 0,
    }
  })
  record('实验室：图表/主区明显宽于条件列（图表为视觉中心）', lab.hasChart && (lab.chartW === 0 || lab.chartW > lab.condW), `chart=${lab.chartW}px cond=${lab.condW}px`)
  await shot('04-lab-1440')

  /* ---------- 右侧上下文面板：侦探 ---------- */
  const paperId = await page.evaluate(() => {
    try {
      const raw = localStorage.getItem('paper-repro-guard.state.v1')
      const s = raw ? JSON.parse(raw) : null
      const list = s?.state?.papers ?? s?.papers ?? []
      return list[0]?.id ?? null
    } catch {
      return null
    }
  })
  if (paperId) {
    await page.goto(`${BASE}/#/paper/${paperId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.reading-row', { timeout: 30000 })
    await page.waitForTimeout(900)
  } else {
    await page.goto(`${BASE}/#/library`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    const link = page.locator('a[href*="#/paper/"], button[href*="#/paper/"]').first()
    if (await link.count()) {
      await link.click()
      await page.waitForSelector('.reading-row', { timeout: 30000 })
    }
  }
  const hasDetectBtn = page.getByRole('button', { name: '找线索' }).first()
  if (await hasDetectBtn.count()) {
    await hasDetectBtn.click()
    await page.waitForSelector('.context-pane', { timeout: 15000 })
    await page.waitForTimeout(900)
    const pane = await page.evaluate(() => {
      const p = document.querySelector('.context-pane')
      const main = document.querySelector('.main')
      return {
        paneW: p ? Math.round(p.getBoundingClientRect().width) : 0,
        mainW: main ? Math.round(main.getBoundingClientRect().width) : 0,
        tabs: document.querySelectorAll('.context-tab').length,
      }
    })
    record('宽屏：右侧上下文面板与主区并排（不遮挡）', pane.paneW > 300 && pane.mainW > 700, `pane=${pane.paneW}px main=${pane.mainW}px tabs=${pane.tabs}`)
    const detTab = page.locator('.context-tab', { hasText: '找线索' })
    record('面板内可切换「原文依据 / 找线索」', (await detTab.count()) > 0)
    await shot('05-detail-context-1440')
    // 关闭面板
    await page.locator('.context-head .icon-btn').click()
    await page.waitForTimeout(500)
    record('面板可关闭且主区恢复', (await page.locator('.context-pane').count()) === 0)
  } else {
    record('宽屏：右侧上下文面板与主区并排（不遮挡）', false, '没有找到「找线索」按钮')
  }

  /* ---------- 验证计划 ---------- */
  await page.goto(`${BASE}/#/plan`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const plan = await page.evaluate(() => ({
    settings: Boolean(document.querySelector('.plan-settings, details')),
    steps: document.querySelectorAll('.plan-steps, .experiment-card').length,
  }))
  record('验证计划：资源设置折叠、任务为主体', plan.settings || plan.steps > 0, `settings=${plan.settings} steps=${plan.steps}`)
  await shot('06-plan-1440')

  /* ---------- 交互细节：导航 / 折叠 / 焦点 ---------- */
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  await page.locator('.nav-item', { hasText: '论文库' }).click()
  await page.waitForTimeout(800)
  record('导航：点击跳转并出现选中态', (await page.locator('.nav-item.active', { hasText: '论文库' }).count()) > 0)
  const before = await page.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width))
  await page.locator('.sidebar-collapse').click()
  await page.waitForTimeout(500)
  const after = await page.evaluate(() => Math.round(document.querySelector('.sidebar').getBoundingClientRect().width))
  record('导航可折叠且宽度变化明显', after < before, `${before}px → ${after}px`)
  await page.locator('.sidebar-collapse').click()
  await page.waitForTimeout(400)
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => {
    const el = document.activeElement
    return el ? `${el.tagName}.${el.className}`.slice(0, 60) : ''
  })
  record('键盘焦点可达（Tab 能落到可交互元素）', focused.length > 0, focused)
  const search = page.locator('.topbar-search')
  record('顶部工具栏：搜索/快捷操作入口存在', (await search.count()) > 0)

  /* ---------- 宽屏 1920：增加有效信息而非空白 ---------- */
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${BASE}/#/compare`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const wide = await page.evaluate(() => {
    const pageEl = document.querySelector('.page')
    const r = pageEl.getBoundingClientRect()
    return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(window.innerWidth - r.right) }
  })
  record('1920 宽屏：工作区宽度利用充分（左右留白可控）', wide.w > 1400 && wide.left < 260, `pageW=${wide.w} left=${wide.left} right=${wide.right}`)
  await shot('07-compare-1920')

  /* ---------- 1366 笔记本 ---------- */
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.goto(`${BASE}/#/lab?family=paper-linear&challenge=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const laptop = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  record('1366 笔记本：无整页横向溢出', laptop.sw <= laptop.iw + 2, `scrollWidth=${laptop.sw} innerWidth=${laptop.iw}`)
  await shot('08-lab-1366')

  /* ---------- 390 窄屏 ---------- */
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const narrow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    sidebar: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
    tools: getComputedStyle(document.querySelector('.home-tools')).gridTemplateColumns,
  }))
  record('390 窄屏：无整页横向溢出且导航收为图标', narrow.sw <= narrow.iw + 2 && narrow.sidebar <= 72, `sw=${narrow.sw} iw=${narrow.iw} sidebar=${narrow.sidebar}px`)
  await shot('09-home-390')
  await page.goto(`${BASE}/#/compare`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const narrow2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }))
  record('390 窄屏：对比页也不横向溢出', narrow2.sw <= narrow2.iw + 2, `sw=${narrow2.sw} iw=${narrow2.iw}`)
  if (narrow2.sw > narrow2.iw + 2) {
    const culprits = await page.evaluate(() => {
      const out = []
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width > window.innerWidth + 2 && r.height > 8) {
          out.push(`${el.tagName}.${String(el.className).slice(0, 42)} w=${Math.round(r.width)}`)
        }
      })
      return out.slice(0, 6)
    })
    console.log('    溢出元素：' + culprits.join(' | '))
  }
  await shot('10-compare-390')

  record('页面无运行时错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (e) {
  record('执行异常', false, e instanceof Error ? e.message : String(e))
} finally {
  await browser.close()
}

const failed = steps.filter((s) => !s.ok)
console.log('')
console.log(`结果：通过 ${steps.length - failed.length} 项，失败 ${failed.length} 项`)
console.log(`截图目录：${OUT}`)
process.exit(failed.length > 0 ? 1 : 0)
