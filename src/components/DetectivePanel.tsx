import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import {
  DETECTIVE_FIELD_LABEL,
  adoptClue,
  cancelDetectiveTask,
  describeDerivedSource,
  derivedFor,
  removeDerived,
  runDetectiveTask,
  type DetectiveClue,
  type DetectiveResult,
} from '@/services/detective'

/**
 * 小咕侦探面板：为"待核对"的字段主动找复现线索。
 * 交互要求：真实阶段反馈（不是假进度）、结果优先展示、逐条可查看来源/采用/保留、
 * 找不到时列出实际查过的来源与下一步；可取消、防重复点击。
 */
export function DetectivePanel({
  paperId,
  pages,
  dataset,
  model,
  horizon,
  fieldValueOf,
  focusField,
  from,
  bordered = true,
  onClose,
  toast,
}: {
  paperId: string
  pages: { page: number; text: string }[]
  dataset?: string | null
  model?: string | null
  horizon?: number | null
  fieldValueOf: (key: string) => string | null
  focusField?: string | null
  /** 从观点卡跳过来时的问题说明 */
  from?: string
  /** 嵌入右侧上下文面板时去掉卡片外壳 */
  bordered?: boolean
  onClose: () => void
  toast: (kind: 'info' | 'success' | 'warning' | 'error', title: string, detail?: string) => void
}) {
  const [field, setField] = useState<string>(focusField || 'learningRate')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DetectiveResult | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [kept, setKept] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<string | null>(null)
  const [adopted, setAdopted] = useState<string[]>(() => derivedFor(paperId).map((e) => e.key))
  const taskRef = useRef<string | null>(null)

  useEffect(() => {
    if (!busy) return undefined
    const t = window.setInterval(() => setElapsed((v) => v + 1), 1000)
    return () => window.clearInterval(t)
  }, [busy])

  useEffect(() => {
    if (focusField) setField(focusField)
  }, [focusField])

  const start = async () => {
    if (busy) return
    setBusy(true)
    setElapsed(0)
    setResult(null)
    const taskId = `det-${paperId}-${field}-${Date.now()}`
    taskRef.current = taskId
    try {
      const res = await runDetectiveTask({
        fieldKey: field,
        dataset: dataset ?? null,
        model: model ?? null,
        horizon: horizon ?? null,
        pages: pages.slice(0, 400).map((p) => ({ page: p.page, text: p.text })),
        fields: Object.fromEntries(
          ['dataset', 'method', 'horizon', 'split', 'preprocessing', 'learningRate', 'batchSize', 'epochs']
            .map((k) => [k, fieldValueOf(k) ? { value: fieldValueOf(k) } : undefined])
            .filter(([, v]) => v) as [string, unknown][],
        ),
        taskId,
      })
      setResult(res)
      if (!res.ok) toast('warning', '这次没找到线索', res.reason || '')
      else if (res.clues.length === 0) toast('info', '没有找到可用线索', '面板里列出了实际查过的来源与下一步')
      else toast('success', res.summary, res.mode === 'model' ? '由模型识别候选、程序回查来源' : '程序直接给出的原始片段，可逐条核对')
    } catch (e) {
      toast('error', '侦探请求失败', e instanceof Error ? e.message : '后端可能不可用')
    } finally {
      setBusy(false)
      taskRef.current = null
    }
  }

  const cancel = async () => {
    if (!taskRef.current) return
    try {
      const r = await cancelDetectiveTask(taskRef.current)
      toast('info', r.note, '已经找到的线索会保留')
    } catch {
      toast('warning', '取消请求没有送达', '可以直接关闭面板，不会影响已经跑过的实验')
    }
  }

  const adopt = (clue: DetectiveClue, asUserChoice = false) => {
    const entry = adoptClue(paperId, clue, { asUserChoice })
    setAdopted((prev) => [...new Set([...prev, clue.field])])
    setConfirming(null)
    toast(
      'success',
      entry.adoptedAs === 'user-choice' ? '已采用（记为「用户选择的新设置」）' : '已采用到派生配置层',
      entry.adoptedAs === 'user-choice'
        ? '归属与当前目标不一致，因此不会当作该论文/该方法的设置；论文抽取值与人工修改也不会被覆盖。'
        : '论文抽取值与人工修改不会被覆盖；可在「派生配置」里移除。',
    )
  }

  const derived = derivedFor(paperId).filter((e) => e.key === field)

  return (
    <div className={bordered ? 'card detective' : 'detective'}>
      <div className={bordered ? 'card-head row' : 'row'}>
        <Icon name="search" size={15} />
        <strong>让小咕找线索</strong>
        {bordered && <Tag tone="slate">论文 → 附录 → 官方仓库脚本</Tag>}
        <span className="spacer" />
        {bordered && (
          <button className="btn btn-sm btn-ghost" onClick={onClose}>
            收起
          </button>
        )}
      </div>
      <div className={bordered ? 'card-body' : ''}>
        {from && (
          <div className="banner banner-info" style={{ marginBottom: 10 }}>
            <Icon name="info" size={14} className="banner-icon" />
            <div>
              正在核对：{from}
              <div className="tiny muted-2">这来自观点卡的「找齐比较条件」，补齐后可以回到对比页重新整理。</div>
            </div>
          </div>
        )}
        <div className="row-tight" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="tiny muted-2">找哪一项：</span>
          <div className="row-tight" style={{ gap: 4, flexWrap: 'wrap' }}>
            {Object.entries(DETECTIVE_FIELD_LABEL).map(([k, label]) => (
              <button key={k} className={`chip${field === k ? ' active' : ''}`} onClick={() => setField(k)} disabled={busy}>
                {label}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void start()}>
            {busy ? `正在查找…（${elapsed}s）` : '开始查找'}
          </button>
          {busy && (
            <button className="btn btn-sm" onClick={() => void cancel()}>
              取消
            </button>
          )}
        </div>
        <div className="tiny muted-2" style={{ marginTop: 6 }}>
          只在**允许的公开来源**里找：论文正文与附录、官方仓库（固定提交）的说明与实验脚本。
          不读密钥文件、不抓取内网地址、不执行下载的脚本；一次最多读 {result?.limits?.maxFiles ?? 6} 个文件、
          {result?.limits?.maxClues ?? 12} 条线索。
        </div>

        {/* 真实阶段反馈 */}
        {busy && (
          <div className="detective-stages">
            <div className="tiny">
              <span className="spinner-dot" /> 正在检索论文正文与附录，再按数据集挑选官方仓库脚本…
            </div>
          </div>
        )}

        {result && (
          <>
            <div className="detective-summary">
              <Tag tone={result.clues.length > 0 ? 'green' : 'slate'}>{result.summary}</Tag>
              <span className="tiny muted-2">
                模式：{result.mode === 'model' ? '模型识别候选 + 程序回查来源' : '程序直接给片段（无模型）'}｜读到{' '}
                {Math.round((result.bytesRead || 0) / 1024)} KB
              </span>
            </div>

            {/* 阶段记录 */}
            <details className="detective-block">
              <summary className="tiny muted-2">查看查找过程（{result.stages.length} 步）</summary>
              <ol className="detective-stagelist">
                {result.stages.map((s, i) => (
                  <li key={`${s.label}-${i}`}>
                    <span className="tiny mono muted-2">{(s.at / 1000).toFixed(1)}s</span> {s.label}
                    {s.detail ? <span className="tiny muted-2"> — {s.detail}</span> : null}
                  </li>
                ))}
              </ol>
            </details>

            {/* 线索 */}
            {result.clues.map((c) => (
              <div className={`detective-clue${kept[c.id] ? ' kept' : ''}`} key={c.id}>
                <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <Tag tone={c.sourceType === 'official-code' ? 'blue' : 'slate'}>
                    {c.sourceType === 'official-code' ? '官方代码' : '论文原文'}
                  </Tag>
                  {c.confidence === 'cross-dataset' && <Tag tone="orange">其它数据集</Tag>}
                  {c.appliesTo.horizon ? <Tag tone="plain">仅跨度 {c.appliesTo.horizon}</Tag> : null}
                  {c.inconsistent === true && <Tag tone="orange">与已有值不一致</Tag>}
                  {c.inconsistent === false && <Tag tone="plain">与已有值一致</Tag>}
                  <span className="tiny muted-2">
                    {DETECTIVE_FIELD_LABEL[c.field] ?? c.field}｜适用：{c.appliesTo.method || '方法未指定'}·
                    {c.appliesTo.dataset || '数据集未确认'}·跨度 {c.appliesTo.horizon ?? '未限定'}
                  </span>
                  <span className="spacer" />
                  <button className="btn btn-sm btn-ghost" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                    {expanded === c.id ? '收起' : '查看原文'}
                  </button>
                  {c.methodMatch && c.methodMatch.ok === false && confirming !== c.id ? (
                    <button className="btn btn-sm" onClick={() => setConfirming(c.id)}>
                      用于当前复现配置
                    </button>
                  ) : (
                    <button className="btn btn-sm" onClick={() => void adopt(c, confirming === c.id)}>
                      {confirming === c.id ? '确认记为「用户选择的新设置」' : '用于当前复现配置'}
                    </button>
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => setKept((k) => ({ ...k, [c.id]: !k[c.id] }))}>
                    {kept[c.id] ? '取消待核对' : '继续保留待核对'}
                  </button>
                </div>
                <div className="detective-value">{c.value}</div>
                {c.binding && (
                  <div className="detective-binding">
                    <span className="mono tiny">
                      {c.binding.repo}@{c.binding.sha.slice(0, 8)}
                    </span>
                    <span className="tiny">
                      ｜脚本 <b>{c.binding.script}:{c.binding.line}</b>
                    </span>
                    <span className="tiny">
                      ｜方法 <b>{c.binding.method ?? '未声明'}</b>
                      {c.binding.methodDeclaredAt ? `（第 ${c.binding.methodDeclaredAt.line} 行声明）` : ''}
                    </span>
                    <span className="tiny">｜数据集 {c.binding.dataset ?? '未读到'}</span>
                    <span className="tiny">｜任务 {c.binding.task}</span>
                    <span className="tiny">｜跨度 {c.binding.horizon ?? '未限定 / 多跨度'}</span>
                    <span className="tiny muted-2">｜{c.binding.statusLabel}</span>
                  </div>
                )}
                {c.methodMatch && c.methodMatch.ok === false && (
                  <div className="detective-mismatch tiny">
                    <b>归属提醒：</b>
                    {c.methodMatch.note}
                  </div>
                )}
                {c.override && (
                  <div className="detective-override tiny">
                    <b>默认值已被实验脚本覆盖：</b>
                    {c.override.script}:{c.override.line} 使用 <b>{c.override.value}</b>（方法 {c.override.method ?? '—'}，跨度{' '}
                    {c.override.horizon ?? '—'}）
                  </div>
                )}
                <div className="tiny muted-2">{c.scope}</div>
                {expanded === c.id && (
                  <div className="detective-source">
                    {c.evidence.kind === 'code' ? (
                      <>
                        <div className="tiny mono">
                          {c.evidence.path}:{c.evidence.line}（提交 {String(c.evidence.sha).slice(0, 8)}）
                        </div>
                        <pre className="detective-code">{c.evidence.snippet}</pre>
                        {c.evidence.url ? (
                          <a className="tiny" href={c.evidence.url} target="_blank" rel="noreferrer">
                            在官方仓库查看这一行 ↗
                          </a>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <div className="tiny mono">
                          论文第 {c.evidence.page} 页{c.evidence.section ? `｜${c.evidence.section}` : ''}
                        </div>
                        <div className="lab-quote">{c.evidence.quote}</div>
                      </>
                    )}
                    {c.note ? <div className="tiny muted-2" style={{ marginTop: 4 }}>{c.note}</div> : null}
                  </div>
                )}
              </div>
            ))}

            {/* 被剔除的候选 */}
            {result.rejected.length > 0 && (
              <details className="detective-block">
                <summary className="tiny muted-2">被程序剔除的候选（{result.rejected.length} 条）</summary>
                <ul className="tight-list tiny">
                  {result.rejected.map((r, i) => (
                    <li key={`${r.value}-${i}`}>
                      {r.value} — {r.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {/* 查过的来源 */}
            <div className="detective-sources">
              <div className="tiny muted-2">实际查过的来源（{result.sourcesChecked.length} 个）</div>
              <ul className="tight-list tiny">
                {result.sourcesChecked.map((s, i) => (
                  <li key={`${s.label}-${i}`}>
                    {s.kind === 'paper' ? '论文' : '官方仓库'}｜{s.label}
                    {s.path ? `（${s.path}）` : ''}
                    {s.detail ? ` · ${s.detail}` : ''}
                    {s.failed ? ' · 未读到' : ''}
                  </li>
                ))}
              </ul>
            </div>

            <div className="detective-next tiny">
              <b>下一步：</b>
              {result.nextStep}
            </div>

            <div className="tiny muted-2" style={{ marginTop: 6 }}>
              {result.note}
            </div>
          </>
        )}

        {/* 已采用的派生配置 */}
        {adopted.includes(field) && (
          <div className="detective-derived">
            <div className="tiny muted-2">派生配置（当前字段：{DETECTIVE_FIELD_LABEL[field] ?? field}）</div>
            {derived.map((e) => (
              <div className="row-tight" key={`${e.key}-${e.adoptedAt}`} style={{ gap: 8, flexWrap: 'wrap' }}>
                <b className="small">{e.value}</b>
                <span className="tiny muted-2">{describeDerivedSource(e)}</span>
                <span className="spacer" />
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    removeDerived(paperId, e.key)
                    setAdopted((prev) => prev.filter((k) => k !== e.key))
                  }}
                >
                  移除
                </button>
              </div>
            ))}
            <div className="tiny muted-2">
              原始抽取结果与人工修改保留不变；派生配置只用于"当前复现配置"，并始终带来源。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
