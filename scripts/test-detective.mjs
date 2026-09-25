/**
 * 小咕侦探 + 论文对撞台 · 离线回归（不需要模型密钥）
 * 覆盖本轮纠偏要求：
 *  侦探：代码线索要绑定「仓库版本/方法/数据集/任务/跨度/脚本」；默认值覆盖要核对；
 *        归属不匹配要说明；找不到要说清查过哪些来源；无模型时降级可用。
 *  对撞台：四类判定分开（性能差异 / 报告值不同 / 主张分歧 / 可比性待确认）；
 *        10% 阈值只筛选数值，不决定类别；不允许为了凑卡片制造冲突。
 * 用法： node scripts/test-detective.mjs
 */
const { runDetective, cancelDetective, DETECTIVE_FIELDS, ALLOWED_REPOS, detectiveTasks } = await import('../server/detective.mjs')
const { buildClashCards, labSupportFor, isVerbatimEvidence, RELATIONS } = await import('../server/clash.mjs')

let pass = 0
let fail = 0
const lines = []
const check = (name, ok, extra = '') => {
  if (ok) pass += 1
  else fail += 1
  lines.push(`${ok ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`)
}

const PAGES = [
  {
    page: 4,
    text: 'Evaluation metric. Following previous works, we use Mean Squared Error (MSE) and Mean Absolute Error (MAE) as the core metrics to compare performance. For DLinear, we train the model with the learning rate of 0.001 and batch size 32 on ETTh1.',
  },
  { page: 9, text: 'We also adopt their default hyper-parameters to train the models. For DLinear, the moving average kernel size for decomposition is 25, which is the same as Autoformer.' },
]

/* ==================== 一、侦探：来源与归属 ==================== */
const r1 = await runDetective({
  paper: { fields: { learningRate: { value: '0.01', evidenceIds: [] } } },
  fieldKey: 'learningRate',
  dataset: 'ETTm2',
  model: 'DLinear',
  horizon: 96,
  pages: PAGES,
  taskId: 'test-1',
})
check('侦探能返回结论与阶段记录', r1.ok === true && Array.isArray(r1.stages) && r1.stages.length >= 4, `${r1.stages?.length} 个阶段`)
check('每条线索都带来源类型与出处', r1.clues.every((c) => ['paper', 'official-code'].includes(c.sourceType) && (c.evidence.page || (c.evidence.path && c.evidence.line))))
check(
  '代码线索都带仓库路径、行号与提交版本',
  r1.clues.filter((c) => c.sourceType === 'official-code').every((c) => c.evidence.path && c.evidence.line > 0 && c.evidence.sha.length === 40),
)
check('与已有值做了比对并标出一致性', r1.clues.every((c) => c.inconsistent === null || typeof c.inconsistent === 'boolean'))
check('列出了实际查过的来源', r1.sourcesChecked.length >= 3 && r1.sourcesChecked.every((s) => s.kind && s.label))
check('上限定死（文件数/片段数/字节数）', r1.limits.maxFiles <= 8 && r1.limits.maxExcerpts <= 40 && r1.limits.maxTotalBytes <= 600 * 1024)

