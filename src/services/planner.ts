import type {
  CheckPerPaper,
  ExperimentProgress,
  ExperimentRecord,
  ExperimentStatus,
  FairnessItem,
  FieldKey,
  Paper,
  PlanValue,
  ReproItem,
  ReproVerdict,
  ResourceProfile,
  RiskOption,
  VerificationExperiment,
  VerificationPlan,
} from '@/types'
import { ruleIdOfFairness, reproRuleId } from '@/data/rules'
import { sameDataset } from './scope'
import { describeNormalized } from './normalize'
import { runFairnessCheck, runReproCheck } from './checks'
import { buildRecords } from './records'

/**
 * 按用户资源生成最小验证实验
 * ------------------------------------------------------------------
 * 设计原则（写代码时不许违反）：
 *  1. **区分来源**：每一个参数都标来源 ——
 *     paper（论文原文写明）/ tool（工具建议）/ unconfirmed（论文没写清楚，待确认）。
 *     论文没写的一律进「待确认」，绝不编造数值。
 *  2. **不承诺**：设备与时间只用来**缩小规模、安排先后顺序**。没有实测依据时，
 *     不写"几分钟能跑完"、"X GB 显存够用"这类话。
 *  3. **完成步骤 ≠ 假设成立**：只有用户填了实际结果，才允许出现「有结果」状态。
 */

/* ------------------------------------------------------------------ */
/* 用户输入                                                            */
/* ------------------------------------------------------------------ */

/** 默认值：用户不改也能直接生成计划 */
export const DEFAULT_PROFILE: ResourceProfile = {
  device: 'gpu1',
  deviceNote: '',
  timeBudget: '1d',
  goal: 'fairness',
  dataset: null,
  riskIds: [],
  codeUrl: '',
  codeReady: 'partial',
  dataReady: 'partial',
}

export const DEVICE_TEXT: Record<ResourceProfile['device'], string> = {
  cpu: '仅 CPU',
  gpu1: '单张 GPU',
  custom: '自定义',
}
export const TIME_TEXT: Record<ResourceProfile['timeBudget'], string> = {
  '1h': '1 小时以内',
  '1d': '1 天',
  '3d': '3 天',
  '1w': '1 周',
}
export const GOAL_TEXT: Record<ResourceProfile['goal'], string> = {
  pipeline: '先跑通流程',
  'single-claim': '验证一个关键结论',
  fairness: '检查比较是否公平',
}
export const STATUS_TEXT: Record<ExperimentStatus, string> = {
  not_started: '未开始',
  running: '进行中',
  to_confirm: '待确认',
  done: '已完成',
}
export const SOURCE_TEXT: Record<PlanValue['source'], string> = {
  paper: '论文给出的设置',
  tool: '工具建议的设置',
  unconfirmed: '待确认（论文没写清楚）',
}

/* ------------------------------------------------------------------ */
/* 工具侧：风险项清单                                                  */
/* ------------------------------------------------------------------ */

/** 供界面选择的「需要确认的风险」清单：只列真正有问题或有缺口的项 */
export function collectRiskOptions(papers: Paper[], scope: string | null): RiskOption[] {
  if (papers.length === 0) return []
  const out: RiskOption[] = []

  for (const item of runFairnessCheck(papers, scope)) {
    if (item.key === 'method') continue
    if (item.verdict === 'consistent') continue
    out.push({
      id: item.id,
      key: String(item.key),
      label: item.label,
      detail: item.reason,
      kind: 'fairness',
      ruleId: ruleIdOfFairness(item),
      verdictText: item.verdict === 'different' ? '存在差异' : '信息不足',
      perPaper: item.perPaper,
    })
  }

  for (const item of runReproCheck(papers)) {
    if (item.verdict === 'found' || item.verdict === 'manual') continue
    out.push({
      id: item.id,
      key: String(item.key),
      label: item.label,
      detail: item.reason,
      kind: 'repro',
      ruleId: reproRuleId(item.verdict),
      verdictText: REPRO_VERDICT_SHORT[item.verdict] ?? item.verdict,
      perPaper: item.perPaper,
    })
  }

  return out
}

/* ------------------------------------------------------------------ */
/* 生成计划                                                            */
/* ------------------------------------------------------------------ */

