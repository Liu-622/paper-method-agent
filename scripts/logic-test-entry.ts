/**
 * 检查逻辑测试用例（会被 esbuild 打包成 Node 可跑的模块）
 * 用真实论文的抽取结果（脱敏为最小字段）验证判定是否符合预期。
 */
import type { Paper, PageText, ResourceProfile } from '@/types'
import { runFairnessCheck, runReproCheck, effectiveFieldStatus, fieldDisplayState } from '@/services/checks'
import { commonDatasets, rawDatasetsOf, scopedValue, sameDataset } from '@/services/scope'
import { buildRecords, recordComparison, recordOf, recordValue } from '@/services/records'
import {
  DEFAULT_PROFILE,
  clampManualStatus,
  collectRiskOptions,
  generatePlan,
  nextStatus,
  planToMarkdown,
} from '@/services/planner'
import { ruleMetaOf } from '@/data/rules'
import { normalizeValue, setOf } from '@/services/normalize'
import { cloneDemoEvidence, cloneDemoPapers } from '@/data/demoData'
import { classifyClaim, consistentWithRule, verifySystemClaim } from '@server/llm.mjs'

let pass = 0
let fail = 0
const lines: string[] = []

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1
    lines.push(`  [PASS] ${name}`)
  } else {
    fail += 1
    lines.push(`  [FAIL] ${name}${extra ? `  ${extra}` : ''}`)
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

/** 造一篇已解析论文的最小结构 */
function paper(id: string, shortLabel: string, fields: Record<string, string>, coverage?: Paper['coverage']): Paper {
  const built: Paper['fields'] = {}
  Object.entries(fields).forEach(([key, value]) => {
    built[key as keyof Paper['fields']] = {
      key: key as never,
      value,
      status: value ? 'found' : 'missing',
      origin: 'paper',
      evidenceIds: [],
    }
  })
  return {
    id,
    source: 'user',
    shortLabel,
    fileName: `${id}.pdf`,
    fileSize: 1000,
    title: `Paper ${shortLabel}`,
    year: 2024,
    venue: '—',
    status: 'parsed',
    uploadedAt: new Date().toISOString(),
    fields: built,
    pageCount: coverage?.totalPages ?? 10,
    textStored: true,
    coverage,
  }
}

export function run(): { text: string; failed: number } {
  lines.push('== 1. 数据集口径：集合不同 ≠ 共同实验不可比较 ==')

  // 真实场景：DLinear 9 个数据集，Autoformer 多一个 COVID-19
  const u1 = paper('u1', 'U1', {
    dataset: 'ETTh1、ETTh2、ETTm1、ETTm2、Traffic、Electricity、Weather、ILI、Exchange-Rate',
    split: '训练/验证/测试 = 7:1:2（ETTh1/ETTh2/ETTm1/ETTm2/Traffic/Electricity/Weather/ILI 均如此）',
    splitRange: '测试集为各数据集的最后 20%（ETTh1 为 2017.7-2018.7）',
    horizon: 'ILI 数据集预测跨度 T ∈ {24, 36, 48, 60}；其余八个数据集 T ∈ {96, 192, 336, 720}',
    sampleInterval: 'ETTh 为 1 小时、ETTm 为 15 分钟、Traffic 为 1 小时、Weather 为 10 分钟、ILI 为 1 周',
    metrics: 'MSE、MAE',
  })
  const u2 = paper('u2', 'U2', {
    dataset:
      'ETTh1、ETTh2、ETTm1、ETTm2、Traffic、Electricity、Weather、ILI、Exchange-Rate、COVID-19',
    split: '所有数据集按 7:1:2 划分（Weather 为 7:1:2；ILI 为 7:1:2）',
    splitRange: '测试集为各数据集的最后 20%（ETTh1 为 2017.7-2018.7；ILI 为最后 20%）',
    horizon: '主实验 O ∈ {96,192,336,720}；ILI 为 {24,36,48,60}；COVID-19 为 {7,15,30}',
    sampleInterval: 'ETTh 1小时、ETTm 15分钟；Weather 10分钟；ILI 周度',
    metrics: 'MSE、MAE、RMSE',
  })

  const commons = commonDatasets([u1, u2])
  check('能算出共同数据集（至少 2 篇都用）', commons.length >= 5, `实际=${commons.length}`)
  check(
    'ETTh1 被识别为共同数据集',
    commons.some((c) => c.name.toUpperCase().includes('ETTH1')),
  )
  check('COVID-19 不是共同数据集', !commons.some((c) => /COVID/i.test(c.name)))
  check('Exchange-Rate / Exchange 视为同一个数据集', sameDataset('Exchange-Rate', 'Exchange'))

  const unfair = runFairnessCheck([u1, u2], null)
  const datasetItem = unfair.find((i) => i.id === 'fair-dataset')!
  eq('数据集整体口径下判为存在差异', datasetItem.verdict, 'different')
  check(
    '理由里说明「不代表共同实验不可比较」并给出共同数据集',
    /不代表.*不可比较/.test(datasetItem.reason) && /ETTh1|Traffic|ILI/.test(datasetItem.reason),
    datasetItem.reason,
  )

  const scoped = runFairnessCheck([u1, u2], 'ETTh1')
  const scopedDataset = scoped.find((i) => i.id === 'fair-dataset')!
  eq('选定共同数据集后，数据集口径判为条件一致', scopedDataset.verdict, 'consistent')

  const scopedSplit = scoped.find((i) => i.id === 'fair-split')!
  eq('限定口径后：两篇的划分比例与测试区间都一致 → 条件一致', scopedSplit.verdict, 'consistent')
  check(
    '限定口径时每篇论文都说明用的是哪段原文',
    scopedSplit.perPaper.every((p) => (p.extra || '').includes('ETTh1') || (p.extra || '').includes('口径')),
    JSON.stringify(scopedSplit.perPaper.map((p) => p.extra)),
  )

  lines.push('== 2. 按数据集裁剪字段文本 ==')
  eq(
    'sampleInterval 按 ETTh1 裁到 ETTh 那一段',
    scopedValue('ETTh 为 1 小时、ETTm 为 15 分钟、Weather 为 10 分钟', 'ETTh1'),
    'ETTh 为 1 小时',
  )
  eq(
    'sampleInterval 按 ETTm1 只取 ETTm 那一段（不被 ETT 误匹配）',
    scopedValue('ETTh 为 1 小时、ETTm 为 15 分钟、Weather 为 10 分钟', 'ETTm1'),
    'ETTm 为 15 分钟',
  )
  eq(
    'horizon 命中「其余数据集」这类通用说法',
    scopedValue('ILI 数据集预测跨度 T ∈ {24, 36, 48, 60}；其余八个数据集 T ∈ {96, 192, 336, 720}', 'ETTh1'),
    '其余八个数据集 T ∈ {96, 192, 336, 720}',
  )
  eq(
    '论文只说明了别的数据集时返回 null（该数据集没单独说明）',
    scopedValue('只在 Traffic 上做了消融实验', 'Weather', ['Weather', 'Traffic']),
    null,
  )
  eq(
    '论文完全没提数据集时视为全局设置（适用于所有数据集）',
    scopedValue('主设置 192 步；额外迁移到 96 与 336 步', 'ETTm1', ['ETTm1', 'Weather']),
    '主设置 192 步；额外迁移到 96 与 336 步',
  )
  eq('不限定口径时原样返回', scopedValue('ETTh 1 小时、ETTm 15 分钟', null), 'ETTh 1 小时、ETTm 15 分钟')

  const noScopePaper = paper('u3', 'U3', {
    dataset: 'ETTh1、Traffic',
    split: '只在 Traffic 上做了划分实验',
    horizon: '仅报告 Traffic 的 96 步',
    sampleInterval: 'Traffic 为 1 小时',
  })
  const scopedGap = runFairnessCheck([noScopePaper, u1], 'ETTh1')
  eq(
    '某篇没说明该数据集 → 信息不足（不是判成差异）',
    scopedGap.find((i) => i.id === 'fair-horizon')!.verdict,
    'insufficient',
  )

  lines.push('== 3. 未检查 vs 未找到 ==')
  const fullCoverage = paper('c1', 'C1', {}, { totalPages: 10, usedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], skippedPages: [], emptyPages: [] })
  const partialCoverage = paper('c2', 'C2', {}, { totalPages: 20, usedPages: [1, 2, 3], skippedPages: [4, 5, 6], emptyPages: [19] })

  eq('所有页面都检查过 → 未找到', effectiveFieldStatus(fullCoverage, 'missing'), 'missing')
  eq('有页面未处理 → 未检查', effectiveFieldStatus(partialCoverage, 'missing'), 'unchecked')
  eq('已找到不受覆盖情况影响', effectiveFieldStatus(partialCoverage, 'found'), 'found')

  const reproFull = runReproCheck([fullCoverage])
  const reproPartial = runReproCheck([partialCoverage])
  const lrFull = reproFull.find((i) => i.key === 'learningRate')!
  const lrPartial = reproPartial.find((i) => i.key === 'learningRate')!
  eq('完整覆盖时学习率判为未找到', lrFull.verdict, 'missing')
  eq('覆盖不全时学习率判为未检查', lrPartial.verdict, 'unchecked')
  check(
    '未检查的理由里点名了具体页码',
    /4、5、6/.test(lrPartial.reason) && /19/.test(lrPartial.reason),
    lrPartial.reason,
  )
  check(
    '未找到的理由说明所有页面都已处理',
    /所有页面都已处理/.test(lrFull.reason),
    lrFull.reason,
  )

  lines.push('== 4. 复合判定与归一化 ==')
  const h1 = runFairnessCheck(
    [
      paper('h1', 'H1', { horizon: '96 步', sampleInterval: '15 分钟', dataset: 'X、Y' }),
      paper('h2', 'H2', { horizon: '96 步', sampleInterval: '1 小时', dataset: 'X、Y' }),
    ],
    null,
  )
  eq('步数相同但采样间隔不同 → 存在差异', h1.find((i) => i.id === 'fair-horizon')!.verdict, 'different')
  const h2 = runFairnessCheck(
    [
      paper('h3', 'H3', { horizon: '96 步', dataset: 'X、Y' }),
      paper('h4', 'H4', { horizon: '96 步', dataset: 'X、Y' }),
    ],
    null,
  )
  eq('步数相同但缺采样间隔 → 信息不足', h2.find((i) => i.id === 'fair-horizon')!.verdict, 'insufficient')

  const s1 = runFairnessCheck(
    [
      paper('s1', 'S1', { split: '7:1:2', dataset: 'X、Y' }),
      paper('s2', 'S2', { split: '7:1:2', dataset: 'X、Y' }),
    ],
    null,
  )
  eq('比例相同但缺测试区间 → 信息不足', s1.find((i) => i.id === 'fair-split')!.verdict, 'insufficient')

  eq('Unicode 减号归一化（10 −4 → 10^-4）', normalizeValue('learningRate', '10 \u22124'), '10^-4')
  eq('科学计数法与幂写法统一（1e-3 与 10^-3）', normalizeValue('learningRate', '1e-3'), '10^-3')
  eq('两种写法归一后相同', normalizeValue('learningRate', '1e-4') === normalizeValue('learningRate', '10 \u22124'), true)
  check(
    '数据集集合归一化后可比',
    setOf(normalizeValue('dataset', 'ETTh1、ETTh2')).has('ETTH1'),
  )

  lines.push('== 5. 演示项目：口径切换与证据完整性 ==')
  const demo = cloneDemoPapers()
  const evidenceIds = new Set(cloneDemoEvidence().map((e) => e.id))
  let dangling = 0
  const danglingList: string[] = []
  demo.forEach((p) => {
    Object.values(p.fields).forEach((f) => {
      ;(f?.evidenceIds || []).forEach((id) => {
        if (!evidenceIds.has(id)) {
          dangling += 1
          danglingList.push(`${p.shortLabel}:${id}`)
        }
      })
    })
  })
  eq('演示数据里没有指向不存在片段的引用', dangling, 0)
  if (danglingList.length) lines.push(`        （悬空：${danglingList.join('、')}）`)

  const demoCommon = commonDatasets(demo)
  check(
    '演示论文的共同数据集包含 ETTm1（保持原始写法）',
    demoCommon.some((c) => c.name === 'ETTm1'),
    demoCommon.map((c) => c.name).join('、'),
  )

  const demoAll = runFairnessCheck(demo, null)
  eq(
    '三篇演示论文整体口径下：数据集判为存在差异',
    demoAll.find((i) => i.id === 'fair-dataset')!.verdict,
    'different',
  )
  check(
    '理由指出「不代表共同实验不可比较」并给出共同数据集',
    /不代表.*不可比较/.test(demoAll.find((i) => i.id === 'fair-dataset')!.reason),
    demoAll.find((i) => i.id === 'fair-dataset')!.reason,
  )

  const demoScoped = runFairnessCheck(demo, 'ETTm1')
  eq(
    '限定 ETTm1 后：数据集口径判为条件一致',
    demoScoped.find((i) => i.id === 'fair-dataset')!.verdict,
    'consistent',
  )
  eq(
    '限定 ETTm1 后：P3 把序列重采样到 1 小时 → 跨度与时长存在差异',
    demoScoped.find((i) => i.id === 'fair-horizon')!.verdict,
    'different',
  )
  check(
    '差异理由里同时给出跨度与采样间隔',
    /跨度/.test(demoScoped.find((i) => i.id === 'fair-horizon')!.reason) &&
      /采样间隔/.test(demoScoped.find((i) => i.id === 'fair-horizon')!.reason),
    demoScoped.find((i) => i.id === 'fair-horizon')!.reason,
  )

  const demoP12 = runFairnessCheck(demo.slice(0, 2), 'ETTm1')
  eq(
    '只选 P1/P2 且在 ETTm1 口径下：跨度与时长条件一致',
    demoP12.find((i) => i.id === 'fair-horizon')!.verdict,
    'consistent',
  )

  lines.push('== 6. 数据集身份：不做"删掉末尾数字"的匹配 ==')
  eq('ETTh1 ≠ ETTh2', sameDataset('ETTh1', 'ETTh2'), false)
  eq('ETTm1 ≠ ETTm2', sameDataset('ETTm1', 'ETTm2'), false)
  eq('ETTh1 ≠ ETTm1', sameDataset('ETTh1', 'ETTm1'), false)
  eq('Exchange = Exchange-Rate（显式别名）', sameDataset('Exchange', 'Exchange-Rate'), true)
  eq('ETTh1 = ETTh1（精确同名）', sameDataset('ETTh1', 'ETTh1'), true)

  const fourEtt = paper('e0', 'E0', {
    dataset: 'ETTh1、ETTh2、ETTm1、ETTm2',
    sampleInterval: 'ETTh1 为 1 小时；ETTh2 为 1 小时；ETTm1 为 15 分钟；ETTm2 为 15 分钟',
  })
  const ettOnly = paper('e1', 'E1', {
    dataset: 'ETTh1、ETTm1',
    sampleInterval: 'ETTh1 为 1 小时；ETTm1 为 15 分钟',
  })
  const opts = commonDatasets([fourEtt, ettOnly], true)
  eq(
    '四个 ETT 数据集各自独立出现（不被合并）',
    opts.filter((o) => /^ETT/.test(o.name)).length,
    4,
  )
  eq('ETTh1 记作 2 篇包含', opts.find((o) => o.name === 'ETTh1')?.paperIds.length, 2)
  eq(
    'ETTh2 只被 1 篇包含，且缺失方被记录',
    opts.find((o) => o.name === 'ETTh2')?.missingPaperIds.length,
    1,
  )
  eq('总数被记录（用于显示 2/3 篇）', opts.find((o) => o.name === 'ETTh1')?.totalPapers, 2)

  lines.push('== 7. 只被部分论文包含的数据集：不许假装可比 ==')
  const twoOfThree = paper('t3', 'T3', {
    dataset: 'ETTh1、ETTm1',
    split: '7:1:2',
    sampleInterval: 'ETTm1 为 15 分钟',
    horizon: '96 步',
  })
  const threePaperScoped = runFairnessCheck([demo[0], demo[1], twoOfThree], 'ETTm1')
  const horizonItem = threePaperScoped.find((i) => i.id === 'fair-horizon')!
  const scopeOptEttm1 = commonDatasets([demo[0], demo[1], twoOfThree], true).find(
    (o) => o.name === 'ETTm1',
  )!
  eq('ETTm1 在 3 篇里被 3 篇包含', scopeOptEttm1.paperIds.length, 3)
  check(
    '限定口径后每篇论文都有取值或明确标为读不到（不允许假装可比）',
    horizonItem.perPaper.every((p) => p.value !== null || p.normalized === ''),
    JSON.stringify(horizonItem.perPaper.map((p) => [p.paperId, p.value])),
  )
  const partialScope = commonDatasets([demo[0], twoOfThree], true).find((o) => o.name === 'ETTh1')
  check(
    '只有 1 篇用到的数据集会被记录为 1/… 篇（界面据此显示"N/M 篇包含"）',
    Boolean(partialScope) && partialScope!.paperIds.length === 1,
    JSON.stringify(partialScope),
  )

  lines.push('== 8. 结构化实验记录 ==')
  const p1Records = buildRecords(demo[0])
  eq('P1 有 2 条实验记录（ETTm1、Weather）', p1Records.length, 2)
  const ettm1Record = p1Records.find((r) => r.dataset === 'ETTm1')!
  eq('记录里带 paperId', ettm1Record.paperId, demo[0].id)
  check('记录里带 evidenceIds', ettm1Record.evidenceIds.length > 0, `${ettm1Record.evidenceIds.length}`)
  check(
    '记录里的采样间隔是按数据集取到的（15 分钟）',
    /15/.test(ettm1Record.sampleInterval || ''),
    String(ettm1Record.sampleInterval),
  )
  check(
    '记录里保留逐字段读取状态',
    Object.keys(ettm1Record.fieldStatus).length > 0,
    JSON.stringify(ettm1Record.fieldStatus),
  )
  eq(
    '未读到数据集的论文退化成一条全局记录（不会被当成某数据集的实验）',
    buildRecords(paper('n1', 'N1', { split: '7:1:2' }))[0].dataset,
    '（未读到数据集）',
  )
  const recordCompare = recordComparison([demo[0], demo[2]], 'ETTm1')
  eq('记录比较：两篇都有 ETTm1 记录', recordCompare.missing.length, 0)
  const recordCompare2 = recordComparison([demo[2], twoOfThree], 'ETTh1')
  eq('记录比较：T3 没有 ETTm1 记录时会被列为缺失', recordCompare2.rows.filter((r) => !r.hasDataset).length, 1)

  lines.push('== 9. 三来源结论分类（服务端确定性规则） ==')
  eq(
    '「本次只提供了 1 篇论文正文」→ 系统事实',
    classifyClaim('本次只提供了 1 篇论文正文，无法进行跨论文比较。', { paperCount: 1 }),
    'system',
  )
  eq(
    '「当前选择 1 篇论文」→ 系统事实',
    classifyClaim('当前选择 1 篇论文，因此只能给出单篇结论。', { paperCount: 1 }),
    'system',
  )
  eq(
    '「采样间隔不同，因此不能直接比较」→ 规则推导',
    classifyClaim('两篇论文的采样间隔不同，因此不能直接比较它们的 MSE。', { paperCount: 2 }),
    'rule',
  )
  eq(
    '「DLinear 在 ETTm1 上用 15 分钟采样」→ 论文事实',
    classifyClaim('DLinear 在 ETTm1 上使用 15 分钟采样间隔。', { paperCount: 2 }),
    'paper',
  )
  eq(
    '系统事实与程序状态一致 → 判定通过',
    verifySystemClaim('本次只提供了 1 篇论文正文。', { paperCount: 1 }).ok,
    true,
  )
  eq(
    '系统事实与程序状态矛盾 → 被标出（不是撤回，而是明确指出数字不对）',
    verifySystemClaim('本次提供了 3 篇论文正文。', { paperCount: 1 }).ok,
    false,
  )

  lines.push('== 10. 验证计划：风险决定任务、资源决定取舍、状态门禁 ==')
  const planPapers = demo.slice(0, 3)
  const risks = collectRiskOptions(planPapers, 'ETTm1')
  check('风险清单非空（演示数据在 ETTm1 口径下有差异）', risks.length > 0, `${risks.length}`)
  const riskSplit = risks.find((r) => r.key === 'split' || r.id === 'fair-split')
  const riskSeed = risks.find((r) => r.key === 'randomSeed')
  const riskInterval = risks.find((r) => r.key === 'sampleInterval' || r.id === 'fair-horizon')

  const cpuProfile: ResourceProfile = {
    ...DEFAULT_PROFILE,
    device: 'cpu',
    timeBudget: '1h',
    goal: 'pipeline',
    dataset: 'ETTm1',
    dataReady: 'ready',
    codeReady: 'ready',
    riskIds: [riskSplit?.id].filter(Boolean) as string[],
  }
  const gpuProfile: ResourceProfile = {
    ...cpuProfile,
    device: 'gpu1',
    timeBudget: '3d',
    goal: 'fairness',
  }
  const planCpu = generatePlan(planPapers, cpuProfile, 'ETTm1', risks)
  const planGpu = generatePlan(planPapers, gpuProfile, 'ETTm1', risks)

  check('允许少于三个实验（不凑数）', planCpu.experiments.length >= 1 && planCpu.experiments.length <= 3, `${planCpu.experiments.length}`)
  check(
    '只勾一个风险 → 只生成一个实验',
    planCpu.experiments.length === 1,
    planCpu.experiments.map((e) => e.title).join(' / '),
  )
  check(
    '划分风险生成的是「划分核对」任务（问题里提到测试区间）',
    /划分/.test(planCpu.experiments[0].title) && /测试区间/.test(planCpu.experiments[0].question),
    planCpu.experiments[0].title,
  )
  check(
    'CPU + 1 小时的计划里没有任何训练步骤',
    planCpu.experiments.every((e) => e.steps.every((s) => !/跑一次最小训练|跑一次对照|训练链路/.test(s.text))),
    planCpu.experiments.flatMap((e) => e.steps.map((s) => s.text)).join(' | ').slice(0, 120),
  )
  check(
    'CPU + 1 小时把训练类任务放进「暂不适合本轮」而不是塞进计划',
    (planCpu.deferredTasks ?? []).some((d) => /训练/.test(d.title)),
    (planCpu.deferredTasks ?? []).map((d) => d.title).join(' / '),
  )
  check(
    '换成 GPU + 3 天后首个任务的规模说明不同（资源真的影响输出）',
    planCpu.experiments[0].scaleNote !== planGpu.experiments[0].scaleNote,
  )
  // 同一资源、换风险 → 步骤必须换一套
  const planSeed = generatePlan(planPapers, { ...gpuProfile, riskIds: [riskSeed?.id].filter(Boolean) as string[] }, 'ETTm1', risks)
  const planInterval = generatePlan(
    planPapers,
    { ...gpuProfile, riskIds: [riskInterval?.id].filter(Boolean) as string[] },
    'ETTm1',
    risks,
  )
  check(
    '风险换成「随机种子」→ 生成随机性/重复实验任务，步骤含种子与波动记录',
    /随机/.test(planSeed.experiments[0].title) && /种子/.test(planSeed.experiments[0].steps.map((s) => s.text).join(' ')),
    planSeed.experiments[0].title,
  )
  check(
    '风险换成「采样间隔/跨度」→ 生成时间跨度换算任务，步骤含换算',
    /跨度/.test(planInterval.experiments[0].title) &&
      /换算/.test(planInterval.experiments[0].steps.map((s) => s.text).join(' ')),
    planInterval.experiments[0].title,
  )
  check(
    '不同风险生成的步骤集合确实不同',
    planSeed.experiments[0].steps.map((s) => s.text).join('|') !==
      planInterval.experiments[0].steps.map((s) => s.text).join('|'),
  )
  check(
    '数据没准备好时，第一个任务是准备任务',
    generatePlan(planPapers, { ...gpuProfile, dataReady: 'none' }, 'ETTm1', risks).experiments[0].id === 'exp-prep',
  )
  check(
    '每个实验都写明问题/优先理由/一致性条件/变量/指标/支持与不支持/停止条件',
    planGpu.experiments.every(
      (e) =>
        e.question &&
        e.whyPriority &&
        e.keepConstant.length > 0 &&
        e.metrics.length > 0 &&
        e.supportIf.length > 0 &&
        e.refuteIf.length > 0 &&
        e.stopIf.length > 0,
    ),
  )
  const allValues = planGpu.experiments.flatMap((e) => e.values)
  check(
    '参数都标了来源（paper / tool / unconfirmed）',
    allValues.every((v) => ['paper', 'tool', 'unconfirmed'].includes(v.source)),
    JSON.stringify([...new Set(allValues.map((v) => v.source))]),
  )
  check(
    '论文没写清楚的项进了「待确认」而不是编一个值',
    planGpu.experiments.some((e) => e.pending.length > 0),
    `${planGpu.experiments.reduce((n, e) => n + e.pending.length, 0)} 条待确认`,
  )
  check(
    '规模说明里没有"几分钟跑完 / 显存够用"这类承诺',
    [...planCpu.experiments, ...planGpu.experiments].every(
      (e) => !/分钟(内)?(能|可以)?(跑完|完成)|显存(够|足够)|保证能跑/.test(e.scaleNote),
    ),
  )

  const exp1 = planGpu.experiments[0]
  eq('未勾选、无结果 → 未开始', nextStatus(exp1, undefined), 'not_started')
  const allSteps = Object.fromEntries(exp1.steps.map((s) => [s.id, true]))
  eq(
    '勾完全部步骤但没有实际结果 → 待确认（绝不是"验证成功"）',
    nextStatus(exp1, { status: 'not_started', steps: allSteps, actualResult: '', observation: '' }),
    'to_confirm',
  )
  eq(
    '**只填观察、没有实际结果 → 待确认**（观察不算结果）',
    nextStatus(exp1, { status: 'not_started', steps: allSteps, actualResult: '', observation: '看起来划分不一致' }),
    'to_confirm',
  )
  eq(
    '手动设为「已完成」但没有实际结果 → 被拦下改成待确认',
    clampManualStatus('done', { status: 'not_started', steps: allSteps, actualResult: '', observation: '有观察' })[0],
    'to_confirm',
  )
  eq(
    '手动设为「已完成」且被拦下 → 明确告知已拦截',
    clampManualStatus('done', { status: 'not_started', steps: allSteps, actualResult: '', observation: '有观察' })[1],
    true,
  )
  eq(
    '有实际结果时手动设为「已完成」→ 放行',
    clampManualStatus('done', { status: 'not_started', steps: allSteps, actualResult: 'MSE=0.4', observation: '' })[0],
    'done',
  )
  eq(
    '填了实际结果 → 已完成（状态只表示"记录完了"，不代表假设成立）',
    nextStatus(exp1, { status: 'not_started', steps: allSteps, actualResult: 'MSE=0.4', observation: '' }),
    'done',
  )
  const md = planToMarkdown(planGpu, {
    [exp1.id]: { status: 'to_confirm', steps: allSteps, actualResult: '', observation: '只写了观察' },
  })
  check('导出 Markdown 里写明「步骤勾完 ≠ 假设成立」', md.includes('步骤勾完 ≠ 假设成立'))
  check('导出 Markdown 里区分了三种参数来源', md.includes('论文给出的设置') && md.includes('待确认（论文没写清楚）'))
  check('导出 Markdown 里带规则编号', /规则 R-\d\d/.test(md) || md.includes('用到的检查规则'))
  check('导出 Markdown 里的状态与页面一致（观察不算结果 → 待确认）', md.includes('**状态**：待确认'))
  check('导出 Markdown 里列出「暂不适合本轮的任务」', md.includes('暂不适合本轮的任务'))

  lines.push('== 11. 规则推导的可信度门禁 ==')
  const fairItems = runFairnessCheck(demo.slice(0, 2), null)
  check(
    '每个公平性检查项都带规则编号（只有程序跑过的规则才有编号）',
    fairItems.every((f) => Boolean(f.ruleId)),
    JSON.stringify(fairItems.map((f) => `${f.id}:${f.ruleId}`)),
  )
  const reproItems = runReproCheck(demo.slice(0, 1))
  check(
    '每个复现缺项都带规则编号',
    reproItems.every((r) => Boolean(r.ruleId)),
    JSON.stringify(reproItems.slice(0, 3).map((r) => `${r.key}:${r.ruleId}`)),
  )
  check(
    '规则编号都能在规则目录里查到（可追溯）',
    [...fairItems, ...reproItems].every((i) => Boolean(ruleMetaOf(i.ruleId))),
  )
  eq(
    '「因为数据集不完全相同，所以不能直接比较」被判为规则类',
    classifyClaim('因为两篇论文的数据集不完全相同，所以不能直接比较。', { paperCount: 2 }),
    'rule',
  )

  lines.push('== 11b. 规则结论必须与规则结果一致（不能只看关键词）==')
  eq(
    '程序判「信息不足」而结论说「一致」→ 不一致，不允许标规则推导',
    consistentWithRule('两篇论文的训练/测试划分比例一致。', '信息不足'),
    false,
  )
  eq(
    '程序判「信息不足」而结论说「存在差异」→ 也不允许',
    consistentWithRule('两篇论文的划分存在差异，不能直接比较。', '信息不足'),
    false,
  )
  eq(
    '程序判「存在差异」而结论说「一致」→ 不允许',
    consistentWithRule('两篇论文的采样间隔一致。', '存在差异'),
    false,
  )
  eq(
    '程序判「存在差异」且结论也说「存在差异」→ 一致，允许',
    consistentWithRule('两篇论文的采样间隔不同，因此不能直接比较。', '存在差异'),
    true,
  )
  eq(
    '程序判「条件一致」且结论也说「一致」→ 允许',
    consistentWithRule('两篇论文在该数据集上的评价指标一致。', '条件一致'),
    true,
  )
  eq(
    '程序判「未找到」而结论说「条件一致」→ 不允许',
    consistentWithRule('两篇论文的基线设置条件一致。', '未找到'),
    false,
  )

  lines.push('== 12. 数据集名解析（括号与分组写法）==')
  const grouped = paper('g1', 'G1', { dataset: 'ETT（ETTh1、ETTh2、ETTm1、ETTm2）、Electricity' })
  check(
    '括号内的数据集名被正确拆出来（ETT（ETTh1 → ETTh1）',
    rawDatasetsOf(grouped).includes('ETTh1'),
    rawDatasetsOf(grouped).join('｜'),
  )
  eq('分组名 ETT 不会与 ETTh1 混为同一个数据集', sameDataset('ETT', 'ETTh1'), false)

  lines.push('')
  lines.push('== 13. 按数据集取值 + 划分与区间严格区分（调用真实 buildRecords / runFairnessCheck）==')
  // 三篇论文的最小复刻：
  //  A：ETT 按 6:2:2、其他数据集按 7:1:2（原文用"其他数据集"统称）
  //  B：整体 7:1:2
  //  C：正文没有说明划分
  const mk = (id: string, label: string, splitValue: string | null, splitRangeValue: string | null) => {
    const p = paper(id, label, { dataset: 'ETTh1、ETTm1、ETTm2、Traffic、Electricity、Weather' })
    const st = (v: string | null): Paper['fields'][keyof Paper['fields']] =>
      ({
        key: 'split' as never,
        value: v,
        status: v ? 'found' : 'missing',
        origin: 'paper',
        evidenceIds: [],
      }) as never
    p.fields.split = st(splitValue)
    p.fields.splitRange = st(splitRangeValue)
    return p
  }
  // A：原文写"ETT 按 6:2:2，其他数据集按 7:1:2" → 由服务端 perDataset 结构化保存
  const pa = mk('t-a', 'A 论文', 'ETT按6:2:2，其他数据集按7:1:2', '只给了比例，没有区间')
  pa.fields.split.perDataset = {
    overall: 'ETT按6:2:2，其他数据集按7:1:2',
    perDataset: [
      { dataset: 'ETTh1', value: 'ETT按6:2:2', page: 7 },
      { dataset: 'ETTm1', value: 'ETT按6:2:2', page: 7 },
      { dataset: 'ETTm2', value: 'ETT按6:2:2', page: 7 },
      { dataset: 'Traffic', value: '其他数据集按7:1:2', page: 7 },
      { dataset: 'Electricity', value: '其他数据集按7:1:2', page: 7 },
      { dataset: 'Weather', value: '其他数据集按7:1:2', page: 7 },
    ],
    scoped: true,
    note: null,
  }
  // B：只有一句整体比例（没有按数据集拆分）→ 走文本回退
  const pb = mk('t-b', 'B 论文', 'ETTm2 的训练/验证/测试 = 7:1:2', null)
  // C：正文没有说明划分
  const pc = mk('t-c', 'C 论文', null, null)

  const recA_ettm2 = recordOf(pa, 'ETTm2')
  eq('A 论文在 ETTm2 口径下的划分取值 = ETT 的 6:2:2', String(recordValue(recA_ettm2, 'split')), 'ETT按6:2:2')
  const recA_traffic = recordOf(pa, 'Traffic')
  check(
    'A 论文在 Traffic 口径下取到「其他数据集 7:1:2」，不会被 ETT 的 6:2:2 串用',
    /7:1:2/.test(String(recordValue(recA_traffic, 'split'))) && !/6:2:2/.test(String(recordValue(recA_traffic, 'split'))),
    String(recordValue(recA_traffic, 'split')),
  )
  eq('B 论文在 ETTm2 口径下的划分 = 7:1:2', String(recordValue(recordOf(pb, 'ETTm2'), 'split')), 'ETTm2 的训练/验证/测试 = 7:1:2')
  eq('C 论文没有说明划分 → null', String(recordValue(recordOf(pc, 'ETTm2'), 'split')), 'null')

  const cmpEtt = recordComparison([pa, pb, pc], 'ETTm2')
  eq(
    '真实比较函数（recordComparison）在 ETTm2 口径下按数据集分别取值：A=6:2:2',
    String(recordValue(cmpEtt.rows[0].record, 'split')),
    'ETT按6:2:2',
  )
  eq(
    '真实比较函数：B=7:1:2（没有 perDataset 时按数据集名回退匹配）',
    String(recordValue(cmpEtt.rows[1].record, 'split')),
    'ETTm2 的训练/验证/测试 = 7:1:2',
  )
  eq('真实比较函数：C=null（正文没说明）', String(recordValue(cmpEtt.rows[2].record, 'split')), 'null')
  check(
    'A 论文的 ETT 取值不会被套到它没涉及的数据集上（ETTm2 记录里不含 Traffic 的 7:1:2）',
    !/7:1:2/.test(String(recordValue(cmpEtt.rows[0].record, 'split'))),
  )

  const fairSplit = runFairnessCheck([pa, pb, pc], 'ETTm2').find((i) => i.key === 'split')
  check(
    '真实比较函数把划分判为「存在差异」（已知差异不会被"另一篇未知"盖掉）',
    fairSplit?.verdict === 'different',
    `verdict=${fairSplit?.verdict}｜` +
      (fairSplit?.perPaper || []).map((x) => `${x.paperId}=${String(x.value).slice(0, 12)}`).join(' / '),
  )

  // 划分比例 vs 测试时间区间：两者不能互相顶替
  const rangeOnly = paper('t-d', 'D 论文', {})
  rangeOnly.fields.split = { key: 'split' as never, value: null, status: 'missing', origin: 'paper', evidenceIds: [] } as never
  rangeOnly.fields.splitRange = {
    key: 'splitRange' as never,
    value: '只给了比例，没有区间',
    status: 'uncertain',
    origin: 'paper',
    evidenceIds: [],
    note: '这里看到的是划分比例，不是测试集的时间区间',
  } as never
  const recD = recordOf(rangeOnly, 'ETTm2')
  eq('只有区间/没有比例时，划分取值不会被当成比例', String(recordValue(recD, 'split')), 'null')
  check(
    '时间区间字段保持独立（note 说明它不是比例）',
    /不是测试集的时间区间/.test(String(rangeOnly.fields.splitRange?.note || '')),
  )
  check(
    '有页面没有可读文本时，字段显示为「尚未检查完整」而不是「未找到」',
    fieldDisplayState(
      { ...pc, status: 'parsed', fields: { ...pc.fields, split: { ...pc.fields.split, checkState: 'unchecked' } } } as never,
      'split' as never,
    ).state === 'not_checked',
  )
  const stOk = fieldDisplayState(pa, 'split' as never)
  eq('字段显示状态：A 的划分是「已确认」', stOk.state, 'ok')
  const stMissing = fieldDisplayState(pc, 'split' as never)
  eq('字段显示状态：C 的划分是「本次未找到明确说明」（不是"原文没写"）', stMissing.state, 'not_found')
  check('「本次未找到明确说明」的提示语里写明不等于原文没有', /不等于原文/.test(stMissing.hint), stMissing.hint)
  const usagePaper = paper('t-e', 'E 论文', { dataset: 'ETTh1' })
  usagePaper.fields.dataset = {
    key: 'dataset' as never,
    value: 'ETTh1、ETTm1',
    status: 'found',
    origin: 'paper',
    evidenceIds: [],
    usageOk: false,
  } as never
  eq('集合字段缺"实验用途"证据 → 显示「已有线索，需确认」', fieldDisplayState(usagePaper, 'dataset' as never).state, 'need_confirm')

  lines.push('')
  lines.push(`结果：通过 ${pass} 项，失败 ${fail} 项`)
  return { text: lines.join('\n'), failed: fail }
}