/* --- 本轮重点：方法归属绑定 --- */
const codeClues = r1.clues.filter((c) => c.sourceType === 'official-code')
check('代码线索数量 > 0', codeClues.length > 0, `${codeClues.length} 条`)
check(
  '每条代码线索都绑定「仓库版本/方法/数据集/任务/跨度/脚本」六要素',
  codeClues.every((c) => {
    const b = c.binding
    return b && b.repo && b.sha && b.script && typeof b.line === 'number' && 'method' in b && 'dataset' in b && 'task' in b && 'horizon' in b
  }),
)
const scriptClues = codeClues.filter((c) => /\.sh$/.test(c.binding.script))
check('来自实验脚本的线索能定位到具体实验块的方法与跨度', scriptClues.length > 0 && scriptClues.every((c) => c.binding.method), `${scriptClues.length} 条来自 .sh`)
const ettm2Clue = scriptClues.find((c) => /ettm2\.sh$/.test(c.binding.script))
check(
  'Linear/ 目录下的 ettm2.sh 归属按脚本里的 model_name 判定（不是按目录名）',
  Boolean(ettm2Clue) && String(ettm2Clue.binding.method).toLowerCase() === 'dlinear',
  ettm2Clue ? `${ettm2Clue.binding.script} → ${ettm2Clue.binding.method}（声明在第 ${ettm2Clue.binding.methodDeclaredAt?.line} 行）` : '没有拿到 ettm2.sh 线索',
)
check(
  '线索带"是否已确认"的状态标签，未确认的不会被说成已确认',
  codeClues.every((c) => ['script-explicit', 'repo-default', 'file-level'].includes(c.binding.status) && typeof c.binding.confirmed === 'boolean' && c.binding.statusLabel.length > 2),
)
check(
  '入口脚本的默认值标为"仓库默认值（未经脚本确认）"',
  codeClues.filter((c) => /run_longExp\.py$/.test(c.binding.script)).every((c) => c.binding.status === 'repo-default'),
)
check('读到仓库默认值时，核对了实验脚本是否覆盖', codeClues.filter((c) => c.binding.status === 'repo-default').every((c) => c.override === null || c.override.script))
check(
  '给 DLinear 找线索时，若脚本块默认属于别的方法，会明确说明差异',
  codeClues.every((c) => c.methodMatch && (c.methodMatch.ok === true || /不是|没有方法声明|不能直接/.test(c.methodMatch.note))),
)
check('归属不匹配的线索只作候选，并提示会记为"用户选择的新设置"', codeClues.every((c) => c.methodMatch.ok || (c.confidence !== 'confirmed' && /用户选择的新设置/.test(String(c.adoptionNote)))))

/* 代码片段逐字回查 */
const { readFileSync, existsSync } = await import('node:fs')
const { join } = await import('node:path')
const repoDir = ALLOWED_REPOS[0].localDir
const verifyOne = codeClues.find((c) => existsSync(join(repoDir, c.evidence.path)))
if (verifyOne) {
  const fileText = readFileSync(join(repoDir, verifyOne.evidence.path), 'utf8')
  const line = fileText.split(/\r?\n/)[verifyOne.evidence.line - 1] || ''
  check('线索片段与文件该行一致（逐字回查）', line.includes(verifyOne.evidence.snippet.slice(0, 30)), `${verifyOne.evidence.path}:${verifyOne.evidence.line}`)
} else {
  check('线索片段与文件该行一致（逐字回查）', false, '没有可回查的代码线索')
}

const r2 = await runDetective({ paper: { fields: {} }, fieldKey: 'learningRate', dataset: 'NotARealDataset', model: 'DLinear', horizon: 96, pages: [], taskId: 'test-2' })
check('数据集未知时如实标注"未确认数据集"', r2.clues.every((c) => !c.appliesTo.dataset || /未确认数据集|属于/.test(String(c.scope))))
check('找不到时给出下一步而不是编造', typeof r2.nextStep === 'string' && r2.nextStep.length > 10)
check('不支持的字段被明确拒绝', (await runDetective({ paper: {}, fieldKey: 'notAField', pages: [], taskId: 'x' })).ok === false)
const taskId = 'test-cancel'
detectiveTasks.set(taskId, { cancelled: true })
check('取消接口能命中运行中的任务', cancelDetective(taskId) === true)
check('取消未知任务返回 false（不假装成功）', cancelDetective('nope') === false)
check('没有模型时仍能给出程序找到的原始片段', r1.mode === 'program' && codeClues.length > 0 && /未经归纳|程序/.test(r1.note))
check('支持的字段列表与需求一致', ['learningRate', 'batchSize', 'epochs', 'seqLen', 'horizon', 'split', 'preprocessing'].every((k) => DETECTIVE_FIELDS.some((f) => f.key === k)))
check('summary 会提到方法归属情况', /方法归属/.test(r1.summary) || /绑定方法归属/.test(r1.summary), r1.summary)

