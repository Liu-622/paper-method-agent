import { useEffect, useRef, useState } from 'react'
import { useApp } from '@/store/AppStore'
import { FIELD_META } from '@/data/fieldSchema'
import { fieldDisplayState } from '@/services/checks'
import type { Evidence, FieldKey } from '@/types'
import { Tag } from './StatusTag'
import { Icon } from './Icons'
import { Buddy } from './Buddy'

/**
 * 证据面板（右侧抽屉）
 * ------------------------------------------------------------------
 * · 从比较项/字段/摘要打开后，**可以在同一面板里切换论文**；
 * · 每篇显示自己的取值、页码、原文与支持状态；**缺证据就说明缺口，不借用别的论文的证据**；
 * · 支持复制原文、复制定位信息、对这一项做真实补查（POST /api/recheck-field）；
 * · Esc 关闭、焦点回到打开它的元素；关闭后页面位置与筛选不受影响（抽屉是浮层，不卸载页面）。
 */
export function EvidenceDrawer() {
  const { state, dispatch, selectedPapers, recheckOneField, toast } = useApp()
  const drawer = state.evidenceDrawer
  const [activePaperId, setActivePaperId] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // 关闭后把焦点还给打开抽屉的那个元素
  useEffect(() => {
    if (drawer.open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null
      requestAnimationFrame(() => panelRef.current?.focus())
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current.focus?.()
      restoreFocusRef.current = null
    }
  }, [drawer.open])

  // Esc 关闭
  useEffect(() => {
    if (!drawer.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dispatch({ type: 'CLOSE_EVIDENCE' })
      }
      // 焦点限制在面板内（Tab 循环）
      if (e.key === 'Tab' && panelRef.current) {
        const nodes = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )
        if (nodes.length === 0) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawer.open, dispatch])

  useEffect(() => {
    if (!drawer.open) return
    // 默认选中"打开抽屉时那篇论文"，否则第一篇已选论文
    const hit = state.papers.find((p) => drawer.title.startsWith(p.shortLabel + ' ·'))
    setActivePaperId(hit?.id ?? selectedPapers[0]?.id ?? null)
    // 只在打开时重置一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer.open, drawer.title, drawer.subtitle])

  if (!drawer.open) return null

  const close = () => dispatch({ type: 'CLOSE_EVIDENCE' })
  const key = (Object.entries(FIELD_META) as [FieldKey, { label: string }][]).find(
    ([, m]) => m.label === drawer.subtitle,
  )?.[0]

  const sourcePaper = state.papers.find(p => drawer.title.startsWith(p.shortLabel + ' ·'))
  const candidates = sourcePaper && !selectedPapers.some(p => p.id === sourcePaper.id) ? [sourcePaper] : selectedPapers
  const switchable = Boolean(key) && candidates.length > 0
  const paper = switchable ? candidates.find((p) => p.id === activePaperId) ?? candidates[0] : undefined
  const field = key && paper ? paper.fields[key] : undefined
  const state4 = key && paper ? fieldDisplayState(paper, key) : null

  // 有可切换的论文与字段时，按当前论文重建证据；否则用打开时传入的片段（问答引用走这条路）
  const paperItems = field
    ? field.evidenceIds.map((id) => state.evidence.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => Boolean(e))
    : []
  const items = switchable ? paperItems : drawer.items
  const unresolved = switchable ? [] : drawer.unresolvedIds
  const hasAny = items.length > 0
  const allDemo = hasAny && items.every((e) => e.source === 'demo')

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast('success', `${label}已复制`, '可以直接粘贴到笔记或 PDF 阅读器里。')
    } catch {
      toast('warning', '复制没有成功', '浏览器拒绝了剪贴板访问，可以手动选中这段原文复制。')
    }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={close} role="presentation" />
      <aside
        className="drawer evidence-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="原文依据"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              原文依据
              {allDemo && <Tag tone="violet">演示片段</Tag>}
            </h3>
            <div className="small muted" style={{ wordBreak: 'break-word' }}>
              {paper ? `${paper.shortLabel} · ${paper.title}` : drawer.title}
            </div>
            <div className="tiny muted-2">
              {drawer.subtitle}
              {paper && <span>｜共 {paper.pageCount ?? '—'} 页</span>}
            </div>
          </div>
          <button className="drawer-close" onClick={close} aria-label="关闭依据面板（Esc）" title="关闭（Esc）">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="drawer-body">
          {/* 同一面板内切换论文 */}
          {switchable && (
            <div className="evidence-switch" role="tablist" aria-label="切换论文">
              {candidates.map((p, i) => {
                const has = key ? (p.fields[key]?.evidenceIds?.length ?? 0) > 0 : false
                return (
                  <button
                    key={p.id}
                    role="tab"
                    aria-selected={p.id === paper?.id}
                    className={p.id === paper?.id ? 'active' : ''}
                    onClick={() => setActivePaperId(p.id)}
                    title={has ? '这篇有原文片段' : '这篇在这一项上没有原文片段'}
                  >
                    {p.shortLabel}
                    {!has && ' · 无片段'}
                  </button>
                )
              })}
            </div>
          )}

          {paper && key && (
            <div className="row-tight" style={{ marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
              {state4 && <Tag tone="slate">{state4.label}</Tag>}
              <span className="tiny muted-2" title={state4?.hint}>
                这篇的取值：
              </span>
              <span className="small strong">
                {field?.value ? String(field.value) : '本次未读到明确取值'}
              </span>
            </div>
          )}

          {drawer.note && (
            <div className="banner banner-info" style={{ marginBottom: 12 }}>
              <div>{drawer.note}</div>
            </div>
          )}

          {!hasAny ? (
            <div className="banner banner-info">
              <div>
                <strong>
                  {paper ? `${paper.shortLabel} 在这一项上没有找到对应的原文片段。` : '这一项没有找到对应的原文片段。'}
                </strong>
                <div style={{ marginTop: 6 }}>
                  这只说明当前材料里没有读到，<strong>不代表论文有错误</strong>；也不会拿别的论文的片段来顶替。
                  可以在下方对这一项做一次定向补查，或到论文里人工确认后在实验检查页补充（会标注为「人工补充」）。
                  {unresolved.length > 0 && (
                    <div style={{ marginTop: 6 }} className="tiny">
                      失效片段编号：{unresolved.join('、')}（可能来自已被重新解析的论文）
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="tiny muted-2" style={{ marginBottom: 10 }}>
                共 {items.length} 条片段 · 页码对应 PDF 页序号
              </div>
              {items.map((ev) => (
                <div className="evidence-card" key={ev.id + ev.page}>
                  <div className="evidence-meta">
                    <span className="page-badge">第 {ev.page} 页</span>
                    <span className="tag tag-plain">{ev.section}</span>
                    {ev.source === 'pdf' && <Tag tone="green">PDF 原文</Tag>}
                    {ev.source === 'demo' && <Tag tone="violet">演示数据</Tag>}
                    {ev.source === 'manual' && <Tag tone="blue">人工补充</Tag>}
                  </div>
                  <div className="evidence-quote">{ev.text}</div>
                  {ev.gloss && (
                    <div className="evidence-gloss">
                      <b>速览：</b>
                      {ev.gloss}
                    </div>
                  )}
                  <div className="row-tight" style={{ marginTop: 6, gap: 4 }}>
                    <button className="evidence-btn" onClick={() => copy(ev.text, '原文')}>
                      <Icon name="copy" size={13} /> 复制原文
                    </button>
                    <button
                      className="evidence-btn"
                      title="复制「论文短名 + 页码」，可直接粘贴到 PDF 阅读器的搜索框定位"
                      onClick={() =>
                        copy(
                          `${paper ? paper.shortLabel : drawer.title} · 第 ${ev.page} 页`,
                          '定位信息',
                        )
                      }
                    >
                      <Icon name="locate" size={13} /> 复制定位信息
                    </button>
                  </div>
                </div>
              ))}
              {allDemo && (
                <div className="banner banner-demo" style={{ marginTop: 6 }}>
                  <div>这些片段来自示例项目的虚构论文，不是真实论文内容，仅用于演示交互。</div>
                </div>
              )}
            </>
          )}

          {/* 这一项的真实补查 */}
          {paper && key && (
            <div className="row-tight" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-sm"
                disabled={rechecking}
                title="只对这一项做定向全文检索与引用校验（不会重跑整篇，也不会覆盖人工修改）"
                onClick={async () => {
                  if (rechecking) return
                  setRechecking(true)
                  try {
                    await recheckOneField(paper, key)
                  } finally {
                    setRechecking(false)
                  }
                }}
              >
                <Icon name="refresh" size={14} /> {rechecking ? '正在补查这一项…' : '补查这一项'}
              </button>
              <span className="tiny muted-2">补查结果会就地更新，失败或没找到时保留原取值。</span>
            </div>
          )}

          {!switchable && (
            <div className="row-tight" style={{ marginTop: 12 }}>
              <Buddy size="xs" px={26} title="小咕" />
              <span className="tiny muted-2">这条依据来自问答引用，可以复制原文核对。</span>
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

/**
 * 证据列表（供右侧上下文面板复用）：
 * 只负责「页码 + 原文 + 中文释义 + 来源状态」，不带抽屉外壳
 */
export function EvidenceList({
  items,
  unresolvedIds,
  note,
}: {
  items: Evidence[]
  unresolvedIds: string[]
  note?: string
}) {
  return (
    <div className="stack-sm">
      {note && <div className="banner banner-info">{note}</div>}
      {items.map((e) => (
        <div className="evidence-card" key={e.id}>
          <div className="evidence-meta">
            <span className="page-badge">P{e.page}</span>
            {e.section && <span className="tiny muted-2">{e.section}</span>}
            {e.source === 'demo' && <Tag tone="violet">演示片段</Tag>}
            {e.source === 'manual' && <Tag tone="blue">人工补充</Tag>}
          </div>
          <div className="evidence-quote">{e.text}</div>
          {e.gloss && <div className="evidence-gloss">{e.gloss}</div>}
        </div>
      ))}
      {unresolvedIds.length > 0 && (
        <div className="banner banner-warn">
          <Icon name="alert" size={14} className="banner-icon" />
          <div>
            有 {unresolvedIds.length} 条引用没有定位到本地正文（可能正文未解析或页码未修正）。
            可以在论文详情里对相关字段点「补查」重新定向检索。
          </div>
        </div>
      )}
      {items.length === 0 && unresolvedIds.length === 0 && <div className="tiny muted-2">这一项没有可展示的原文片段。</div>}
    </div>
  )
}