/** 从结构化实验记录里取一项，并标明来源（paper / tool / unconfirmed） */
function valueOf(papers: Paper[], scope: string | null, key: FieldKey, label: string): PlanValue {
  const parts: string[] = []
  const evidenceIds: string[] = []
  const unconfirmed: string[] = []
  const needsConfirm: string[] = []
  let fromPaper = 0

  for (const paper of papers) {
    const field = paper.fields[key]
    const record: ExperimentRecord | null = scope
      ? (buildRecords(paper).find((r) => sameDataset(r.dataset, scope)) ?? null)
      : (buildRecords(paper)[0] ?? null)
    const raw = record
      ? key === 'split'
        ? record.split
        : key === 'splitRange'
          ? record.testRange
          : key === 'sampleInterval'
            ? record.sampleInterval
            : key === 'horizon'
              ? record.horizon
              : key === 'metrics'
                ? record.metrics.join('、') || null
                : key === 'preprocessing'
                  ? record.preprocessing
                  : (field?.value ?? null)
      : (field?.value ?? null)

    if (raw && field?.status === 'found' && field.origin !== 'user') {
      parts.push(`${paper.shortLabel}：${String(raw).slice(0, 120)}`)
      evidenceIds.push(...(field.evidenceIds || []))
      fromPaper += 1
    } else if (raw) {
      // 有值但不是"已找到"（需要确认 / 人工补充）→ 必须回原文确认，不能当论文给出的设置
      parts.push(`${paper.shortLabel}：${String(raw).slice(0, 120)}（需回原文确认）`)
      if (field?.evidenceIds?.length) evidenceIds.push(...field.evidenceIds)
      needsConfirm.push(paper.shortLabel)
    } else {
      unconfirmed.push(paper.shortLabel)
    }
  }

  const source: PlanValue['source'] =
    unconfirmed.length > 0 || needsConfirm.length > 0
      ? 'unconfirmed'
      : fromPaper === papers.length
        ? 'paper'
        : 'tool'
  const noteParts: string[] = []
  if (unconfirmed.length > 0) {
    noteParts.push(`${unconfirmed.join('、')} 没有读到这个字段，必须先在原文里确认，不能沿用默认值`)
  }
  if (needsConfirm.length > 0) {
    noteParts.push(`${needsConfirm.join('、')} 的取值需要回原文/向作者确认后才能当依据`)
  }
  return {
    label,
    value: parts.length ? parts.join('；') : '论文未给出',
    source,
    field: key,
    evidenceIds: [...new Set(evidenceIds)],
    note: noteParts.length ? noteParts.join('；') : undefined,
  }
}

/** 设备与时间如何影响规模（只缩规模、排先后，不做时间/显存承诺） */
function scaleAdvice(profile: ResourceProfile): { tail: string; small: boolean } {
  if (profile.device === 'cpu' && profile.timeBudget === '1h') {
    return {
      small: true,
      tail:
        '资源条件（仅 CPU + 1 小时以内）：建议只做数据与评估流程核对、指标复算，不训练模型；' +
        '具体耗时取决于论文代码与数据规模，本工具不对时间或显存做任何承诺。',
    }
  }
  if (profile.device === 'cpu') {
    return {
      small: true,
      tail:
        '资源条件（仅 CPU）：建议把实验压到「一个数据集 + 一个跨度 + 最小 epoch」，或直接使用论文/官方仓库给出的权重与中间产物；' +
        '本工具不对训练耗时或内存做承诺。',
    }
  }
  if (profile.device === 'gpu1') {
    return {
      small: false,
      tail:
        '资源条件（单张 GPU）：通常可以跑一次单点训练或一次对照，但**能否跑完取决于论文代码、数据规模与显卡型号**，本工具不做显存或耗时承诺。',
    }
  }
  return {
    small: false,
    tail: `资源条件（自定义：${profile.deviceNote || '未说明'}）：请按实际可用资源自行缩小或扩大规模；本工具不做时间与显存承诺。`,
  }
}


const MAX_EXPERIMENTS = 3

/* ------------------------------------------------------------------ */
/* 任务模板：风险类型 → 对应的验证任务                                  */
/* ------------------------------------------------------------------ */

/** 训练类任务是否可用：数据没准备 / 代码没跑通 / 只有 1 小时 / 仅 CPU → 都不适合训练 */
function canTrainNow(profile: ResourceProfile): { ok: boolean; reason: string } {
  if (profile.timeBudget === '1h') {
    return { ok: false, reason: '可投入时间只有 1 小时以内：训练类任务放不进这一轮' }
  }
  if (profile.device === 'cpu') {
    return { ok: false, reason: '仅 CPU：训练类任务建议改用官方权重或最小规模，本轮先不做' }
  }
  if (profile.dataReady === 'none') {
    return { ok: false, reason: '数据还没有准备：先完成数据准备与核对任务' }
  }
  if (profile.codeReady === 'none') {
    return { ok: false, reason: '代码尚未跑通：先完成代码检查任务' }
  }
  return { ok: true, reason: '' }
}

