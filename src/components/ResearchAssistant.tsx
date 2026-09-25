import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/store/AppStore'
import { Icon } from '@/components/Icons'
import { Buddy, type BuddyMood } from '@/components/Buddy'
import { askQuestion } from '@/services/qa'
import { fieldDisplayState, runFairnessCheck, runReproCheck } from '@/services/checks'
import { FIELD_META } from '@/data/fieldSchema'
import { FieldStateTag } from '@/components/InsightBits'

/**
 * 右下角「小咕」：紧凑面板（问当前问题 / 查看本页待办 / 跳到验证计划）。
 * 问答**复用真实问答能力**（services/qa），自动带入当前论文、数据集与选中问题。
 * 未接模型时明确说明，并保留可用的本地功能。
 */
export function ResearchAssistant() {
  const navigate = useNavigate()
  const { state, selectedPapers, toast, dispatch } = useApp()
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<{ paragraphs: string[]; bullets: string[]; notice?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // 小咕的表情：思考中 / 成功点头 / 失败困惑，几秒后回到 idle
  const [mood, setMood] = useState<BuddyMood>('idle')
  const moodTimer = useRef<number | null>(null)
  useEffect(() => () => { if (moodTimer.current) window.clearTimeout(moodTimer.current) }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open])

  const flashMood = (m: BuddyMood, ms: number) => {
    if (moodTimer.current) window.clearTimeout(moodTimer.current)
    setMood(m)
    moodTimer.current = window.setTimeout(() => setMood('idle'), ms)
  }

  const backendReady =
    state.backend.status === 'ok' && Boolean(state.backend.health?.hasCredentials)

  // 本页待办：来自当前选中论文的字段显示状态（真实数据，不是假清单）
  const todos = useMemo(() => {
    const keys = ['dataset', 'split', 'splitRange', 'sampleInterval', 'evalProtocol'] as const
    const out: { paperLabel: string; key: string; label: string }[] = []
    for (const p of selectedPapers) {
      for (const k of keys) {
        if (p.fields[k] === undefined) continue
        const st = fieldDisplayState(p, k)
        if (st.state === 'ok' || st.state === 'recovered') continue
        out.push({ paperLabel: p.shortLabel, key: k, label: FIELD_META[k].label })
      }
    }
    return out.slice(0, 6)
  }, [selectedPapers])

  const contextLine = `${selectedPapers.length} 篇论文${state.datasetScope ? `｜口径：${state.datasetScope}` : ''}${
    state.planDraft ? `｜来自：${state.planDraft.fromProblem}` : ''
  }`

  const run = async () => {
    if (!question.trim() || busy || !selectedPapers.length) return
    setBusy(true)
    setAnswer(null)
    try {
      // 复用真实问答能力：自动带入当前论文、数据集口径与检查结果
      const fairness = runFairnessCheck(selectedPapers, state.datasetScope ?? null)
      const res = await askQuestion({
        papers: selectedPapers,
        question: question.trim(),
        fairness,
        repro: runReproCheck(selectedPapers),
        simulateFailure: state.simulateQaFailure,
        datasetScope: state.datasetScope ?? null,
        pagesByPaper: state.texts,
        backendReady,
      })
      dispatch({ type: 'PUSH_QA', answer: res })
      setAnswer({
        paragraphs: res.paragraphs ?? [],
        bullets: res.bullets ?? [],
        notice: res.notice,
      })
      if (res.status === 'failed') {
        flashMood('confused', 2600)
        toast('warning', '问答没有成功', '已保留原有字段与检查结果，可以重试。')
      } else {
        // 只是"问答请求完成"，不代表论文结论已被验证
        flashMood('happy', 1200)
      }
    } catch (e) {
      flashMood('confused', 2600)
      setAnswer({
        paragraphs: [],
        bullets: [],
        notice: `问答没有成功：${e instanceof Error ? e.message : '未知错误'}。已有的字段与检查结果不受影响。`,
      })
    } finally {
      setBusy(false)
    }
  }

  const moodNow: BuddyMood = busy ? 'thinking' : mood

  return (
    <>
      {open && (
        <div className="buddy-panel" role="dialog" aria-label="小咕">
          <div className="row-tight" style={{ marginBottom: 6 }}>
            <h4 style={{ margin: 0 }}>小咕</h4>
            <div className="spacer" />
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="收起助手">
              <Icon name="close" size={15} />
            </button>
          </div>

          <div className="assistant-ctx">
            <span className="tiny muted-2">将带入：</span>
            <span className="tiny">{contextLine}</span>
          </div>

          {!backendReady && (
            <div className="tiny" style={{ color: 'var(--amber)', marginBottom: 6 }}>
              当前未接入模型：真实论文问答不可用；示例项目仍可体验本地演示回答。
            </div>
          )}

          <textarea
            className="textarea"
            style={{ minHeight: 64, fontSize: 13 }}
            placeholder="问当前问题，例如：ETTm2 上两篇的划分和跨度能直接比吗？"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
            }}
          />
          <div className="row-tight" style={{ marginTop: 6 }}>
            <button className="btn btn-sm btn-primary" onClick={run} disabled={busy || !question.trim() || !selectedPapers.length}>
              {busy ? '正在查…' : '问这个问题'}
            </button>
            <span className="tiny muted-2">⌘/Ctrl + Enter</span>
          </div>

          {answer && (
            <div style={{ marginTop: 10 }}>
              <button className="evidence-btn" onClick={() => { setOpen(false); navigate('/qa') }}>打开完整回答与引用 →</button>
              {answer.paragraphs.map((p, i) => (
                <p key={i} className="small" style={{ margin: '0 0 6px', lineHeight: 1.7 }}>
                  {p}
                </p>
              ))}
              {answer.bullets.length > 0 && (
                <ul className="tight-list">
                  {answer.bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
              {answer.notice && (
                <div className="tiny muted-2" style={{ marginTop: 4 }}>
                  {answer.notice}
                </div>
              )}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 8 }}>
            <div className="tiny muted-2" style={{ marginBottom: 4 }}>
              本页待办（按当前选中的论文）
            </div>
            {todos.length === 0 ? (
              <div className="tiny muted-2">{selectedPapers.length ? '已检查的重点字段暂无待核对项。' : '先到论文库选择要讨论的论文。'}</div>
            ) : (
              <ul className="assistant-todos">
                {todos.map(t => <li key={`${t.paperLabel}-${t.key}`}><button className="evidence-btn" onClick={() => { setOpen(false); navigate(`/compare?focus=${t.key}`) }}>{t.paperLabel} · {t.label} →</button></li>)}
              </ul>
            )}
            <div className="row-tight" style={{ marginTop: 8 }}>
              <button className="btn btn-sm" onClick={() => navigate('/plan')}>
                <Icon name="plan" size={14} /> 打开验证计划
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(answer ? [...answer.paragraphs, ...answer.bullets, answer.notice ?? ''].join('\n') : contextLine)
                    toast('success', '已复制当前内容', '可以直接粘贴到你的笔记里。')
                  } catch { toast('warning', '复制未成功', '可手动选择回答文字复制。') }
                }}
              >
                <Icon name="copy" size={14} /> 复制
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        className="buddy-fab"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-expanded={open}
        aria-label={open ? '收起小咕' : '打开小咕（小咕）'}
        title="小咕：问当前问题 / 查看待办 / 跳到验证计划"
      >
        <Buddy size="sm" px={42} mood={moodNow} tilt={hover && !open} />
        {hover && !open && <span className="buddy-bubble">需要一起核对吗？</span>}
      </button>
    </>
  )
}
