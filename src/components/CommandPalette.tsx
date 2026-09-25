import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '@/store/AppStore'
import { Icon, type IconName } from '@/components/Icons'
import { useDialogFocus } from './useDialogFocus'

interface Cmd {
  id: string
  label: string
  kind: '论文' | '页面' | '检查项' | '操作'
  icon: IconName
  run: () => void
}

/** Ctrl/Cmd+K 命令面板：搜索跳转论文/页面/检查项，并执行已有操作 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { state, scopedPapers, dispatch, toast } = useApp()
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useDialogFocus(open, onClose)

  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      // 打开后把焦点放进输入框（避免打字触发全局快捷键）
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const cmds = useMemo<Cmd[]>(() => {
    const list: Cmd[] = []

    for (const p of scopedPapers) {
      list.push({
        id: `paper-${p.id}`,
        label: `${p.shortLabel} · ${p.title}`,
        kind: '论文',
        icon: 'library',
        run: () => navigate(`/paper/${p.id}`),
      })
    }

    const pages: [string, string, IconName][] = [
      ['/', '首页', 'home'],
      ['/library', '论文库', 'library'],
      ['/compare', '方法对比', 'compare'],
      ['/check', '实验检查', 'check'],
      ['/plan', '验证计划', 'plan'],
      ['/qa', '论文问答', 'qa'],
    ]
    for (const [to, label, icon] of pages) {
      list.push({ id: `page-${to}`, label: `打开：${label}`, kind: '页面', icon, run: () => navigate(to) })
    }

    const checks: [string, string][] = [
      ['split', '划分比例'],
      ['splitRange', '测试时间区间'],
      ['sampleInterval', '采样间隔'],
      ['horizon', '预测跨度'],
      ['metrics', '评价指标'],
      ['evalProtocol', '评估协议'],
      ['baselines', '对比基线'],
    ]
    for (const [key, label] of checks) {
      list.push({
        id: `check-${key}`,
        label: `看检查项：${label}`,
        kind: '检查项',
        icon: 'check',
        run: () => navigate(`/compare?focus=${key}`),
      })
    }

    list.push(
      {
        id: 'act-compare',
        label: '用已选论文开始对比',
        kind: '操作',
        icon: 'compare',
        run: () => navigate('/compare'),
      },
      {
        id: 'act-plan',
        label: '生成验证计划',
        kind: '操作',
        icon: 'rocket',
        run: () => navigate('/plan'),
      },
      {
        id: 'act-export',
        label: '导出验证计划（Markdown）',
        kind: '操作',
        icon: 'export',
        run: () => navigate('/plan?export=1'),
      },
      {
        id: 'act-clear',
        label: '清除已选论文',
        kind: '操作',
        icon: 'close',
        run: () => {
          dispatch({ type: 'CLEAR_SELECT' })
          toast('info', '已清除选择', '可以重新勾选要对比的论文。')
        },
      },
    )

    if (!q.trim()) return list.slice(0, 40)
    const needle = q.trim().toLowerCase()
    return list.filter((c) => c.label.toLowerCase().includes(needle)).slice(0, 40)
  }, [q, scopedPapers, navigate, dispatch, toast])

  useEffect(() => {
    setCursor(0)
  }, [q])

  if (!open) return null

  return (
    <div className="palette-mask" onMouseDown={onClose}>
      <div ref={panelRef as React.RefObject<HTMLDivElement>} tabIndex={-1} className="palette" role="dialog" aria-modal="true" aria-label="快捷操作" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // 输入时不要让全局快捷键抢走按键
            e.stopPropagation()
            if (e.key === 'Escape') onClose()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.max(0, Math.min(c + 1, cmds.length - 1)))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            }
            if (e.key === 'Enter' && cmds.length) {
              e.preventDefault()
              cmds[Math.max(0, Math.min(cursor, cmds.length - 1))].run()
              onClose()
            }
          }}
          placeholder="搜索论文、页面、检查项，或执行操作…"
          aria-label="搜索"
        />
        <div className="palette-list">
          {cmds.length === 0 && (
            <div className="small muted" style={{ padding: '10px 12px' }}>
              没有匹配项。可以试试论文短名（Autoformer / FEDformer / PatchTST）或「计划」。
            </div>
          )}
          {cmds.map((c, i) => (
            <button
              key={c.id}
              className={`palette-item${i === cursor ? ' active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                c.run()
                onClose()
              }}
            >
              <Icon name={c.icon} size={15} />
              <span>{c.label}</span>
              <span className="pi-kind">{c.kind}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