/** 按风险项生成对应类型的验证任务（不同的风险 → 不同的问题、步骤、变量与指标） */
function taskForRisk(
  risk: RiskOption,
  papers: Paper[],
  scope: string | null,
  values: ReturnType<typeof collectValues>,
  scale: { tail: string; small: boolean },
  train: { ok: boolean; reason: string },
  profile: ResourceProfile,
): VerificationExperiment {
  const datasetLabel = scope ?? '论文整体口径（未限定数据集）'
  const why = `对应检查项「${risk.label}」（规则 ${risk.ruleId}，判定：${risk.verdictText}）。`
  const base = {
    relatedRiskIds: [risk.id],
    relatedRiskLabels: [risk.label],
    relatedEvidence: [] as VerificationExperiment['relatedEvidence'],
    prepare: {
      data: [`目标数据集：${scope ?? '论文里该风险涉及的原始数据'}`],
      code: [] as string[],
      env: ['Python + 论文代码依赖（按论文或仓库说明安装）'],
    },
    scaleNote: scale.tail,
  }

  // 划分问题 → 划分核对（比例 + 测试区间 + 两篇是否同一段数据）
  if (risk.id === 'fair-split' || risk.key === 'split' || risk.key === 'splitRange') {
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `划分核对：比例、测试区间与数据窗口是否一致（${datasetLabel}）`,
      question: `两篇论文在「${datasetLabel}」上的划分比例与测试区间分别是什么？比例相同的话，测试的是不是同一段数据？`,
      whyPriority: `${why}这一步不训练也能做，且它决定后面所有数字有没有可比性。`,
      values: [values.dataset, values.split, values.splitRange],
      steps: [
        { id: 's1', text: `分别记下两篇的划分比例：${values.split.value.slice(0, 90)}`, done: false },
        { id: 's2', text: `分别找出测试区间（时间范围 / 最后百分比）：${values.splitRange.value.slice(0, 90)}`, done: false },
        { id: 's3', text: '核对：比例相同 ≠ 同一段测试数据 —— 比较两篇测试区间的起止（或长度占比）是否一致', done: false },
        { id: 's4', text: '把两篇的划分与区间写进同一张表（数据集 / 比例 / 测试起止 / 来源页码）', done: false },
      ],
      keepConstant: ['比较时使用同一个数据集', '统计口径（按时间轴还是按样本数）'],
      variables: ['划分比例与测试区间（这是本任务要确认的量，不改动它们本身）'],
      metrics: ['每篇的划分比例', '测试区间的起止或长度占比', '两篇是否落在同一段数据上'],
      supportIf: ['两篇的测试区间（不只是比例）指向同一段数据'],
      refuteIf: ['比例相同但区间不同，或其中一篇没有写明区间'],
      stopIf: ['任一篇没有给出区间且无法从原始数据长度推出来 → 记录"信息不足"，先向作者确认'],
      pending: values.pendingOf(values.split, values.splitRange),
    }
  }

  // 采样间隔 / 跨度问题 → 时间跨度换算
  if (risk.id === 'fair-horizon' || risk.key === 'sampleInterval' || risk.key === 'horizon') {
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `时间跨度换算：步数换算成实际时长后是否可比（${datasetLabel}）`,
      question: `两篇论文的预测跨度（步数）和采样间隔分别是什么？步数相同的话，实际预测时长一样吗？`,
      whyPriority: `${why}步数相同 ≠ 预测时长相同，这一步只用纸面计算就能完成。`,
      values: [values.dataset, values.horizon, values.interval],
      steps: [
        { id: 's1', text: `列出两篇的跨度集合：${values.horizon.value.slice(0, 90)}`, done: false },
        { id: 's2', text: `列出两篇在该数据集上的采样间隔：${values.interval.value.slice(0, 90)}`, done: false },
        { id: 's3', text: '换算：每个跨度 × 采样间隔 = 实际预测时长（例如 96 步 × 15 分钟 = 24 小时）', done: false },
        { id: 's4', text: '比较换算后的时长集合，找出只有一方覆盖的时长（这些点不可比）', done: false },
      ],
      keepConstant: ['换算时使用同一单位（分钟或小时）', '比较同一数据集下的时长'],
      variables: ['跨度步数与采样间隔（要确认的量）'],
      metrics: ['换算后的实际预测时长集合', '两篇共同覆盖的时长', '只有一方覆盖的时长'],
      supportIf: ['换算后两篇覆盖的实际时长集合一致'],
      refuteIf: ['步数相同但间隔不同（实际时长不同），或共同覆盖的时长很少'],
      stopIf: ['某篇没有写明该数据集的采样间隔 → 记录"信息不足"，不要用常见默认值代替'],
      pending: values.pendingOf(values.horizon, values.interval),
    }
  }

  // 随机种子缺失 → 随机性记录 / 重复实验建议
  if (risk.key === 'randomSeed') {
    const rep = train.ok ? 3 : 2
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `随机性与重复实验：没有种子时结果有多稳（${datasetLabel}）`,
      question: '论文没有给出随机种子。用不同的种子/初始化重复跑同一个小设置，结果波动有多大？报告的是单次还是平均？',
      whyPriority: `${why}没有种子意味着报告的数字可能只是某一次运行的结果；先量化波动，才能判断"差 2%"到底有没有意义。`,
      values: [values.dataset, values.horizon, values.interval],
      prepare: {
        ...base.prepare,
        code: [
          train.ok
            ? '论文/官方仓库代码（能跑通的前提下做最小设置）'
            : '暂不训练：先用论文报告的"平均值/多次运行"表述做纸面核对，等代码与数据就绪后再跑',
        ],
        env: [
          train.ok
            ? `${profile.device === 'cpu' ? '仅 CPU：把规模压到最小（单变量、最小 epoch）' : '单张 GPU 或你自定义的设备'}`
            : '本任务不需要 GPU：纸面核对部分现在就能做',
        ],
      },
      steps: [
        { id: 's1', text: '回原文确认：论文说结果是单次还是 N 次运行的平均？如果写了，记下 N', done: false },
        { id: 's2', text: '在代码里显式设置并记录每个种子（不要依赖默认随机性）', done: false },
        {
          id: 's3',
          text: train.ok
            ? `用 ${rep} 个不同种子跑同一个最小设置，记录每次的指标与均值/标准差`
            : `纸面核对：把"多次运行平均"与"单次运行"的差异列成对照，并记下等代码就绪后要跑的 ${rep} 次重复计划`,
          done: false,
        },
        { id: 's4', text: '把波动幅度（标准差或极差）与论文报告的提升幅度放在一起比较', done: false },
      ],
      keepConstant: ['数据划分与评估代码', '模型与超参数（除种子外的全部）'],
      variables: ['随机种子 / 初始化'],
      metrics: ['每次运行的指标', '均值与标准差', '波动幅度 vs 论文声称的提升幅度'],
      supportIf: ['波动远小于两篇论文之间的差异 → 差异不太可能是随机性造成的'],
      refuteIf: ['波动与论文声称的提升同量级 → 不能排除"结果靠运气"'],
      stopIf: [
        '如果时间预算不允许重复 → 至少完成 s1/s2（记录种子与运行口径），重复实验列入待办',
        scale.small ? '仅 CPU/1 小时：跳过实际训练，保留纸面核对' : '重复次数可以按时间预算缩到 2 次',
      ],
      pending: ['随机种子：论文未给出（待确认）', '运行次数：需回原文确认是单次还是平均'],
    }
  }

  // 预处理 → 归一化与信息泄漏检查
  if (risk.key === 'preprocessing') {
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `归一化与信息泄漏检查（${datasetLabel}）`,
      question: '两篇论文的归一化方式一致吗？统计量是只用训练集算的，还是用了全量数据（后者会泄漏未来信息）？',
      whyPriority: `${why}归一化口径不同会让指标不可比，且信息泄漏会让结果偏乐观 —— 这一步看代码就能确认。`,
      values: [values.dataset, values.preprocessing],
      steps: [
        { id: 's1', text: `记下两篇的预处理描述：${values.preprocessing.value.slice(0, 90)}`, done: false },
        { id: 's2', text: '在代码里定位归一化调用的位置：是在划分之前还是之后', done: false },
        { id: 's3', text: '确认统计量（均值/方差或 min/max）来自训练集还是全量数据', done: false },
        { id: 's4', text: '如果有论文未写明的部分，记录为待确认并注明要向作者问什么', done: false },
      ],
      keepConstant: ['同一份数据与划分', '同一份评估代码'],
      variables: ['归一化方式与统计量来源（要确认的量）'],
      metrics: ['归一化方式', '统计量来源（训练集 / 全量）', '是否存在信息泄漏'],
      supportIf: ['两篇方式一致且统计量都只来自训练集'],
      refuteIf: ['方式不同，或任一篇用全量数据统计（泄漏）'],
      stopIf: ['代码不可得 → 只做纸面比对并标记"待确认"'],
      pending: values.pendingOf(values.preprocessing),
    }
  }

  // 指标 → 指标口径核对
  if (risk.key === 'metrics') {
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `指标口径核对（${datasetLabel}）`,
      question: '两篇报告的是同一组指标吗？计算方式（在什么尺度上平均、是否含反归一化）一致吗？',
      whyPriority: `${why}指标口径不同时数字不可直接对照，这一步只需读论文与看代码。`,
      values: [values.dataset, values.metrics],
      steps: [
        { id: 's1', text: `列出两篇的指标集合：${values.metrics.value.slice(0, 90)}`, done: false },
        { id: 's2', text: '确认每个指标是在归一化前还是归一化后的尺度上计算', done: false },
        { id: 's3', text: '确认平均方式（按样本 / 按变量 / 按时间步）', done: false },
        { id: 's4', text: '用同一份评估代码对同一份预测复算指标，比较两篇的口径是否一致', done: false },
      ],
      keepConstant: ['同一份预测结果', '同一份评估代码'],
      variables: ['指标定义与计算口径（要确认的量）'],
      metrics: ['指标集合', '计算尺度与平均方式'],
      supportIf: ['集合一致且口径一致'],
      refuteIf: ['集合不同（一方多报告指标），或口径不一致'],
      stopIf: ['论文未写明口径 → 标记待确认，先在相同口径的子集上比较'],
      pending: values.pendingOf(values.metrics),
    }
  }

  // 评估协议 → 单次多步 vs 滚动
  if (risk.key === 'evalProtocol') {
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `评估协议核对（${datasetLabel}）`,
      question: '两篇都是"一次生成全部预测步"，还是滚动/自回归预测？这两种协议的数字不可直接比较。',
      whyPriority: `${why}评估协议不同是常见的隐性不公平来源，确认它不需要训练。`,
      values: [values.dataset],
      steps: [
        { id: 's1', text: '在两篇的实验设置里找到评估协议的描述并记录页码', done: false },
        { id: 's2', text: '在代码里确认推理循环：一次前向出全部步，还是分步滚动', done: false },
        { id: 's3', text: '若不同：记录哪些结果表受影响，不要把这些表的数字放在一起比', done: false },
      ],
      keepConstant: ['比较时只使用同一种协议下的结果'],
      variables: ['评估协议（要确认的量）'],
      metrics: ['每篇的评估协议'],
      supportIf: ['两篇使用同一协议'],
      refuteIf: ['协议不同（单次多步 vs 滚动）'],
      stopIf: ['论文未写明 → 标记待确认'],
      pending: [],
    }
  }

  // 基线 → 基线集合核对
  if (risk.key === 'baselines') {
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `对比基线核对（${datasetLabel}）`,
      question: '两篇比较的基线集合一样吗？"相对提升"的分母不同，不能跨论文比较。',
      whyPriority: `${why}基线不同会让百分比提升不可比。`,
      values: [values.dataset],
      steps: [
        { id: 's1', text: '列出两篇的基线集合并记录来源页码', done: false },
        { id: 's2', text: '找出共同基线：只有这些基线上的对比是可比较的', done: false },
        { id: 's3', text: '检查基线数字是作者自己复现的还是引用来的（复现设置是否一致）', done: false },
      ],
      keepConstant: ['只在共同基线上比较'],
      variables: ['基线集合（要确认的量）'],
      metrics: ['基线集合', '共同基线数量', '基线数字来源（复现/引用）'],
      supportIf: ['基线集合一致或共同基线足够多'],
      refuteIf: ['基线集合基本不重叠'],
      stopIf: ['基线数字来源不明 → 标记待确认'],
      pending: [],
    }
  }

  // 未检查（有页面没被处理）→ 先去读那几页
  if (risk.verdictText === '未检查') {
    return {
      ...base,
      id: `exp-${risk.id}`,
      priority: 0,
      title: `先补查未检查的页面：${risk.label}`,
      question: `这一项被判为「未检查」是因为有页面没被处理。哪些页？上面写没写这项设置？`,
      whyPriority: `${why}在读完这些页之前，这一项既不能说"论文写了"也不能说"没写"。`,
      values: [values.dataset],
      steps: [
        { id: 's1', text: `打开原文中被列出的页面（见实验检查页的说明：${risk.detail.slice(0, 60)}…）`, done: false },
        { id: 's2', text: '逐页查找该设置的表述，找到就记录页码与原句', done: false },
        { id: 's3', text: '找到后回工具里用「人工补充 / 修正这一项」录入，并注明来源页码', done: false },
        { id: 's4', text: '确实没写 → 回到复现缺项页确认它显示为「未找到」', done: false },
      ],
      keepConstant: ['只读原文，不做任何实现改动'],
      variables: [],
      metrics: ['找到/没找到', '找到时的页码与原句'],
      supportIf: ['在未检查的页面里找到了该设置的明确表述'],
      refuteIf: ['全部页面读完后仍没有该设置 → 记为「未找到」'],
      stopIf: ['页面是扫描件/图片 → 需要 OCR，本工具暂不支持'],
      pending: [],
    }
  }

  // 训练细节类（学习率/批大小/轮数/优化器）→ 来源确认任务
  return {
    ...base,
    id: `exp-${risk.id}`,
    priority: 0,
    title: `确认「${risk.label}」的取值来源（${datasetLabel}）`,
    question: `论文没有写明${risk.label}。官方仓库的默认值是多少？你实际打算用多少？两者都要记录，不能只记一个。`,
    whyPriority: `${why}复现结果对训练细节敏感，先把"用什么值、值从哪来"定下来，后面的实验才有可解释性。`,
    values: [values.dataset],
    steps: [
      { id: 's1', text: '打开官方仓库，找到该参数的默认值并记录（提交哈希/文件名）', done: false },
      { id: 's2', text: '写下你打算用的值与理由（例如沿用默认 / 按资源缩小）', done: false },
      { id: 's3', text: '把两个值都记进实验记录：默认值（来源=代码）与你用的值（来源=自己设定）', done: false },
      {
        id: 's4',
        text: train.ok
          ? '跑一个最小设置，确认改动该参数后结果是否明显变化（敏感性）'
          : '暂不跑敏感性：列入待办，等代码与数据就绪',
        done: false,
      },
    ],
    keepConstant: ['除该参数外的全部设置'],
    variables: [risk.label],
    metrics: ['默认值与你的取值', '（若跑了敏感性）改动前后的指标变化'],
    supportIf: ['默认值明确且你的取值有记录'],
    refuteIf: ['仓库默认值与论文表述矛盾（例如论文暗示另一个量级）→ 需要向作者确认'],
    stopIf: ['仓库没有公开 → 标记待确认并记录你自行设定的值'],
    pending: [`${risk.label}：论文未给出（待确认，先用仓库默认并记录来源）`],
  }
}

