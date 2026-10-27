'use strict'
const mapBases = [
  'progress_v1',
  'sr_vocabulary_v1',
  'listening179_sr_v1',
  'reading538_sr_v1',
  'corpus_sr_v1',
  'mistake_parts_v2',
  'mistake_resets_v2',
  'daily_parts_v2',
  'daily_resets_v2',
  'stats_parts_v2',
  'timer_sessions_v2',
  'checkin_years_v2',
]
const setBases = [
  'reading_mastered_v1',
  'writing_mastered_v1',
  'flashcard_checkin_v1',
]
const arrayBases = ['mock_history_v1', 'task1_essays_v1', 'task2_essays_v1']
const collectionBases = [...mapBases, ...setBases, ...arrayBases]
const scalarBases = [
  'flashcard_daily_goal_v1',
  'listening179_daily_goal_v1',
  'reading538_daily_goal_v1',
  'corpus_daily_goal_v1',
  'stats_archive_v2',
  'checkin_archive_v2',
  'archive_retention_v2',
  'migration_version_v2',
]
const legacyBases = [
  'mistakes_v1',
  'flashcard_daily_new_v1',
  'listening179_daily_new_v1',
  'reading538_daily_new_v1',
  'corpus_daily_new_v1',
  'study_time_v1',
  'stats_attempts_v1',
  'tombstones_v1',
]
const protocolVersion = 2
function baseOf(key, user) {
  const prefix = `myielts_u_${user}_`
  if (!key.startsWith(prefix)) return null
  const base = key.slice(prefix.length),
    [table, suffix, extra] = base.split('__entry_')
  if (
    extra === undefined &&
    ((suffix !== undefined &&
      collectionBases.includes(table) &&
      /^(?:[a-f\d]{4})+$/i.test(suffix)) ||
      (suffix === undefined &&
        [...collectionBases, ...scalarBases, ...legacyBases].includes(base)) ||
      /^study_time_v1_[a-z\d-]+$/i.test(base) ||
      /^aigrade_(?:speaking_)?v1_(?:[a-z\d]+_)?-?[a-z\d]+$/i.test(base))
  )
    return base
  return null
}
function decode(raw) {
  const value = JSON.parse(raw)
  if (value && value.__ielts === 2) {
    if (
      !Array.isArray(value.stamp) ||
      !Number.isSafeInteger(value.stamp[0]) ||
      value.stamp[0] < 0 ||
      typeof value.stamp[1] !== 'string' ||
      value.stamp[1].length > 200
    )
      throw new Error('Invalid version')
    return value
  }
  return { __ielts: 2, stamp: [0, 'legacy'], value }
}
const compare = (a, b) =>
  a.stamp[0] - b.stamp[0] || a.stamp[1].localeCompare(b.stamp[1])
const archive = (base) => /^aigrade_(?:speaking_)?v1_/.test(base)
const past = (key, e, c) =>
  c &&
  (e.stamp[0] - c[0] ||
    e.stamp[1].localeCompare(c[1]) ||
    key.localeCompare(c[2])) <= 0
function mergeData(previous, incoming, user) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))
    throw new Error('Invalid data')
  const out = Object.create(null)
  for (const [key, raw] of Object.entries(previous || {}))
    if (baseOf(key, user) && typeof raw === 'string') {
      try {
        decode(raw)
        out[key] = raw
      } catch {}
    }
  for (const [key, raw] of Object.entries(incoming)) {
    const base = baseOf(key, user)
    if (!base || typeof raw !== 'string') throw new Error('Invalid account key')
    const e = decode(raw),
      old = out[key] === undefined ? null : decode(out[key])
    if (
      base.startsWith('checkin_years_v2__entry_') &&
      !e.deleted &&
      !old?.deleted
    ) {
      const days = [
        ...new Set([
          ...(Array.isArray(old?.value) ? old.value : []),
          ...(Array.isArray(e.value) ? e.value : []),
        ]),
      ]
        .filter((x) => Number.isInteger(x) && x >= 0 && x <= 365)
        .sort((a, b) => a - b)
      out[key] = JSON.stringify({
        ...(!old || compare(e, old) > 0 ? e : old),
        value: days,
      })
    } else if (!old || compare(e, old) > 0) out[key] = JSON.stringify(e)
  }
  // A monotonic retention watermark prevents stale devices from restoring pruned AI archives.
  const marker = `myielts_u_${user}_archive_retention_v2`
  const cuts = [previous?.[marker], incoming[marker]]
    .filter(Boolean)
    .map((x) => decode(x).value?.cutoff)
    .filter((x) => Array.isArray(x) && x.length === 3)
  cuts.sort(
    (a, b) =>
      a[0] - b[0] ||
      String(a[1]).localeCompare(String(b[1])) ||
      String(a[2]).localeCompare(String(b[2])),
  )
  let cutoff = cuts.at(-1)
  const entries = Object.keys(out)
    .filter((k) => archive(baseOf(k, user)))
    .map((key) => ({ key, e: decode(out[key]) }))
    .sort((a, b) => compare(b.e, a.e) || b.key.localeCompare(a.key))
  let bytes = 0,
    kept = 0
  for (const { key, e } of entries) {
    bytes += Buffer.byteLength(out[key])
    kept++
    if ((kept > 30 || bytes > 1048576) && (!cutoff || !past(key, e, cutoff)))
      cutoff = [...e.stamp, key]
  }
  if (cutoff) {
    for (const { key, e } of entries) if (past(key, e, cutoff)) delete out[key]
    const current = out[marker] ? decode(out[marker]) : null
    if (JSON.stringify(current?.value?.cutoff) !== JSON.stringify(cutoff))
      out[marker] = JSON.stringify({
        __ielts: 2,
        stamp: [
          Math.max(Date.now(), (current?.stamp[0] || 0) + 1),
          'server-retention',
        ],
        value: { cutoff },
      })
  }
  const migration = out[`myielts_u_${user}_migration_version_v2`]
  if (migration && decode(migration).value === 2) {
    // The transaction stores the pre-upgrade blob in sync_backups before dropping legacy tables.
    for (const key of Object.keys(out)) {
      const base = baseOf(key, user)
      if (
        collectionBases.includes(base) ||
        legacyBases.includes(base) ||
        base.startsWith('study_time_v1_')
      )
        delete out[key]
    }
  }
  const cutoffDay = Date.now() - 14 * 86400000
  for (const key of Object.keys(out)) {
    const base = baseOf(key, user),
      e = decode(out[key])
    if (
      (base.startsWith('daily_parts_v2__entry_') ||
        base.startsWith('daily_resets_v2__entry_') ||
        base.startsWith('timer_sessions_v2__entry_')) &&
      e.value?.date &&
      new Date(e.value.date).getTime() < cutoffDay
    )
      delete out[key]
    if (base.startsWith('stats_parts_v2__entry_') && e.value?.days) {
      const value = JSON.parse(JSON.stringify(e.value))
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - 13)
      for (const date of Object.keys(value.days))
        if (new Date(date).getTime() < d.getTime()) delete value.days[date]
      out[key] = JSON.stringify({ ...e, value })
    }
    if (base.startsWith('flashcard_checkin_v1__entry_')) {
      const encoded = base.split('__entry_')[1],
        date = encoded
          .match(/.{4}/g)
          .map((x) => String.fromCharCode(parseInt(x, 16)))
          .join('')
      if (new Date(date).getTime() < Date.now() - 90 * 86400000) delete out[key]
    }
  }
  return out
}
module.exports = { protocolVersion, baseOf, decode, compare, mergeData }
