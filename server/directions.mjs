import { callModelText, parseJsonLoose } from './llm.mjs'

const SYSTEM = `你是科研实验设计助手。输入是一组已经由程序完成来源核验的候选研究方向。
你的任务不是复述固定模板，而是根据每条方向自己的论文方法、作者局限/未来工作、已知实验设置和真实案例，提出互相有实质区别的可检验方案。

严格规则：
1. 不得新增论文事实、引用、页码、实验结果或“作者提出”的内容；来源和证据由程序保留，你只能设计工具建议。
2. 每条方案必须明确：问题、假设、对照、唯一主要变量、固定条件、数据要求、指标、支持/削弱/无法判断的判据、前置条件、资源和边界。
3. 数据或实现不具备时仍可给清楚的实验方案，但必须列为前置条件，不能声称当前可执行。
4. 节假日/日历协变量必须检查地域、适用日历、事件覆盖、预测时可获得性和方法输入接口；有日期列不等于已适配。
5. 变化点必须说明识别/构造规则，并禁止根据测试结果反选有利区间。
6. 更换预测跨度通常需要对应跨度重新训练，不能直接复用 pred_len=96 权重。
7. 已有案例延伸必须区分“已经观察到”和“尚未验证”，不能预设现象会复现。
8. 中文输出，简洁具体。只输出 JSON，不要 markdown。

JSON：{"directions":[{"id":"保持输入 id","question":"...","hypothesis":"...","minimalExperiment":{"baseline":"...","variable":"...","fixed":"...","dataset":"...","metrics":["..."]},"judgment":"支持/削弱/无法判断的判据","prerequisites":["..."],"unsupportedSteps":["..."],"resources":"...","boundary":"...","recommendReason":"...","generationNote":"说明为什么此方案与该来源对应"}]}

任何无法确定的内容写成具体待核对条件，不要编数字。`

function short(value, max = 1200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function strings(value, maxItems = 12, maxLen = 500) {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxItems).map((x) => short(x, maxLen)).filter(Boolean)
}

function sanitizeExperiment(raw, fallback) {
  const x = raw && typeof raw === 'object' ? raw : {}
  const metrics = strings(x.metrics, 8, 80)
  return {
    baseline: short(x.baseline, 600) || fallback.baseline,
    variable: short(x.variable, 1000) || fallback.variable,
    fixed: short(x.fixed, 1000) || fallback.fixed,
    dataset: short(x.dataset, 1000) || fallback.dataset,
    metrics: metrics.length ? metrics : fallback.metrics,
  }
}

/**
 * 模型只完善“工具建议”部分。id、来源类型、论文关联、证据与真实案例版本
 * 都由调用方保存，模型不能改写这些字段。
 */
export async function synthesizeDirections({ domain, papers, directions }) {
  const candidates = Array.isArray(directions) ? directions.slice(0, 6) : []
  if (!candidates.length) return { directions: [], generatedAt: new Date().toISOString() }

  const payload = {
    domain: short(domain, 200),
    papers: (Array.isArray(papers) ? papers : []).slice(0, 20).map((p) => ({
      id: short(p?.id, 100),
      label: short(p?.label, 120),
      method: short(p?.method, 240),
      researchProblem: short(p?.researchProblem, 800),
      authorClaim: short(p?.authorClaim, 800),
      limitations: strings(p?.limitations, 5, 700),
      futureWork: strings(p?.futureWork, 5, 700),
    })),
    directions: candidates.map((d) => ({
      id: short(d?.id, 120),
      sourceType: short(d?.sourceType, 80),
      question: short(d?.question, 1000),
      reasoning: short(d?.reasoning, 1600),
      hypothesis: short(d?.hypothesis, 1000),
      sourceClaims: (Array.isArray(d?.sourceClaims) ? d.sourceClaims : []).slice(0, 8).map((c) => ({
        kind: short(c?.kind, 80),
        paperId: short(c?.paperId, 100),
        page: Number.isFinite(Number(c?.page)) ? Number(c.page) : null,
        quote: short(c?.quote, 1000),
        verified: Boolean(c?.verified),
      })),
      existingExperiment: d?.minimalExperiment,
      caseSource: d?.caseSource ?? null,
    })),
  }

  const raw = await callModelText({
    system: SYSTEM,
    user: `请为以下候选方向分别设计具体方案。不同来源必须体现不同实验逻辑。\n${JSON.stringify(payload)}`,
    maxTokens: 8000,
  })
  const parsed = parseJsonLoose(raw)
  const rows = Array.isArray(parsed?.directions) ? parsed.directions : []
  const byId = new Map(rows.map((r) => [String(r?.id ?? ''), r]))

  const output = []
  for (const base of candidates) {
    const r = byId.get(base.id)
    if (!r || typeof r !== 'object') continue
    output.push({
      id: base.id,
      question: short(r.question, 1200) || base.question,
      hypothesis: short(r.hypothesis, 1200) || base.hypothesis,
      minimalExperiment: sanitizeExperiment(r.minimalExperiment, base.minimalExperiment),
      judgment: short(r.judgment, 1400) || base.judgment,
      prerequisites: strings(r.prerequisites, 12, 700),
      unsupportedSteps: strings(r.unsupportedSteps, 12, 700),
      resources: short(r.resources, 1200) || base.resources,
      boundary: short(r.boundary, 1200) || base.boundary,
      recommendReason: short(r.recommendReason, 1000) || base.recommendReason,
      generationNote: short(r.generationNote, 800),
    })
  }
  return { directions: output, generatedAt: new Date().toISOString() }
}
