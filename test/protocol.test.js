const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { baseOf, mergeData, mergeDataWithReport, decode } = require('../sync-protocol')
const key = (n) => `myielts_u_alice_${n}`
const value = (v, n = 1, actor = 'a') =>
  JSON.stringify({ __ielts: 2, stamp: [n, actor], value: v })
test('username boundaries and credentials never synchronize', () => {
  assert.equal(baseOf('myielts_u_alice_bob_progress_v1', 'alice'), null)
  for (const name of ['token', 'ai_settings_v1', 'session_v1'])
    assert.equal(baseOf(key(name), 'alice'), null)
  // Unknown / foreign keys are skipped and reported, not fatal:
  // they must neither land in the merged data nor break good entries.
  const { data, rejected } = mergeDataWithReport(
    {},
    { [key('unknown')]: value(1) },
    'alice',
  )
  assert.deepEqual(rejected, [key('unknown')])
  assert.equal(data[key('unknown')], undefined)
})
test('two independent writes preserve both records inside SQLite', () => {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE sync_data(data TEXT)')
  db.prepare('INSERT INTO sync_data VALUES(?)').run('{}')
  const write = (data) => {
    db.exec('BEGIN IMMEDIATE')
    const previous = JSON.parse(
      db.prepare('SELECT data FROM sync_data').get().data,
    )
    const merged = mergeData(previous, data, 'alice')
    db.prepare('UPDATE sync_data SET data=?').run(JSON.stringify(merged))
    db.exec('COMMIT')
  }
  write({ [key('progress_v1__entry_0061')]: value({ done: 1 }) })
  write({ [key('progress_v1__entry_0062')]: value({ done: 2 }) })
  const data = JSON.parse(db.prepare('SELECT data FROM sync_data').get().data)
  assert.equal(Object.keys(data).length, 2)
  db.close()
})
test('late stale writes cannot replace a newer word or resurrect a deletion', () => {
  const k = key('reading_mastered_v1__entry_0061')
  const old = { [k]: value(true, 1) },
    removed = mergeData(
      old,
      { [k]: JSON.stringify({ __ielts: 2, stamp: [2, 'a'], deleted: true }) },
      'alice',
    )
  assert.equal(decode(mergeData(removed, old, 'alice')[k]).deleted, true)
  assert.equal(
    decode(mergeData(removed, { [k]: value(true, 3) }, 'alice')[k]).value,
    true,
  )
})
test('malformed envelopes are skipped and reported, good entries still merge', () => {
  const bad = key('progress_v1')
  const good = key('progress_v1__entry_0061')
  const { data, rejected } = mergeDataWithReport(
    {},
    {
      [bad]: JSON.stringify({
        __ielts: 2,
        stamp: ['bad'],
        value: 1,
      }),
      [good]: value({ done: 1 }),
    },
    'alice',
  )
  assert.deepEqual(rejected, [bad])
  assert.equal(data[bad], undefined)
  assert.equal(decode(data[good]).value.done, 1)
  // A previously stored good entry survives a later payload carrying a bad key.
  const again = mergeDataWithReport(
    data,
    { [bad]: 'not json at all' },
    'alice',
  )
  assert.deepEqual(again.rejected, [bad])
  assert.equal(decode(again.data[good]).value.done, 1)
})
test('concurrent yearly check-ins are unioned', () => {
  const k = key('checkin_years_v2__entry_0032003000320036')
  assert.deepEqual(
    decode(
      mergeData({ [k]: value([1, 2], 2) }, { [k]: value([3], 1) }, 'alice')[k],
    ).value,
    [1, 2, 3],
  )
})
test('AI archives are capped and stale devices cannot restore pruned results', () => {
  const incoming = Object.fromEntries(
    Array.from({ length: 35 }, (_, i) => [
      key('aigrade_v1_' + i),
      value({ essay: i }, i + 1),
    ]),
  )
  let merged = mergeData({}, incoming, 'alice')
  assert.equal(
    Object.keys(merged).filter((k) => k.includes('_aigrade_')).length,
    30,
  )
  merged = mergeData(merged, incoming, 'alice')
  assert.equal(
    Object.keys(merged).filter((k) => k.includes('_aigrade_')).length,
    30,
  )
})
test('legacy tables remain until client confirms successful migration', () => {
  const original = {
    [key('stats_attempts_v1')]: JSON.stringify({
      '2026-1-1': { vocabulary: { known: 3 } },
    }),
  }
  assert.ok(mergeData(original, {}, 'alice')[key('stats_attempts_v1')])
  assert.equal(
    mergeData(original, { [key('migration_version_v2')]: value(2) }, 'alice')[
      key('stats_attempts_v1')
    ],
    undefined,
  )
})
