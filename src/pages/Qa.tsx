import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/store/AppStore'
import { askQuestion, citationToEvidence, PRESET_QUESTIONS } from '@/services/qa'
import { runFairnessCheck, runReproCheck } from '@/services/checks'
import type { QaAnswer } from '@/types'
import { EmptyState } from '@/components/EmptyState'
import { Buddy } from '@/components/Buddy'
import { DemoBanner } from '@/components/DemoBadge'
import { QaStatusTag, SupportTag, Tag } from '@/components/StatusTag'

/**
 * 一条结论的「来源 + 依据」说明。
 * 三类结论的展示方式刻意不同：
 *  - 系统事实：标明由程序状态证明，不要求论文引用；
 *  - 规则推导：展开输入字段 / 使用的规则 / 推导结果；
 *  - 论文事实：标明支持程度（部分支持 / 未复核）。
 */
function ClaimNote({ claim }: { claim: NonNullable<QaAnswer['claims']>[number] }) {
  const d = claim.derivation
  return (
    <span style={{ display: 'block', marginTop: 4 }}>
      <SupportTag support={claim.support} />
      <span className="tiny muted-2" style={{ marginLeft: 6 }}>
        {claim.reason}
      </span>
      {d && (
        <span
          className="tiny"
          style={{
            display: 'block',
            marginTop: 4,
            paddingLeft: 8,
            borderLeft: '2px solid var(--border-strong, #d4d4d8)',
          }}
        >
          <span className="muted-2">
            推导依据（规则 {d.ruleId}「{d.ruleName}」{d.scope ? `｜口径：${d.scope}` : ''}）
          </span>
          <span style={{ display: 'block' }}>
            输入字段：
            {d.inputs.length > 0
              ? d.inputs.map((x) => `${x.paperLabel} ${x.label}=${x.value}`).join('；')
              : '（本次没有附上逐篇输入字段，可到实验检查页核对）'}
          </span>
          <span style={{ display: 'block' }}>规则：{d.rule || '——'}</span>
          <span style={{ display: 'block' }}>结果：{d.result || '——'}</span>
          {d.inputs.some((x) => (x.evidenceIds || []).length > 0) && (
            <span className="muted-2" style={{ display: 'block' }}>
              输入证据：{d.inputs.reduce((n, x) => n + (x.evidenceIds || []).length, 0)} 条
              （可在论文详情页按字段查看页码与英文原句）
            </span>
          )}
        </span>
      )}
    </span>
  )
}

