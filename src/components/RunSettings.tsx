import { useEffect, useState } from 'react'
import { useApp } from '@/store/AppStore'
import { Tag } from './StatusTag'
import { FILE_PERSISTENCE_NOTE } from '@/config'
import { estimateLocalUsage, formatBytes } from '@/services/filestore'
import { useDialogFocus } from './useDialogFocus'

/**
 * 运行设置（面板，不是新页面）
 * ------------------------------------------------------------------
 * - 后端地址与访问口令：部署在静态托管时，用它把前端指向自己启动的后端
 * - 后端与模型状态：来自 GET /api/health
 * - 能力开关：只展示「实际接通并成功跑过」的能力
 * - 演示用：模拟问答失败、重置本地数据
 */
export function RunSettings({
  open,
  onClose,
  initialUrl,
  initialToken,
  onSave,
  onReset,
}: {
  open: boolean
  onClose: () => void
  initialUrl: string
  initialToken: string
  onSave: (url: string, token: string) => void
  onReset?: () => void
}) {
  const { state, dispatch, checkBackend, toast } = useApp()
  const panelRef = useDialogFocus(open, onClose)
  const [url, setUrl] = useState(initialUrl)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const savedCount = state.papers.filter((p) => p.fileStored).length

  useEffect(() => {
    if (!open) return undefined
    let alive = true
    void estimateLocalUsage().then((u) => {
      if (alive) setUsage(u)
    })
    return () => {
      alive = false
    }
  }, [open, savedCount])
  const [token, setToken] = useState(initialToken)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (open) {
      setUrl(initialUrl)
      setToken(initialToken)
    }
  }, [open, initialUrl, initialToken])

  if (!open) return null

  const backend = state.backend
  const health = backend.health
  const backendOk = backend.status === 'ok' && Boolean(health?.hasCredentials)

  const test = async () => {
    setTesting(true)
    onSave(url, token)
    // 等 localStorage 写入后再探测
    await new Promise((r) => window.setTimeout(r, 60))
    const result = await checkBackend()
    setTesting(false)
    if (result?.hasCredentials) {
      toast('success', '后端连接正常', `模型：${result.model}（${result.baseUrlHost || '同源'}）`)
    } else if (result) {
      toast('warning', '后端已连通，但没有配置模型密钥', '请在服务端设置 LLM_API_KEY 后重启后端。')
    } else {
      toast('error', '连接失败', backend.error || '请确认后端已启动、地址填写正确。')
    }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} role="presentation" />
      <aside ref={panelRef} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-label="运行设置">
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <h3>运行设置</h3>
            <div className="small muted">后端地址、连接状态与能力开关</div>
          </div>
          <button className="drawer-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="drawer-body">
          {/* ---------- 后端状态 ---------- */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h3>后端与模型</h3>
              <div className="head-actions">
                <Tag
                  tone={
                    backendOk ? 'green' : backend.status === 'checking' ? 'blue' : 'orange'
                  }
                >
                  {backendOk ? '已连接' : backend.status === 'checking' ? '检测中…' : '未连接'}
                </Tag>
              </div>
            </div>
            <div className="card-body stack-sm">
              {health ? (
                <div className="small muted">
                  <div>
                    模型：<b>{health.model}</b>（{health.apiStyle} 接口）
                  </div>
                  <div>
                    接口地址：<span className="mono">{health.baseUrlHost || '同源'}</span>
                  </div>
                  <div>
                    密钥：{health.hasCredentials ? '已在服务端配置' : '未配置'}
                    {health.requiresAccessToken ? ' · 该后端要求访问口令' : ''}
                  </div>
                </div>
              ) : (
                <div className="small muted">
                  {backend.error || '还没有探测到后端。'}
                  <div style={{ marginTop: 6 }}>
                    真实字段抽取与真实问答都需要后端（模型密钥只能放在服务端）。启动命令：
                    <br />
                    <code>node server/index.mjs</code>
                    <br />
                    启动后地址通常是 <code>http://127.0.0.1:8787</code>。
                  </div>
                </div>
              )}

              <div>
                <label className="field-label">后端地址（留空 = 与前端同源）</label>
                <input
                  className="input"
                  value={url}
                  placeholder="例如 https://your-backend.example.com"
                  onChange={(e) => setUrl(e.target.value)}
                />
                <div className="tiny muted-2" style={{ marginTop: 4 }}>
                  部署在静态托管（如当前在线版本）时，前端本身没有后端，需要在这里填写你自己的后端地址。
                </div>
              </div>

              <div>
                <label className="field-label">访问口令（后端设置了 API_ACCESS_TOKEN 时才需要）</label>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={token}
                  placeholder="可留空；这里不是模型 API Key"
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>

              <div className="row-tight">
                <button className="btn btn-sm btn-primary" onClick={() => void test()} disabled={testing}>
                  {testing ? (
                    <>
                      <span className="spinner light" /> 测试中…
                    </>
                  ) : (
                    '保存并测试连接'
                  )}
                </button>
                <button className="btn btn-sm" onClick={() => void checkBackend()}>
                  重新检测
                </button>
              </div>
            </div>
          </div>

          {/* ---------- 能力开关 ---------- */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-head">
              <h3>能力开关</h3>
              <div className="head-actions">
                <span className="tiny muted-2">只有实际接通并成功跑过一次才会打开</span>
              </div>
            </div>
            <div className="card-body stack-sm small">
              <div className="row">
                <Tag tone={state.caps.realPdfParsing ? 'green' : 'slate'}>
                  {state.caps.realPdfParsing ? '已启用' : '未验证'}
                </Tag>
                <span>真实 PDF 正文读取（浏览器端，按页保留页码）</span>
              </div>
              <div className="row">
                <Tag tone={state.caps.realLlmExtract ? 'green' : 'slate'}>
                  {state.caps.realLlmExtract ? '已启用' : '未验证'}
                </Tag>
                <span>模型字段抽取（研究问题 / 方法 / 数据集 / 划分 / 跨度 / 指标 / 复现信息）</span>
              </div>
              <div className="row">
                <Tag tone={state.caps.realLlmQa ? 'green' : 'slate'}>
                  {state.caps.realLlmQa ? '已启用' : '未验证'}
                </Tag>
                <span>模型问答（基于真实正文片段，回答带可核对引用）</span>
              </div>
              <div className="row">
                <Tag tone={state.caps.persistOriginalFile ? 'green' : 'orange'}>
                  {state.caps.persistOriginalFile ? '已启用' : '未保存过'}
                </Tag>
                <span>
                  上传原文件本地保存（IndexedDB）：保存成功后，刷新页面可以直接重新解析，不用再选一次文件
                </span>
              </div>
              <div className="row">
                <Tag tone="plain">本地占用</Tag>
                <span className="small muted">
                  {usage
                    ? `当前站点已用 ${formatBytes(usage.usage)}${
                        usage.quota ? ` / 上限约 ${formatBytes(usage.quota)}` : ''
                      }`
                    : '当前浏览器不支持查看用量估算'}
                  {savedCount > 0 ? ` · 已保存 ${savedCount} 份原文件` : ' · 还没有保存过原文件'}
                </span>
              </div>
              <div className="banner" style={{ marginTop: 4 }}>
                <span className="banner-icon">🗂️</span>
                <div>{FILE_PERSISTENCE_NOTE}</div>
              </div>
            </div>
          </div>

          {/* ---------- 演示与重置 ---------- */}
          <div className="card">
            <div className="card-head">
              <h3>演示与重置</h3>
            </div>
            <div className="card-body stack-sm">
              <label className="switch demo-switch">
                <input
                  type="checkbox"
                  checked={state.simulateQaFailure}
                  onChange={() => dispatch({ type: 'TOGGLE_SIMULATE_FAILURE' })}
                />
                <span>模拟问答失败（用于演示失败与重试状态）</span>
              </label>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  onClose()
                  onReset?.()
                }}
                title="清空上传记录、解析正文、字段与问答历史"
              >
                重置本地数据
              </button>
              <div className="tiny muted-2">
                本地保存内容包括：解析出的正文文本、字段抽取结果、人工补充、选择状态与问答历史。
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
