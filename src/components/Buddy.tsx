import { useMemo } from 'react'

/**
 * 小咕 —— 原创小猫头鹰（扁平矢量，无 emoji）
 * 结构：奶油色身体 + 鼠尾草绿翅膀 + 大眼睛 + 短耳羽 + 抱着一张小论文。
 * 40px 仍可辨认；支持 size / 表情 / 眨眼 / 歪头 / 思考 状态。
 */
export type BuddyMood = 'idle' | 'thinking' | 'happy' | 'confused'
export type BuddySize = 'xs' | 'sm' | 'md' | 'lg'

const SIZE_PX: Record<BuddySize, number> = { xs: 28, sm: 40, md: 56, lg: 96 }

export function Buddy({
  size = 'sm',
  mood = 'idle',
  tilt = false,
  blink = true,
  px,
  className,
  title,
}: {
  size?: BuddySize
  mood?: BuddyMood
  /** 悬停歪头 */
  tilt?: boolean
  /** 是否自动眨眼（尊重系统减少动效设置） */
  blink?: boolean
  px?: number
  className?: string
  title?: string
}) {
  const cls = useMemo(() => {
    const parts = ['buddy', `buddy-${mood}`]
    if (tilt) parts.push('buddy-tilt')
    if (blink) parts.push('buddy-blink')
    if (className) parts.push(className)
    return parts.join(' ')
  }, [mood, tilt, blink, className])

  return (
    <svg
      className={cls}
      width={px ?? SIZE_PX[size]}
      height={px ?? SIZE_PX[size]}
      viewBox="0 0 100 100"
      role="img"
      aria-label={title ?? '小咕'}
      focusable="false"
    >
      <title>{title ?? '小咕 · 论文复现助手'}</title>

      {/* 耳羽 */}
      <path d="M30 30c-2-8-1-13 1-16 4 2 8 7 10 12z" fill="#e9dfc9" />
      <path d="M70 30c2-8 1-13-1-16-4 2-8 7-10 12z" fill="#e9dfc9" />

      {/* 腹部/身体（奶油色） */}
      <path
        d="M50 16c18 0 30 13 30 32 0 20-13 36-30 36S20 68 20 48c0-19 12-32 30-32z"
        fill="#f6efdd"
      />
      {/* 面盘 */}
      <ellipse cx="50" cy="45" rx="26" ry="24" fill="#fbf6ea" />
      {/* 翅膀（鼠尾草绿） */}
      <path d="M22 46c-4 10-3 22 3 30 6-3 9-9 9-15z" fill="#9db9a3" />
      <path d="M78 46c4 10 3 22-3 30-6-3-9-9-9-15z" fill="#9db9a3" />

      {/* 眼睛 */}
      <g className="buddy-eyes">
        <circle cx="39" cy="45" r="10.5" fill="#fffdf7" />
        <circle cx="61" cy="45" r="10.5" fill="#fffdf7" />
        <g className="buddy-pupils">
          <circle cx="39" cy="46" r="5.4" fill="#203b35" />
          <circle cx="61" cy="46" r="5.4" fill="#203b35" />
          <circle cx="41" cy="43.6" r="1.7" fill="#fffdf7" />
          <circle cx="63" cy="43.6" r="1.7" fill="#fffdf7" />
        </g>
      </g>

      {/* 快乐/眨眼时眯眼 */}
      {mood === 'happy' && (
        <g stroke="#203b35" strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path d="M33 45c2-4 10-4 12 0" />
          <path d="M55 45c2-4 10-4 12 0" />
        </g>
      )}
      {mood === 'confused' && (
        <g stroke="#203b35" strokeWidth="2.2" strokeLinecap="round" fill="none">
          <path d="M32 36l14 3" />
          <path d="M68 38l-12 2" />
        </g>
      )}

      {/* 喙 */}
      <path d="M50 54l-5 5 5 4 5-4z" fill="#f2c7a9" />

      {/* 抱着的小论文 */}
      <g className="buddy-paper">
        <rect x="34" y="66" width="32" height="22" rx="3" fill="#ffffff" stroke="#d3dad0" strokeWidth="1.6" />
        <path d="M45 66v22" stroke="#e4e9e2" strokeWidth="1.4" />
        <g stroke="#c8dbcd" strokeWidth="1.6" strokeLinecap="round">
          <path d="M49 72h13M49 77h13M49 82h9" />
          <path d="M38 72h4M38 77h4M38 82h4" />
        </g>
        {/* 小翅膀压着论文 */}
        <path d="M30 70c6 0 10 4 10 8-5 1-9-2-10-8z" fill="#9db9a3" />
        <path d="M70 70c-6 0-10 4-10 8 5 1 9-2 10-8z" fill="#9db9a3" />
      </g>

      {/* 思考时的小气泡 */}
      {mood === 'thinking' && (
        <g className="buddy-think">
          <circle cx="80" cy="26" r="3.4" fill="#f2c7a9" />
          <circle cx="87" cy="19" r="4.6" fill="#f2c7a9" opacity="0.85" />
        </g>
      )}
    </svg>
  )
}

/** 侧栏品牌用：小咕 + 产品短名 */
export function BuddyBrand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="buddy-brand">
      <Buddy size="sm" px={38} title="小咕 · 论文复现助手" />
      <div className="buddy-brand-text">
        <div className="buddy-brand-name">论文复现助手</div>
        {subtitle && <div className="buddy-brand-sub">{subtitle}</div>}
      </div>
    </div>
  )
}
