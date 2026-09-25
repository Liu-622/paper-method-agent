import { useEffect, useRef } from 'react'
import { useDialogFocus } from './useDialogFocus'

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认删除',
  cancelText = '取消',
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: React.ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const panelRef = useDialogFocus(open, onCancel)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onCancel} role="presentation">
      <div
        className="modal"
        ref={panelRef as React.RefObject<HTMLDivElement>}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        <div className="muted small">{message}</div>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            ref={confirmRef}
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
