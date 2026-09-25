import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { MAX_SELECTION, useApp } from '@/store/AppStore'
import { DemoBadge, DemoBanner } from '@/components/DemoBadge'
import { EmptyState } from '@/components/EmptyState'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { PaperStatusTag, Tag } from '@/components/StatusTag'
import { PAPER_STATUS_TEXT } from '@/components/StatusTag'
import { formatFileSize, needsFileReselection, PARSER_CAPABILITY_NOTE } from '@/services/parser'
import { FILE_PERSISTENCE_NOTE, UPLOAD_RULES } from '@/config'
import type { Paper, UploadIssue } from '@/types'
import { Icon } from '@/components/Icons'

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return iso
  }
}

const ISSUE_LABEL: Record<UploadIssue['type'], string> = {
  'rejected-format': '格式不支持',
  'rejected-size': '超出限制',
  duplicate: '重复上传',
  empty: '空文件',
}

export function LibraryPage() {
  const {
    state,
    dispatch,
    scopedPapers,
    loadDemo,
    switchScope,
    uploadFiles,
    reextract,
    removePaper,
    resetAll,
    toast,
  } = useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()

  const inputRef = useRef<HTMLInputElement>(null)
  const reuploadRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [issues, setIssues] = useState<UploadIssue[]>([])
  const [pendingDelete, setPendingDelete] = useState<Paper | null>(null)
  const [reuploadId, setReuploadId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const visiblePapers = scopedPapers.filter(p =>
    `${p.title} ${p.shortLabel} ${p.fileName}`.toLowerCase().includes(query.toLowerCase()) &&
    (statusFilter === 'all' || (statusFilter === 'ready' ? p.status === 'parsed' : p.status !== 'parsed')))

  const isDemo = state.scope === 'demo'
  const selected = state.selectedIds
  const backendOk = state.backend.status === 'ok' && Boolean(state.backend.health?.hasCredentials)

  /* 从首页「上传论文」跳进来时自动唤起文件选择 */
  useEffect(() => {
    if (params.get('upload') === '1') {
      switchScope('user')
      const t = window.setTimeout(() => inputRef.current?.click(), 80)
      setParams({}, { replace: true })
      return () => window.clearTimeout(t)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files) return
    const list = Array.from(files)
    if (list.length === 0) return
    setIssues([])
    const found = await uploadFiles(list)
    if (found.length > 0) setIssues((prev) => [...prev, ...found])
    if (inputRef.current) inputRef.current.value = ''
  }

  const toggleSelect = (paper: Paper) => {
    if (isDemo !== (paper.source === 'demo')) {
      toast('warning', '不能跨项目选择', '切换左上角的「示例项目 / 我的论文」，把要比较的论文放在同一个项目里。')
      return
    }
    if (paper.source === 'user' && paper.status !== 'parsed') {
      toast(
        'warning',
        `${paper.shortLabel} 还没有完成字段抽取`,
        '对比与检查需要字段信息。可以让它先完成解析，或在「实验检查」页查看它为什么没有完成。',
      )
      return
    }
    dispatch({ type: 'TOGGLE_SELECT', id: paper.id })
  }

  const askReupload = (paper: Paper) => {
    setReuploadId(paper.id)
    reuploadRef.current?.click()
  }

  const isBusyStatus = (status: Paper['status']) =>
    status === 'parsing' || status === 'extracting' || status === 'pending'

  return (
    <div className="page library-page">
      <header className="page-heading"><div><div className="eyebrow">YOUR PAPER COLLECTION</div><h1>论文库</h1><p>把值得读的论文放在一起，让研究有迹可循。</p></div><button className="btn btn-primary" onClick={() => { switchScope('user'); window.setTimeout(() => inputRef.current?.click(), 100) }}><Icon name="plus" size={15} /> 添加论文</button></header>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="segmented">
          <button
            className={isDemo ? 'active' : ''}
            onClick={() => {
              if (!state.demoLoaded) loadDemo()
              else switchScope('demo')
            }}
          >
            示例项目
            {state.demoLoaded ? ` · ${state.papers.filter((p) => p.source === 'demo').length}` : ''}
          </button>
          <button className={!isDemo ? 'active' : ''} onClick={() => switchScope('user')}>
            我的论文 · {state.papers.filter((p) => p.source === 'user').length}
          </button>
        </div>
        <div className="spacer" />
        <button
          className="btn"
          onClick={() => navigate('/compare')}
          disabled={selected.length < 2}
          title={
            selected.length < 2
              ? '需要先勾选 2～3 篇论文（勾选框在每篇论文左侧）'
              : '并排比较方法与实验条件'
          }
        >
          <Icon name="compare" size={15} /> 对比论文（{selected.length}）
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => navigate('/check')}
          disabled={selected.length < 2}
          title={
            selected.length < 2
              ? '需要先勾选 2～3 篇论文（勾选框在每篇论文左侧）'
              : '检查实验公平性与复现缺项'
          }
        >
          <Icon name="check-circle" size={15} /> 实验检查
        </button>
      </div>

      {isDemo ? (
        <DemoBanner>
          ：下面 3 篇论文是虚构的演示数据，用于演示完整流程，与你自己上传的论文分开存放。
        </DemoBanner>
      ) : (
        <>
          {/* ---------------- 后端状态 ---------------- */}
          {!backendOk && (
            <div className="banner banner-warn" style={{ marginBottom: 12 }}>
              <span className="banner-icon">🔌</span>
              <div>
                <strong>没有连接到后端，字段抽取和问答会不可用。</strong>
                PDF 正文仍然会在浏览器里真实读取（页码、片段都能看到），但「模型抽取字段」这一步需要后端。
                <br />
                启动后端：<code>node server/index.mjs</code>（配置好模型密钥）；
                如果前端部署在静态托管上，请在左下角「运行设置」里填写后端地址。
              </div>
            </div>
          )}

          {/* ---------------- 上传区 ---------------- */}
          <div
            className={`dropzone${dragging ? ' dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              void handleFiles(e.dataTransfer.files)
            }}
          >
            <div className="dropzone-icon" aria-hidden="true">
              <Icon name="plus" size={24} />
            </div>
            <h3>把 PDF 拖到这里，或点击选择文件</h3>
            <p>
              文本型 PDF · 每批最多 {UPLOAD_RULES.maxFilesPerBatch} 篇 · 单篇不超过 {UPLOAD_RULES.maxFileSizeLabel}
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
                选择 PDF 文件
              </button>
              <button
                className="btn"
                onClick={() => {
                  if (!state.demoLoaded) loadDemo()
                  else switchScope('demo')
                }}
              >
                先看示例 →
              </button>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              hidden
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <input
              ref={reuploadRef}
              type="file"
              accept=".pdf,application/pdf"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0]
                const id = reuploadId
                if (reuploadRef.current) reuploadRef.current.value = ''
                setReuploadId(null)
                if (file && id) await reextract(id, file)
              }}
            />
          </div>

          {issues.length > 0 && (
            <div className="card" style={{ marginTop: 12, borderColor: 'var(--orange-border)' }}>
              <div className="card-head">
                <h3>本次上传的提示</h3>
                <div className="head-actions">
                  <button className="btn btn-sm btn-ghost" onClick={() => setIssues([])}>
                    清除
                  </button>
                </div>
              </div>
              <div className="card-body stack-sm">
                {issues.map((it, i) => (
                  <div className="row" key={`${it.fileName}-${i}`} style={{ alignItems: 'flex-start' }}>
                    <Tag tone={it.type === 'duplicate' ? 'orange' : 'red'}>
                      {ISSUE_LABEL[it.type]}
                    </Tag>
                    <span className="small" style={{ flex: 1, minWidth: 200 }}>
                      <b className="mono">{it.fileName}</b> —— {it.message}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <details className="upload-help"><summary>文件如何处理与保存？</summary><div className="banner">
            <Icon name="info" size={15} />
            <div>
              <strong>解析说明：</strong>
              {PARSER_CAPABILITY_NOTE}
              <div style={{ marginTop: 6 }}>{FILE_PERSISTENCE_NOTE}</div>
            </div>
          </div></details>
        </>
      )}

      {/* ---------------- 选择提示 ---------------- */}
      {selected.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-body tight">
            <div className="row">
              <Tag tone="blue">
                已选 {selected.length}/{MAX_SELECTION}
              </Tag>
              {selected.map((id) => {
                const p = state.papers.find((x) => x.id === id)
                if (!p) return null
                return (
                  <span className="chip" key={id}>
                    <span className="mono strong">{p.shortLabel}</span>
                    <span className="clamp-2" style={{ maxWidth: 240 }}>
                      {p.title}
                    </span>
                    <button
                      className="chip-x"
                      onClick={() => dispatch({ type: 'TOGGLE_SELECT', id })}
                      aria-label={`移除 ${p.shortLabel}`}
                    >
                      ✕
                    </button>
                  </span>
                )
              })}
              <div className="spacer" />
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => dispatch({ type: 'CLEAR_SELECT' })}
              >
                清除选择
              </button>
              <button className="btn btn-sm" onClick={() => navigate('/compare')}>
                开始对比 →
              </button>
            </div>
          </div>
        </div>
      )}

      {selected.length < 2 && scopedPapers.length >= 2 && (
        <div className="banner banner-info" style={{ marginTop: 12 }}>
          <span className="banner-icon">👉</span>
          <div>
            <strong>下一步：勾选 2～3 篇论文。</strong>
            勾选框在每篇论文左侧；选好后「去对比」和「去检查实验条件」就能点了。
          </div>
        </div>
      )}

      {/* ---------------- 列表 ---------------- */}
      <div className="library-toolbar"><label className="library-search"><Icon name="search" size={16} /><input className="input" aria-label="搜索论文" placeholder="搜索标题、简称或文件名" value={query} onChange={e => setQuery(e.target.value)} /></label><select className="select" aria-label="筛选处理状态" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">全部状态</option><option value="ready">已完成整理</option><option value="pending">待继续处理</option></select><span className="spacer" /><span className="small muted">{visiblePapers.length} 篇论文</span></div>
      <div className="section-title">
        <h2>{isDemo ? '示例论文' : '已上传的论文'}</h2>
        <span className="sub">
          共 {scopedPapers.length} 篇 · 勾选 2～{MAX_SELECTION} 篇后可以对比方法、检查实验条件、围绕它们提问
        </span>
      </div>

      {scopedPapers.length === 0 ? (
        isDemo ? (
          <EmptyState
            icon="🧪"
            title="示例项目里还没有论文"
            description="你可能删除了示例论文。可以重新载入一次示例数据。"
            actions={
              <button
                className="btn btn-primary"
                onClick={() => {
                  resetAll()
                  window.setTimeout(() => loadDemo(), 0)
                }}
              >
                重新载入示例
              </button>
            }
          />
        ) : (
          <EmptyState
            icon="📄"
            title="还没有上传论文"
            description="上传 2～3 篇同领域（时间序列预测）的文本型 PDF，就会真实读取正文、抽取字段，然后可以对比方法与检查实验条件。也可以先看看示例项目里长什么样。"
            actions={
              <>
                <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>
                  选择 PDF 文件
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    if (!state.demoLoaded) loadDemo()
                    else switchScope('demo')
                  }}
                >
                  ✨ 体验示例
                </button>
              </>
            }
          />
        )
      ) : (
        <div className="paper-list">
          {visiblePapers.length === 0 && <div className="empty"><h3>没有匹配的论文</h3><p>试试其他关键词，或清除当前筛选。</p><button className="btn" onClick={() => { setQuery(''); setStatusFilter('all') }}>清除筛选</button></div>}
          {visiblePapers.map((paper) => {
            const isSelected = selected.includes(paper.id)
            const progress = state.progress[paper.id]
            const busy = state.busyPaperIds.includes(paper.id) || isBusyStatus(paper.status)
            const pct =
              progress && progress.total > 0
                ? Math.round((progress.done / progress.total) * 100)
                : null
            return (
              <div className={`paper-item${isSelected ? ' selected' : ''}`} key={paper.id}>
                <div className="paper-check">
                  <label className="checkbox" title="加入对比 / 检查">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(paper)}
                      aria-label={`选择 ${paper.shortLabel}`}
                    />
                  </label>
                </div>

                <div className="paper-main">
                  <div className="paper-title">
                    <Link to={`/paper/${paper.id}`}>{paper.title}</Link>
                  </div>
                  <div className="paper-meta">
                    <span className="mono strong" style={{ color: 'var(--accent-strong)' }}>
                      {paper.shortLabel}
                    </span>
                    <span className="fname">{paper.fileName}</span>
                    <span>{formatFileSize(paper.fileSize)}</span>
                    {paper.pageCount ? <span>{paper.pageCount} 页</span> : null}
                    {paper.textChars ? <span>{paper.textChars.toLocaleString('zh-CN')} 字符</span> : null}
                    {paper.year && <span>{paper.year} 年</span>}
                    {paper.venue && paper.venue !== '—' && <span>{paper.venue}</span>}
                    <span>上传于 {fmtDate(paper.uploadedAt)}</span>
                  </div>
                  <div className="paper-tags">
                    <PaperStatusTag status={paper.status} />
                    {paper.source === 'demo' && <DemoBadge compact />}
                    {paper.status === 'parsed' && Object.keys(paper.fields).length > 0 && (
                      <span className="tiny muted-2">
                        已抽取 {Object.keys(paper.fields).length} 个字段
                        {paper.textStored ? ' · 正文已本地保存' : ' · 正文未本地保存'}
                        {paper.source === 'user'
                          ? paper.fileStored
                            ? ' · 原文件已本地保存'
                            : ' · 原文件未保存'
                          : ''}
                      </span>
                    )}
                    {paper.status === 'text-only' && (
                      <span className="tiny muted-2">字段还没抽出来，可以点「继续抽取」</span>
                    )}
                    {paper.source === 'user' &&
                      paper.status !== 'pending' &&
                      needsFileReselection(paper) && (
                        <span className="tiny" style={{ color: 'var(--orange-strong, #b45309)' }}>
                          本地没有正文与原文件了，需要重新选择文件
                        </span>
                      )}
                  </div>

                  {busy && (
                    <div style={{ marginTop: 9 }}>
                      <div className={`progress${pct === null ? ' progress-indeterminate' : ''}`}>
                        <div className="progress-bar" style={pct === null ? undefined : { width: `${pct}%` }} />
                      </div>
                      <div className="tiny muted-2" style={{ marginTop: 5 }}>
                        {progress
                          ? `${progress.stage}${progress.total ? ` · 第 ${progress.done}/${progress.total} 页` : ''}`
                          : PAPER_STATUS_TEXT[paper.status]}
                      </div>
                    </div>
                  )}

                  {!busy && paper.parseMessage && (
                    <div className="tiny muted-2" style={{ marginTop: 7 }}>
                      {paper.parseMessage}
                    </div>
                  )}
                  {!busy && paper.parseError && (
                    <div className="tiny" style={{ marginTop: 5, color: 'var(--red)' }}>
                      ⚠️ {paper.parseError}
                    </div>
                  )}
                </div>

                <div className="paper-actions">
                  <button className="btn btn-sm" onClick={() => navigate(`/paper/${paper.id}`)}>
                    查看详情
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => toggleSelect(paper)}
                  >
                    {isSelected ? '移出选择' : '加入对比'}
                  </button>
                  <details className="paper-more"><summary className="btn btn-sm btn-ghost">更多操作</summary>
                  {paper.source === 'user' && !busy && (
                    <>
                      {(paper.textStored || paper.fileStored) && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => void reextract(paper.id)}
                          title={
                            paper.fileStored
                              ? '用本地保存的原文件重新读取正文并抽取字段，不需要再选文件'
                              : '用本地保存的正文重新抽取字段'
                          }
                        >
                          {paper.status === 'parsed'
                            ? paper.fileStored
                              ? '用原文件重跑'
                              : '重新抽取'
                            : paper.fileStored
                              ? '继续（用原文件）'
                              : '继续抽取'}
                        </button>
                      )}
                      <button className="btn btn-sm btn-ghost" onClick={() => askReupload(paper)}>
                        {paper.fileStored ? '换一份文件' : '重新解析（选择文件）'}
                      </button>
                    </>
                  )}
                  <button className="btn btn-sm btn-danger" onClick={() => setPendingDelete(paper)}>
                    删除
                  </button>
                  </details>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="确认删除这篇论文？"
        message={
          pendingDelete ? (
            <>
              将从当前项目中移除 <b>{pendingDelete.shortLabel}</b>「{pendingDelete.title}」，
              同时清除它的解析正文、字段、原文片段，
              {pendingDelete.fileStored ? '以及本地保存的原文件' : '（这篇的原文件没有保存在本地）'}。
              <br />
              如果有对比或检查结果引用它，相关结果会同步更新。此操作不可撤销。
            </>
          ) : null
        }
        confirmText="确认删除"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            removePaper(pendingDelete.id)
            toast('success', `已删除 ${pendingDelete.shortLabel}`, '对比与检查结果已同步更新。')
          }
          setPendingDelete(null)
        }}
      />

      <div className="tiny muted-2" style={{ marginTop: 18 }}>
        论文处理状态：{Object.values(PAPER_STATUS_TEXT).join(' → ')}
      </div>
    </div>
  )
}
