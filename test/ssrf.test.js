const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'),
  os = require('os'),
  path = require('path')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ielts-ssrf-test-'))
process.env.DATA_DIR = dir
process.env.JWT_SECRET = 'local-test-secret'
process.env.CRON_TOKEN = 'local-cron-test'
const { normalizeAiHost, isPrivateOrReservedIp } = require('../server')

test('ai allowlist hostname drops a trailing dot instead of misrejecting', () => {
  assert.equal(normalizeAiHost('api-cdn.thehive.ai.'), 'api-cdn.thehive.ai')
  assert.equal(normalizeAiHost('api-cdn.thehive.ai'), 'api-cdn.thehive.ai')
  assert.equal(normalizeAiHost('evil.com.'), 'evil.com')
})

test('private/reserved IP classification (pure function)', () => {
  const blocked = [
    '10.0.0.1',
    '172.16.0.5',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc00::abcd',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
  ]
  for (const ip of blocked)
    assert.equal(isPrivateOrReservedIp(ip), true, ip)
  const allowed = [
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '192.0.3.1',
    '198.51.101.1',
    '203.0.114.1',
    '100.128.0.1',
    '11.0.0.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ]
  for (const ip of allowed)
    assert.equal(isPrivateOrReservedIp(ip), false, ip)
  assert.equal(isPrivateOrReservedIp('not-an-ip'), false)
  assert.equal(isPrivateOrReservedIp(''), false)
  fs.rmSync(dir, { recursive: true, force: true })
})
