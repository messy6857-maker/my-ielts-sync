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
  assert.deepEqual(rejected, [{ key: key('unknown'), reason: 'unknown-base' }])
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
  assert.deepEqual(rejected, [{ key: bad, reason: 'decode-failed' }])
  assert.equal(data[bad], undefined)
  assert.equal(decode(data[good]).value.done, 1)
  // A previously stored good entry survives a later payload carrying a bad key.
  const again = mergeDataWithReport(
    data,
    { [bad]: 'not json at all' },
    'alice',
  )
  assert.deepEqual(again.rejected, [{ key: bad, reason: 'decode-failed' }])
  assert.equal(decode(again.data[good]).value.done, 1)
})
test('legacy seed keys merge by union/max instead of first-writer freeze', () => {
  const enc = (id) =>
    id
      .split('')
      .map((c) => c.charCodeAt(0).toString(16).padStart(4, '0'))
      .join('')
  const legacy = (v) => JSON.stringify({ __ielts: 2, stamp: [0, 'legacy'], value: v })
  // stats: per-field max, neither device loses historical counts.
  const statsKey = key('stats_parts_v2__entry_' + enc('legacy'))
  const mergedStats = mergeData(
    { [statsKey]: legacy({ totals: { vocabulary: { known: 3, vague: 0, unknown: 0 } }, days: {} }) },
    { [statsKey]: legacy({ totals: { vocabulary: { known: 5, vague: 2, unknown: 0 } }, days: {} }) },
    'alice',
  )
  assert.deepEqual(decode(mergedStats[statsKey]).value.totals, {
    vocabulary: { known: 5, vague: 2, unknown: 0 },
  })
  assert.deepEqual(decode(mergedStats[statsKey]).stamp, [0, 'legacy'])
  // mistake: count max, firstAt min, lastAt max.
  const mistakeKey = key('mistake_parts_v2__entry_' + enc('vocabulary:apple|legacy'))
  const mergedMistake = mergeData(
    { [mistakeKey]: legacy({ count: 2, firstAt: 100, lastAt: 200 }) },
    { [mistakeKey]: legacy({ count: 5, firstAt: 50, lastAt: 150 }) },
    'alice',
  )
  assert.deepEqual(decode(mergedMistake[mistakeKey]).value, {
    count: 5,
    firstAt: 50,
    lastAt: 200,
  })
  // daily: same date keeps the higher count; a later date wins outright.
  // (Dates are relative to today: the merge trims daily entries older than
  // 14 days, so fixed 2026-10-01 fixtures would be pruned, not merged.)
  const fmtDay = (d) => d.toISOString().slice(0, 10)
  const day1 = fmtDay(new Date(Date.now() - 86400000))
  const day2 = fmtDay(new Date())
  const dailyKey = key('daily_parts_v2__entry_' + enc(`vocabulary|${day1}|legacy`))
  const mergedDaily = mergeData(
    { [dailyKey]: legacy({ date: day1, count: 3 }) },
    { [dailyKey]: legacy({ date: day1, count: 5 }) },
    'alice',
  )
  assert.equal(decode(mergedDaily[dailyKey]).value.count, 5)
  const laterDaily = mergeData(
    { [dailyKey]: legacy({ date: day1, count: 9 }) },
    { [dailyKey]: legacy({ date: day2, count: 1 }) },
    'alice',
  )
  assert.equal(decode(laterDaily[dailyKey]).value.date, day2)
  // Boundary: a stamp-0 entry that is NOT a legacy seed id keeps plain LWW
  // (first writer wins on equal stamps); a versioned write beats a seed.
  const plainKey = key('stats_parts_v2__entry_' + enc('plain'))
  const plain = mergeData(
    { [plainKey]: legacy({ totals: { vocabulary: { known: 1 } } }) },
    { [plainKey]: legacy({ totals: { vocabulary: { known: 9 } } }) },
    'alice',
  )
  assert.equal(decode(plain[plainKey]).value.totals.vocabulary.known, 1)
  const versioned = mergeData(
    { [statsKey]: legacy({ totals: { vocabulary: { known: 3 } }, days: {} }) },
    { [statsKey]: value({ totals: { vocabulary: { known: 1 } }, days: {} }, 7) },
    'alice',
  )
  assert.equal(decode(versioned[statsKey]).value.totals.vocabulary.known, 1)
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
