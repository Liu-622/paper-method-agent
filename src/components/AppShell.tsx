import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useApp, MAX_SELECTION } from '@/store/AppStore'
import { EvidenceDrawer, EvidenceList } from './EvidenceDrawer'
import { Toasts } from './Toasts'
import { ConfirmDialog } from './ConfirmDialog'
import { APP_NAME, APP_SUBTITLE } from '@/config'
import { Tag } from './StatusTag'
import { Icon, type IconName } from './Icons'
import { BuddyBrand } from './Buddy'
import { DockBar } from './DockBar'
import { ResearchAssistant } from './ResearchAssistant'
import { CommandPalette } from './CommandPalette'
import { getAccessToken, getBackendUrl, setAccessToken, setBackendUrl } from '@/services/api'
import { RunSettings } from './RunSettings'
import { DetectivePanel } from './DetectivePanel'
import { FocusFrame } from './FocusFrame'

const NAV: { to: string; label: string; icon: IconName; end: boolean }[] = [
  { to: '/', label: '首页', icon: 'home', end: true },
  { to: '/collections', label: '文献集合', icon: 'library', end: false },
  { to: '/map', label: '方法地图', icon: 'branch', end: false },
  { to: '/directions', label: '研究方向', icon: 'sparkle', end: false },
  { to: '/compare', label: '方法对比', icon: 'compare', end: false },
  { to: '/check', label: '实验检查', icon: 'check', end: false },
  { to: '/plan', label: '验证计划', icon: 'plan', end: false },
  { to: '/lab', label: '小咕实验室', icon: 'lab', end: false },
  { to: '/qa', label: '论文问答', icon: 'qa', end: false },
]

const COLLAPSE_KEY = 'paper-repro-guard.ui.sidebar-collapsed'

