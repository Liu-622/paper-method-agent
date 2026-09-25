import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApp } from '@/store/AppStore'
import { Icon } from '@/components/Icons'
import { Tag } from '@/components/StatusTag'
import { buildMapNodes, buildTimeline, evolutionSummary, collectionSummary } from '@/services/collection'
import type { ClassificationTag, MethodProfile, PaperRelation } from '@/types'

const FAMILY_COLOR: Record<string, string> = {
  Linear: 'var(--accent)',
  Transformer: 'var(--series-b)',
  CNN: 'var(--violet)',
  RNN: 'var(--series-c)',
  MLP: '#2f9e6b',
  混合架构: '#b45f2f',
  待分类: 'var(--text-3)',
}
const colorOf = (f: string) => FAMILY_COLOR[f] ?? 'var(--text-3)'

/* ------------------------------------------------------------------ */
/* 统一的证据状态渲染：地图 / 时间线 / 列表 / 连线必须用同一套判断     */
/* ------------------------------------------------------------------ */

type EvidenceLike = {
  verdict?: string
  quoteLocated?: boolean
  semanticSupport?: string
  page?: number
  locatedPage?: number | null
  semanticReason?: string
  verdictReason?: string
  reason?: string
}

/** 四个维度各自的状态，缺一不可；界面按这个显示，绝不只看「引文有没有定位到」。 */
const VERDICT_META: Record<string, { label: string; tone: 'green' | 'orange' | 'blue' | 'slate' | 'red' }> = {
  'paper-supported': { label: '原文支持', tone: 'green' },
  pending: { label: '待确认', tone: 'orange' },
  excluded: { label: '未归入本文方法', tone: 'slate' },
  unlocated: { label: '引用未定位', tone: 'red' },
  unsupported: { label: '原句不支持', tone: 'red' },
}

function verdictOf(it: EvidenceLike): string {
  if (it.verdict && VERDICT_META[it.verdict]) return it.verdict
  // 旧缓存没有 verdict：按最保守的方式降级，绝不当成「原文支持」
  if (it.quoteLocated) return 'pending'
  return 'unlocated'
}

function pageOf(it: EvidenceLike): number | null {
  const p = it.locatedPage ?? it.page
  return typeof p === 'number' && Number.isFinite(p) ? p : null
}

/**
 * 面向前台的状态说明。歧义要给出具体原因，不能一律说「待确认」。
 */
function statusHint(it: EvidenceLike): string {
  const v = verdictOf(it)
  const page = pageOf(it)
  const where = page ? `第 ${page} 页` : '页码未定位'
  const why = it.verdictReason || it.semanticReason || ''
  switch (v) {
    case 'paper-supported':
      return `${where} · 原句逐字命中，且语义复核确认支持`
    case 'excluded':
      return `${where} · ${why || '原句讲的是相关工作/基线/未来设想，未归入本文方法'}`
    case 'unlocated':
      return `${why || '引用未定位到正文'} —— 不能作为原文依据`
    case 'unsupported':
      return `${where} · ${why || '原句未支持该结论'}`
    default:
      if (it.semanticSupport === 'unchecked') return `${where} · 语义复核未执行，按未复核处理`
      if (it.semanticSupport === 'ambiguous') return `${where} · ${why || '语义支持存在歧义，需人工确认'}`
      return `${where} · ${why || '尚未通过完整校验'}`
  }
}

function StatusPill({ it }: { it: EvidenceLike }) {
  const v = verdictOf(it)
  const meta = VERDICT_META[v]
  return (
    <span className="tiny" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <Tag tone={meta.tone}>{meta.label}</Tag>
      <span className="muted-2">{statusHint(it)}</span>
    </span>
  )
}