export function QaPage() {
  const navigate = useNavigate()
  const { state, dispatch, selectedPapers, scopedPapers, openEvidenceItems, toast } = useApp()

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [scopeId, setScopeId] = useState<'all' | string>('all')

  const targetPapers = useMemo(() => {
    if (scopeId === 'all') return selectedPapers
    return selectedPapers.filter((p) => p.id === scopeId)
  }, [scopeId, selectedPapers])

  const fairness = useMemo(
    () => runFairnessCheck(targetPapers, state.datasetScope ?? null),
    [targetPapers, state.datasetScope],
  )
  const repro = useMemo(() => runReproCheck(targetPapers), [targetPapers])

  const allDemo = targetPapers.length > 0 && targetPapers.every((p) => p.source === 'demo')
  const backendOk = state.backend.status === 'ok' && Boolean(state.backend.health?.hasCredentials)
  const withTextCount = targetPapers.filter((p) => (state.texts[p.id]?.length ?? 0) > 0).length

  const runAsk = async (question: string) => {
    const q = question.trim()
    if (!q || loading) return
    dispatch({ type: 'SET_ACTIVE_QUESTION', question: q })
    setLoading(q)
    try {
      const answer = await askQuestion({
        question: q,
        papers: targetPapers,
        fairness,
        repro,
        datasetScope: state.datasetScope ?? null,
        simulateFailure: state.simulateQaFailure,
        pagesByPaper: state.texts,
        backendReady: backendOk,
        backendError: state.backend.error,
      })
      dispatch({ type: 'PUSH_QA', answer })
      if (answer.status === 'failed') toast('error', '问答请求失败', '可以点回答右上角的「重新回答」再试一次。')
      else if (answer.status === 'answered' && answer.mode === 'llm') {
        dispatch({ type: 'SET_CAPS', patch: { realLlmQa: true } })
      }
    } catch {
      const failed: QaAnswer = {
        id: `qa-${Date.now()}`,
        question: q,
        status: 'failed',
        mode: 'llm',
        paragraphs: ['请求过程中出现异常，没有拿到结果。可以点击「重新回答」重试。'],
        bullets: [],
        citations: [],
        notice: '请求失败：可以重试。',
        paperIds: targetPapers.map((p) => p.id),
        createdAt: new Date().toISOString(),
      }
      dispatch({ type: 'PUSH_QA', answer: failed })
      toast('error', '问答请求异常', '已保留问题，可以重试。')
    } finally {
      setLoading(null)
      setInput('')
    }
  }

  return (
    <div className="page qa-page">
      <div className="qa-hero">
        <Buddy size="md" px={54} title="小咕" />
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">ASK WITH EVIDENCE</div><h1 className="qa-hero-title">和小咕，一起读论文</h1>
          <div className="qa-hero-sub">
            围绕 {selectedPapers.length || 0} 篇论文提问。论文事实附原文引用，规则推导与建议单独标注。
          </div>
        </div>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => navigate('/check')} disabled={!selectedPapers.length}>
          查看实验检查
        </button>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="small muted">回答只基于已读取的正文与字段；没把握的地方会明确说「本次未找到」。</div>
        <div className="spacer" />
        <button
          className="btn btn-sm"
          onClick={() => {
            dispatch({ type: 'CLEAR_QA' })
            toast('info', '已清空问答历史', '')
          }}
          disabled={state.qaHistory.length === 0}
        >
          清空对话
        </button>
      </div>

      {allDemo && (
        <div style={{ marginBottom: 14 }}>
          <DemoBanner>
            ：当前是示例项目，问答由本地规则根据演示字段生成，不是模型回答，也不是真实论文内容。
          </DemoBanner>
        </div>
      )}

      {!allDemo && (
        <div
          className={`banner ${backendOk ? 'banner-info' : 'banner-warn'}`}
          style={{ marginBottom: 14 }}
        >
          <span className="banner-icon">{backendOk ? '🤖' : '🔌'}</span>
          <div>
            {backendOk ? (
              <>
                <strong>已连接模型，将对真实论文正文提问。</strong>
                回答由模型阅读所选论文的真实正文片段生成，引用会逐条回查原文页码。
                {withTextCount < targetPapers.length && (
                  <>
                    <br />
                    注意：所选论文中有 {targetPapers.length - withTextCount} 篇还没有可用正文，本次回答不会使用它们。
                  </>
                )}
              </>
            ) : (
              <>
                <strong>没有连接到后端，真实论文的问答暂时不可用。</strong>
                真实问答必须由后端调用模型（密钥不能放在前端）。启动后端：
                <code>node server/index.mjs</code>；若前端部署在静态托管上，请在左下角「运行设置」里填写后端地址。
              </>
            )}
          </div>
        </div>
      )}

      {selectedPapers.length === 0 ? (
        <EmptyState
          icon="💬"
          title="先选择要提问的论文"
          description="可以围绕 1 篇论文提问，也可以同时选中 2～3 篇一起问（例如「这几篇的方法主要有什么区别」）。上传真实 PDF 后可以直接自由提问。"
          actions={
            <>
              <button className="btn btn-primary" onClick={() => navigate('/library')}>
                去论文库选择
              </button>
              <button
                className="btn"
                onClick={() =>
                  dispatch({
                    type: 'SET_SELECT',
                    ids: scopedPapers.filter((p) => p.status === 'parsed').slice(0, 3).map((p) => p.id),
                  })
                }
                disabled={scopedPapers.filter((p) => p.status === 'parsed').length === 0}
              >
                选择已就绪的论文
              </button>
            </>
          }
        />
      ) : (
        <div className="qa-layout">
          {/* ---------------- 主区 ---------------- */}
          <div>
            <div className="card">
              <div className="card-body">
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="field-label" style={{ margin: 0 }}>
                    提问范围
                  </span>
                  <select
                    className="select"
                    style={{ width: 'auto', minWidth: 220 }}
                    value={scopeId}
                    onChange={(e) => setScopeId(e.target.value)}
                  >
                    <option value="all">
                      当前选中的 {selectedPapers.length} 篇论文（
                      {selectedPapers.map((p) => p.shortLabel).join('、')}）
                    </option>
                    {selectedPapers.map((p) => (
                      <option value={p.id} key={p.id}>
                        只看 {p.shortLabel} · {p.title.slice(0, 40)}
                      </option>
                    ))}
                  </select>
                  <div className="spacer" />
                  <button className="btn btn-sm btn-ghost" onClick={() => navigate('/library')}>
                    调整论文
                  </button>
                </div>

                <div className="qa-composer" style={{ marginTop: 0 }}>
                  <textarea
                    className="textarea"
                    value={input}
                    placeholder={
                      allDemo
                        ? '演示项目：可以用上面的预设问题，或输入相关问题试试'
                        : '自由提问，例如：这篇论文的学习率、批大小和训练轮数分别是多少？'
                    }
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runAsk(input)
                    }}
                  />
                  <div className="qa-composer-actions">
                    <span className="tiny muted-2">⌘/Ctrl + Enter 发送</span>
                    <div className="spacer" />
                    <button
                      className="btn btn-primary"
                      onClick={() => void runAsk(input)}
                      disabled={!input.trim() || loading !== null}
                    >
                      {loading ? (
                        <>
                          <span className="spinner light" /> 思考中…
                        </>
                      ) : (
                        '提问'
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="qa-thread" style={{ marginTop: 16 }}>
              {loading && (
                <div className="qa-block">
                  <div className="qa-question">
                    <div className="qa-avatar">我</div>
                    <div className="strong">{loading}</div>
                  </div>
                  <div className="qa-answer">
                    <div className="row" style={{ marginBottom: 10 }}>
                      <span className="spinner" />
                      <span className="small muted">
                        {allDemo ? '正在根据演示字段组织回答…' : '模型正在阅读论文正文并核对引用…'}
                      </span>
                    </div>
                    <div className="stack-sm">
                      <div className="skeleton" style={{ height: 12, width: '92%' }} />
                      <div className="skeleton" style={{ height: 12, width: '78%' }} />
                      <div className="skeleton" style={{ height: 12, width: '85%' }} />
                    </div>
                  </div>
                </div>
              )}

              {state.qaHistory.map((ans) => (
                <div className="qa-block" key={ans.id}>
                  <div className="qa-question">
                    <div className="qa-avatar">我</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="strong">{ans.question}</div>
                      <div className="tiny muted-2" style={{ marginTop: 3 }}>
                        {new Date(ans.createdAt).toLocaleTimeString('zh-CN')} · 范围：
                        {ans.paperIds
                          .map((id) => state.papers.find((p) => p.id === id)?.shortLabel ?? '?')
                          .join('、')}
                      </div>
                    </div>
                    <QaStatusTag status={ans.status} />
                  </div>

                  <div className="qa-answer">
                    {ans.notice && (
                      <div
                        className={`banner ${
                          ans.status === 'answered'
                            ? 'banner-info'
                            : ans.status === 'failed'
                              ? 'banner-error'
                              : 'banner-warn'
                        }`}
                        style={{ marginBottom: 12 }}
                      >
                        <span className="banner-icon">
                          {ans.status === 'answered' ? 'ℹ️' : ans.status === 'failed' ? '❌' : '🚧'}
                        </span>
                        <div>{ans.notice}</div>
                      </div>
                    )}

                    {ans.paragraphs.map((p, i) => {
                      const claim = ans.claims?.find(
                        (c) => c.kind === 'paragraph' && c.text === p,
                      )
                      return (
                        <p key={i}>
                          {p}
                          {claim && claim.support !== 'full' && <ClaimNote claim={claim} />}
                        </p>
                      )
                    })}

                    {ans.bullets.length > 0 && (
                      <ul>
                        {ans.bullets.map((b, i) => {
                          const claim = ans.claims?.find((c) => c.kind === 'bullet' && c.text === b)
                          return (
                            <li key={i}>
                              {b}
                              {claim && claim.support !== 'full' && <ClaimNote claim={claim} />}
                            </li>
                          )
                        })}
                      </ul>
                    )}

                    {ans.withdrawn && ans.withdrawn.length > 0 && (
                      <div className="banner banner-warn" style={{ marginTop: 10 }}>
                        <span className="banner-icon">↩️</span>
                        <div>
                          <strong>
                            已撤回 {ans.withdrawn.length} 条结论（原文里找不到能支持它的依据）
                          </strong>
                          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                            {ans.withdrawn.map((w, i) => (
                              <li key={i}>
                                <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>
                                  {w.text}
                                </span>
                                <span className="tiny muted-2" style={{ display: 'block' }}>
                                  撤回原因：{w.reason}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <div style={{ marginTop: 6 }}>
                            这些结论已从上面的回答里移除，避免把没有原文依据的说法当成结论；
                            如果你知道依据在哪，可以点「重新回答」并补充说明。
                          </div>
                        </div>
                      </div>
                    )}

                    {ans.citations.length > 0 && (
                      <div className="qa-citations">
                        <div className="qa-citations-title">
                          引用出处（{ans.citations.length}）· 点击查看原文片段
                        </div>
                        <div className="citation-list">
                          {ans.citations.map((c) => (
                            <button
                              className="citation"
                              key={c.evidenceId}
                              onClick={() =>
                                openEvidenceItems(
                                  c.paperTitle,
                                  `回答引用 · ${c.section}`,
                                  [citationToEvidence(c)],
                                )
                              }
                            >
                              <span className="page-badge">p.{c.page}</span>
                              <span style={{ minWidth: 0, flex: 1 }}>
                                <span className="citation-text">{c.text}</span>
                                <span className="tiny muted-2" style={{ display: 'block', marginTop: 3 }}>
                                  {c.section}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="row-tight" style={{ marginTop: 12 }}>
                      <button
                        className="btn btn-sm"
                        onClick={() => void runAsk(ans.question)}
                        disabled={loading !== null}
                      >
                        ↻ 重新回答
                      </button>
                      {ans.status === 'unsupported' && (
                        <span className="tiny muted-2">
                          试试侧边的预设问题，或先把论文解析完成
                        </span>
                      )}
                      <span className="tiny muted-2">
                        {ans.mode === 'llm' ? '生成方式：模型阅读论文正文' : '生成方式：本地规则（演示数据）'}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              {state.qaHistory.length === 0 && !loading && (
                <EmptyState
                  icon="💬"
                  title={allDemo ? '从右边挑一个问题开始' : '直接提问，模型会读论文原文回答'}
                  description={
                    allDemo
                      ? '演示问题由本地规则根据演示字段回答，并带上演示片段作为出处。'
                      : '回答只依据所选论文的正文，引用会逐条回查原文页码，可以直接和 PDF 对照。资料不足时会明确说明。'
                  }
                />
              )}
            </div>
          </div>

          {/* ---------------- 侧区 ---------------- */}
          <aside className="qa-side">
            <div className="card">
              <div className="card-head">
                <h3>可以问的问题</h3>
              </div>
              <div className="card-body">
                <div className="qa-preset">
                  {PRESET_QUESTIONS.map((q) => (
                    <button key={q.id} onClick={() => void runAsk(q.text)} disabled={loading !== null}>
                      <span className="q-icon">▸</span>
                      <span style={{ minWidth: 0 }}>
                        {q.text}
                        <span className="q-hint">{q.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="tiny muted-2" style={{ marginTop: 10, lineHeight: 1.6 }}>
                  {allDemo
                    ? '以上问题会结合演示字段与检查结果回答。'
                    : '以上问题会发送给模型，并结合所选论文的真实正文回答。也可以在下方的输入框自由提问。'}
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-head">
                <h3>回答的可信度</h3>
              </div>
              <div className="card-body stack-sm">
                <div className="row">
                  <Tag tone={state.caps.realLlmQa ? 'green' : allDemo ? 'violet' : 'orange'}>
                    {state.caps.realLlmQa ? '模型已接通' : allDemo ? '演示数据' : '模型未接通'}
                  </Tag>
                  <span className="tiny muted-2">
                    {state.caps.realLlmQa
                      ? '回答来自模型 + 论文原文'
                      : allDemo
                        ? '由本地规则生成'
                        : '需要后端才能回答真实论文'}
                  </span>
                </div>
                <div className="small muted">
                  真实论文的每条引用都由服务端<strong>逐字回查原文</strong>：在对应页找不到的引用会被剔除，
                  所以页码与句子可以直接和 PDF 对照。资料不足时会明确说明，不会编造。
                </div>
                {state.simulateQaFailure && (
                  <div className="banner banner-warn">
                    <span className="banner-icon">🧪</span>
                    <div>当前打开了「模拟问答失败」，提问会返回失败状态，用于演示失败与重试。</div>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