/** 宽屏判定：≥1181px 时右侧上下文面板与主区并排，否则改为抽屉 */
function useDockedContext() {
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 1520px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1520px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

export function AppShell() {
  const { state, dispatch, scopedPapers, loadDemo, switchScope, resetAll, toast } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const [confirmReset, setConfirmReset] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [paneTab, setPaneTab] = useState<'evidence' | 'detective'>('evidence')
  const docked = useDockedContext()

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    } catch {
      /* 忽略存储失败 */
    }
  }, [collapsed])

  // Ctrl/Cmd+K 打开快捷操作面板；输入框内不触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (typing) return
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 字段行/观点卡的「找线索」事件：统一在这里进入右侧上下文面板
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { paperId?: string; fieldKey?: string; from?: string } | undefined
      if (!detail?.fieldKey) return
      const pid = detail.paperId ?? state.papers.find((p) => p.id === location.pathname.split('/')[2])?.id
      if (!pid) {
        toast('warning', '先打开一篇论文', '侦探需要知道在哪篇论文里找线索。')
        return
      }
      dispatch({ type: 'OPEN_DETECTIVE', ctx: { paperId: pid, fieldKey: detail.fieldKey, from: detail.from } })
      setPaneTab('detective')
    }
    window.addEventListener('open-detective', onOpen)
    return () => window.removeEventListener('open-detective', onOpen)
  }, [dispatch, location.pathname, state.papers, toast])

  const isDemo = state.scope === 'demo'
  const selectedCount = state.selectedIds.length
  const backendOk = state.backend.status === 'ok' && Boolean(state.backend.health?.hasCredentials)

  const currentPaper = location.pathname.startsWith('/paper/')
    ? state.papers.find((p) => p.id === location.pathname.split('/')[2])
    : undefined

  const crumbMap: Record<string, string> = {
    '/': '首页',
    '/library': '论文库',
    '/collections': '文献集合',
    '/map': '方法地图',
    '/directions': '研究方向',
    '/compare': '方法对比',
    '/check': '实验检查',
    '/qa': '论文问答',
    '/plan': '验证计划',
    '/lab': '小咕实验室',
  }

  const paneOpen = state.evidenceDrawer.open || Boolean(state.detective)

  const closePane = useCallback(() => {
    dispatch({ type: 'CLOSE_EVIDENCE' })
    dispatch({ type: 'CLOSE_DETECTIVE' })
  }, [dispatch])

  useEffect(() => {
    if (!paneOpen || settingsOpen || paletteOpen || confirmReset) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closePane() }
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [paneOpen, settingsOpen, paletteOpen, confirmReset, closePane])

  // 打开证据时自动切到证据页签；只开侦探时切到侦探页签
  useEffect(() => {
    if (state.evidenceDrawer.open) setPaneTab('evidence')
  }, [state.evidenceDrawer.open])
  useEffect(() => {
    if (state.detective) setPaneTab('detective')
  }, [state.detective])

  const detPaper = state.detective ? state.papers.find((p) => p.id === state.detective?.paperId) : undefined

  return (
    <>
    <FocusFrame onSettings={() => setSettingsOpen(true)} onSearch={() => setPaletteOpen(true)} overlayOpen={paneOpen || settingsOpen || paletteOpen || confirmReset} onCloseContext={closePane}>
    <div className={`app-shell${collapsed ? ' collapsed' : ''}${paneOpen && docked ? ' with-context' : ''}`}>
      {/* ---------------- 左侧导航 ---------------- */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BuddyBrand subtitle={APP_SUBTITLE || APP_NAME} />
          <button
            className="icon-btn sidebar-collapse"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? '展开导航' : '收起导航'}
            aria-label={collapsed ? '展开导航' : '收起导航'}
            aria-expanded={!collapsed}
          >
            <Icon name={collapsed ? 'panel-right' : 'panel-left'} size={15} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <div className="nav-section-label">研究工作台</div>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              title={item.label}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon name={item.icon} size={17} />
              </span>
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}

          <div className="nav-section-label">工作空间</div>
          <div className="seg" role="tablist" aria-label="工作空间">
            <button
              role="tab"
              aria-selected={isDemo}
              className={isDemo ? 'active' : ''}
              onClick={() => {
                if (!state.demoLoaded) loadDemo()
                else switchScope('demo')
              }}
              title="打开预置的示例项目（虚构演示数据）"
            >
              示例
            </button>
            <button
              role="tab"
              aria-selected={!isDemo}
              className={!isDemo ? 'active' : ''}
              onClick={() => switchScope('user')}
              title="查看自己上传的论文"
            >
              我的
            </button>
          </div>
          <div className="sidebar-note">
            {scopedPapers.length} 篇论文 · {isDemo ? '示例项目（虚构数据）' : '数据保存在本机浏览器'}
          </div>
        </nav>

        <div className="sidebar-foot">
          <button className="sidebar-status" onClick={() => setSettingsOpen(true)} title="打开运行设置">
            <span className={`status-dot ${backendOk ? 'ok' : state.backend.status === 'checking' ? '' : 'warn'}`} />
            <span>{backendOk ? '模型已连接' : state.backend.status === 'checking' ? '检测中…' : '模型未连接'}</span>
            <span className="spacer" />
            <span className="tiny muted-2">设置</span>
          </button>
        </div>
      </aside>

      {/* ---------------- 中央工作区 ---------------- */}
      <div className="main">
        <header className="topbar">
          <nav className="breadcrumb" aria-label="位置">
            {currentPaper ? (
              <>
                <NavLink to="/library">论文库</NavLink>
                <span className="sep">/</span>
                <span className="current nowrap" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {currentPaper.shortLabel} · {currentPaper.title}
                </span>
              </>
            ) : (
              <>
                <span className="muted-2">{isDemo ? '示例项目' : '我的论文库'}</span>
                <span className="sep">/</span>
                <span className="current">{crumbMap[location.pathname] ?? '页面'}</span>
              </>
            )}
          </nav>

          <div className="topbar-actions">
            <select className="focus-scope-select" aria-label="选择工作空间" value={isDemo ? 'demo' : 'user'} onChange={e => {
              if (e.target.value === 'demo') { if (!state.demoLoaded) loadDemo(); else switchScope('demo') }
              else switchScope('user')
            }}><option value="user">我的论文</option><option value="demo">示例 · 虚构数据</option></select>
            {isDemo && <Tag tone="violet">演示数据</Tag>}
            <button className="topbar-search" onClick={() => setPaletteOpen(true)} title="搜索论文、页面、操作（Ctrl/Cmd + K）">
              <Icon name="search" size={14} />
              <span>搜索论文、页面或操作</span>
              <span className="kbd">Ctrl K</span>
            </button>
            {selectedCount > 0 && <Tag tone="blue">已选 {selectedCount}/{MAX_SELECTION}</Tag>}
            {paneOpen && !docked && (
              <button className="icon-btn" onClick={closePane} title="关闭右侧面板" aria-label="关闭右侧面板">
                <Icon name="close" size={15} />
              </button>
            )}
          </div>
        </header>

        <Outlet />
      </div>

      {/* ---------------- 右侧上下文面板（宽屏并排 / 窄屏抽屉） ---------------- */}
      {paneOpen && (docked || Boolean(state.detective)) && (
        <aside className="context-pane" aria-label="上下文面板">
          <div className="context-head">
            <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
              <div className="context-title nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {paneTab === 'detective'
                  ? `找线索：${detPaper?.shortLabel ?? ''}`
                  : state.evidenceDrawer.title || '原文依据'}
              </div>
              <div className="context-sub">上下文跟随当前选择，不会遮挡主区</div>
            </div>
            <span className="spacer" />
            <button className="icon-btn" onClick={closePane} title="关闭面板" aria-label="关闭面板">
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className="context-tabs" role="tablist" aria-label="上下文面板内容">
            <button
              role="tab"
              aria-selected={paneTab === 'evidence'}
              className={`context-tab${paneTab === 'evidence' ? ' active' : ''}`}
              onClick={() => setPaneTab('evidence')}
            >
              原文依据
            </button>
            <button
              role="tab"
              aria-selected={paneTab === 'detective'}
              className={`context-tab${paneTab === 'detective' ? ' active' : ''}`}
              onClick={() => setPaneTab('detective')}
              disabled={!state.detective}
              title={state.detective ? undefined : '在论文详情里对任意字段点「找线索」'}
            >
              找线索
            </button>
          </div>
          <div className="context-body">
            {paneTab === 'detective' && detPaper && state.detective ? (
              <DetectivePanel
                bordered={false}
                paperId={detPaper.id}
                pages={(state.texts[detPaper.id] ?? []).map((t) => ({ page: t.page, text: t.text }))}
                dataset={
                  detPaper.fields.dataset?.value
                    ? String(detPaper.fields.dataset.value).split(/[、,，;；/]/)[0].trim()
                    : null
                }
                model={detPaper.fields.method?.value ? String(detPaper.fields.method.value).slice(0, 40) : null}
                horizon={(() => {
                  const m = String(detPaper.fields.horizon?.value ?? '').match(/\d+/)
                  return m ? Number(m[0]) : null
                })()}
                fieldValueOf={(k: string) => {
                  const f = detPaper.fields[k as keyof typeof detPaper.fields]
                  return f?.value !== undefined && f?.value !== null ? String(f.value) : null
                }}
                focusField={state.detective.fieldKey}
                from={state.detective.from}
                onClose={closePane}
                toast={toast}
              />
            ) : (
              <div className="stack">
                <div className="stack-sm">
                  <div className="context-title">{state.evidenceDrawer.title || '还没有选择依据'}</div>
                  <div className="context-sub">{state.evidenceDrawer.subtitle}</div>
                </div>
                <EvidenceList
                  items={state.evidenceDrawer.items}
                  unresolvedIds={state.evidenceDrawer.unresolvedIds}
                  note={state.evidenceDrawer.note}
                />
                {state.evidenceDrawer.items.length === 0 && (
                  <div className="tiny muted-2">
                    在论文详情里点字段的「核对原文」，或在对比/检查页点「查看证据」，这里会显示对应的原文片段。
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      )}

    </div>
    </FocusFrame>
      {location.pathname !== '/' && !docked && !state.detective && <EvidenceDrawer />}
      <Toasts />
      {location.pathname !== '/' && <DockBar />}
      {location.pathname !== '/' && <ResearchAssistant />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      <RunSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialUrl={getBackendUrl()}
        initialToken={getAccessToken()}
        onSave={(url, token) => {
          setBackendUrl(url)
          setAccessToken(token)
        }}
        onReset={() => setConfirmReset(true)}
      />

      <ConfirmDialog
        open={confirmReset}
        title="重置本地数据？"
        message={
          <>
            将清空：上传记录、本地保存的原文件、解析出的正文、字段抽取结果、人工补充、论文选择、问答历史。
            <br />
            演示项目的 3 篇论文会重新变为未加载状态。此操作不可撤销。
          </>
        }
        confirmText="确认重置"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          resetAll()
          setConfirmReset(false)
          navigate('/')
        }}
      />
    </>
  )
}