/** 可点开的原句：点一下展开发原文与页码，再点收起。 */
function QuoteToggle({ it }: { it: EvidenceLike & { quote?: string } }) {
  const [open, setOpen] = useState(false)
  const has = Boolean(it.quote && it.quote.trim())
  return (
    <div className="stack-sm" style={{ gap: 3, marginTop: 3 }}>
      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
        <StatusPill it={it} />
        {has && (
          <button className="btn btn-sm btn-ghost" style={{ padding: '0 8px', height: 22 }} onClick={() => setOpen((o) => !o)}>
            {open ? '收起原句' : '查看原句'}
          </button>
        )}
      </div>
      {open && has && (
        <blockquote className="small" style={{ margin: 0, padding: '6px 10px', borderLeft: '2px solid var(--border)', background: 'var(--surface-2, transparent)', color: 'var(--text-2)' }}>
          {it.quote}
        </blockquote>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/** 方法地图 + 技术演进（赛题能力 2/3 · 方法自动分类 / 技术演进梳理） */
export function MapPage() {
  const { state, dispatch, collectionPapers, currentCollection, runCollectionAnalysis } = useApp()
  const navigate = useNavigate()

  /**
   * 跨页面上下文：把筛选与选中写进 URL 查询串，
   * 这样从地图跳到论文详情 / 研究方向 / 侦探再返回时（含刷新）状态都还在。
   */
  const [sp, setSp] = useSearchParams()
  const tab = (sp.get('tab') === 'timeline' ? 'timeline' : 'map') as 'map' | 'timeline'
  const famFilter = sp.get('fam')
  const mechFilter = sp.get('mech')
  const yearFilter = sp.get('year')
  const selected = sp.get('sel')
  const query = sp.get('q') ?? ''
  const compare = useMemo(() => (sp.get('cmp') ? sp.get('cmp')!.split(',').filter(Boolean).slice(0, 3) : []), [sp])
  const [scale, setScale] = useState(1)
  /** 点击连线后要高亮的连线 id（用于在详情面板定位并展开「证据与来源」） */
  const [focusRelation, setFocusRelation] = useState<string | null>(null)

  const patch = (kv: Record<string, string | null>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(kv)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setSp(next, { replace: true })
  }

  const profiles = state.methodProfiles
  const nodes = useMemo(() => buildMapNodes(collectionPapers, profiles), [collectionPapers, profiles])
  const summary = currentCollection ? collectionSummary(collectionPapers, profiles) : null
  const relations = state.relations

  const famSet = useMemo(() => Array.from(new Set(nodes.flatMap((n) => n.family))).filter(Boolean), [nodes])
  const mechSet = useMemo(() => Array.from(new Set(nodes.flatMap((n) => n.mechanisms))).filter(Boolean), [nodes])
  const yearSet = useMemo(
    () => Array.from(new Set(nodes.map((n) => n.year).filter((y): y is number => typeof y === 'number'))).sort(),
    [nodes],
  )

  const q = query.trim().toLowerCase()
  const filtered = nodes.filter((n) => {
    if (famFilter && !n.family.includes(famFilter)) return false
    if (mechFilter && !n.mechanisms.includes(mechFilter)) return false
    if (yearFilter && String(n.year ?? '') !== yearFilter) return false
    if (q && !`${n.shortLabel} ${n.title} ${n.ownMethod ?? ''} ${n.mechanisms.join(' ')}`.toLowerCase().includes(q)) return false
    return true
  })

  /** 搜索命中的节点（用于高亮，不改变布局） */
  const hits = useMemo(() => {
    if (!q) return [] as string[]
    return nodes.filter((n) => `${n.shortLabel} ${n.title} ${n.ownMethod ?? ''}`.toLowerCase().includes(q)).map((n) => n.paperId)
  }, [q, nodes])

  const timeline = useMemo(() => buildTimeline(collectionPapers, nodes), [collectionPapers, nodes])
  const evoLines = useMemo(() => evolutionSummary(collectionPapers, nodes), [collectionPapers, nodes])

  const selNode = selected ? nodes.find((n) => n.paperId === selected) ?? null : null
  // 详情面板的证据必须属于当前选中的论文：选中 id 不在本集合里时不显示面板
  const selProfile: MethodProfile | null = selNode ? profiles[selNode.paperId] ?? null : null
  const selRelations = useMemo(
    () => (selNode ? relations.filter((r) => r.from === selNode.paperId || r.to === selNode.paperId) : []),
    [relations, selNode],
  )

  if (!currentCollection) {
    return (
      <div className="page narrow">
        <header className="page-heading"><div><div className="eyebrow">METHOD MAP</div><h1>方法地图</h1><p>先建一个集合，地图才有数据。</p></div><div className="head-actions"><button className="btn btn-primary" onClick={() => navigate('/collections')}>去创建集合</button></div></header>
        <div className="empty"><span className="empty-icon"><Icon name="branch" size={20} /></span><strong>没有可分析的数据</strong><p className="small muted">在「文献集合」里导入论文后，这里会按模型家族组织方法地图。</p></div>
      </div>
    )
  }

  return (
    <div className="page" style={{ maxWidth: '100%' }}>
      <header className="page-heading">
        <div>
          <div className="eyebrow">METHOD MAP</div>
          <h1>方法地图</h1>
          <p>{currentCollection.name} · {nodes.length} 篇。按模型家族组织；未分类论文进入「待分类」，不会为了图好看而隐藏。</p>
        </div>
        <div className="head-actions">
          <button className="btn btn-sm" onClick={() => runCollectionAnalysis(currentCollection.id)}><Icon name="refresh" size={13} /> 分析方法</button>
          <button className="btn btn-sm" onClick={() => navigate('/collections')}>集合管理</button>
        </div>
      </header>

      {summary && (
        <div className="tiny muted-2">
          已分类 {summary.classified}/{summary.total} · 待确认 {summary.pending} · 家族 {summary.familyCount} · 机制 {summary.mechanismCount}
          （多标签可能重叠，计数非互斥）
        </div>
      )}

      {/* 搜索 + 筛选 + 页签 */}
      <div className="workbar">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'map'} className={tab === 'map' ? 'active' : ''} onClick={() => patch({ tab: null })}>方法地图</button>
          <button role="tab" aria-selected={tab === 'timeline'} className={tab === 'timeline' ? 'active' : ''} onClick={() => patch({ tab: 'timeline' })}>技术演进</button>
        </div>
        <div className="workbar-group">
          <span className="workbar-label">搜索</span>
          <input
            className="input"
            style={{ width: 190, height: 30 }}
            placeholder="方法名 / 标题"
            value={query}
            onChange={(e) => patch({ q: e.target.value || null })}
            aria-label="搜索论文或方法"
          />
        </div>
        <div className="workbar-group">
          <span className="workbar-label">家族</span>
          <button className={`chip${famFilter === null ? ' active' : ''}`} onClick={() => patch({ fam: null })}>全部</button>
          {famSet.map((f) => <button key={f} className={`chip${famFilter === f ? ' active' : ''}`} onClick={() => patch({ fam: famFilter === f ? null : f })}>{f}</button>)}
        </div>
        <div className="workbar-group">
          <span className="workbar-label">机制</span>
          <button className={`chip${mechFilter === null ? ' active' : ''}`} onClick={() => patch({ mech: null })}>全部</button>
          {mechSet.slice(0, 6).map((m) => <button key={m} className={`chip${mechFilter === m ? ' active' : ''}`} onClick={() => patch({ mech: mechFilter === m ? null : m })}>{m}</button>)}
        </div>
        {yearSet.length > 1 && (
          <div className="workbar-group">
            <span className="workbar-label">年份</span>
            <button className={`chip${yearFilter === null ? ' active' : ''}`} onClick={() => patch({ year: null })}>全部</button>
            {yearSet.map((y) => <button key={y} className={`chip${yearFilter === String(y) ? ' active' : ''}`} onClick={() => patch({ year: yearFilter === String(y) ? null : String(y) })}>{y}</button>)}
          </div>
        )}
        {tab === 'map' && (
          <div className="workbar-group" style={{ marginLeft: 'auto' }}>
            <span className="workbar-label">缩放</span>
            <button className="icon-btn" onClick={() => setScale((s) => Math.max(0.5, Number((s - 0.15).toFixed(2))))} aria-label="缩小"><Icon name="minus" size={14} /></button>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              aria-label="缩放比例（拖动调节）"
              title={`缩放 ${Math.round(scale * 100)}%`}
              style={{ width: 120, accentColor: 'var(--accent)' }}
            />
            <button className="icon-btn" onClick={() => setScale((s) => Math.min(2, Number((s + 0.15).toFixed(2))))} aria-label="放大"><Icon name="plus" size={14} /></button>
            <button className="icon-btn" onClick={() => setScale(1)} aria-label="适应视口"><Icon name="locate" size={14} /></button>
          </div>
        )}
      </div>

      {/* 图例 */}
      <div className="lab-legend">
        {famSet.map((f) => <span className="lab-legend-item" key={f}><i style={{ background: colorOf(f) }} />{f}</span>)}
        <span className="lab-legend-item"><i style={{ background: 'var(--text-3)' }} />实线=已确认关系 · 虚线=待确认</span>
      </div>

      {tab === 'map' ? (
        <MapSvg
          nodes={filtered}
          scale={scale}
          selected={selected}
          hits={hits}
          compare={compare}
          relations={relations}
          onSelect={(id) => patch({ sel: id })}
          onSelectRelation={(rid) => {
            const rel = relations.find((r) => r.id === rid)
            if (!rel) return
            setFocusRelation(rid)
            patch({ sel: rel.from })
          }}
          onToggleCompare={(id) => {
            const next = compare.includes(id) ? compare.filter((x) => x !== id) : [...compare, id].slice(0, 3)
            patch({ cmp: next.length ? next.join(',') : null })
          }}
          onScale={setScale}
        />
      ) : (
        <Timeline timeline={timeline} nodes={nodes} selected={selected} onSelect={(id) => patch({ sel: id })} />
      )}

      {/* 勾选对比 + 演进摘要 */}
      {tab === 'map' && compare.length > 0 && (
        <div className="dock">
          <span className="dock-count">已选 {compare.length} 篇</span>
          <span className="dock-actions">
            <button className="btn btn-sm" onClick={() => patch({ cmp: null })}>清空</button>
            <button className="btn btn-sm btn-primary" disabled={compare.length < 2} onClick={() => { dispatch({ type: 'SET_SELECT', ids: compare }); navigate('/compare') }}>进入深度比较</button>
          </span>
        </div>
      )}
      {tab === 'timeline' && (
        <div className="section">
          <div className="section-title">演进摘要（只描述本集合内观察）</div>
          <div className="tiny muted-2" style={{ marginBottom: 6 }}>
            输入范围：本集合 {collectionPapers.length} 篇；下列判断只在这批论文内成立，不作跨集合外推。
          </div>
          {evoLines.map((l, i) => <div className="small" key={i}>{l}</div>)}
        </div>
      )}

      {selNode && (
        <DetailPanel
          node={selNode}
          profile={selProfile}
          relations={selRelations}
          nodes={nodes}
          compare={compare}
          focusRelation={focusRelation}
          onClose={() => { patch({ sel: null }); setFocusRelation(null) }}
          onOpenPaper={() => navigate(`/paper/${selNode.paperId}`)}
          onOpenDirections={() => navigate('/directions')}
          onOpenDetective={() => navigate(`/paper/${selNode.paperId}?panel=detective`)}
          onPlan={() => navigate('/plan')}
          onToggleCompare={(id) => {
            const next = compare.includes(id) ? compare.filter((x) => x !== id) : [...compare, id].slice(0, 3)
            patch({ cmp: next.length ? next.join(',') : null })
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 详情面板：地图节点与时间线节点共用同一套结构                        */
/* ------------------------------------------------------------------ */

const ATTR_TEXT: Record<string, string> = {
  used: '本文采用',
  discussed: '相关工作',
  baseline: '对照基线',
  future: '未来设想',
}

function Section({ title, defaultOpen = false, children, empty }: { title: string; defaultOpen?: boolean; children?: React.ReactNode; empty?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="stack-sm" style={{ gap: 4, marginTop: 12, borderTop: '1px solid var(--divider)', paddingTop: 8 }}>
      <button
        className="row-tight"
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="context-title" style={{ margin: 0 }}>{title}</span>
        <span className="spacer" />
        <span className="tiny muted-2">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <div className="stack-sm" style={{ gap: 6 }}>
          {empty ? <div className="tiny muted-2">{empty}</div> : children}
        </div>
      )}
    </div>
  )
}

function TagRow({ tag }: { tag: ClassificationTag }) {
  const originLabel: Record<string, string> = { paper: '原文明示', inferred: '工具推断', catalog: '清单预置', manual: '人工确认' }
  const tone = tag.origin === 'paper' ? 'green' : tag.origin === 'catalog' ? 'violet' : 'blue'
  return (
    <div className="stack-sm" style={{ gap: 3, padding: '6px 0', borderBottom: '1px solid var(--divider)' }}>
      <div className="row-tight" style={{ flexWrap: 'wrap' }}>
        <Tag tone={tone}>{tag.label}</Tag>
        <span className="tiny muted-2">{originLabel[tag.origin] ?? tag.origin}</span>
        {tag.attribution && <span className="tiny muted-2">· {ATTR_TEXT[tag.attribution] ?? tag.attribution}</span>}
        {tag.manualStatus && <span className="tiny" style={{ color: 'var(--accent)' }}>人工{tag.manualStatus === 'confirmed' ? '确认' : '修改'}</span>}
      </div>
      <StatusPill it={tag as EvidenceLike} />
    </div>
  )
}

function DetailPanel({
  node,
  profile,
  relations,
  nodes,
  onClose,
  onOpenPaper,
  onOpenDirections,
  onOpenDetective,
  onPlan,
  compare,
  focusRelation,
  onToggleCompare,
}: {
  node: ReturnType<typeof buildMapNodes>[number]
  profile: MethodProfile | null
  relations: PaperRelation[]
  nodes: ReturnType<typeof buildMapNodes>
  onClose: () => void
  onOpenPaper: () => void
  onOpenDirections: () => void
  onOpenDetective: () => void
  onPlan: () => void
  compare: string[]
  focusRelation: string | null
  onToggleCompare: (id: string) => void
}) {
  // 窄屏 / 触控：面板改为整屏，避免 380px 侧栏在手机上挤爆
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 760)
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  /**
   * 挂载到悬浮窗口的工作区（顶栏下方），而不是 fixed 到窗口顶部：
   * 之前 fixed + top:0 会盖住顶栏右侧的「展开/还原」与「关闭」按钮，
   * 面板自己的头部也被顶出可视区。挂到 .focus-workspace 后面板正好从顶栏下沿开始。
   */
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setHost(document.querySelector('.focus-workspace') as HTMLElement | null)
  }, [])

  const labelOf = (id: string) => nodes.find((n) => n.paperId === id)?.shortLabel ?? id.slice(0, 8)

  const panel = (
    <aside
      className="context-pane"
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: narrow ? '100%' : 400,
        zIndex: 60,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--shadow-pop)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div className="context-head">
        <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <div className="context-title" style={{ overflowWrap: 'anywhere' }}>{node.shortLabel} · {node.title}</div>
          <div className="context-sub" style={{ overflowWrap: 'anywhere' }}>{node.year ?? '年份待确认'}{node.ownMethod ? ` · 本文方法 ${node.ownMethod}` : ''}</div>
        </div>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="关闭详情"><Icon name="close" size={15} /></button>
      </div>

      <div className="context-body" style={{ overflowY: 'auto' }}>
        {!profile ? (
          <div className="small muted">这篇还没有分析结果，先在集合里点「分析方法」。没有分析结果不等于论文没有内容。</div>
        ) : (
          <>
            {/* 默认展开：方法概览、主要贡献 */}
            <Section title="方法概览" defaultOpen>
              <div className="small">本文方法：<b>{profile.ownMethod ?? '待识别'}</b></div>
              {profile.family.length > 0 && (
                <>
                  <div className="tiny muted-2">模型家族</div>
                  {profile.family.map((f) => <TagRow key={`fam-${f.label}`} tag={f} />)}
                </>
              )}
              {profile.mechanisms.length > 0 && (
                <>
                  <div className="tiny muted-2" style={{ marginTop: 4 }}>技术机制</div>
                  {profile.mechanisms.map((f) => <TagRow key={`mech-${f.label}`} tag={f} />)}
                </>
              )}
              {profile.tasks.length > 0 && (
                <>
                  <div className="tiny muted-2" style={{ marginTop: 4 }}>研究任务</div>
                  {profile.tasks.map((f) => <TagRow key={`task-${f.label}`} tag={f} />)}
                </>
              )}
              {profile.semanticReviewRan === false && (
                <div className="tiny" style={{ color: 'var(--warn, #9a6700)' }}>
                  注意：本次分析未执行语义复核，所有标签按「工具推断」处理，不会显示为原文明示。
                </div>
              )}
            </Section>

            <Section title="主要贡献（作者声称）" defaultOpen>
              {profile.authorClaim ? (
                <div className="small">{profile.authorClaim}<div className="tiny muted-2">来自模型对正文的归纳，属工具推断</div></div>
              ) : (
                <div className="tiny muted-2">本次分析未找到作者明确表述的贡献句。这不等于作者没有报告。</div>
              )}
            </Section>

            <Section title="研究问题" defaultOpen>
              {profile.researchProblem ? (
                <div className="small">{profile.researchProblem}<div className="tiny muted-2">来自模型对正文的归纳，属工具推断</div></div>
              ) : (
                <div className="tiny muted-2">本次分析未抽出研究问题句。</div>
              )}
            </Section>

            <Section
              title="与前作的区别"
              empty={profile.differences?.length ? undefined : '本次分析未找到「与前作的区别」的原句。可能原因：相关页面未处理，或论文未明确对比。'}
            >
              {profile.differences?.map((d, i) => (
                <div className="small" key={i} style={{ paddingBottom: 6, borderBottom: '1px solid var(--divider)' }}>
                  <b>{d.target || '前作'}</b>：{d.change}
                  <QuoteToggle it={d} />
                </div>
              ))}
            </Section>

            <Section
              title="局限与未来工作"
              empty={
                (profile.limitations?.length ?? 0) + (profile.futureWork?.length ?? 0) === 0
                  ? '本次分析未找到作者明确报告的局限或未来工作。这不等于作者未报告，也可能是相关页面未被处理。'
                  : undefined
              }
            >
              {profile.limitations?.map((l, i) => (
                <div className="small" key={`l${i}`}>局限：{l.text}<QuoteToggle it={l} /></div>
              ))}
              {profile.futureWork?.map((f, i) => (
                <div className="small" key={`f${i}`}>未来工作：{f.text}<QuoteToggle it={f} /></div>
              ))}
            </Section>

            <Section
              title="证据与来源"
              defaultOpen={focusRelation !== null}
              empty={relations.length === 0 && !(profile.excluded?.length) ? '本次没有可展示的关系或排除项。' : undefined}
            >
              {profile.excluded && profile.excluded.length > 0 && (
                <div className="stack-sm" style={{ gap: 4 }}>
                  <div className="tiny muted-2">正文提到、但未归入本文方法（用于证明没有误归类）：</div>
                  {profile.excluded.map((e, i) => (
                    <div className="tiny muted-2" key={i}>
                      「{e.label}」为{ATTR_TEXT[e.attribution] ?? '相关工作'}提及，未归入本文方法
                      {e.semanticReason ? `（${e.semanticReason}）` : ''}
                    </div>
                  ))}
                </div>
              )}
              {relations.length > 0 && (
                <div className="stack-sm" style={{ gap: 4 }}>
                  <div className="tiny muted-2">与本文相关的关系（连线）：</div>
                  {relations.map((r) => {
                    const focused = focusRelation === r.id
                    const typeLabel = r.type === 'shared-mechanism' ? '共享机制（无向，不代表继承）' : r.type === 'improves' ? '改进/继承' : '引用'
                    return (
                      <div className="tiny" key={r.id} style={focused ? { background: 'var(--accent-weak, #eef6ff)', border: '1px solid var(--accent)', borderRadius: 8, padding: 6 } : undefined}>
                        <div className="row-tight" style={{ flexWrap: 'wrap' }}>
                          <Tag tone={r.review === 'confirmed' ? 'green' : 'orange'}>{r.review === 'confirmed' ? '已确认' : '待确认'}</Tag>
                          <Tag tone="plain">{typeLabel}</Tag>
                        </div>
                        <div>{r.directed ? '本文 →' : '—'} {labelOf(r.from === node.paperId ? r.to : r.from)}</div>
                        <div className="muted-2">{r.reason}</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </Section>

            <div className="row-tight" style={{ marginTop: 16, flexWrap: 'wrap', gap: 6 }}>
              <button className="btn btn-sm" onClick={onOpenPaper}>查看原文依据</button>
              <button className="btn btn-sm btn-ghost" onClick={onOpenDetective}>补查配置</button>
              <button className="btn btn-sm btn-ghost" onClick={onOpenDirections}>研究方向</button>
              <button className="btn btn-sm btn-ghost" onClick={onPlan}>生成验证计划</button>
              <button className="btn btn-sm" onClick={() => onToggleCompare(node.paperId)}>{compare.includes(node.paperId) ? '移出对比' : '加入对比'}</button>
            </div>
          </>
        )}
      </div>
    </aside>
  )

  // 首帧 host 还没探测到时不渲染，下一帧 effect 后通过 portal 挂进工作区
  return host ? createPortal(panel, host) : null
}

/* ------------------------------------------------------------------ */

function MapSvg({
  nodes,
  scale,
  selected,
  hits,
  compare,
  relations,
  onSelect,
  onSelectRelation,
  onToggleCompare,
  onScale,
}: {
  nodes: ReturnType<typeof buildMapNodes>
  scale: number
  selected: string | null
  hits: string[]
  compare: string[]
  relations: PaperRelation[]
  onSelect: (id: string) => void
  onSelectRelation: (id: string) => void
  onToggleCompare: (id: string) => void
  onScale: (s: number) => void
}) {
  // 按家族分泳道，泳道内按年份排序 —— 位置由数据决定，重渲染不会打乱
  const lanes = Array.from(new Set(nodes.map((n) => n.family[0] ?? '待分类')))
  const rows: Record<string, typeof nodes> = {}
  for (const l of lanes) rows[l] = nodes.filter((n) => (n.family[0] ?? '待分类') === l).sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
  const laneW = 210
  const nodeH = 44
  // 画布高度必须按「节点最多的泳道」计算：只按泳道数算会让靠后的节点被 viewBox 裁掉
  const maxRows = Math.max(1, ...lanes.map((l) => rows[l].length))
  const H = Math.max(360, 44 + maxRows * (nodeH + 12) + 24)
  const W = lanes.length * laneW + 40

  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const [dragging, setDragging] = useState(false)

  const posOf = (id: string) => {
    for (const l of lanes) {
      const idx = rows[l].findIndex((n) => n.paperId === id)
      if (idx >= 0) return { x: 20 + lanes.indexOf(l) * laneW + (laneW - 20) / 2, y: 44 + idx * (nodeH + 12) + nodeH / 2 }
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, moved: false }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const dx = e.clientX - drag.current.x
    const dy = e.clientY - drag.current.y
    // 超过阈值才算「拖动」，避免拖完手一抖就误开详情
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      drag.current.moved = true
      setDragging(true)
    }
    if (drag.current.moved) setPan({ x: drag.current.px + dx, y: drag.current.py + dy })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDrag = drag.current?.moved === true
    drag.current = null
    setDragging(false)
    if (wasDrag) return // 拖动收尾不触发选中
    const el = (e.target as Element).closest?.('[data-paper-id]') as HTMLElement | null
    if (el?.dataset.paperId) onSelect(el.dataset.paperId)
  }

  /** 让图上全部节点回到视口内（适应视口） */
  const fitViewport = () => {
    setPan({ x: 0, y: 0 })
    onScale(1)
  }

  return (
    <div>
      <div className="matrix-wrap" style={{ overflow: 'hidden', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', minWidth: Math.min(W, 520), height: 'auto', transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: 'top left', transition: dragging ? 'none' : 'transform 180ms' }}
          role="img"
          aria-label="方法地图：按模型家族分泳道"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { drag.current = null; setDragging(false) }}
        >
          {lanes.map((l, li) => (
            <g key={l}>
              <text x={20 + li * laneW} y={26} fontSize={13} fontWeight={600} fill={colorOf(l)}>{l}</text>
              {rows[l].map((n, ri) => {
                const x = 20 + li * laneW
                const y = 44 + ri * (nodeH + 12)
                const isSel = selected === n.paperId
                const isCmp = compare.includes(n.paperId)
                const isHit = hits.includes(n.paperId)
                return (
                  <g key={n.paperId} data-paper-id={n.paperId} style={{ cursor: 'pointer' }} onDoubleClick={() => onToggleCompare(n.paperId)}>
                    <rect
                      x={x} y={y} width={laneW - 20} height={nodeH} rx={10}
                      fill={isHit ? 'var(--warn-weak, #fff7e6)' : isSel ? 'var(--accent-weak)' : 'var(--surface)'}
                      stroke={isCmp ? 'var(--accent)' : isSel || isHit ? 'var(--accent)' : 'var(--border)'}
                      strokeWidth={isSel || isCmp ? 2 : 1}
                    />
                    <text x={x + 12} y={y + 18} fontSize={12.5} fontWeight={600} fill="var(--text)">{n.shortLabel} {n.year ?? ''}</text>
                    <text x={x + 12} y={y + 34} fontSize={10.5} fill="var(--text-2)">{n.ownMethod ?? n.title.slice(0, 22)}</text>
                    <title>{`${n.title}${n.year ? `（${n.year}）` : ''} — 单击查看详情，双击勾选对比，拖拽平移`}</title>
                  </g>
                )
              })}
            </g>
          ))}
          {/* 连线：已确认实线，待确认虚线。状态与列表完全一致 */}
          {relations.map((r) => {
            const a = posOf(r.from)
            const b = posOf(r.to)
            if (!a || !b) return null
            const confirmed = r.review === 'confirmed'
            return (
              <line
                key={r.id}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={confirmed ? 'var(--accent)' : 'var(--text-3)'}
                strokeWidth={confirmed ? 1.6 : 1}
                strokeDasharray={confirmed ? undefined : '4 4'}
                opacity={0.7}
                style={{ cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); onSelectRelation(r.id) }}
              >
                <title>{`${r.type === 'shared-mechanism' ? '共享机制' : r.type === 'improves' ? '改进/继承' : '引用'} · ${confirmed ? '已确认' : '待确认'}\n${r.reason}\n点击查看两端论文与依据`}</title>
              </line>
            )
          })}
        </svg>
      </div>
      {/* 触控 / 窄屏替代操作：不依赖拖拽也能平移与缩放 */}
      <div className="row-tight" style={{ padding: '6px 8px', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span className="tiny muted-2">拖拽平移 · 单击详情 · 双击勾选对比</span>
        <span className="spacer" style={{ flex: 1 }} />
        <div className="row-tight" style={{ gap: 2 }}>
          <button className="icon-btn" aria-label="向左平移" title="向左平移" onClick={() => setPan((p) => ({ ...p, x: p.x + 60 }))}><Icon name="arrow-left" size={13} /></button>
          <button className="icon-btn" aria-label="向右平移" title="向右平移" onClick={() => setPan((p) => ({ ...p, x: p.x - 60 }))}><Icon name="arrow-right" size={13} /></button>
          <button className="icon-btn" aria-label="向上平移" title="向上平移" onClick={() => setPan((p) => ({ ...p, y: p.y + 60 }))}><Icon name="arrow-up" size={13} /></button>
          <button className="icon-btn" aria-label="向下平移" title="向下平移" onClick={() => setPan((p) => ({ ...p, y: p.y - 60 }))}><Icon name="arrow-down" size={13} /></button>
          <button className="btn btn-sm btn-ghost" onClick={fitViewport}>适应视口</button>
        </div>
      </div>
    </div>
  )
}

function Timeline({ timeline, nodes, selected, onSelect }: { timeline: ReturnType<typeof buildTimeline>; nodes: ReturnType<typeof buildMapNodes>; selected: string | null; onSelect: (id: string) => void }) {
  const { withYear, unknown, lanes } = timeline
  const y0 = timeline.yearMin ?? 2020
  const y1 = timeline.yearMax ?? 2024
  const span = Math.max(1, y1 - y0)
  const W = 900
  const laneH = 60
  const px = (year: number) => 90 + ((year - y0) / span) * (W - 90 - 30)
  if (withYear.length === 0) return <div className="empty"><span className="small muted">年份可靠的论文不足，暂不生成时间线。</span></div>
  return (
    <div className="matrix-wrap" style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${lanes.length * laneH + 70}`} style={{ width: '100%', minWidth: 720 }} role="img" aria-label="技术演进时间线">
        {lanes.map((l, li) => {
          const y = 40 + li * laneH + laneH / 2
          return (
            <g key={l}>
              <line x1={10} y1={y} x2={W - 10} y2={y} stroke="var(--divider)" />
              <text x={10} y={y - 8} fontSize={11} fill={colorOf(l)} fontWeight={600}>{l}</text>
            </g>
          )
        })}
        {[y0, y0 + Math.round(span / 2), y1].map((yr) => (
          <text key={yr} x={px(yr)} y={28} fontSize={11} fill="var(--text-3)" textAnchor="middle">{yr}</text>
        ))}
        {withYear.map((n, i) => {
          const lane = n.family[0] ?? '待分类'
          const li = Math.max(0, lanes.indexOf(lane))
          const x = px(n.year ?? y0)
          const y = 40 + li * laneH + laneH / 2 + (i % 2 === 0 ? -8 : 8)
          return (
            <g key={n.paperId} style={{ cursor: 'pointer' }} onClick={() => onSelect(n.paperId)}>
              <circle cx={x} cy={y} r={7} fill={colorOf(lane)} stroke={selected === n.paperId ? 'var(--text)' : 'var(--surface)'} strokeWidth={2} />
              <text x={x + 12} y={y + 4} fontSize={11} fill="var(--text)">{n.shortLabel} {n.ownMethod ? `· ${n.ownMethod}` : ''}</text>
              <title>{`${n.title}（${n.year}）— 单击查看同一套技术档案详情`}</title>
            </g>
          )
        })}
        {unknown.length > 0 && (
          <g>
            <text x={10} y={lanes.length * laneH + 52} fontSize={11} fill="var(--text-3)" fontWeight={600}>年份待确认（{unknown.length} 篇）</text>
            <text x={10} y={lanes.length * laneH + 68} fontSize={11} fill="var(--text-2)">{unknown.map((n) => n.shortLabel).join('、')}</text>
          </g>
        )}
      </svg>
      <div className="tiny muted-2" style={{ padding: 8 }}>同一年的论文已错位避免重叠；年份来自可靠元信息或人工确认，文件名只作待确认线索。单击节点打开与地图相同的技术档案面板。</div>
    </div>
  )
}
