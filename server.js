// my-ielts sync server: 账号 + 学习数据多设备同步
// 跑法: node --experimental-sqlite server.js  (Node 22+)
// 数据: ./data/sync.db (SQLite，Node 内置 node:sqlite，零 native 依赖)

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { DatabaseSync } = require('node:sqlite')
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const PORT = Number(process.env.PORT || 3001)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const CRON_TOKEN = process.env.CRON_TOKEN || ''
fs.mkdirSync(DATA_DIR, { recursive: true })

// JWT 密钥：环境变量优先，否则生成并落盘
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret')
let JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } else {
    JWT_SECRET = crypto.randomBytes(48).toString('hex')
    fs.writeFileSync(SECRET_FILE, JWT_SECRET, { mode: 0o600 })
    console.log('generated new JWT secret')
  }
}

const db = new DatabaseSync(path.join(DATA_DIR, 'sync.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_data (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS daily_readings (
    date TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (date, user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`)

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/

const app = express()
app.use(cors()) // 前端在 GitHub Pages，允许跨域
app.use(express.json({ limit: '5mb' })) // 学习数据 blob 上限 5MB

// 登录/注册接口限流：防爆破
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 })

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

app.post('/api/register', authLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  if (!USERNAME_RE.test(username))
    return res.status(400).json({ ok: false, message: '用户名需为 2-20 位字母、数字、下划线或中文' })
  if (password.length < 4)
    return res.status(400).json({ ok: false, message: '密码至少 4 位' })
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists)
    return res.status(409).json({ ok: false, message: '用户名已存在，换一个吧' })
  const hash = await bcrypt.hash(password, 10)
  const result = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, hash, Date.now())
  const token = jwt.sign({ uid: Number(result.lastInsertRowid), username }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ ok: true, token, username })
})

app.post('/api/login', authLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user)
    return res.status(401).json({ ok: false, message: '用户不存在，请先注册' })
  const match = await bcrypt.compare(password, user.password_hash)
  if (!match)
    return res.status(401).json({ ok: false, message: '密码不正确' })
  const token = jwt.sign({ uid: user.id, username }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ ok: true, token, username })
})

function auth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token)
    return res.status(401).json({ ok: false, message: '未登录' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ ok: false, message: '登录已过期，请重新登录' })
  }
}

// 拉取： whole blob
app.get('/api/sync', auth, (req, res) => {
  const row = db.prepare('SELECT data, updated_at FROM sync_data WHERE user_id = ?').get(req.user.uid)
  if (!row)
    return res.json({ ok: true, data: null, updatedAt: 0 })
  res.json({ ok: true, data: JSON.parse(row.data), updatedAt: row.updated_at })
})

// 推送： whole blob 整体覆盖（last-write-wins）
// 定时任务专用：获取某用户某天学过的单词 ID（只读，需 X-Cron-Token）
// studiedAt 用 dueAt - interval 反推；date 为北京时间 YYYY-MM-DD
// 定时任务专用：列出所有用户名（只读，需 X-Cron-Token），用于按账号生成每日阅读
app.get('/api/cron/users', (req, res) => {
  const token = req.headers['x-cron-token']
  if (!CRON_TOKEN || token !== CRON_TOKEN)
    return res.status(401).json({ ok: false, message: 'unauthorized' })
  const rows = db.prepare('SELECT username FROM users ORDER BY username').all()
  res.json({ ok: true, count: rows.length, users: rows.map(r => r.username) })
})
// 定时任务专用：存入某用户某天的词汇阅读（只读，需 X-Cron-Token）
app.post('/api/cron/daily-reading', (req, res) => {
  const token = req.headers['x-cron-token']
  if (!CRON_TOKEN || token !== CRON_TOKEN)
    return res.status(401).json({ ok: false, message: 'unauthorized' })
  const { username, date, reading } = req.body || {}
  if (!username || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !reading || typeof reading !== 'object')
    return res.status(400).json({ ok: false, message: '需要 username、date(YYYY-MM-DD)、reading' })
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (!user)
    return res.status(404).json({ ok: false, message: '用户不存在' })
  db.prepare(`INSERT INTO daily_readings (date, user_id, data, created_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(date, user_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`)
    .run(date, user.id, JSON.stringify(reading), Date.now())
  res.json({ ok: true })
})
// 用户取自己的词汇阅读（需登录 JWT，只能拿自己的）
app.get('/api/daily-reading', auth, (req, res) => {
  const { date } = req.query
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ ok: false, message: '需要 date(YYYY-MM-DD)' })
  const row = db.prepare('SELECT data FROM daily_readings WHERE date = ? AND user_id = ?').get(date, req.user.uid)
  if (!row)
    return res.json({ ok: true, date, reading: null })
  res.json({ ok: true, date, reading: JSON.parse(row.data) })
})
app.get('/api/cron/studied-words', (req, res) => {
  const token = req.headers['x-cron-token']
  if (!CRON_TOKEN || token !== CRON_TOKEN)
    return res.status(401).json({ ok: false, message: 'unauthorized' })
  const { username, date } = req.query
  if (!username || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ ok: false, message: '需要 username 和 date(YYYY-MM-DD)' })
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (!user)
    return res.status(404).json({ ok: false, message: '用户不存在' })
  const row = db.prepare('SELECT data FROM sync_data WHERE user_id = ?').get(user.id)
  if (!row)
    return res.json({ ok: true, date, count: 0, words: [] })
  const blob = JSON.parse(row.data)
  const sched = JSON.parse(blob[`myielts_u_${username}_sr_vocabulary_v1`] || '{}')
  const dayStart = new Date(date + 'T00:00:00+08:00').getTime()
  const dayEnd = dayStart + 86400000
  const words = []
  for (const [id, s] of Object.entries(sched)) {
    if (!s || typeof s.dueAt !== 'number' || typeof s.interval !== 'number')
      continue
    const studiedAt = s.dueAt - s.interval * 86400000
    if (studiedAt >= dayStart && studiedAt < dayEnd)
      words.push(id)
  }
  res.json({ ok: true, date, count: words.length, words })
})

app.put('/api/sync', auth, (req, res) => {
  const data = req.body?.data
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return res.status(400).json({ ok: false, message: '数据格式不正确' })
  const now = Date.now()
  db.prepare(`
    INSERT INTO sync_data (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.user.uid, JSON.stringify(data), now)
  res.json({ ok: true, updatedAt: now })
})

// AI 中转：浏览器直连第三方 API 会被 CORS 拦截，走服务端转发
// 仅 messy 可用（与前端 AI 批改权限一致）
app.post('/api/ai/chat', auth, async (req, res) => {
  if (req.user.username !== 'messy')
    return res.status(403).json({ ok: false, message: 'AI 功能仅限站长账号使用' })
  const { baseUrl, apiKey, model, messages, temperature } = req.body || {}
  if (!baseUrl || !apiKey || !model || !Array.isArray(messages))
    return res.status(400).json({ ok: false, message: '缺少 baseUrl/apiKey/model/messages' })
  // 只允许 https 地址
  let url
  try {
    url = new URL(baseUrl.replace(/\/+$/, '') + '/chat/completions')
    if (url.protocol !== 'https:')
      throw new Error('only https')
  } catch {
    return res.status(400).json({ ok: false, message: 'API 地址不合法' })
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ model, messages, temperature: temperature ?? 0.3 }),
      signal: AbortSignal.timeout(120000),
    })
    const data = await r.json().catch(() => null)
    if (!r.ok)
      return res.status(r.status).json({ ok: false, message: 'AI 接口返回 ' + r.status, data })
    res.json({ ok: true, data })
  } catch (e) {
    res.status(502).json({ ok: false, message: 'AI 接口请求失败' })
  }
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`my-ielts sync server listening on 127.0.0.1:${PORT}`)
})
