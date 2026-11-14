const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-hardening-test-'))
process.env.DATA_DIR = dir
process.env.JWT_SECRET = 'local-test-secret'
process.env.CRON_TOKEN = 'local-cron-test'
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

test('new accounts need 8+ characters and at most 72 bytes', async () => {
  assert.equal((await post('/api/register', { username: 'short', password: '1234' })).status, 400)
  assert.equal((await post('/api/register', { username: 'long', password: '密'.repeat(25) })).status, 400)
  const ok = await post('/api/register', { username: 'okuser', password: 'eight-ok' })
  assert.equal(ok.status, 200)
  assert.equal(ok.ok, true)
})

test('login with an unknown user and with a wrong password look the same', async () => {
  const unknown = await post('/api/login', { username: 'nobody', password: 'whatever1' })
  const wrong = await post('/api/login', { username: 'okuser', password: 'wrong-pass' })
  assert.equal(unknown.status, 401)
  assert.equal(wrong.status, 401)
  assert.equal(unknown.message, wrong.message)
  assert.equal((await post('/api/login', { username: 'okuser', password: 'eight-ok' })).status, 200)
})

test('cron routes check the token', async () => {
  const wrong = await fetch(base + '/api/cron/users', { headers: { 'X-Cron-Token': 'local-cron-tesT' } })
  assert.equal(wrong.status, 401)
  const missing = await fetch(base + '/api/cron/users')
  assert.equal(missing.status, 401)
  const right = await fetch(base + '/api/cron/users', { headers: { 'X-Cron-Token': 'local-cron-test' } })
  assert.equal(right.status, 200)
})

test('deploy files take the domain from DOMAIN and default to the live server', () => {
  const caddy = fs.readFileSync(path.resolve(__dirname, '../deploy/Caddyfile'), 'utf8')
  const install = fs.readFileSync(path.resolve(__dirname, '../deploy/install.sh'), 'utf8')
  assert.match(caddy, /^__SYNC_DOMAIN__ \{$/m)
  assert.ok(install.includes('SYNC_DOMAIN="${DOMAIN:-38-64-63-20.sslip.io}"'))
  assert.ok(install.includes('s/__SYNC_DOMAIN__/$SYNC_DOMAIN/g'))
  assert.ok(install.includes('https://${SYNC_DOMAIN}/api/health'))
  assert.ok(!install.includes('104-233-149-98'))
})