/* ==================== 二、对撞台：四类判定 ==================== */
const mk = (id, label, fields, ev) => ({ id, shortLabel: label, fields, evidence: ev })
const EV = (id, page, text) => ({ id, page, text })

/* 1) 不同方法、同一范围、数值差大 → 性能差异（不是观点分歧） */
const A = mk('A', 'PaperA', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE, MSE' }, horizon: { value: '96' }, method: { value: 'DLinear' }, conclusion: { value: 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.' } }, [EV('e1', 5, 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.')])
const B = mk('B', 'PaperB', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE, MSE' }, horizon: { value: '96' }, method: { value: 'PatchTST' }, conclusion: { value: 'PatchTST reaches MAE 0.320 on ETTm2 at horizon 96.' } }, [EV('e2', 7, 'PatchTST reaches MAE 0.320 on ETTm2 at horizon 96.')])
const perf = buildClashCards({ papers: [A, B] })
check('不同方法成绩不同 → 判为「不同方法的性能差异」', perf.cards.some((c) => c.relation.code === 'performanceDifference') && !perf.cards.some((c) => c.relation.code === 'claimConflict'), perf.cards.map((c) => c.relation.code).join(','))
check('性能差异卡的说明明确"不是观点分歧"', perf.cards.some((c) => c.relation.code === 'performanceDifference' && /性能差异/.test(c.relationReason) && /不构成|不是/.test(c.relationReason)))
check('数值阈值只作提示（signals.worthChecking），不决定类别', perf.cards.every((c) => typeof c.signals?.worthChecking === 'boolean'))

/* 2) 同一方法报告不同成绩 → 报告值不同，需核对实验设置 */
const A2 = mk('A2', 'PaperA', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear' }, conclusion: { value: 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.' } }, [EV('e3', 5, 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.')])
const B2 = mk('B2', 'PaperB', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear' }, conclusion: { value: 'We report DLinear MAE 0.310 on ETTm2 at horizon 96.' } }, [EV('e4', 9, 'We report DLinear MAE 0.310 on ETTm2 at horizon 96.')])
const same = buildClashCards({ papers: [A2, B2] })
check('同一方法报告值不同 → 判为「报告值不同，需核对实验设置」', same.cards.some((c) => c.relation.code === 'reportValueMismatch'), same.cards.map((c) => c.relation.code).join(','))
check('报告值不同的卡不判定谁对谁错', same.cards.filter((c) => c.relation.code === 'reportValueMismatch').every((c) => /不判断谁对谁错|不判断/.test(c.relationReason)))

/* 3) 同一具体问题上方向相反 + 两侧逐字依据 → 主张存在分歧 */
const C = mk('C', 'PaperC', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear, Linear' }, conclusion: { value: 'Our experiments show that DLinear achieves lower MAE than Linear on ETTm2 at horizon 96.' } }, [EV('e5', 5, 'Our experiments show that DLinear achieves lower MAE than Linear on ETTm2 at horizon 96.')])
const D = mk('D', 'PaperD', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear, Linear' }, conclusion: { value: 'We find that DLinear yields higher MAE than Linear on ETTm2 at horizon 96.' } }, [EV('e6', 8, 'We find that DLinear yields higher MAE than Linear on ETTm2 at horizon 96.')])
const conflict = buildClashCards({ papers: [C, D] })
check('同问题方向相反且两侧有逐字依据 → 判为「主张存在分歧」', conflict.cards.some((c) => c.relation.code === 'claimConflict'), conflict.cards.map((c) => c.relation.code).join(','))
check('主张分歧卡要求逐字证据标记为 true', conflict.cards.filter((c) => c.relation.code === 'claimConflict').every((c) => c.signals?.verbatimEvidence === true))

/* 4) 条件不齐 → 可比性待确认（且不会硬造冲突） */
const E = mk('E', 'PaperE', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '336' }, method: { value: 'DLinear, Linear' }, conclusion: { value: 'Our experiments show that DLinear achieves lower MAE than Linear on ETTm2 at horizon 336.' } }, [EV('e7', 5, 'Our experiments show that DLinear achieves lower MAE than Linear on ETTm2 at horizon 336.')])
const pending = buildClashCards({ papers: [C, E] })
check('跨度没对齐 → 判为「可比性待确认」，不判分歧', pending.cards.every((c) => c.relation.code !== 'claimConflict') && pending.cards.some((c) => c.relation.code === 'comparabilityPending'), pending.cards.map((c) => c.relation.code).join(','))
const noEvidence = buildClashCards({ papers: [C, mk('F', 'PaperF', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear, Linear' }, conclusion: { value: 'We find that DLinear yields higher MAE than Linear on ETTm2 at horizon 96.' } }, [])] })
check('一侧没有逐字依据时不判分歧', !noEvidence.cards.some((c) => c.relation.code === 'claimConflict'), noEvidence.cards.map((c) => c.relation.code).join(','))

/* 5) 只差方法名/年份 → 不生成冲突卡（允许 0 张） */
const weak = buildClashCards({ papers: [mk('G', 'PaperG', { method: { value: 'Autoformer' }, dataset: { value: 'ETTm2' } }, []), mk('H', 'PaperH', { method: { value: 'PatchTST' }, dataset: { value: 'ETTm2' } }, [])] })
check('只差方法名、没有证据时不生成冲突', weak.cards.filter((c) => c.relation.code === 'claimConflict').length === 0, `${weak.cards.length} 张卡`)
check('条件完全对齐且无差异时允许 0 张卡（不硬造）', (() => {
  const X = mk('X', 'PaperX', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear' }, split: { value: '0.6/0.2/0.2' }, preprocessing: { value: 'StandardScaler' }, conclusion: { value: 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.' } }, [EV('e8', 5, 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.')])
  const Y = mk('Y', 'PaperY', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear' }, split: { value: '0.6/0.2/0.2' }, preprocessing: { value: 'StandardScaler' }, conclusion: { value: 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.' } }, [EV('e9', 6, 'DLinear reaches MAE 0.260 on ETTm2 at horizon 96.')])
  const r = buildClashCards({ papers: [X, Y] })
  return r.cards.length === 0 && r.skipped.length > 0
})())

/* 6) 占位/省略号证据不能当逐字依据 */
check('带省略号的片段被判为"非逐字"', isVerbatimEvidence('DLinear MAE … 0.260 on ETTm2') === false && isVerbatimEvidence('DLinear reaches MAE 0.260 on ETTm2 at horizon 96.') === true)
const elided = buildClashCards({ papers: [mk('I', 'PaperI', { dataset: { value: 'ETTm2' }, metrics: { value: 'MAE' }, horizon: { value: '96' }, method: { value: 'DLinear, Linear' }, conclusion: { value: 'DLinear achieves lower MAE than Linear on ETTm2 at horizon 96.' } }, [EV('e10', 3, 'DLinear achieves lower MAE … than Linear')]), D] })
check('省略号证据不参与"主张分歧"判定', !elided.cards.some((c) => c.relation.code === 'claimConflict'), elided.cards.map((c) => c.relation.code).join(','))

/* 7) 四类标签齐全 */
check('四类关系标签齐全', ['performanceDifference', 'reportValueMismatch', 'claimConflict', 'comparabilityPending'].every((k) => RELATIONS[k]?.label))

/* 8) 实验支持范围 */
check('实验室支持 DLinear/Linear 时给出"可运行验证"', labSupportFor(['DLinear', 'Linear']).supported === true)
check('不支持的方法不给"运行验证"，并说明原因', labSupportFor(['Autoformer', 'PatchTST']).supported === false)
check('只有教学方法时明确说是教学类比', labSupportFor(['季节朴素', '岭回归']).scope === 'teaching-only')

lines.push('')
lines.push(`结果：通过 ${pass} 项，失败 ${fail} 项`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
