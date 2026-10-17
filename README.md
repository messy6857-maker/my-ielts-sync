# my-ielts sync server

my-ielts 网站的多设备同步后端：账号注册/登录 + 学习数据云同步。

## 架构

- Node.js + Express + better-sqlite3（零外部依赖数据库）
- 密码 bcrypt 哈希，JWT 登录态（30 天）
- 数据模型：每用户一个 JSON blob（`myielts_u_<username>_*` 的 localStorage 快照），整体覆盖、last-write-wins
- Caddy 反向代理 + Let's Encrypt 自动 HTTPS

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/register | {username, password} → {token} |
| POST | /api/login | {username, password} → {token} |
| GET | /api/sync | 拉取数据 → {data, updatedAt}（需 Bearer token） |
| PUT | /api/sync | 推送数据 {data}（需 Bearer token） |
| GET | /api/health | 健康检查 |

## 本地开发

```bash
npm install
PORT=3001 node server.js
```

## 部署到 VPS（Debian 12）

```bash
# 把本目录传到 VPS（如 /root/my-ielts-sync），然后：
sudo bash deploy/install.sh
```

脚本会：装 Node 20 + Caddy → 部署到 /opt/my-ielts-sync → 注册 systemd 服务并启动 → 配置 Caddy 反向代理 `38-64-63-20.sslip.io`（自动申请 HTTPS 证书）。

健康检查：`curl -sk https://38-64-63-20.sslip.io/api/health`

## 前端对接

前端 `src/sync-config.ts` 中的 `SYNC_API_BASE` 指向 `https://38-64-63-20.sslip.io/api` 即开启云同步；留空则回退到纯本地模式。
