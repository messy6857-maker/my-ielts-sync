const test = require('node:test')
const assert = require('node:assert/strict')
const { mergeData,decode } = require('../sync-protocol')
process.env.DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ielts-regression-'))
process.env.JWT_SECRET = 'local-regression-secret'
const { isPrivateOrReservedIp } = require('../server')
const entry = (base,id) => `myielts_u_alice_${base}__entry_${[...id].map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')}`
const raw = (value,deleted=false) => JSON.stringify({__ielts:2,stamp:[1,'writer'],...(deleted?{deleted:true}:{value})})
test('expired dated tombstones and resets are not retained or resurrected',()=>{
 const keys=[entry('daily_parts_v2','vocabulary|2020-1-1|word|old'),entry('daily_resets_v2','vocabulary|2020-1-1'),entry('timer_sessions_v2','old:2020-1-1')]
 const payload=Object.fromEntries(keys.map(key=>[key,raw(undefined,true)]))
 assert.deepEqual(Object.keys(mergeData({},payload,'alice')),[])
})
test('history watermarks cap collections and reject stale reuploads',()=>{
 const payload=Object.fromEntries(Array.from({length:60},(_,i)=>[entry('task1_essays_v1',String(1700000000000+i)),raw({text:'essay'})]))
 const merged=mergeData({},payload,'alice')
 assert.equal(Object.keys(merged).filter(k=>k.includes('__entry_')).length,50)
 assert.deepEqual(mergeData(merged,payload,'alice'),merged)
})
test('new per-word spelling records preserve independent chapters',()=>{
 const a=entry('vocabulary_spell_v2','chapterA|1'),b=entry('vocabulary_spell_v2','chapterB|2')
 const merged=mergeData({[a]:raw('first')},{[b]:raw('second')},'alice')
 assert.equal(decode(merged[a]).value,'first');assert.equal(decode(merged[b]).value,'second')
})
test('full IPv4-mapped IPv6 and NAT64 private addresses are refused',()=>{
 for(const ip of ['0:0:0:0:0:ffff:7f00:1','0:0:0:0:0:ffff:a00:1','64:ff9b::7f00:1','64:ff9b::a00:1']) assert.equal(isPrivateOrReservedIp(ip),true,ip)
 assert.equal(isPrivateOrReservedIp('64:ff9b::808:808'),false)
})
