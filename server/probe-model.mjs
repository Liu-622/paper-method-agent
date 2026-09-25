// 最小真实模型调用探针：确认 callModelText 可用（不输出密钥）
import { callModelText, llmStatus } from './llm.mjs'

const status = llmStatus()
console.log('status:', JSON.stringify(status))
const t0 = Date.now()
try {
  const out = await callModelText({ system: '你是学术助手，只回答一个词。', user: '时间序列预测中 PatchTST 的核心表示是？用一个词回答。', maxTokens: 16 })
  console.log('model reply:', JSON.stringify(out))
  console.log('elapsed ms:', Date.now() - t0)
} catch (e) {
  console.error('CALL FAILED:', e?.message ?? String(e))
  process.exit(1)
}
