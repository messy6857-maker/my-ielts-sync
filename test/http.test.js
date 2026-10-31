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
  const r = await request(
    '/api/sync',
    'PUT',
    {
      protocolVersion: 2,
      data: { myielts_u_alice_progress_v1: envelope({}) },
    },
    tokenBob,
  )
  // Foreign keys are skipped and reported (no longer a whole-payload 400),
  // but nothing is stored for bob and alice's data is untouched.
  assert.equal(r.status, 200)
  assert.deepEqual(r.rejected, [
    { key: 'myielts_u_alice_progress_v1', reason: 'unknown-base' },
  ])
  assert.equal(
    (await request('/api/sync', 'GET', undefined, tokenBob)).data,
    null,
  )
  assert.equal(Object.keys((await request('/api/sync')).data).length, 2)
})
test('a bad entry is skipped and reported while good entries still land', async () => {
  const r = await request('/api/sync', 'PUT', {
    protocolVersion: 2,
    data: {
      myielts_u_alice_progress_v1__entry_0063: envelope({ done: 3 }),
      bad: 'invalid',
    },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.rejected, [{ key: 'bad', reason: 'unknown-base' }])
  assert.equal(Object.keys((await request('/api/sync')).data).length, 3)
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
test('corrupted stored blob returns empty studied words instead of 500', async () => {
  const row = db.prepare('SELECT data FROM sync_data WHERE user_id=1').get()
  db.prepare('UPDATE sync_data SET data=? WHERE user_id=1').run('invalid JSON')
  const response = await fetch(
    base + '/api/cron/studied-words?username=alice&date=2026-10-27',
    { headers: { 'X-Cron-Token': 'local-cron-test' } },
  )
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.words, [])
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

test('ai relay rejects non-allowlisted hosts before fetching upstream', async () => {
  const r = await request('/api/ai/chat', 'POST', {
    baseUrl: 'https://example.com/v1',
    apiKey: 'x',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(r.status, 400)
  assert.match(r.message, /允许列表/)
})

test('ai relay is rate limited per account', async () => {
  // bob's bucket is untouched by the allowlist test above (alice's token);
  // every call is rejected by the allowlist before any upstream fetch.
  let last
  for (let i = 0; i < 61; i++) {
    last = await request(
      '/api/ai/chat',
      'POST',
      {
        baseUrl: 'https://example.com/v1',
        apiKey: 'x',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      },
      tokenBob,
    )
  }
  assert.equal(last.status, 429)
  assert.match(last.message, /频繁/)
})

test('trust proxy is set so login rate limiting sees real client IPs', () => {
  assert.equal(app.get('trust proxy'), 1)
})

test('corrupted sync blob returns data null and heals on next push', async () => {
  const uid = db
    .prepare('SELECT id FROM users WHERE username=?')
    .get('alice').id
  const row = db.prepare('SELECT data FROM sync_data WHERE user_id=?').get(uid)
  db.prepare('UPDATE sync_data SET data=? WHERE user_id=?').run('invalid JSON', uid)
  const pulled = await request('/api/sync')
  assert.equal(pulled.status, 200)
  assert.equal(pulled.data, null)
  const pushed = await request('/api/sync', 'PUT', {
    protocolVersion: 2,
    data: { ['myielts_u_alice_progress_v1__entry_0069']: envelope({ done: 9 }) },
  })
  assert.equal(pushed.ok, true)
  const healed = await request('/api/sync')
  assert.equal(Object.keys(healed.data).length, 1)
  if (row)
    // 恢复原始 blob 时同步推进 updated_at：GET 缓存以 (uid, updated_at) 为键，
    // 只恢复 data 不动 updated_at 会让后续 GET 命中 heal 时的旧缓存。
    // +1000ms 保证键一定变化（heal 的 now 与恢复时刻可能同毫秒）。
    db.prepare('UPDATE sync_data SET data=?, updated_at=? WHERE user_id=?').run(
      row.data,
      Date.now() + 1000,
      uid,
    )
  else db.prepare('DELETE FROM sync_data WHERE user_id=?').run(uid)
})

test('corrupted daily reading returns reading null instead of 500', async () => {
  const uid = db
    .prepare('SELECT id FROM users WHERE username=?')
    .get('alice').id
  db.prepare(
    'INSERT INTO daily_readings (date, user_id, data, created_at) VALUES (?,?,?,?)',
  ).run('2026-10-27', uid, 'invalid JSON', Date.now())
  const r = await request('/api/daily-reading?date=2026-10-27')
  assert.equal(r.status, 200)
  assert.equal(r.reading, null)
  db.prepare('DELETE FROM daily_readings WHERE date=? AND user_id=?').run(
    '2026-10-27',
    uid,
  )
})

test('a PUT invalidates the cached GET merge for that account', async () => {
  const before = await request('/api/sync')
  const beforeCount = Object.keys(before.data || {}).length
  const fresh = 'myielts_u_alice_progress_v1__entry_0099'
  const put = await request('/api/sync', 'PUT', {
    protocolVersion: 2,
    data: { [fresh]: envelope({ done: 99 }) },
  })
  assert.equal(put.status, 200)
  // The first GET after the PUT populates the cache; a second GET must
  // still show the new entry (a stale cache would hide it on both).
  for (let i = 0; i < 2; i++) {
    const after = await request('/api/sync')
    assert.equal(Object.keys(after.data).length, beforeCount + 1)
    assert.equal(JSON.parse(after.data[fresh]).value.done, 99)
  }
})

test('a non-string incoming value is rejected with its own reason', async () => {
  const { mergeDataWithReport } = require('../sync-protocol')
  const { rejected } = mergeDataWithReport(
    {},
    { myielts_u_alice_progress_v1: 42 },
    'alice',
  )
  assert.deepEqual(rejected, [
    { key: 'myielts_u_alice_progress_v1', reason: 'non-string' },
  ])
})

test('cron skips one corrupted independent schedule instead of failing the endpoint', async () => {
  const uid = db.prepare('SELECT id FROM users WHERE username=?').get('alice').id
  const row = db.prepare('SELECT data FROM sync_data WHERE user_id=?').get(uid)
  const original = row.data
  const data = JSON.parse(original)
  data.myielts_u_alice_sr_vocabulary_v1__entry_0070006f00690073006f006e = '{broken-json'
  db.prepare('UPDATE sync_data SET data=? WHERE user_id=?').run(JSON.stringify(data),uid)
  try {
    const r = await fetch(base+'/api/cron/studied-words?username=alice&date=2026-10-31',{headers:{'X-Cron-Token':'local-cron-test'}})
    assert.equal(r.status,200)
    assert.equal((await r.json()).ok,true)
  } finally {db.prepare('UPDATE sync_data SET data=? WHERE user_id=?').run(original,uid)}
})
test('identical PUT leaves the persisted update version unchanged', async () => {
  const data = (await request('/api/sync')).data
  const uid = db.prepare('SELECT id FROM users WHERE username=?').get('alice').id
  const before = db.prepare('SELECT updated_at FROM sync_data WHERE user_id=?').get(uid).updated_at
  const result = await request('/api/sync','PUT',{protocolVersion:2,data})
  assert.equal(result.ok,true)
  assert.equal(result.updatedAt,before)
  assert.equal(db.prepare('SELECT updated_at FROM sync_data WHERE user_id=?').get(uid).updated_at,before)
})
test('AI relay refuses redirection rather than following a second unvalidated host', async () => {
  const relayToken = (await request('/api/register','POST',{username:'relay_redirect',password:'local-test-only'},null)).token
  const originalFetch = global.fetch
  const dns = require('node:dns')
  const originalLookup = dns.promises.lookup
  dns.promises.lookup = async () => [{address:'8.8.8.8',family:4}]
  let upstream = false
  global.fetch = async (url,init) => {
    if (String(url).startsWith(base)) return originalFetch(url,init)
    upstream = true
    assert.equal(init.redirect,'error')
    throw new Error('redirect rejected in local fixture')
  }
  try {
    const result = await request('/api/ai/chat','POST',{baseUrl:'https://api-cdn.thehive.ai/api/v3',apiKey:'local-test-only',model:'test',messages:[]},relayToken)
    assert.equal(result.ok,false)
    assert.equal(upstream,true)
  } finally {global.fetch=originalFetch;dns.promises.lookup=originalLookup}
})
test('GET cache expires without requiring a PUT on the following day', async () => {
  const bearer = (await request('/api/register','POST',{username:'cache_day',password:'local-test-only'},null)).token
  const now = Date.now()
  const date = new Date(now-13*86400000).toISOString().slice(0,10)
  const id = `vocabulary|${date}|word|device`
  const hex = [...id].map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')
  const key = `myielts_u_cache_day_daily_parts_v2__entry_${hex}`
  await request('/api/sync','PUT',{protocolVersion:2,data:{[key]:envelope({date,count:1})}},bearer)
  assert.ok((await request('/api/sync','GET',undefined,bearer)).data[key])
  const original = Date.now
  Date.now = () => now+2*86400000
  try {assert.equal((await request('/api/sync','GET',undefined,bearer)).data[key],undefined)}
  finally {Date.now=original}
})
