const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'),
  os = require('os'),
  path = require('path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-sync-limit-'))
process.env.DATA_DIR = dir
process.env.JWT_SECRET = 'local-test-secret'
process.env.CRON_TOKEN = 'local-cron-test'
// Loose production default is 600/15min; the test override only narrows the
// bucket so the 429 path is reachable without hammering 600 requests.
process.env.SYNC_RATE_LIMIT_MAX = '10'
const { app, db } = require('../server')
let server, base, tokenAlice, tokenBob
async function request(route, method = 'GET', body, bearer) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, ...(await response.json()) }
}
before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  base = 'http://127.0.0.1:' + server.address().port
  tokenAlice = (
    await request('/api/register', 'POST', {
      username: 'alice',
      password: 'test-pass',
    })
  ).token
  tokenBob = (
    await request('/api/register', 'POST', {
      username: 'bob',
      password: 'test-pass',
    })
  ).token
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
test('sync endpoints are rate limited per account, not per IP', async () => {
  for (let i = 0; i < 10; i++)
    assert.equal((await request('/api/sync', 'GET', undefined, tokenAlice)).status, 200)
  const limited = await request('/api/sync', 'GET', undefined, tokenAlice)
  assert.equal(limited.status, 429)
  assert.match(limited.message, /频繁/)
  // Another account's bucket is untouched: the limit is per uid, not global.
  assert.equal((await request('/api/sync', 'GET', undefined, tokenBob)).status, 200)
})