/** 收集字段取值（含来源），供任务模板引用 */
function collectValues(papers: Paper[], scope: string | null) {
  const dataset = {
    label: '目标数据集',
    value: scope ?? '论文整体口径',
    source: 'tool' as const,
    note: scope ? '由你在计划里选定' : '未限定数据集，结论只适用于论文级设置',
  }
  const split = valueOf(papers, scope, 'split', '训练/验证/测试划分')
  const splitRange = valueOf(papers, scope, 'splitRange', '测试区间')
  const interval = valueOf(papers, scope, 'sampleInterval', '采样间隔')
  const horizon = valueOf(papers, scope, 'horizon', '预测跨度')
  const metrics = valueOf(papers, scope, 'metrics', '评价指标')
  const preprocessing = valueOf(papers, scope, 'preprocessing', '预处理')
  const pendingOf = (...list: PlanValue[]) =>
    list
      .filter((v) => v.source === 'unconfirmed')
      .map((v) => `${v.label}：论文没写清楚，待确认（${v.note ?? '需要回原文核对'}）`)
  return {
    dataset,
    split,
    splitRange,
    interval,
    horizon,
    metrics,
    preprocessing,
    pendingOf,
    all: [dataset, split, splitRange, interval, horizon, metrics, preprocessing],
  }
}

