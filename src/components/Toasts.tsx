import { useApp } from '@/store/AppStore'

export function Toasts() {
  const { state, dispatch } = useApp()
  if (state.toasts.length === 0) return null
  return (
    <div className="toast-wrap">
      {state.toasts.map((t) => (
        <div className={`toast toast-${t.type}`} key={t.id} role="status">
          <div style={{ minWidth: 0 }}>
            <div className="toast-msg">{t.message}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
          </div>
          <button
            className="toast-close"
            onClick={() => dispatch({ type: 'TOAST_DISMISS', id: t.id })}
            aria-label="关闭提示"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
