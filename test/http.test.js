const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-test-'))
process.env.DATA_DIR = dir
process.env.JWT_SECRET = 'local-test-secret'
process.env.CRON_TOKEN = 'local-cron-test'
const { app, db } = require('../server')
let server, base, token, tokenBob
const envelope = (value, stamp = 1) =>
  JSON.stringify({ __ielts: 2, stamp: [stamp, 'test'], value })
async function request(route, method = 'GET', body, bearer = token) {
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
  token = (
    await request(
      '/api/register',
      'POST',
      { username: 'alice', password: 'test-pass' },
      null,
    )
  ).token
  tokenBob = (
    await request(
      '/api/register',
      'POST',
      { username: 'bob', password: 'test-pass' },
      null,
    )
  ).token
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
test('advertises protocol 2 and rejects legacy whole-blob PUTs', async () => {
  assert.equal((await request('/api/sync')).protocolVersion, 2)
  assert.equal((await request('/api/sync', 'PUT', { data: {} })).status, 426)
})
test('merges independent device pushes instead of replacing the stored blob', async () => {
  for (const [id, done] of [
    ['0061', 1],
    ['0062', 2],
  ])
    assert.equal(
      (
        await request('/api/sync', 'PUT', {
          protocolVersion: 2,
          data: {
            ['myielts_u_alice_progress_v1__entry_' + id]: envelope({ done }),
          },
        })
      ).ok,
      true,
    )
  const result = await request('/api/sync')
  assert.equal(Object.keys(result.data).length, 2)
})
test('cross-account data is rejected without damaging either account', async () => {
  assert.equal(
    (
      await request(
        '/api/sync',
        'PUT',
        {
          protocolVersion: 2,
          data: { myielts_u_alice_progress_v1: envelope({}) },
        },
        tokenBob,
      )
    ).status,
    400,
  )
  assert.equal(
    (await request('/api/sync', 'GET', undefined, tokenBob)).data,
    null,
  )
  assert.equal(Object.keys((await request('/api/sync')).data).length, 2)
})
test('a failed merge rolls back every entry in its payload', async () => {
  const r = await request('/api/sync', 'PUT', {
    protocolVersion: 2,
    data: {
      myielts_u_alice_progress_v1__entry_0063: envelope({ done: 3 }),
      bad: 'invalid',
    },
  })
  assert.equal(r.status, 400)
  assert.equal(Object.keys((await request('/api/sync')).data).length, 2)
})
test('backs up pre-upgrade data once and retains that immutable copy', async () => {
  const row = db.prepare('SELECT data FROM sync_backups WHERE user_id=1').get()
  assert.ok(row)
  const before = row.data
  await request('/api/sync', 'PUT', {
    protocolVersion: 2,
    data: { myielts_u_alice_progress_v1__entry_0061: envelope({ done: 9 }, 9) },
  })
  assert.equal(
    db.prepare('SELECT data FROM sync_backups WHERE user_id=1').get().data,
    before,
  )
})
test('cron recognizes independently stored vocabulary schedules', async () => {
  const id = 'vocab:12',
    encoded = Array.from(id)
      .map((c) => c.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('')
  await request('/api/sync', 'PUT', {
    protocolVersion: 2,
    data: {
      ['myielts_u_alice_sr_vocabulary_v1__entry_' + encoded]: envelope({
        dueAt: Date.parse('2026-10-28T04:00:00Z'),
        interval: 1,
      }),
    },
  })
  const r = await fetch(
    base + '/api/cron/studied-words?username=alice&date=2026-10-27',
    { headers: { 'X-Cron-Token': 'local-cron-test' } },
  )
  assert.deepEqual((await r.json()).words, ['vocab:12'])
})
test('cron failures return a JSON error without leaking a stack', async () => {
  const row = db.prepare('SELECT data FROM sync_data WHERE user_id=1').get()
  db.prepare('UPDATE sync_data SET data=? WHERE user_id=1').run('invalid JSON')
  const response = await fetch(
    base + '/api/cron/studied-words?username=alice&date=2026-10-27',
    { headers: { 'X-Cron-Token': 'local-cron-test' } },
  )
  assert.equal(response.status, 500)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.stack, undefined)
  db.prepare('UPDATE sync_data SET data=? WHERE user_id=1').run(row.data)
})
test('body-parser client errors keep their status instead of becoming 500', async () => {
  const malformed = await fetch(base + '/api/sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).ok, false)
  const oversized = await fetch(base + '/api/sync', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024) }),
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).ok, false)
})

test('trust proxy is set so login rate limiting sees real client IPs', () => {
  assert.equal(app.get('trust proxy'), 1)
})