/**
 * 生成按优先级排列的验证实验（1 ~ 3 个，不凑数）。
 * 任务内容由**风险类型**决定；顺序与取舍由**资源**决定：
 *  - 数据没准备好 / 代码没跑通 → 先安排准备与检查任务；
 *  - 只有 1 小时 / 仅 CPU → 不排训练步骤，训练类任务进「暂不适合」清单；
 *  - 选了什么风险，就生成什么任务 —— 换一个风险，步骤与指标就换一套。
 */
export function generatePlan(
  papers: Paper[],
  profile: ResourceProfile,
  scope: string | null,
  risks: RiskOption[],
): VerificationPlan {
  const scale = scaleAdvice(profile)
  const datasetLabel = scope ?? '论文整体口径（未限定数据集）'
  const paperLabels = papers.map((p) => p.shortLabel)
  const values = collectValues(papers, scope)
  const train = canTrainNow(profile)
  const chosen = risks.filter((r) => profile.riskIds.includes(r.id))

  const experiments: VerificationExperiment[] = []
  const deferredTasks: { title: string; reason: string }[] = []

  // 1) 没数据 / 代码没跑通 → 先安排准备任务（放在最前面）
  const needPrep = profile.dataReady === 'none' || profile.codeReady === 'none'
  if (needPrep) {
    experiments.push({
      id: 'exp-prep',
      priority: 0,
      title: `先做准备工作：${[profile.dataReady === 'none' ? '数据' : '', profile.codeReady === 'none' ? '代码' : '']
        .filter(Boolean)
        .join(' 与 ')}还没就绪`,
      question: '数据与代码就绪之前，任何验证实验都建立在不可复现的基础上。这一步先把它们准备好并确认能跑。',
      whyPriority:
        '你填写的信息里，数据或代码还没有就绪。先完成准备与检查，再谈验证 —— 否则跑出来的数字无法解释。',
      relatedRiskIds: [],
      relatedRiskLabels: [],
      relatedEvidence: [],
      values: [values.dataset],
      prepare: {
        data: [
          profile.dataReady === 'none'
            ? '把目标数据集的原始文件下载/整理好（论文或仓库一般给出获取方式）'
            : '数据已就绪（你填写的状态）',
        ],
        code: [
          profile.codeReady === 'none'
            ? '拉取论文/官方仓库代码，按说明安装依赖，先跑通它自带的示例或最小入口'
            : `已有代码地址：${profile.codeUrl || '（未填写）'}`,
        ],
        env: ['Python 环境 + 仓库依赖；这一步不需要 GPU'],
      },
      steps: [
        { id: 's1', text: '准备好数据：能读到完整的一条序列（打印长度与时间范围）', done: false },
        { id: 's2', text: '跑通代码的最小入口（示例脚本 / 单测），确认没有环境错误', done: false },
        { id: 's3', text: '把数据与代码的版本（提交哈希 / 下载日期）记录下来', done: false },
      ],
      keepConstant: ['后续所有任务都使用这一步准备的数据与代码版本'],
      variables: [],
      metrics: ['数据长度与时间范围', '代码能否跑通（跑通的入口）'],
      supportIf: ['数据完整、代码能跑通最小示例'],
      refuteIf: ['数据不完整或代码跑不通 → 后续任务全部保持未开始'],
      stopIf: ['数据无法获取 → 停止，改为纸面口径核对（只比较论文写明的设置）'],
      scaleNote: '准备工作现在就能做，不受设备限制；本工具不对耗时做承诺。',
      pending: [],
    })
  }

  // 2) 按风险生成任务（最多到 3 个为止，包含准备任务占用的名额）
  for (const risk of chosen) {
    if (experiments.length >= MAX_EXPERIMENTS) break
    const task = taskForRisk(risk, papers, scope, values, scale, train, profile)
    // 训练强度高的任务在当前资源下不合适 → 不生成，进「暂不适合」清单
    if (risk.key === 'randomSeed' && !train.ok && profile.timeBudget === '1h') {
      // 随机性任务降级后仍可做（纸面核对），保留；只有纯训练任务会被推迟
    }
    experiments.push(task)
  }

  // 3) 一个任务都没有（没选风险、也不需要准备）→ 给一个最小的流程核对任务
  if (experiments.length === 0) {
    experiments.push({
      id: 'exp-pipeline',
      priority: 0,
      title: `最小流程核对：数据划分与指标计算（${datasetLabel}）`,
      question: `在「${datasetLabel}」上，数据划分 / 采样间隔 / 指标计算的实现是否与论文描述一致？`,
      whyPriority:
        '你没有勾选任何风险项，因此只安排一个不依赖训练的流程核对：先确认"数字是怎么算出来的"，后面的实验才有意义。',
      relatedRiskIds: [],
      relatedRiskLabels: [],
      relatedEvidence: [],
      values: values.all,
      prepare: {
        data: [`目标数据集：${scope ?? '论文里该数据集对应的原始数据'}`, '建议只取一段连续时间窗口，先把流程跑通'],
        code: ['论文/官方仓库的数据处理与评估脚本'],
        env: ['本步骤不需要 GPU'],
      },
      steps: [
        { id: 's1', text: `按论文口径实现/核对数据划分：${values.split.value.slice(0, 90)}`, done: false },
        { id: 's2', text: `核对采样间隔：${values.interval.value.slice(0, 90)}`, done: false },
        { id: 's3', text: `用同一份评估代码复算指标（${values.metrics.value.slice(0, 60)}）`, done: false },
        { id: 's4', text: '打印并保存数据形状、时间范围与采样间隔，作为记录', done: false },
      ],
      keepConstant: ['数据集与时间窗口', '划分比例与测试区间（如果论文写了）', '评价指标定义'],
      variables: ['本步骤不改变模型或训练参数'],
      metrics: ['各集合长度与时间范围', '采样间隔', '复算指标与论文报告值的量级关系'],
      supportIf: ['划分、区间、间隔与论文一致，且指标复算量级合理'],
      refuteIf: ['任一项与论文不一致（比例相同但区间不同也算）'],
      stopIf: ['数据无法获取 → 改为纸面口径核对，不训练'],
      scaleNote: scale.tail,
      pending: values
        .all.filter((v) => v.source === 'unconfirmed')
        .map((v) => `${v.label}：论文没写清楚，待确认（${v.note ?? '需要回原文核对'}）`),
    })
  }

  // 4) 训练类后续任务单独列出（不进入本轮计划）
  if (!train.ok) {
    deferredTasks.push({
      title: '最小规模的单点训练（跑通训练与评估链路）',
      reason: train.reason + '；等条件满足后再生成训练类任务',
    })
    deferredTasks.push({
      title: '换一个跨度/数据集重复评估（稳健性检查）',
      reason: '依赖上一步训练结果，本轮不安排',
    })
  } else {
    deferredTasks.push({
      title: '换一个跨度/数据集重复评估（稳健性检查）',
      reason: '安排在训练任务之后：先有单点基线，再检查稳健性',
    })
  }

  // 4) 资源允许时，追加一个依赖训练的任务（资源不允许则进「暂不适合」清单）
  const hasConditionRisk = chosen.some(
    (r) => r.kind === 'fairness' || r.key === 'sampleInterval' || r.key === 'horizon' || r.key === 'split',
  )
  if (train.ok && experiments.length < MAX_EXPERIMENTS) {
    experiments.push({
      id: 'exp-train',
      priority: 0,
      title: hasConditionRisk
        ? `对齐条件后重跑一次对照（最小规模，${datasetLabel}）`
        : `最小规模的单点训练：跑通训练与评估链路（${datasetLabel}）`,
      question: hasConditionRisk
        ? '把两边的条件对齐到同一数据集、同一跨度、同一指标后，原先的差异还剩多少？'
        : '在最小规模设置下，模型能否跑出与论文同方向（趋势一致）的结果？',
      whyPriority:
        '你的资源与准备情况允许跑一次训练（设备不是仅 CPU、时间不止 1 小时、数据与代码已就绪），' +
        '所以把这一步排进本轮：只有先有一个真实跑出来的基线数字，前面核对出来的口径差异才能被量化。',
      relatedRiskIds: chosen.map((r) => r.id),
      relatedRiskLabels: chosen.map((r) => r.label),
      relatedEvidence: [],
      values: [values.dataset, values.horizon, values.interval, values.metrics],
      prepare: {
        data: [`同一个数据集（${scope ?? '论文对应数据集'}），沿用上一步核对过的划分结果`],
        code: ['论文/官方仓库的训练与评估代码（建议先用官方默认超参数跑一次）'],
        env: [
          `${profile.device === 'gpu1' ? '单张 GPU' : profile.device === 'custom' ? `自定义设备（${profile.deviceNote || '未说明'}）` : '你的设备'}`,
          '训练细节多数论文没写全 → 先用仓库默认值，并把用到的值逐条记录下来',
        ],
      },
      steps: [
        { id: 's1', text: '用论文/仓库默认超参数跑一次最小训练（先不管能不能追平论文数字）', done: false },
        { id: 's2', text: '用与上一步完全相同的评估代码计算指标', done: false },
        { id: 's3', text: '把本次用到的所有超参数（含默认值来源）逐条记录下来', done: false },
        { id: 's4', text: '保存指标结果与运行配置，作为后续比较的基线', done: false },
        { id: 's5', text: '把跑出来的数字与论文报告值对照：方向是否一致、量级是否接近（不要求追平）', done: false },
      ],
      keepConstant: ['数据划分与测试区间（与核对结果一致）', '评估代码与指标口径', '模型结构'],
      variables: ['训练是否真的能跑通（本轮只验证链路与趋势）'],
      metrics: ['MSE / MAE（或论文使用的指标）', '与论文报告值的**方向与量级**关系', '运行配置（超参数、数据窗口）'],
      supportIf: ['结果与论文同方向，且指标在同一量级区间内'],
      refuteIf: ['结果与论文方向相反，且在确认实现无误后仍然相反'],
      stopIf: [
        '训练明显超出时间预算 → 立即改小：更少 epoch、单变量序列，或只做评估',
        '本轮只是最小规模验证 → 不要写成"完整复现"',
      ],
      scaleNote: `${scale.tail} 注意：最小规模跑通**不等于**复现了论文结果。`,
      pending: ['学习率 / 批大小 / 训练轮数 / 随机种子：论文多数没写明，先用仓库默认值并记录来源'],
    })
  }

  // 5) 编号与优先级（1 起）
  experiments.forEach((e, i) => {
    e.priority = i + 1
  })

  return {
    id: `plan-${Date.now()}`,
    createdAt: new Date().toISOString(),
    profile,
    dataset: scope,
    paperLabels,
    experiments,
    deferredTasks,
    ruleIds: chosen.map((c) => c.ruleId),
    noResultsYet: true,
  }
}


