import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import { buildClash, type ClashCard } from '@/services/detective'
import { useApp } from '@/store/AppStore'
import type { Paper } from '@/types'

/**
 * 论文对撞台：把论文之间的差异组织成"值得核对的研究问题"。
 * 布局：两侧观点 / 中间关键条件 / 底部行动；关系判断由服务端程序决定，不用模型判定对错。
 */
export function ClashCards({
  papers,
  toast,
}: {
  papers: Paper[]
  toast: (kind: 'info' | 'success' | 'warning' | 'error', title: string, detail?: string) => void
}) {
  const navigate = useNavigate()
  const { state } = useApp()
  const [busy, setBusy] = useState(false)
  const [cards, setCards] = useState<ClashCard[] | null>(null)
  const [support, setSupport] = useState<{ supported: boolean; scope: string; label: string } | null>(null)
  const [note, setNote] = useState<string>('')
  const [skipped, setSkipped] = useState<{ pair: string; reason: string }[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  /** 四类关系的展示色：主张分歧最重，性能差异最轻 */
  const TONE: Record<string, 'orange' | 'blue' | 'slate' | 'plain'> = {
    claimConflict: 'orange',
    reportValueMismatch: 'blue',
    performanceDifference: 'slate',
    comparabilityPending: 'plain',
  }

  const run = async () => {
    if (busy) return
    if (papers.length < 2) {
      toast('warning', '至少选择两篇论文', '在下面勾选 2–3 篇之后再试。')
      return
    }
    setBusy(true)
    try {
      const res = await buildClash(
        papers.map((p) => ({
          id: p.id,
          shortLabel: p.shortLabel,
          title: p.title,
          fields: p.fields,
          evidence: state.evidence
            .filter((e) => e.paperId === p.id)
            .map((e) => ({ page: e.page, text: e.text, id: e.id })),
        })),
      )
      setCards(res.cards ?? [])
      setSupport(res.labSupport ?? null)
      setNote(res.note ?? '')
      setSkipped(res.skipped ?? [])
      if (!res.cards?.length) toast('info', '这几篇论文之间暂时没有可核对的观点差异', '只有在两侧都有真实主张与证据时才会生成卡片。')
      else toast('success', `生成了 ${res.cards.length} 张观点卡`, '关系判断与依据都来自已抽取的证据')
    } catch (e) {
      toast('error', '生成失败', e instanceof Error ? e.message : '后端可能不可用')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card clash">
      <div className="card-head row">
        <Icon name="compare" size={15} />
        <strong>看看它们哪里值得讨论</strong>
        <Tag tone="slate">最多 3 张观点卡</Tag>
        <span className="spacer" />
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run()}>
          {busy ? '正在整理…' : cards ? '重新整理' : '生成观点卡'}
        </button>
      </div>
      <div className="card-body">
        <div className="tiny muted-2">
          只在两侧都有**真实主张与逐字依据**时才生成卡片。判定分四类，不用一个阈值决定：
          <b>不同方法的成绩差 → 性能差异</b>（不叫观点分歧）；<b>同一方法报告值不同 → 需核对实验设置</b>；
          <b>同一问题方向相反且有逐字依据 → 主张存在分歧</b>；<b>条件不齐 → 可比性待确认</b>。
          10% 阈值只用于提示"数值差异值得看"。没有可核对的内容时，这里可以一张卡也不出。
        </div>

        {cards?.length === 0 && (
          <div className="clash-empty tiny">
            没有生成观点卡 —— 这本身是一个结论：{skipped[0] ? skipped[0].reason : '这几篇论文之间暂时没有需要核对的差异或缺口'}。
            如果缺的是复现条件，可以让小咕先去找线索（学习率、批大小、轮数、划分、预处理）。
          </div>
        )}

        {(cards ?? []).map((c) => (
          <div className="clash-card" key={c.id}>
            <div className="clash-question">
              <span className="clash-qmark">?</span>
              {c.question}
              <span className="spacer" />
              <Tag tone={TONE[c.relation.code] ?? 'slate'}>{c.relation.label}</Tag>
              {c.relationLabelNote ? <span className="tiny muted-2">{c.relationLabelNote}</span> : null}
            </div>
            <div className="clash-body">
              {[c.sideA, c.sideB].map((side, idx) => (
                <div className="clash-side" key={`${c.id}-${idx}`}>
                  <div className="clash-side-name">{side.paper}</div>
                  <div className="clash-side-claim">{side.statement}</div>
                  <div className="tiny muted-2">
                    {side.evidence.length > 0
                      ? side.evidence.map((e) => `第 ${e.page} 页${e.verbatim === false ? '（节选，非逐字）' : ''}`).join('、')
                      : '（这一侧没有可引用的原文依据）'}
                  </div>
                  {expanded === c.id && (
                    <div className="clash-evidence">
                      {side.evidence.map((e, i) => (
                        <div className={e.verbatim === false ? 'clash-quote-muted' : 'lab-quote'} key={`${c.id}-${idx}-${i}`}>
                          {e.quote}
                          {e.verbatim === false ? <span className="tiny muted-2">（这一段含省略/占位，只作位置指认，不作为逐字依据）</span> : null}
                        </div>
                      ))}
                      <ul className="tight-list tiny">
                        {Object.entries(side.conditions)
                          .filter(([, v]) => v)
                          .map(([k, v]) => (
                            <li key={k}>
                              {k}: {String(v)}
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
              <div className="clash-key">
                <div className="tiny muted-2">关键条件</div>
                <div className="small">{c.keyCondition}</div>
                <div className="tiny muted-2" style={{ marginTop: 6 }}>
                  {c.relationReason}
                </div>
              </div>
            </div>
            <div className="clash-actions">
              <button className="btn btn-sm" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                {expanded === c.id ? '收起依据' : '展开依据与条件'}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  const target = c.detectivePaper ? papers.find((p) => p.id === c.detectivePaper) : papers[0]
                  const field = c.detectiveField ?? 'learningRate'
                  if (!target) return
                  navigate(`/paper/${target.id}?detect=${field}`)
                }}
              >
                <Icon name="search" size={13} /> 找齐比较条件
              </button>
              <button className="btn btn-sm" onClick={() => navigate('/check')}>
                查看实验差异
              </button>
              <button className="btn btn-sm" onClick={() => navigate('/plan')}>
                设计验证任务
              </button>
              {support?.supported ? (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() =>
                    navigate(`/lab?source=paper&claim=${encodeURIComponent(c.question)}`)
                  }
                  title={support.label}
                >
                  <Icon name="lab" size={13} /> 运行验证
                </button>
              ) : (
                <button className="btn btn-sm" disabled title={support?.label ?? '先在对比页生成观点卡'}>
                  运行验证不可用
                </button>
              )}
              <span className="spacer" />
              <span className="tiny muted-2">
                {support ? support.label : '生成卡片后会说明实验室是否支持这一对方法'}
              </span>
            </div>
            <div className="tiny muted-2" style={{ marginTop: 6 }}>
              下一步：{c.nextStep}
            </div>
          </div>
        ))}
        {cards && cards.length > 0 && note ? <div className="tiny muted-2">{note}</div> : null}
      </div>
    </div>
  )
}
