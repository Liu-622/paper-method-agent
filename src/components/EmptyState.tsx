export function EmptyState({
  icon,
  title,
  description,
  actions,
}: {
  /** 图标可以是字符串（emoji/字符）或任意节点（例如小咕插画） */
  icon?: React.ReactNode
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <span aria-hidden="true">·</span>}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {actions && <div className="empty-actions">{actions}</div>}
    </div>
  )
}
