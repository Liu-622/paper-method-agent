import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '@/components/Icons'
import { Buddy } from '@/components/Buddy'
import { MAX_SELECTION, useApp, useFieldEditor } from '@/store/AppStore'
import type { CheckPerPaper, FairnessItem, FieldKey, Paper, ReproItem } from '@/types'
import { FIELD_META } from '@/data/fieldSchema'
import { runFairnessCheck, runReproCheck, summarizeFairness, summarizeRepro } from '@/services/checks'
import { commonDatasets } from '@/services/scope'
import { EmptyState } from '@/components/EmptyState'
import { DemoBanner } from '@/components/DemoBadge'
import {
  FAIRNESS_TEXT,
  FairnessTag,
  PaperStatusTag,
  REPRO_TEXT,
  ReproTag,
  Tag,
} from '@/components/StatusTag'
import { CHECK_RULE_VERSION } from '@/config'

type Tab = 'fairness' | 'repro'

/* ------------------------------------------------------------------ */
/* 单篇论文在该项上的取值 + 修改入口                                     */
/* ------------------------------------------------------------------ */

function PerPaperBlock({
  item,
  paper,
  fieldKey,
  onChanged,
}: {
  item: CheckPerPaper
  paper?: Paper
  fieldKey?: FieldKey
  onChanged: () => void
}) {
  const { openEvidence } = useApp()
  const save = useFieldEditor()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.value ?? '')

  const label = paper?.shortLabel ?? item.paperId
  const key = fieldKey

  return (
    <div className="per-paper">
      <div className="per-paper-head">
        <span className="per-paper-label">{label}</span>
        {item.origin === 'user' && <Tag tone="blue">人工补充</Tag>}
        {item.unparsed && <Tag tone="slate">待抽取</Tag>}
        <div className="spacer" />
        <button
          className={`evidence-btn${item.evidenceIds.length ? '' : ' neutral'}`}
          onClick={() =>
            openEvidence(
              paper ? `${paper.shortLabel} · ${paper.title}` : item.paperTitle,
              key ? `${FIELD_META[key].label}${item.extra ? ` · ${item.extra}` : ''}` : item.paperTitle,
              item.evidenceIds,
            )
          }
        >
          🔍 依据
        </button>
      </div>

      {editing && key && paper ? (
        <div className="stack-sm">
          <textarea
            className="textarea"
            style={{ minHeight: 66, fontSize: 12.8 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="按原文填写取值（留空表示未提供）"
          />
          <div className="row-tight">
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                save(paper, key, draft)
                setEditing(false)
                onChanged()
              }}
            >
              保存并重新检查
            </button>
            <button className="btn btn-sm" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
          <div className="tiny muted-2">
            填写的内容会标为「人工补充」，不会被当作论文原文依据。
          </div>
        </div>
      ) : (
        <>
          <div className={`per-paper-value${item.value ? '' : ' none'}`}>
            {item.value ?? (item.unparsed ? '论文还没有完成字段抽取，无法读取' : '未在论文中读到')}
          </div>
          {item.extra && <div className="per-paper-extra">↳ {item.extra}</div>}
          {item.origin === 'user' && item.extractedValue !== undefined && (
            <div className="per-paper-extra">
              ↳ 论文原文：{item.extractedValue ? `「${item.extractedValue}」` : '未找到（该项为人工补充）'}
            </div>
          )}
          {key && paper && (
            <button
              className="expand-toggle"
              onClick={() => {
                setDraft(item.value ?? '')
                setEditing(true)
              }}
            >
              ✎ {item.origin === 'user' ? '修改补充' : '补充 / 修正这一项'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 公平性检查项                                                        */
/* ------------------------------------------------------------------ */

function FairnessBlock({
  item,
  papers,
  onChanged,
}: {
  item: FairnessItem
  papers: Paper[]
  onChanged: () => void
}) {
  const [openEvidenceAll, setOpenEvidenceAll] = useState(false)
  const { openEvidence } = useApp()
  const allEvidence = item.perPaper.flatMap((p) => p.evidenceIds)

  return (
    <div className={`check-item verdict-${item.verdict}`}>
      <div className="check-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="check-title">
            <span className="check-label">{item.label}</span>
            <FairnessTag verdict={item.verdict} />
            {item.keys.length > 1 && (
              <Tag tone="plain">
                综合核对：{item.keys.map((k) => FIELD_META[k].label).join(' + ')}
              </Tag>
            )}
            {item.hasManualInput && <Tag tone="blue">含人工补充</Tag>}
          </div>
          <div className="check-reason">{item.reason}</div>
        </div>
        <div className="row-tight" style={{ flex: 'none' }}>
          <button
            className={`evidence-btn${allEvidence.length ? '' : ' neutral'}`}
            onClick={() => openEvidence(`公平性检查 · ${item.label}`, '全部论文的对应原文片段', allEvidence)}
          >
            🔍 查看双方证据{allEvidence.length ? ` (${allEvidence.length})` : ''}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setOpenEvidenceAll((v) => !v)}>
            {openEvidenceAll ? '收起对比 ▴' : '展开逐篇 ▾'}
          </button>
        </div>
      </div>

      {openEvidenceAll && (
        <div className="check-body">
          <div className="per-paper-grid">
            {item.perPaper.map((p) => (
              <PerPaperBlock
                key={p.paperId}
                item={p}
                paper={papers.find((x) => x.id === p.paperId)}
                onChanged={onChanged}
              />
            ))}
          </div>
        </div>
      )}

      <div className="check-body">
        <div className="check-why">
          <b>为什么这项会影响可比性：</b>
          {item.whyItMatters}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 复现缺项检查项                                                      */
/* ------------------------------------------------------------------ */

function ReproBlock({
  item,
  papers,
  onChanged,
}: {
  item: ReproItem
  papers: Paper[]
  onChanged: () => void
}) {
  const { openEvidence } = useApp()
  const allEvidence = item.perPaper.flatMap((p) => p.evidenceIds)

  return (
    <div className={`check-item verdict-${item.verdict}`}>
      <div className="check-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="check-title">
            <span className="check-label">{item.label}</span>
            <ReproTag verdict={item.verdict} />
            <Tag tone="plain">{FIELD_META[item.key].label}</Tag>
          </div>
          <div className="check-reason">{item.reason}</div>
        </div>
        <div className="row-tight" style={{ flex: 'none' }}>
          <button
            className={`evidence-btn${allEvidence.length ? '' : ' neutral'}`}
            onClick={() => openEvidence(`复现缺项 · ${item.label}`, '全部论文的对应原文片段', allEvidence)}
          >
            🔍 查看依据{allEvidence.length ? ` (${allEvidence.length})` : ''}
          </button>
        </div>
      </div>

      <div className="check-body">
        <div className="per-paper-grid">
          {item.perPaper.map((p) => (
            <PerPaperBlock
              key={p.paperId}
              item={p}
              paper={papers.find((x) => x.id === p.paperId)}
              fieldKey={item.key}
              onChanged={onChanged}
            />
          ))}
        </div>
        <div className="check-why" style={{ marginTop: 10 }}>
          <b>缺失会影响什么：</b>
          {item.impact}
        </div>
        {item.verdict === 'missing' && (
          <div className="banner banner-warn" style={{ marginTop: 10 }}>
            <span className="banner-icon">ℹ️</span>
            <div>
              「未找到」只说明本次上传的文件里没有读到这一项，<strong>不代表论文有错误</strong>。
              建议先回原文核对：如果论文其实写了，请用上面的「修正这一项」补上；
              如果确实没写，复现时需要自己设定并记录。
            </div>
          </div>
        )}
        {item.verdict === 'unchecked' && (
          <div className="banner banner-warn" style={{ marginTop: 10 }}>
            <span className="banner-icon">🕳️</span>
            <div>
              这一项是<strong>「还没检查」而不是「未找到」</strong>：论文里还有页面没有被处理
              （正文超长被截断，或页面本身抽不出文字）。这些页面里可能恰好写着这一项，
              所以不能据此下「论文没写」的结论。可以在论文库点「用原文件重跑」补上，
              或直接用上面的「修正这一项」人工补充。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export function CheckPage() {
  const navigate = useNavigate()
  const { state, dispatch, scopedPapers, selectedPapers, toast, setDatasetScope } = useApp()
  const [tab, setTab] = useState<Tab>('fairness')
  const [rechecking, setRechecking] = useState(false)
  const [version, setVersion] = useState(0)

  const datasetScope = state.datasetScope ?? null
  const scopeOptions = useMemo(() => commonDatasets(selectedPapers), [selectedPapers])

  // 选中的数据集如果已经不在共同数据集里（换论文/改字段），自动退回整体口径
  useEffect(() => {
    if (datasetScope && !scopeOptions.some((o) => o.name === datasetScope)) setDatasetScope(null)
  }, [datasetScope, scopeOptions, setDatasetScope])

  const fairness = useMemo(
    () => runFairnessCheck(selectedPapers, datasetScope),
    [selectedPapers, version, datasetScope],
  )
  const repro = useMemo(() => runReproCheck(selectedPapers), [selectedPapers, version])
  const fairSum = summarizeFairness(fairness.filter((f) => f.key !== 'method'))
  const reproSum = summarizeRepro(repro)

  const allDemo = selectedPapers.length > 0 && selectedPapers.every((p) => p.source === 'demo')

  const recheck = () => {
    setRechecking(true)
    window.setTimeout(() => {
      setRechecking(false)
      setVersion((v) => v + 1)
      toast('success', '已按最新字段重新检查', `规则版本：${CHECK_RULE_VERSION}`)
    }, 520)
  }

  return (
    <div className="page">
      <header className="page-heading">
        <div>
          <div className="eyebrow">CHECK BEFORE YOU REPRODUCE</div>
          <h1>先核对，再动手</h1>
          <p>逐项判断实验条件是否公平可比，并列出复现前还缺哪些关键信息。</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-sm" onClick={recheck} disabled={rechecking || selectedPapers.length === 0} title="重新跑一遍检查规则">
            {rechecking ? (
              <>
                <span className="spinner" /> 检查中…
              </>
            ) : (
              <>
                <Icon name="refresh" size={14} /> 重新检查
              </>
            )}
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => navigate('/plan')}
            disabled={selectedPapers.length === 0}
            title="按你的设备与时间，生成最多 3 个按优先级排列的最小验证实验"
          >
            <Icon name="plan" size={15} /> 生成验证计划
          </button>
          <details className="more-actions">
            <summary className="btn btn-sm btn-ghost">更多</summary>
            <div className="more-actions-menu popover">
              <button className="palette-item" onClick={() => navigate('/lab?source=paper')}>
                <Icon name="lab" size={14} /> 进小咕实验室
                <span className="pi-kind">改条件跑真实计算</span>
              </button>
              <button className="palette-item" onClick={() => navigate('/compare')}>
                <Icon name="compare" size={14} /> 返回方法对比
              </button>
              <button className="palette-item" onClick={() => navigate('/qa')} disabled={!selectedPapers.length}>
                <Icon name="qa" size={14} /> 问小咕
              </button>
            </div>
          </details>
        </div>
      </header>

      {allDemo && (
        <div style={{ marginBottom: 14 }}>
          <DemoBanner>
            ：下面的检查结论基于虚构的演示论文，演示「条件一致 / 存在差异 / 信息不足 / 未找到」四类结果。
          </DemoBanner>
        </div>
      )}

      {selectedPapers.length === 0 ? (
        <EmptyState
          icon="🧪"
          title="先选择要检查的论文"
          description="实验检查需要 2 篇以上论文来比较实验条件（复现缺项检查 1 篇也可以）。可以到论文库勾选，或直接载入示例项目。"
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
                    ids: scopedPapers.filter((p) => p.status === 'parsed').slice(0, 2).map((p) => p.id),
                  })
                }
                disabled={scopedPapers.filter((p) => p.status === 'parsed').length < 2}
              >
                选择前 2 篇已解析论文
              </button>
            </>
          }
        />
      ) : (
        <>
          {/* ---------------- 选择 + 摘要 ---------------- */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-body tight">
              <div className="row" style={{ flexWrap: 'wrap', rowGap: 6 }}>
                <Tag tone="blue">
                  已选 {selectedPapers.length}/{MAX_SELECTION}
                </Tag>
                {selectedPapers.map((p) => (
                  <span className="chip chip-wrap" key={p.id}>
                    <span className="mono strong">{p.shortLabel}</span>
                    <span className="clamp-2" style={{ maxWidth: 250, overflowWrap: 'anywhere' }}>
                      {p.title}
                    </span>
                    <button
                      className="chip-x"
                      onClick={() => dispatch({ type: 'TOGGLE_SELECT', id: p.id })}
                      aria-label="移除"
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <div className="spacer" />
                <button className="btn btn-sm btn-ghost" onClick={() => navigate('/library')}>
                  调整选择
                </button>
              </div>
            </div>
          </div>

          {/* ---------------- 对比口径：共同数据集 ---------------- */}
          {scopeOptions.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-body tight">
                <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                  <Tag tone={datasetScope ? 'green' : 'plain'}>对比口径</Tag>
                  <span className="small">
                    {datasetScope
                      ? `已限定在共同数据集「${datasetScope}」上比较`
                      : '当前按论文整体口径比较'}
                  </span>
                  <div className="spacer" />
                  <label className="small muted-2" htmlFor="scope-select">
                    选共同数据集：
                  </label>
                  <select
                    id="scope-select"
                    className="input input-sm"
                    value={datasetScope ?? ''}
                    onChange={(e) => setDatasetScope(e.target.value || null)}
                  >
                    <option value="">不限定（论文整体口径）</option>
                    {scopeOptions.map((o) => (
                      <option key={o.name} value={o.name}>
                        {o.name}（{o.paperIds.length}/{o.totalPapers} 篇包含）
                      </option>
                    ))}
                  </select>
                </div>
                {datasetScope &&
                  (() => {
                    const opt = scopeOptions.find((o) => o.name === datasetScope)
                    if (!opt || opt.missingPaperIds.length === 0) return null
                    const missing = selectedPapers.filter((p) => opt.missingPaperIds.includes(p.id))
                    return (
                      <div className="banner banner-warn" style={{ marginTop: 8 }}>
                        <span className="banner-icon">⚠️</span>
                        <div>
                          「{datasetScope}」只在 {opt.paperIds.length}/{opt.totalPapers} 篇论文里出现：
                          <b>{missing.map((p) => p.shortLabel).join('、')}</b> 没有用到这个数据集。
                          因此下面每一项里，这几篇都会被标成<b>「信息不足」</b>，
                          不会被算作"已经比较过" —— 它们在该数据集上的实验本来就不存在。
                        </div>
                      </div>
                    )
                  })()}
                <div className="small muted-2" style={{ marginTop: 8 }}>
                  两篇论文的数据集集合不一样，<b>不代表它们的共同实验不可比较</b>。
                  选定共同数据集后，划分、测试区间、预测跨度、采样间隔、指标等会只按这个数据集的口径重新判定；
                  如果某篇论文没有单独说明该数据集上的设置，会如实标为「信息不足」而不是硬判成差异。
                </div>
              </div>
            </div>
          )}

          {(() => {
            const notReady = selectedPapers.filter((p) => p.status !== 'parsed')
            const manual = selectedPapers.filter((p) =>
              Object.values(p.fields).some((f) => f?.origin === 'user'),
            )
            if (notReady.length === 0 && manual.length === 0) return null
            return (
              <div className="stack-sm" style={{ marginBottom: 14 }}>
                {notReady.length > 0 && (
                  <div className="banner banner-warn">
                    <span className="banner-icon">⏳</span>
                    <div>
                      <strong>
                        有 {notReady.length} 篇论文还没有完成字段抽取（
                        {notReady.map((p) => p.shortLabel).join('、')}）。
                      </strong>
                      <div style={{ marginTop: 6 }}>
                        这些论文的检查项会显示为「信息不足 / 未找到」，这不是论文本身的问题，而是当前还没抽到字段。
                        可以到论文库点「继续抽取」，或确认后端是否已连接、PDF 是否为文本型。
                      </div>
                    </div>
                  </div>
                )}
                {manual.length > 0 && (
                  <div className="banner banner-info">
                    <span className="banner-icon">✍️</span>
                    <div>
                      当前检查中包含<b>人工补充</b>的字段（{manual.map((p) => p.shortLabel).join('、')}）。
                      人工补充的值只用于让你继续推进检查，不会被记为论文原文依据；相关检查项上会标注「含人工补充」。
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          <div className="row" style={{ marginBottom: 14, alignItems: 'center', flexWrap: 'wrap', rowGap: 6 }}>
            <div className="tabs">
              <button
                className={`tab${tab === 'fairness' ? ' active' : ''}`}
                onClick={() => setTab('fairness')}
              >
                实验公平性检查
                <span className="tab-count">
                  {fairSum.different + fairSum.insufficient || 0} 需注意
                </span>
              </button>
              <button className={`tab${tab === 'repro' ? ' active' : ''}`} onClick={() => setTab('repro')}>
                复现缺项检查
                <span className="tab-count">{reproSum.missing + reproSum.needConfirm} 需处理</span>
              </button>
            </div>
            <div className="spacer" />
            <div className="status-legend">
              <span>检查规则：{CHECK_RULE_VERSION}</span>
              <span className="muted-2">·</span>
              <span>结论自动随字段修改更新</span>
            </div>
          </div>

          {rechecking && (
            <div className="stack-sm" style={{ marginBottom: 14 }}>
              <div className="skeleton" style={{ height: 14, width: '38%' }} />
              <div className="skeleton" style={{ height: 42 }} />
              <div className="skeleton" style={{ height: 42 }} />
            </div>
          )}

          {/* ---------------- 公平性检查 ---------------- */}
          {tab === 'fairness' && (
            <>
              <div className="summary-strip" style={{ marginBottom: 12 }}>
                <div className="summary-cell green">
                  <div className="n">{fairSum.consistent}</div>
                  <div className="k">条件一致</div>
                </div>
                <div className="summary-cell orange">
                  <div className="n">{fairSum.different}</div>
                  <div className="k">存在差异</div>
                </div>
                <div className="summary-cell slate">
                  <div className="n">{fairSum.insufficient}</div>
                  <div className="k">待核对条件</div>
                </div>
                <div className="summary-cell">
                  <div className="n">{fairSum.total}</div>
                  <div className="k">检查项总数</div>
                </div>
              </div>

              <details className="analysis" style={{ marginBottom: 14 }}>
                <summary>这些结论怎么来的（判定规则与边界）</summary>
                <div className="small muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
                  这里只判断「条件是否一致」，不给方法排名。每项显示「{FAIRNESS_TEXT.consistent}」「
                  {FAIRNESS_TEXT.different}」「{FAIRNESS_TEXT.insufficient}」中的一种。其中两项是<b>综合核对</b>：
                  <b>划分</b>要同时看比例与测试区间（比例相同不等于同一段数据）；<b>预测跨度</b>要同时看步数与采样间隔。
                  条件一致也不代表实验结论已经被证明。
                </div>
              </details>

              {(() => {
                const items = fairness.filter((f) => f.key !== 'method')
                const diff = items.filter((i) => i.verdict === 'different')
                const pending = items.filter((i) => i.verdict === 'insufficient')
                const same = items.filter((i) => i.verdict === 'consistent')
                const groups = [
                  { id: 'diff', label: '存在差异', hint: '这些条件不一致，直接比成绩会得出错误结论', list: diff, open: true },
                  { id: 'pending', label: '待核对', hint: '本次没读到足够依据，需要回原文确认', list: pending, open: true },
                  { id: 'same', label: '已确认一致', hint: '这些条件读到的取值一致，可以按同一口径继续', list: same, open: false },
                ].filter((g) => g.list.length > 0)
                return groups.map((g) => (
                  <details key={g.id} className="check-group" open={g.open}>
                    <summary>
                      <span className={`cg-dot ${g.id}`} />
                      <span className="cg-label">{g.label}</span>
                      <span className="cg-count">{g.list.length}</span>
                      <span className="cg-hint">{g.hint}</span>
                      <span className="spacer" />
                      <Icon name="chevron" size={15} className="ic-chev" />
                    </summary>
                    <div className="check-group-body">
                      {g.list.map((item) => (
                        <FairnessBlock key={item.id} item={item} papers={selectedPapers} onChanged={recheck} />
                      ))}
                    </div>
                  </details>
                ))
              })()}

              {selectedPapers.length < 2 && (
                <div className="banner banner-warn">
                  <span className="banner-icon">⚠️</span>
                  <div>公平性检查需要至少 2 篇论文；当前只选了 1 篇，各项均显示为「信息不足」。</div>
                </div>
              )}
            </>
          )}

          {/* ---------------- 复现缺项检查 ---------------- */}
          {tab === 'repro' && (
            <>
              <div className="summary-strip" style={{ marginBottom: 12 }}>
                <div className="summary-cell green">
                  <div className="n">{reproSum.found}</div>
                  <div className="k">已找到</div>
                </div>
                <div className="summary-cell red">
                  <div className="n">{reproSum.missing}</div>
                  <div className="k">未找到</div>
                </div>
                <div className="summary-cell violet">
                  <div className="n">{reproSum.needConfirm}</div>
                  <div className="k">需要确认</div>
                </div>
                <div className="summary-cell">
                  <div className="n">{reproSum.manual}</div>
                  <div className="k">人工补充</div>
                </div>
                <div className="summary-cell">
                  <div className="n">{reproSum.total}</div>
                  <div className="k">检查项总数</div>
                </div>
              </div>

              <div className="banner banner-info" style={{ marginBottom: 14 }}>
                <span className="banner-icon">🧾</span>
                <div>
                  逐项检查复现必需的设置：<b>{REPRO_TEXT.found}</b> / <b>{REPRO_TEXT.missing}</b> /{' '}
                  <b>{REPRO_TEXT.need_confirm}</b> / <b>{REPRO_TEXT.manual}</b>。
                  每项都会解释「缺失会影响什么」，并给出建议。
                  <br />
                  「{REPRO_TEXT.missing}」只表示本次上传的文件里没有读到这一项，<b>不代表论文有错误</b>；
                  如果论文其实写了，用「补充 / 修正这一项」填上后结论会立刻更新，
                  填进去的值会标为「<b>人工补充</b>」，不会被当成论文原文依据，论文原始抽取值与证据也会保留。
                </div>
              </div>

              {repro.map((item) => (
                <ReproBlock
                  key={item.id}
                  item={item}
                  papers={selectedPapers}
                  onChanged={recheck}
                />
              ))}
            </>
          )}

          {/* ---------------- 底部操作 ---------------- */}
          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-body">
              <div className="row">
                <div style={{ minWidth: 220, flex: 1 }}>
                  <h3 style={{ marginBottom: 4 }}>改完字段之后</h3>
                  <div className="small muted">
                    所有检查结果都由字段直接推导，修改任意一项后会自动重算。也可以点「重新检查」手动触发一次。
                  </div>
                </div>
                <div className="btn-group">
                  <button className="btn" onClick={recheck} disabled={rechecking}>
                    ↻ 重新检查
                  </button>
                  <button className="btn" onClick={() => navigate('/qa')}>
                    💬 提问这些差异
                  </button>
                  <button className="btn btn-primary" onClick={() => navigate('/library')}>
                    回到论文库
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
