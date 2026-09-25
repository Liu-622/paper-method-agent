import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/store/AppStore'
import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import { collectionSummary } from '@/services/collection'
import { UPLOAD_RULES } from '@/config'

/** 文献集合：批量导入与整理（赛题能力 1 · 批量文献解析） */
export function CollectionsPage() {
  const {
    state, dispatch, toast, scopedPapers, collectionPapers, currentCollection,
    createCollection, renameCollection, deleteCollection, addPapersToCollection,
    removePaperFromCollection, bootstrapTsCollection, runCollectionAnalysis, uploadFiles, importCatalogPages,
    analyzeCollectionPapers, cancelAnalysis, collectionAnalysisStatus,
  } = useApp()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  const [importingPages, setImportingPages] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  const textReadCount = collectionPapers.filter((p) => state.texts[p.id]?.length).length
  const evidenceCount = collectionPapers.filter((p) => state.methodProfiles[p.id]?.family.some((f) => f.origin === 'paper')).length

  const paperById = useMemo(() => new Map(state.papers.map((p) => [p.id, p])), [state.papers])
  const summary = currentCollection ? collectionSummary(collectionPapers, state.methodProfiles) : null
  const analysis = currentCollection ? state.analyses.find((a) => a.collectionId === currentCollection.id) : null
  const cacheStatus = currentCollection ? collectionAnalysisStatus() : null

  const pendingUpload = scopedPapers.filter((p) => p.status === 'pending' || p.status === 'parsing' || p.status === 'extracting')
  const failed = scopedPapers.filter((p) => p.status === 'failed')

  const filtered = collectionPapers.filter((p) => {
    if (query && !(p.title + p.fileName).toLowerCase().includes(query.toLowerCase())) return false
    if (filter === 'classified') return state.methodProfiles[p.id]?.family.some((f) => f.label !== '待分类')
    if (filter === 'pending') return !state.methodProfiles[p.id]?.family.some((f) => f.label !== '待分类')
    if (filter === 'failed') return p.status === 'failed'
    return true
  })

  const onFiles = async (files: File[]) => {
    if (!currentCollection) return
    const before = new Set(stateRef.current.papers.map((p) => p.id))
    const issues = await uploadFiles(files)
    // 成功后新论文会进入 store.papers，用差值找出本次新增的 id 加入集合
    const addedIds = stateRef.current.papers.filter((p) => !before.has(p.id)).map((p) => p.id)
    if (addedIds.length) addPapersToCollection(currentCollection.id, addedIds)
    if (addedIds.length) toast('success', `已加入 ${addedIds.length} 篇到集合`, '逐篇解析，失败不阻断其它论文')
    if (issues.length) toast('warning', `${issues.length} 篇未能导入`, issues[0]?.message ?? '')
  }

  return (
    <div className="page narrow">
      <header className="page-heading">
        <div>
          <div className="eyebrow">COLLECTIONS</div>
          <h1>文献集合</h1>
          <p>把一批论文收进一个集合，批量解析、分类、梳理演进；单个集合是后续地图、演进与方向的统一数据来源。</p>
        </div>
        <div className="head-actions">
          {!currentCollection && (
            <button className="btn btn-primary" onClick={() => bootstrapTsCollection()} title="一键导入 12 篇来源可查的时间序列预测公开文献">
              <Icon name="sparkle" size={15} /> 导入示例集合
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              const c = createCollection(name.trim() || `新集合 ${state.collections.length + 1}`)
              setName('')
              toast('success', '已新建集合', c.name)
            }}
          >
            <Icon name="plus" size={15} /> 新建集合
          </button>
        </div>
      </header>

      {state.collections.length === 0 ? (
        <div className="empty">
          <span className="empty-icon"><Icon name="library" size={20} /></span>
          <strong>还没有研究集合</strong>
          <p className="small muted">先导入内置的「时间序列预测」公开文献清单快速体验，或新建空集合后批量上传自己的 PDF。</p>
          <div className="empty-actions">
            <button className="btn btn-primary" onClick={() => bootstrapTsCollection()}>导入示例集合（12 篇真实文献）</button>
            <button className="btn" onClick={() => { const c = createCollection('时间序列预测研究'); toast('success', '已新建', c.name) }}>新建空集合</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          {/* 集合切换 */}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="tiny muted-2">当前集合：</span>
            {state.collections.map((c) => (
              <button key={c.id} className={`chip${c.id === currentCollection?.id ? ' active' : ''}`} onClick={() => dispatch({ type: 'SET_CURRENT_COLLECTION', id: c.id })}>
                {c.name} <span className="chip-sub">{c.paperIds.length}</span>
              </button>
            ))}
          </div>

          {currentCollection && (
            <>
              {/* 集合概览 + 分类摘要（数字实时计算，多标签可重叠） */}
              <section className="section">
                <div className="row">
                  <div>
                    <div className="section-title" style={{ marginBottom: 4 }}>{currentCollection.name}</div>
                    <div className="tiny muted-2">{currentCollection.domain} · 最近更新 {new Date(currentCollection.updatedAt).toLocaleString()}</div>
                  </div>
                  <span className="spacer" />
                  <button className="btn btn-sm btn-ghost" disabled={importingPages} onClick={async () => { setImportingPages(true); const n = await importCatalogPages(); setImportingPages(false); toast(n > 0 ? 'success' : 'warning', `已导入 ${n} 篇真实正文`, '正文来自本地已下载的 arXiv PDF，分类将基于实际正文而非清单预置') }} title="读取本地已下载的 12 篇 arXiv PDF 正文（无需模型）">
                    <Icon name="file-text" size={13} /> 导入真实正文
                  </button>
                  <button className="btn btn-sm btn-primary" disabled={analyzing} onClick={async () => { setAnalyzing(true); const r = await analyzeCollectionPapers(currentCollection.id, 'analyze-new'); setAnalyzing(false); toast(r.done > 0 ? 'success' : 'warning', `分析未完成项：完成 ${r.done} 篇`, r.failed ? `失败 ${r.failed} 篇，已保留旧结果` : `跳过 ${r.skipped} 篇有效缓存，未调用模型`) }} title="只分析尚未分析 / 上次失败的论文，有效结果直接复用">
                    {analyzing ? <><span className="spinner light" /> 分析中…</> : <><Icon name="sparkle" size={13} /> 分析未完成项</>}
                  </button>
                  <button className="btn btn-sm btn-ghost" disabled={analyzing} onClick={async () => { setAnalyzing(true); const r = await analyzeCollectionPapers(currentCollection.id, 'update-stale'); setAnalyzing(false); toast(r.done > 0 ? 'success' : 'warning', `更新过期分析：完成 ${r.done} 篇`, r.failed ? `失败 ${r.failed} 篇` : `跳过 ${r.skipped} 篇未过期`) }} title="只处理正文变化 / 分析流程升级 / 模型变化的论文">
                    更新过期分析
                  </button>
                  <button className="btn btn-sm btn-ghost" disabled={analyzing} onClick={async () => { const total = collectionPapers.length; if (!window.confirm(`强制重新分析会重新调用模型处理全部 ${total} 篇（失败会保留旧结果）。确定继续？`)) return; setAnalyzing(true); const r = await analyzeCollectionPapers(currentCollection.id, 'force'); setAnalyzing(false); toast(r.done > 0 ? 'success' : 'warning', `强制重跑完成 ${r.done} 篇`, r.failed ? `失败 ${r.failed} 篇（旧结果保留）` : undefined) }} title="重新调用模型分析全部论文">
                    强制重新分析
                  </button>
                  {analyzing && <button className="btn btn-sm btn-ghost" onClick={cancelAnalysis}>取消</button>}
                  {cacheStatus && (
                    <Tag tone="slate">有效 {cacheStatus.counts['fresh'] ?? 0} · 未分析 {cacheStatus.counts['missing'] ?? 0} · 过期 {cacheStatus.counts['stale-content'] ?? 0} · 失败 {cacheStatus.counts['failed'] ?? 0}</Tag>
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => { const n = window.prompt('重命名集合', currentCollection.name); if (n?.trim()) renameCollection(currentCollection.id, n.trim()) }} title="重命名集合">重命名</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => { if (window.confirm(`删除集合「${currentCollection.name}」？只删集合，不删原论文（${currentCollection.paperIds.length} 篇保留在论文库）。`)) { deleteCollection(currentCollection.id); toast('info', '已删除集合', '论文本身仍在论文库中') } }} title="删除集合（不删论文）">删除</button>
                  <button className="btn btn-sm btn-primary" onClick={() => runCollectionAnalysis(currentCollection.id)}>
                    <Icon name="refresh" size={13} /> 重新分类
                  </button>
                  <button className="btn btn-sm" onClick={() => navigate('/map')}>打开方法地图</button>
                  <button className="btn btn-sm" onClick={() => navigate('/directions')}>生成研究方向</button>
                </div>
                {summary && (
                  <div className="small">
                    正文已读取 <b>{textReadCount}</b>/<b>{collectionPapers.length}</b> 篇 · 有正文证据支持 <b>{evidenceCount}</b> 篇 · 有分类建议{' '}
                    <b>{summary.classified}</b> 篇（待确认 <b>{summary.pending}</b>）。
                    <span className="tiny muted-2">（分类建议 ≠ 正文证据；清单预置标签在读取正文前不视为分析结论）</span>
                  </div>
                )}
                {cacheStatus?.stampStale && (
                  <div className="tiny" style={{ color: 'var(--warn, #9a6700)' }}>
                    集合成员或分析流程已变化：地图 / 演进摘要 / 方向基于旧范围生成，仍可查看；重新分析后点「重新分类」「生成研究方向」更新。
                  </div>
                )}
              </section>

              {/* 批量导入（拖拽多文件） */}
              <div
                className={`dropzone${dragging ? ' dragging' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files)) }}
              >
                <span className="dropzone-icon"><Icon name="plus" size={20} /></span>
                <div className="stack-sm">
                  <div className="small strong">批量导入 PDF（可一次选多个，也可拖拽）</div>
                  <div className="upload-help">单文件 ≤ {UPLOAD_RULES.maxFileSizeLabel}；逐篇解析，单篇失败不阻断其它论文。解析队列与阶段在下方列表里实时显示。</div>
                </div>
                <span className="spacer" />
                <button className="btn" onClick={() => fileRef.current?.click()}>选择文件</button>
                <button className="btn btn-ghost" onClick={() => navigate('/library')}>从论文库加入</button>
                <input ref={fileRef} type="file" accept=".pdf" multiple hidden onChange={(e) => { if (e.target.files?.length) onFiles(Array.from(e.target.files)) }} />
              </div>

              {/* 队列状态 */}
              {(pendingUpload.length > 0 || failed.length > 0) && (
                <div className="panel">
                  <div className="tiny muted-2">
                    处理中 {pendingUpload.length} 篇 · 失败 {failed.length} 篇（刷新后已完成结果保留，中断任务可继续）
                  </div>
                  {failed.length > 0 && (
                    <div className="row-tight">
                      <button className="btn btn-sm" onClick={() => failed.forEach((p) => addPapersToCollection(currentCollection.id, []))}>仅重试失败（保留成功结果）</button>
                    </div>
                  )}
                </div>
              )}

              {/* 列表 + 搜索筛选 */}
              <div className="library-toolbar">
                <label className="library-search"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按标题搜索" /></label>
                <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="all">全部状态</option>
                  <option value="classified">已分类</option>
                  <option value="pending">待确认</option>
                  <option value="failed">失败</option>
                </select>
                <span className="spacer" />
                <span className="small muted">{filtered.length} / {collectionPapers.length} 篇</span>
              </div>

              <div className="paper-list">
                {filtered.map((p) => {
                  const pr = state.methodProfiles[p.id]
                  return (
                    <div className="paper-item" key={p.id}>
                      <div className="paper-main">
                        <div className="paper-title">{p.title}</div>
                        <div className="paper-meta">
                          <span>{p.shortLabel}</span>
                          {p.year && <span>{p.year}</span>}
                          {p.venue && <span className="tiny">{p.venue}</span>}
                          {p.source === 'catalog' && <Tag tone="violet">内置清单</Tag>}
                          <StatusChip p={p} />
                        </div>
                        {pr && (
                          <div className="paper-tags">
                            {pr.family.filter((f) => f.label !== '待分类').map((f) => <Tag key={f.label} tone={f.origin === 'paper' ? 'green' : 'blue'}>{f.label}</Tag>)}
                            {pr.mechanisms.filter((m) => m.label !== '待确认').slice(0, 4).map((m) => <Tag key={m.label} tone="plain">{m.label}</Tag>)}
                          </div>
                        )}
                      </div>
                      <div className="paper-actions">
                        <button className="btn btn-sm btn-ghost" onClick={() => navigate(`/paper/${p.id}`)}>详情</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => removePaperFromCollection(currentCollection.id, p.id)} title="从集合移除（不删除原文件）">移出</button>
                      </div>
                    </div>
                  )
                })}
                {filtered.length === 0 && <div className="empty" style={{ border: 0, padding: 24 }}><span className="small muted">没有匹配的论文。可以批量导入 PDF，或从论文库把已有论文加入集合。</span></div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function StatusChip({ p }: { p: { status: string; source?: string; parseMessage?: string } }) {
  if (p.source === 'catalog' && p.status === 'pending') return <Tag tone="violet"><span title={p.parseMessage}>仅有元信息</span></Tag>
  const map: Record<string, [string, 'green' | 'blue' | 'slate' | 'orange' | 'red']> = {
    parsed: ['方法分析完成', 'green'],
    pending: ['等待处理', 'slate'],
    parsing: ['读取正文', 'blue'],
    extracting: ['提取信息', 'blue'],
    'text-only': ['正文已读取（未抽取字段）', 'blue'],
    failed: ['失败', 'red'],
  }
  const [label, tone] = map[p.status] ?? ['处理中', 'slate']
  return <Tag tone={tone}><span title={p.parseMessage}>{label}</span></Tag>
}
