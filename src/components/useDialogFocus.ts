import { useEffect, useRef } from 'react'

/** Keyboard containment, Escape and focus return for a modal surface. */
export function useDialogFocus(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLElement | null>(null)
  const callback = useRef(onClose)
  callback.current = onClose
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const frame = requestAnimationFrame(() => {
      const first = panel.current?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex="0"]')
      ;(first ?? panel.current)?.focus()
    })
    const keydown = (e: KeyboardEvent) => {
      const el = panel.current
      if (!el || !el.contains(document.activeElement)) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); callback.current() }
      if (e.key !== 'Tab') return
      const targets = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(x => x.getClientRects().length)
      const first = targets[0], last = targets[targets.length - 1]
      if (!first) { e.preventDefault(); el.focus(); return }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus() }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', keydown, true)
      document.body.style.overflow = previousOverflow
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  return panel
}
