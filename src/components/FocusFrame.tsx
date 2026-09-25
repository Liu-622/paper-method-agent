import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { HomePage } from '@/pages/Home'
import { Icon } from './Icons'

type Origin = { x: number; y: number; width: number; height: number }
const SPACE_NAMES: Record<string, string> = { library: '论文书房', paper: '论文书房', collections: '文献集合', map: '方法地图', directions: '研究方向', compare: '发现差异', check: '实验检查', lab: '小咕实验室', plan: '研究笔记', qa: '问小咕' }

/** The gallery is the persistent backdrop; every working page opens in one floating space. */
export function FocusFrame({ children, onSettings, onSearch, overlayOpen, onCloseContext }: {
  children: ReactNode; onSettings: () => void; onSearch: () => void; overlayOpen: boolean; onCloseContext: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const open = location.pathname !== '/'
  const [expanded, setExpanded] = useState(false)
  const [closing, setClosing] = useState(false)
  const gallery = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const origin = useRef<Origin | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const animation = useRef<Animation | null>(null)
  const closeTimer = useRef<number | null>(null)
  const title = SPACE_NAMES[location.pathname.split('/')[1]] ?? '研究空间'

  const close = useCallback(() => {
    if (closing) return
    onCloseContext()
    setClosing(true)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    closeTimer.current = window.setTimeout(() => { navigate('/'); setClosing(false) }, reduced ? 0 : 190)
  }, [closing, navigate, onCloseContext])

  useLayoutEffect(() => {
    if (open && gallery.current?.contains(document.activeElement)) {
      opener.current = document.activeElement as HTMLElement
    }
    gallery.current?.toggleAttribute('inert', open)
    if (!open) {
      setExpanded(false)
      opener.current?.focus({ preventScroll: true })
      return
    }
    origin.current = (location.state as { roomOrigin?: Origin } | null)?.roomOrigin ?? null
    closeButton.current?.focus({ preventScroll: true })
    const element = sheet.current
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dest = element.getBoundingClientRect()
    const source = origin.current
    const start = source
      ? `translate(${source.x + source.width / 2 - dest.x - dest.width / 2}px, ${source.y + source.height / 2 - dest.y - dest.height / 2}px) scale(${source.width / dest.width}, ${source.height / dest.height})`
      : 'translateY(22px) scale(.96)'
    animation.current = element.animate([
      { transform: start, opacity: .2 },
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    ], { duration: 460, easing: 'cubic-bezier(.22, 1, .36, 1)' })
    return () => { animation.current?.cancel() }
    // Animate only when a space opens, not on navigation inside the space.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = oldOverflow }
  }, [open])

  useEffect(() => {
    const scroller = sheet.current?.querySelector('.main')
    scroller?.scrollTo({ top: 0, behavior: 'auto' })
  }, [location.pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (overlayOpen || event.defaultPrevented) return
      const otherDialog = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
        .some(el => el !== sheet.current && el.getClientRects().length > 0)
      if (otherDialog) return
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab') return
      const controls = Array.from(sheet.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? [])
        .filter(el => el.getClientRects().length > 0)
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, overlayOpen])
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current) }, [])

  return <div className={`focus-app${open ? ' has-open-space' : ''}`}>
    <div ref={gallery} className="gallery-backdrop" aria-hidden={open || undefined}><HomePage onSettings={onSettings} onSearch={onSearch} /></div>
    {open && <>
      <div className={`focus-shade${closing ? ' is-closing' : ''}`} onClick={close} aria-hidden="true" />
      <div ref={sheet} className={`focus-sheet${expanded ? ' is-expanded' : ''}${closing ? ' is-closing' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="focus-chrome">
          <button className="focus-home-button" onClick={close} title="回到研究空间"><Icon name="arrow-left" size={16} /><span>研究空间</span></button>
          <span className="focus-window-name">{title}</span>
          <div className="focus-window-controls">
            <button className="focus-control" onClick={() => setExpanded(value => !value)} aria-label={expanded ? '恢复悬浮窗口' : '展开工作区'} title={expanded ? '恢复悬浮窗口' : '展开工作区'}><Icon name={expanded ? 'shrink' : 'expand'} size={15} /></button>
            <button ref={closeButton} className="focus-control focus-close" onClick={close} aria-label="关闭研究空间" title="关闭 · Esc"><Icon name="close" size={18} /></button>
          </div>
        </header>
        <div className="focus-workspace">{children}</div>
      </div>
    </>}
  </div>
}
