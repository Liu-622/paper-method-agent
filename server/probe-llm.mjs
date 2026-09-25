/**
 * 环境探测：确认模型网关是否可用（不打印密钥）
 */
const base = process.env.ANTHROPIC_BASE_URL || ''
const token = process.env.ANTHROPIC_AUTH_TOKEN || ''
const model = process.env.ANTHROPIC_MODEL || ''

console.log('base =', base)
console.log('model =', model)
console.log('token length =', token.length, 'prefix =', token.slice(0, 5))

async function main() {
  if (!base || !token) {
    console.log('RESULT: missing base or token')
    return
  }
  // 尝试 Anthropic Messages API
  const url = base.replace(/\/+$/, '') + '/v1/messages'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': token,
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
      }),
    })
    const text = await res.text()
    console.log('status =', res.status)
    console.log('body(500) =', text.slice(0, 500))
  } catch (e) {
    console.log('ERROR:', e.message)
  }
}

main()
