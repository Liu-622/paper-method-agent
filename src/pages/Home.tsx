import { useNavigate } from 'react-router-dom'
import type { MouseEvent } from 'react'
import { useApp } from '@/store/AppStore'
import { Buddy } from '@/components/Buddy'
import { Icon } from '@/components/Icons'

const ROOMS = [
  { id: 'collections', number: '01', title: '文献集合', desc: '一次收进十余篇，批量解析、自动分类。', to: '/collections', kind: 'paper', meta: 'READ & DISCOVER' },
  { id: 'map', number: '02', title: '方法地图', desc: '看清方法家族、技术机制与演进。', to: '/map', kind: 'compare', meta: 'CONNECT THE DOTS' },
  { id: 'directions', number: '03', title: '研究方向', desc: '证据驱动的建议，每一个都能追溯。', to: '/directions', kind: 'notes', meta: 'ONE STEP FURTHER' },
  { id: 'lab', number: '04', title: '小咕实验室', desc: '动手一次，让结论自己说话。', to: '/lab?family=paper-linear&challenge=1', kind: 'lab', meta: 'MAKE IT REAL' },
] as const

/** Decorative paper/diagram objects, not experimental results or source evidence. */
function RoomArt({ kind }: { kind: typeof ROOMS[number]['kind'] }) {
  if (kind === 'paper') return <div className="room-art paper-art" aria-hidden="true">
    <div className="paper-object paper-object-back"><i /><i /><i /></div>
    <div className="paper-object paper-object-front"><span className="paper-symbol"><Icon name="file-text" size={25} /></span><b /><i /><i /><i /><div className="paper-mini-blocks"><span /><span /><span /></div></div>
    <span className="paper-bookmark" />
  </div>
  if (kind === 'compare') return <div className="room-art compare-art" aria-hidden="true">
    <div className="comparison-orbit orbit-a" /><div className="comparison-orbit orbit-b" />
    <div className="comparison-node"><Icon name="compare" size={25} /></div>
    <span className="orbit-dot dot-a" /><span className="orbit-dot dot-b" />
  </div>
  if (kind === 'lab') return <div className="room-art lab-art" aria-hidden="true">
    <div className="lab-orbit lab-orbit-one" /><div className="lab-orbit lab-orbit-two" />
    <div className="lab-sphere"><Icon name="lab" size={50} strokeWidth={1.05} /></div>
    <span className="lab-dot" />
  </div>
  return <div className="room-art notes-art" aria-hidden="true">
    <div className="note-object"><span className="note-binding" /><div className="note-line"><span className="note-tick"><Icon name="check" size={13} /></span><i /></div><div className="note-line"><span className="note-tick"><Icon name="check" size={13} /></span><i /></div><div className="note-line"><span /><i /></div></div>
    <div className="note-pencil" />
  </div>
}

export function HomePage({ onSettings, onSearch }: { onSettings?: () => void; onSearch?: () => void }) {
  const navigate = useNavigate()
  const { state, scopedPapers, loadDemo, switchScope } = useApp()
  const enter = (event: MouseEvent<HTMLButtonElement>, to: string, tile: string) => {
    const rect = event.currentTarget.getBoundingClientRect()
    navigate(to, { state: { roomOrigin: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, roomTile: tile } })
  }
  return <div className="gallery-home">
    <header className="gallery-header">
      <a className="gallery-brand" href="#/" onClick={(e) => { e.preventDefault(); navigate('/') }} aria-label="小咕研究室首页"><Buddy px={41} blink={false} /><span>小咕<span className="brand-separator">/</span><span className="brand-caption">研究室</span></span></a>
      <nav className="gallery-nav" aria-label="首页导航">
        <button className="gallery-nav-current" aria-current="page">研究空间</button>
        <button onClick={() => navigate('/qa')}>问小咕</button>
        <span className="gallery-nav-divider" />
        <button className="gallery-icon-button" onClick={onSearch} aria-label="搜索论文或功能" title="搜索 · Ctrl K"><Icon name="search" size={18} /></button>
        <button className="gallery-icon-button" onClick={onSettings} aria-label="运行设置" title="运行设置"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="2.5" fill="currentColor" stroke="none"/></svg></button>
      </nav>
    </header>

    <main className="gallery-content">
      <section className="gallery-intro" aria-labelledby="gallery-title">
        <div className="gallery-eyebrow"><span /> A LITTLE SPACE FOR BIG IDEAS</div>
        <h1 id="gallery-title">让好奇，成为发现</h1>
        <p>读论文，找线索，亲手验证。打开一个空间，从这里开始。</p>
      </section>
      <section className="room-grid" aria-label="选择一个研究空间">
        {ROOMS.map(room => <button key={room.id} data-room-tile={room.id} className={`room-card room-${room.kind}`} onClick={event => enter(event, room.to, room.id)} aria-label={`打开${room.title}`} aria-haspopup="dialog">
          <span className="room-number">{room.number}<span> / {room.meta}</span></span>
          <RoomArt kind={room.kind} />
          <span className="room-copy"><span className="room-title">{room.title}</span><span className="room-description">{room.desc}</span></span>
          <span className="room-enter" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>
        </button>)}
      </section>
      <footer className="gallery-footer">
        <span>{state.scope === 'demo' ? '示例空间 · 虚构演示数据' : scopedPapers.length ? `我的空间 · ${scopedPapers.length} 篇论文` : '你的下一次发现，从一篇论文开始。'}</span>
        <button onClick={() => { if (!state.demoLoaded) loadDemo(); else switchScope('demo'); navigate('/library') }}>浏览示例<span className="gallery-demo-note">（虚构数据）</span><Icon name="chevron-right" size={13} /></button>
      </footer>
    </main>
  </div>
}
