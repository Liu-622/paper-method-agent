import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MAX_SELECTION, useApp } from '@/store/AppStore'
import { DETAIL_GROUPS, FIELD_ORDER, FIELD_META } from '@/data/fieldSchema'
import { FieldCard } from '@/components/FieldCard'
import { DemoBadge, DemoBanner } from '@/components/DemoBadge'
import { UpdateAnalysisNotice } from '@/components/UpdateAnalysisNotice'
import { FieldReading } from '@/components/FieldReading'
import { Icon } from '@/components/Icons'
import { EmptyState } from '@/components/EmptyState'
import { PaperStatusTag, Tag } from '@/components/StatusTag'
import { formatFileSize } from '@/services/parser'
import { runReproCheck, summarizeRepro } from '@/services/checks'

export function PaperDetailPage() {
  const { paperId } = useParams()
  const navigate = useNavigate()
  const { state, dispatch, toast } = useApp()

  /* 对撞台/首页可以带 ?detect=<fieldKey> 直接打开右侧面板的侦探 */
  useEffect(() => {
    const detect = new URLSearchParams(location.search).get('detect')
    if (detect && paperId) {
      dispatch({ type: 'OPEN_DETECTIVE', ctx: { paperId, fieldKey: detect, from: '来自观点卡的「找齐比较条件」' } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, paperId])

  const paper = state.papers.find((p) => p.id === paperId)

  if (!paper) {
    return (
      <div className="page">
        <EmptyState
          icon="🔍"
          title="没有找到这篇论文"
          description="它可能已被删除，或者你打开的链接来自另一个浏览器会话。"
          actions={
            <button className="btn btn-primary" onClick={() => navigate('/library')}>
              返回论文库
            </button>
          }
        />
      </div>
    )
  }

  const isSelected = state.selectedIds.includes(paper.id)
  const isDemo = paper.source === 'demo'
  const repro = runReproCheck([paper])
  const reproSum = summarizeRepro(repro)
  const gaps = repro.filter((r) => r.verdict !== 'found')

  const toggleSelect = () => {
    dispatch({ type: 'TOGGLE_SELECT', id: paper.id })
    if (!isSelected) {
      toast('success', `已把 ${paper.shortLabel} 加入对比`, '可以继续选择同项目下的其他论文。')
    }
  }

  return (
    <div className="page">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigate('/library')}>
          ← 返回论文库
        </button>
        <div className="spacer" />
        <button className={`btn btn-sm${isSelected ? '' : ' btn-primary'}`} onClick={toggleSelect}>
          {isSelected ? '移出对比' : '加入对比'}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => navigate('/check')}
          disabled={state.selectedIds.length < 1}
          title={state.selectedIds.length < 1 ? '请先在论文库勾选论文' : '打开实验检查'}
        >
          检查复现条件
        </button>
        <button className="btn btn-sm" onClick={() => { dispatch({ type: 'SET_SELECT', ids: [paper.id] }); navigate('/qa') }}>
          就这篇提问
        </button>
      </div>

      {isDemo && (
        <div style={{ marginBottom: 14 }}>
          <DemoBanner>
            ：这篇论文及其全部原文片段均为虚构的演示内容，用于演示字段与出处机制。
          </DemoBanner>
        </div>
      )}

      {/* ---------------- 头部信息 ---------------- */}
      <div className="card">
        <div className="card-body">
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="tag tag-plain mono strong">{paper.shortLabel}</span>
            <PaperStatusTag status={paper.status} />
            {isDemo && <DemoBadge compact />}
          </div>
          <h1 style={{ fontSize: 21, marginBottom: 10 }}>{paper.title}</h1>
          <div className="row-tight" style={{ marginBottom: 10 }}>
            <button
              className="btn btn-sm"
              title="把这篇论文的结论转译成可执行的代理实验，并检查它与当前实验的关系"
              onClick={() =>
                navigate(
                  `/lab?source=paper&paper=${paper.id}&claim=${encodeURIComponent(
                    `${paper.shortLabel} 的结论在实验条件变化时是否稳定？（原文说法与证据会被带进转译卡）`,
                  )}`,
                )
              }
            >
              <Icon name="lab" size={14} /> 转译结论并进实验室
            </button>
            <span className="tiny muted-2">会先生成「结论转译卡 + 可验证范围矩阵」，再决定要不要运行</span>
          </div>
          <div className="paper-meta" style={{ marginBottom: 12 }}>
            {paper.authors && paper.authors !== '—' && <span>{paper.authors}</span>}
            {paper.year && <span>{paper.year} 年</span>}
            {paper.venue && paper.venue !== '—' && <span>{paper.venue}</span>}
            <span className="fname">{paper.fileName}</span>
            <span>{formatFileSize(paper.fileSize)}</span>
          </div>

          {paper.status === 'parsed' ? (
            <div className="row">
              <Tag tone="green">字段已抽取 {Object.keys(paper.fields).length} 项</Tag>
              {paper.pageCount ? <Tag tone="plain">PDF {paper.pageCount} 页</Tag> : null}
              {paper.textChars ? (
                <Tag tone="plain">正文 {paper.textChars.toLocaleString('zh-CN')} 字符</Tag>
              ) : null}
              <Tag tone={reproSum.missing > 0 ? 'red' : reproSum.needConfirm > 0 ? 'violet' : 'green'}>
                复现缺项：{reproSum.missing} 项未找到 / {reproSum.needConfirm} 项需确认
                {reproSum.manual > 0 ? ` / ${reproSum.manual} 项人工补充` : ''}
              </Tag>
              <span className="tiny muted-2">
                字段旁点「查看依据」可查看论文名、PDF 页序号与原文片段
              </span>
            </div>
          ) : (
            <div className="banner banner-warn">
              <span className="banner-icon">⏳</span>
              <div>
                <strong>
                  {paper.status === 'text-only'
                    ? '这篇论文的正文已经读到，但字段还没有抽出来。'
                    : paper.status === 'failed'
                      ? '这篇论文没有解析成功。'
                      : '这篇论文正在解析中。'}
                </strong>
                <div style={{ marginTop: 6 }}>
                  {paper.parseError ? (
                    <>
                      <b>失败原因：</b>
                      {paper.parseError}
                    </>
                  ) : (
                    <>
                      解析分两步：先在浏览器里读取 PDF 正文（已实现），再交给后端模型抽取字段。
                      如果第二步没有成功，通常是后端未连接。
                    </>
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-sm btn-primary" onClick={() => navigate('/library')}>
                    回到论文库处理
                  </button>
                </div>
              </div>
            </div>
          )}

          {paper.extractWarnings && paper.extractWarnings.length > 0 && (
            <div className="banner banner-warn" style={{ marginTop: 12 }}>
              <span className="banner-icon">⚠️</span>
              <div>
                <b>抽取提示：</b>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {paper.extractWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>

      {paper.status !== 'parsed' && (
        <div className="grid-2" style={{ marginTop: 16 }}>
          <div className="card">
            <div className="card-head">
              <h3>文件与解析信息</h3>
            </div>
            <div className="card-body stack-sm small">
              <div className="row">
                <span className="muted" style={{ width: 110 }}>
                  文件名
                </span>
                <span className="mono" style={{ wordBreak: 'break-all' }}>
                  {paper.fileName}
                </span>
              </div>
              <div className="row">
                <span className="muted" style={{ width: 110 }}>
                  大小
                </span>
                <span>{formatFileSize(paper.fileSize)}</span>
              </div>
              <div className="row">
                <span className="muted" style={{ width: 110 }}>
                  上传时间
                </span>
                <span>{new Date(paper.uploadedAt).toLocaleString('zh-CN')}</span>
              </div>
              <div className="row">
                <span className="muted" style={{ width: 110 }}>
                  已读到的正文
                </span>
                <span>
                  {paper.pageCount ? (
                    <>
                      <Tag tone="green">已读取</Tag> {paper.pageCount} 页 /{' '}
                      {(paper.textChars ?? 0).toLocaleString('zh-CN')} 字符
                    </>
                  ) : (
                    <Tag tone="red">未读取</Tag>
                  )}
                </span>
              </div>
              <div className="row">
                <span className="muted" style={{ width: 110 }}>
                  本地是否保留
                </span>
                <span>
                  {paper.textStored ? (
                    <Tag tone="green">正文已本地保存</Tag>
                  ) : (
                    <Tag tone="orange">未保存（刷新后需重新选择文件）</Tag>
                  )}
                </span>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3>字段抽取完成后这里会显示</h3>
            </div>
            <div className="card-body small muted">
              <ul style={{ marginBottom: 0 }}>
                {DETAIL_GROUPS.map((g) => (
                  <li key={g.group}>
                    <b>{g.title}</b>：{g.subtitle}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ---------------- 字段卡片 ---------------- */}
      {paper.status === 'parsed' && (
        <>
          <UpdateAnalysisNotice papers={[paper]} />

          <div className="banner banner-info">
            <Icon name="search" size={14} className="banner-icon" />
            <div>
              在任意字段行点<b>「找线索」</b>，右侧面板会去论文附录与官方仓库脚本里找这一项的出处（含文件行号与提交版本），
              也可以点「核对原文」查看这一项的所有原文片段。
            </div>
          </div>
          {DETAIL_GROUPS.map((group) => {
            const keys = FIELD_ORDER.filter(
              (k) => FIELD_META[k].group === group.group && paper.fields[k] !== undefined,
            )
            if (keys.length === 0) return null
            return (
              <div key={group.group} className="field-group">
                <div className="field-group-title">
                  {group.title}
                  <span className="fg-count">{keys.length} 项</span>
                  <span className="spacer" />
                  <span className="tiny muted-2">{group.subtitle}</span>
                </div>
                {keys.map((k) => (
                  <FieldReading key={k} paper={paper} fieldKey={k} />
                ))}
              </div>
            )
          })}

          <div className="section-title">
            <h2>下一步</h2>
            <span className="sub">把这些字段用在对比和检查里</span>
          </div>
          <div className="grid-3">
            <div className="cap-card">
              <h3>⚖️ 和其他论文并排比较</h3>
              <p>
                当前已选 {state.selectedIds.length}/{MAX_SELECTION} 篇。选择 2～3 篇后可以对比方法与实验条件。
              </p>
              <button className="btn btn-sm btn-primary" onClick={() => navigate('/compare')}>
                打开方法对比
              </button>
            </div>
            <div className="cap-card">
              <h3>🧪 检查能否公平比较</h3>
              <p>
                这篇论文目前有 {gaps.length} 项复现信息不到位（{reproSum.missing} 未找到、
                {reproSum.needConfirm} 需确认），可以先处理影响最大的几项。
              </p>
              <button className="btn btn-sm" onClick={() => navigate('/check')}>
                打开实验检查
              </button>
            </div>
            <div className="cap-card">
              <h3>💬 就这篇提问</h3>
              <p>问「这篇论文还需要确认哪些设置」，回答会带上原文页码与片段。</p>
              <button className="btn btn-sm" onClick={() => navigate('/qa')}>
                打开论文问答
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