/* ------------------------------------------------------------------ */
/* 导出与状态                                                          */
/* ------------------------------------------------------------------ */

/**
 * 用户记录结果后推进状态。这是**执行状态**，不是假设判断：
 *  - 「已完成」只表示"记录完了"，不代表假设得到支持（是否成立由用户按
 *    「什么结果支持/不支持假设」自行判定）；
 *  - **只有「实际结果」能触发已完成** —— 只填「观察」不算，观察是解释不是跑出来的数字/事实；
 *  - 手动切换走 clampManualStatus 的同一道校验。
 */
export function nextStatus(
  exp: VerificationExperiment,
  progress: ExperimentProgress | undefined,
): ExperimentStatus {
  const steps = progress?.steps ?? {}
  const doneCount = exp.steps.filter((s) => steps[s.id]).length
  const hasResult = Boolean(progress?.actualResult?.trim())
  if (hasResult) return 'done'
  if (doneCount > 0 && doneCount < exp.steps.length) return 'running'
  if (doneCount >= exp.steps.length && exp.steps.length > 0) return 'to_confirm'
  return 'not_started'
}

/** 手动切换也必须过同一道校验：想「已完成」但没有实际结果 → 只能给「待确认」 */
export function clampManualStatus(
  status: ExperimentStatus,
  progress: ExperimentProgress | undefined,
): [ExperimentStatus, boolean] {
  if (status === 'done' && !progress?.actualResult?.trim()) {
    return ['to_confirm', true]
  }
  return [status, false]
}

