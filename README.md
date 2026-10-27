# my-ielts sync server

my-ielts 网站的多设备同步后端：账号注册/登录 + 学习数据云同步。

## 架构

- Node.js 22 + Express + 内置 node:sqlite（零 native 依赖、零外部数据库）
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

## 同步协议 2 升级

前端与本后端需要配套升级。PUT /api/sync 必须带 protocolVersion: 2；旧客户端写入返回 426，防止整包覆盖。新前端遇到旧服务时保留本机记录并停止上传，更新服务后可手动点击同步恢复。

每个学习条目带版本 stamp，服务器在 SQLite BEGIN IMMEDIATE 事务中合并，删除也是版本化条目。首次升级写入前，原始整包保存在 sync_backups 表（每账号一份，不覆盖）。存量原始表仅在客户端确认迁移完成后移除；凭据、API Key 和草稿不进入同步白名单。

部署时必须同时复制 server.js、sync-protocol.js、package.json、package-lock.json；安装脚本已包含这四个文件。Node 22.13+（建议 24），依赖用 npm ci 安装。运行 npm test 验证协议、HTTP 路由和真实内存 SQLite。此提交没有执行部署或改动 VPS。
