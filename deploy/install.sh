#!/usr/bin/env bash
# my-ielts sync server 一键部署（Debian 12）
# 用法：把 my-ielts-sync 目录传到 VPS 后，执行 sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/my-ielts-sync
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"
SYNC_PORT="${PORT:-3001}"
[[ "$SYNC_PORT" =~ ^[0-9]+$ ]] && (( SYNC_PORT >= 1 && SYNC_PORT <= 65535 )) || { echo "PORT 必须为 1–65535"; exit 1; }

echo "==> 1/5 安装 Node.js 22"
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  NODE_MAJOR=$(node --version | cut -d. -f1 | tr -dc '0-9')
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "检测到 Node $NODE_MAJOR，升级到 Node 22（需要内置 SQLite）"
    NEED_NODE=1
  fi
fi
if [ "$NEED_NODE" = 1 ]; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node --version

echo "==> 2/5 安装 Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
caddy version

echo "==> 3/5 部署应用到 $APP_DIR"
mkdir -p "$APP_DIR/data"
cp "$SRC_DIR/server.js" "$SRC_DIR/sync-protocol.js" "$SRC_DIR/retention.js" "$SRC_DIR/stats-archive.js" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$APP_DIR/"
cd "$APP_DIR"
# 仅安装纯 JS 依赖（无 native 模块）；如已有 node_modules 则先清理，避免残留 better-sqlite3
rm -rf node_modules/better-sqlite3
npm ci --omit=dev --no-audit --no-fund -qq
echo "==> 3.5/5 自检：SQLite + 服务启动冒烟测试"
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t(a)');
console.log('node:sqlite OK');
"

CONFIG_BACKUP_DIR=$(mktemp -d)
[ ! -f /etc/my-ielts-sync.env ] || cp /etc/my-ielts-sync.env "$CONFIG_BACKUP_DIR/env"
[ ! -f /etc/systemd/system/my-ielts-sync.service ] || cp /etc/systemd/system/my-ielts-sync.service "$CONFIG_BACKUP_DIR/service"
APP_WAS_ACTIVE=0
if systemctl is-active --quiet my-ielts-sync; then APP_WAS_ACTIVE=1; fi
CADDY_CANDIDATE=$(mktemp)
trap 'rm -f "$CADDY_CANDIDATE"; rm -rf "$CONFIG_BACKUP_DIR"' EXIT
sed "s/__SYNC_PORT__/$SYNC_PORT/g" "$SCRIPT_DIR/Caddyfile" > "$CADDY_CANDIDATE"
caddy validate --config "$CADDY_CANDIDATE" --adapter caddyfile

echo "==> 4/5 配置 systemd 服务"
ENV_CANDIDATE="$CONFIG_BACKUP_DIR/new-env"
if [ -f /etc/my-ielts-sync.env ]; then
  sed '/^[[:space:]]*PORT=/d' /etc/my-ielts-sync.env > "$ENV_CANDIDATE"
fi
printf '\nPORT=%s\n' "$SYNC_PORT" >> "$ENV_CANDIDATE"
install -m 600 "$ENV_CANDIDATE" /etc/my-ielts-sync.env
cp "$SCRIPT_DIR/my-ielts-sync.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now my-ielts-sync
# enable --now 对已运行服务是 no-op：重跑时必须显式 restart，新代码才真正生效
systemctl restart my-ielts-sync
sleep 2
systemctl is-active --quiet my-ielts-sync && echo "sync server 运行中" || { echo "sync server 启动失败"; journalctl -u my-ielts-sync --no-pager -n 20; exit 1; }
# 健康校验：服务须真正响应（service 文件默认 PORT=3001、只绑 127.0.0.1；
# 若改过 service 的 Environment=PORT，跑脚本时用同一 PORT=... 前缀传入）
HEALTH_PORT="$SYNC_PORT"
curl -fsS "http://127.0.0.1:${HEALTH_PORT}/api/health" >/dev/null || { echo "sync server 健康检查失败"; journalctl -u my-ielts-sync --no-pager -n 20; exit 1; }
echo "sync server 健康检查通过"

echo "==> 5/5 配置 Caddy 反向代理 + 自动 HTTPS"
# 先备份 VPS 现有 Caddyfile 再覆盖，避免抹掉仓库版之外的本地定制
CADDY_BACKUP="/etc/caddy/Caddyfile.bak-$(date +%F-%H%M%S)"
if [ -f /etc/caddy/Caddyfile ]; then cp /etc/caddy/Caddyfile "$CADDY_BACKUP"; fi
cp "$CADDY_CANDIDATE" /etc/caddy/Caddyfile
if ! systemctl reload caddy; then
  if [ -f "$CONFIG_BACKUP_DIR/env" ]; then
    cp "$CONFIG_BACKUP_DIR/env" /etc/my-ielts-sync.env
  else rm -f /etc/my-ielts-sync.env; fi
  if [ -f "$CONFIG_BACKUP_DIR/service" ]; then
    cp "$CONFIG_BACKUP_DIR/service" /etc/systemd/system/my-ielts-sync.service
  else rm -f /etc/systemd/system/my-ielts-sync.service; fi
  systemctl daemon-reload
  if [ "$APP_WAS_ACTIVE" = 1 ]; then systemctl restart my-ielts-sync; else systemctl stop my-ielts-sync; fi
  if [ -f "$CADDY_BACKUP" ]; then
    cp "$CADDY_BACKUP" /etc/caddy/Caddyfile
    if ! systemctl reload caddy; then echo "恢复原 Caddyfile 后再次重载失败，请立即检查 Caddy 日志"; exit 1; fi
  else
    rm -f /etc/caddy/Caddyfile
    echo "此前无 Caddyfile，已移除本次新增配置；请检查现有 Caddy 运行状态"
  fi
  echo "Caddy 重载失败，已尝试恢复原配置"; exit 1
fi
sleep 3

echo ""
echo "部署完成，检查健康状态："
if ! curl -fsS --retry 10 --retry-delay 5 --retry-all-errors https://104-233-149-98.sslip.io/api/health; then
  echo "应用已启动且本机健康检查通过，但 HTTPS 部署验证尚未通过；可能仍在签发证书，请检查 Caddy 日志并单独重试 HTTPS 健康检查，无需重新安装。"
  exit 2
fi
