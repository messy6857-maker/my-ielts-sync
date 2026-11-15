const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-review-test-'))
process.env.DATA_DIR = dir
process.env.JWT_SECRET = 'local-test-secret'
const { app } = require('../server')

let server, base
async function post(route, body, headers = {}) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, ...(await response.json()) }
}
before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  base = 'http://127.0.0.1:' + server.address().port
})
after(() => {
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('password length counts characters, not UTF-16 code units', async () => {
  // 4 个 emoji 是 8 个 UTF-16 单元，但只有 4 个字符：不够 8 个字符
  assert.equal((await post('/api/register', { username: 'emoji4', password: '😀😀😀😀' })).status, 400)
  // 8 个 emoji = 8 个字符、32 字节：合规
  assert.equal((await post('/api/register', { username: 'emoji8', password: '😀'.repeat(8) })).status, 200)
  // 19 个 emoji = 76 字节：超过 72 字节
  assert.equal((await post('/api/register', { username: 'emoji19', password: '😀'.repeat(19) })).status, 400)
})

test('two concurrent registrations of the same name give 200 and 409, never 500', async () => {
  const results = await Promise.all([
    post('/api/register', { username: 'racer', password: 'race-pass-1' }),
    post('/api/register', { username: 'racer', password: 'race-pass-2' }),
  ])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  const conflict = results.find(r => r.status === 409)
  assert.equal(conflict.ok, false)
  assert.match(conflict.message, /用户名已存在/)
})

test('key detection only accepts one chosen provider and never probes the others', async () => {
  const { token } = await post('/api/register', { username: 'detector', password: 'detect-pass' })
  const auth = { Authorization: `Bearer ${token}` }
  const realFetch = globalThis.fetch
  const outbound = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (!target.startsWith(base)) {
      outbound.push(target)
      return new Response('{}', { status: 401 })
    }
    return realFetch(url, init)
  }
  try {
    const missing = await post('/api/ai/detect', { apiKey: 'sk-test' }, auth)
    assert.equal(missing.status, 400)
    const unknown = await post('/api/ai/detect', { apiKey: 'sk-test', provider: 'nope' }, auth)
    assert.equal(unknown.status, 400)
    assert.deepEqual(outbound, [])
    const chosen = await post('/api/ai/detect', { apiKey: 'sk-test', provider: 'deepseek' }, auth)
    assert.equal(chosen.status, 401)
    assert.deepEqual(outbound, ['https://api.deepseek.com/chat/completions'])
  }
  finally {
    globalThis.fetch = realFetch
  }
})
