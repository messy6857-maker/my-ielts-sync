# my-ielts sync server

my-ielts 网站的多设备同步后端：账号注册/登录 + 学习数据云同步。

## 架构

- Node.js 22 + Express + 内置 node:sqlite（零 native 依赖、零外部数据库）
- 密码 bcrypt 哈希，JWT 登录态（30 天）
- 数据模型：每用户一组带版本 stamp 的学习条目（`myielts_u_<username>_*`），协议 2 按条目逐条合并（戳大者胜，删除为版本化条目）
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
PORT=3001 node --experimental-sqlite server.js
```

## 部署到 VPS（Debian 12）

```bash
# 把本目录传到 VPS（如 /root/my-ielts-sync），然后：
sudo bash deploy/install.sh
```

脚本会：装 Node 22 + Caddy → 部署到 /opt/my-ielts-sync → 注册 systemd 服务并启动 → 配置 Caddy 反向代理 `104-233-149-98.sslip.io`（自动申请 HTTPS 证书）。

重跑安全（幂等）：脚本可重复执行，不会丢数据——数据目录 `data/`（含 `sync.db` 与 JWT 密钥）只 `mkdir -p` 不覆盖；重跑前先备份 VPS 现有 Caddyfile（`Caddyfile.bak-日期时间`），再覆盖；服务先 `enable --now` 再显式 `restart`（`enable --now` 对已运行服务是 no-op，不 restart 则旧代码继续跑）；最后做健康校验。健康校验默认查 `127.0.0.1:3001`（由 `/etc/my-ielts-sync.env` 提供给 systemd，与 Caddy 模板及健康检查共用同一端口）；若改过 service 的端口，跑脚本时用同一值传入，如 `PORT=3002 sudo -E bash deploy/install.sh`。

健康检查：`curl -sk https://104-233-149-98.sslip.io/api/health`

## 前端对接

前端 `src/sync-config.ts` 中的 `SYNC_API_BASE` 指向 `https://104-233-149-98.sslip.io/api` 即开启云同步；留空则回退到纯本地模式。

## 同步协议 2 升级

前端与本后端需要配套升级。PUT /api/sync 必须带 protocolVersion: 2；旧客户端写入返回 426，防止整包覆盖。新前端遇到旧服务时保留本机记录并停止上传，更新服务后可手动点击同步恢复。

每个学习条目带版本 stamp，服务器在 SQLite BEGIN IMMEDIATE 事务中合并，删除也是版本化条目。首次升级写入前，原始整包保存在 sync_backups 表（每账号一份，不覆盖）。存量原始表仅在客户端确认迁移完成后移除；凭据、API Key 和草稿不进入同步白名单。

跳过与 rejected 回报：PUT 时单个非法条目不再让整包 400 回滚——服务端跳过它、照常合并好条目，并在响应里回 `rejected: [{ key, reason }]`，原因分三类：`unknown-base`（未知或跨账号 base）、`non-string`（原始值非字符串）、`decode-failed`（版本戳非法）。跨账号键不再 400，而是 200 + rejected（调用方只会发本账号键，跨账号只对手工请求可达）。客户端约定：收到 rejected 的键记入本机隔离表，不再随包上传，并在设置页琥珀区提示；本地值重写后自动解封，7 天后重探一次；设置页可单键解除，解除后主动再推一次。旧客户端/旧服务端混用窗口：新客户端同时兼容 `rejected` 的 string[] 旧形状与对象新形状；旧客户端收到对象形状时无法隔离（只会循环重推，不丢数据），新增数据表时应先升级后端白名单，再发布前端；若曾被旧后端隔离，升级后可在设置页解除隔离并重新同步。

限流：注册/登录按 IP 限流（`trust proxy 1`，只信任本机 Caddy）；AI 中转与 `/api/sync` 按账号 uid 限流（`/api/sync` 600 次/15 分钟，远高于正常同步频率）；AI 中转白名单只放 `api-cdn.thehive.ai`（校验前去 hostname 尾点），且 fetch 前若 DNS 明确解析到私有/保留段则拒绝，DNS 解析失败时不拦截。

部署时必须同时复制 server.js、sync-protocol.js、retention.js、package.json、package-lock.json；安装脚本已包含这五个文件。Node 22.13+（建议 24），依赖用 npm ci 安装。运行 npm test 验证协议、HTTP 路由和真实内存 SQLite。此提交没有执行部署或改动 VPS。

## 2026-10-31 配套更新

- 客户端分批上传，遇到 413 自动缩小批次。服务端仍保留 5MiB 请求和账号容量约束；单条超过客户端 4MiB 上限时保留本机原文、隔离提示，不阻塞其他记录。
- `vocabulary_spell_v2` 按章节/词存储，`collection_retention_v3` 保存单调递增的历史回收水位。前后端按日期键识别旧 daily/reset/timer 删除信封，14 天后丢弃；旧打卡明细保留 90 天，历史仍保存在年度集合。统计累计不裁剪。
- 历史回收最多保留 100 个模考有效记录和每类 50 篇作文；删除记录也受有界身份水位约束，避免删除历史无限重传。回收水位不允许旧设备把早于水位的数据复活。未带日期的活跃统计作者累计与词条删除标记不按 TTL 擅自删除。
- GET 缓存为 60 秒 TTL、最多 100 账号的 LRU；完全相同的 PUT 不改 SQLite 数据版本。AI fetch 禁止重定向，IPv6 mapped/NAT64 私网地址按内嵌 IPv4 检查。
- `sudo PORT=3002 bash deploy/install.sh` 会同时生成 systemd 环境文件、Caddy 端口及健康检查地址。先 `caddy validate`，重载失败时恢复 Caddyfile 备份。仓库内 Caddyfile 为模板，请通过安装脚本生成，不能直接复制占位符到线上。

本轮仅修改及验证源码，没有连接或部署 VPS。
