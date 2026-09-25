/**
 * 统一线性图标（内联 SVG，无依赖、无 emoji）。
 * 用法：<Icon name="compare" />；尺寸由 size 控制，颜色继承 currentColor。
 */
export type IconName =
  | 'home'
  | 'library'
  | 'compare'
  | 'check'
  | 'plan'
  | 'qa'
  | 'lab'
  | 'search'
  | 'plus'
  | 'close'
  | 'copy'
  | 'locate'
  | 'refresh'
  | 'chevron'
  | 'sparkle'
  | 'rocket'
  | 'alert'
  | 'info'
  | 'todo'
  | 'export'
  | 'check-circle'
  | 'arrow-left'
  | 'chevron-right'
  | 'panel-left'
  | 'panel-right'
  | 'external'
  | 'trash'
  | 'filter'
  | 'file-text'
  | 'clock'
  | 'branch'
  | 'expand'
  | 'shrink'
  | 'minus'
  | 'arrow-right'
  | 'arrow-up'
  | 'arrow-down'

const PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  library: 'M4 4.5h5.5v15H4zM10.5 4.5H16v15h-5.5zM17.5 5.5l3 14',
  compare: 'M4 7h7M4 12h5M4 17h7M15 5l4 4-4 4M19 9h-6',
  check: 'M5 13l4 4L19 7',
  plan: 'M4 6h10M4 12h7M4 18h10M17 12l3 3-3 3M20 15h-5',
  qa: 'M4 5.5h16v10H9l-5 4z',
  lab: 'M9 3h6M10 3v5.5L5.5 17A2.4 2.4 0 0 0 7.7 21h8.6a2.4 2.4 0 0 0 2.2-4L14 8.5V3M7.6 14.5h8.8',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  locate: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  chevron: 'M8 10l4 4 4-4',
  sparkle: 'M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z',
  rocket: 'M12 3c3.5 1.5 5.5 4.5 5.5 8L12 16l-5.5-5C6.5 7.5 8.5 4.5 12 3zM12 16v5M9 20h6',
  alert: 'M12 4l8.5 15h-17zM12 10v4M12 17h.01',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 8h.01',
  todo: 'M4 6h3v3H4zM4 15h3v3H4zM10 7.5h10M10 16.5h10',
  export: 'M12 4v11M8 11l4 4 4-4M5 20h14',
  'check-circle': 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8.5 12l2.5 2.5 4.5-5',
  'arrow-left': 'M19 12H5M11 6l-6 6 6 6',
  'chevron-right': 'M10 8l4 4-4 4',
  'panel-left': 'M4 5.5h16v13H4zM10 5.5v13',
  'panel-right': 'M4 5.5h16v13H4zM14 5.5v13',
  external: 'M14 5h5v5M19 5l-7 7M18 14v4.5H5.5V6H10',
  trash: 'M5 7h14M9.5 7V5h5v2M7 7l1 13h8l1-13M10.5 10.5v6M13.5 10.5v6',
  filter: 'M4 6h16M7 12h10M10 18h4',
  'file-text': 'M7 3.5h7L18.5 8v12.5H7zM14 3.5V8h4.5M10 12h6M10 15.5h6',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 1.8',
  branch: 'M7 5.5v13M7 10.5h6a4 4 0 0 1 4 4v2M7 8.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  expand: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  shrink: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  minus: 'M5 12h14',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
}

export function Icon({
  name,
  size = 15,
  className,
  strokeWidth = 1.7,
}: {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
}) {
  return (
    <svg
      className={`ic${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