/** 步骤勾完但没填结果时，界面必须显示这句话 */
export const NO_RESULT_WARNING =
  '步骤勾完 ≠ 假设成立。你还没有填写「实际结果」，因此这里不会给出任何"验证成功/失败"的结论。'

/** 只填了「观察」、没填「实际结果」时的提示 */
export const OBSERVATION_ONLY_WARNING =
  '「我的观察」是解释，不是跑出来的结果。只填观察不能把实验标为「已完成」——请把跑出来的数字/事实填进「实际结果」。'

export function planToMarkdown(
  plan: VerificationPlan,
  progress: Record<string, ExperimentProgress>,
): string {
  const lines: string[] = []
  lines.push(`# 最小验证实验计划（${plan.paperLabels.join('、')}）`)
  lines.push('')
  lines.push(`- 生成时间：${new Date(plan.createdAt).toLocaleString('zh-CN')}`)
  lines.push(`- 目标数据集：${plan.dataset ?? '论文整体口径（未限定）'}`)
  lines.push(
    `- 设备条件：${DEVICE_TEXT[plan.profile.device]}${plan.profile.deviceNote ? `（${plan.profile.deviceNote}）` : ''}`,
  )
  lines.push(`- 可投入时间：${TIME_TEXT[plan.profile.timeBudget]}`)
  lines.push(`- 目标：${GOAL_TEXT[plan.profile.goal]}`)
  lines.push(`- 用到的检查规则：${plan.ruleIds.join('、') || '（无）'}`)
  lines.push('')
  lines.push('> 标「论文给出的设置」的项来自原文并可回溯页码；标「工具建议的设置」的是本工具的建议；')
  lines.push('> 标「待确认」的是论文没有写清楚、必须先回原文或向作者确认的参数，本工具不会替你编造。')
  lines.push('')
  if (plan.deferredTasks?.length) {
    lines.push('## 暂不适合本轮的任务（等条件满足后再生成）')
    lines.push('')
    for (const d of plan.deferredTasks) {
      lines.push(`- **${d.title}** —— ${d.reason}`)
    }
    lines.push('')
  }

  for (const exp of plan.experiments) {
    const p = progress[exp.id]
    const status = p?.status ?? nextStatus(exp, p)
    lines.push(`## 优先级 ${exp.priority}｜${exp.title}`)
    lines.push('')
    lines.push(`**状态**：${STATUS_TEXT[status]}`)
    lines.push('')
    lines.push(`**要确认的问题**：${exp.question}`)
    lines.push('')
    lines.push(`**为什么优先**：${exp.whyPriority}`)
    lines.push('')
    lines.push('### 关键参数（含来源）')
    lines.push('')
    lines.push('| 参数 | 取值 | 来源 |')
    lines.push('| --- | --- | --- |')
    for (const v of exp.values) {
      lines.push(`| ${v.label} | ${v.value.replace(/\|/g, '/')} | ${SOURCE_TEXT[v.source]} |`)
    }
    lines.push('')
    if (exp.pending.length) {
      lines.push('### 待确认项（论文没写清楚，不要编造）')
      lines.push('')
      exp.pending.forEach((x) => lines.push(`- ${x}`))
      lines.push('')
    }
    lines.push('### 需要准备')
    lines.push('')
    lines.push('**数据**')
    exp.prepare.data.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('**代码**')
    exp.prepare.code.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('**环境**')
    exp.prepare.env.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('### 最小操作步骤')
    lines.push('')
    exp.steps.forEach((s) => lines.push(`- [${p?.steps?.[s.id] ? 'x' : ' '}] ${s.text}`))
    lines.push('')
    lines.push('### 保持一致的条件')
    exp.keepConstant.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('### 需要改变的变量')
    exp.variables.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('### 应记录的指标')
    exp.metrics.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('### 什么结果支持当前假设')
    exp.supportIf.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('### 什么结果不支持当前假设')
    exp.refuteIf.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('### 什么情况下停止 / 改用更小的实验')
    exp.stopIf.forEach((x) => lines.push(`- ${x}`))
    lines.push('')
    lines.push('### 规模说明')
    lines.push('')
    lines.push(exp.scaleNote)
    lines.push('')
    lines.push('### 我的实际结果')
    lines.push('')
    lines.push(p?.actualResult?.trim() ? p.actualResult : '（未填写）')
    lines.push('')
    lines.push('### 我的观察')
    lines.push('')
    lines.push(p?.observation?.trim() ? p.observation : '（未填写）')
    lines.push('')
    if (!p?.actualResult?.trim()) {
      // 没有「实际结果」就不是完成：单独填了「观察」也要把这句话写进导出文档，
      // 保证导出文档与页面、刷新后的状态判断一致。
      lines.push(`> ${NO_RESULT_WARNING}`)
      lines.push('')
      if (p?.observation?.trim()) {
        lines.push(`> ${OBSERVATION_ONLY_WARNING}`)
        lines.push('')
      }
    }
    lines.push('---')
    lines.push('')
  }
  return lines.join('\n')
}

const REPRO_VERDICT_SHORT: Record<ReproVerdict, string> = {
  found: '已找到',
  missing: '未找到',
  unchecked: '未检查',
  need_confirm: '需要确认',
  manual: '人工补充',
}

