#!/usr/bin/env bash
# my-ielts sync server 一键部署（Debian 12）
# 用法：把 my-ielts-sync 目录传到 VPS 后，执行 sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/my-ielts-sync
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$(dirname "$SCRIPT_DIR")"

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
cp "$SRC_DIR/server.js" "$SRC_DIR/sync-protocol.js" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$APP_DIR/"
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

echo "==> 4/5 配置 systemd 服务"
cp "$SCRIPT_DIR/my-ielts-sync.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now my-ielts-sync
sleep 2
systemctl is-active --quiet my-ielts-sync && echo "sync server 运行中" || { echo "sync server 启动失败"; journalctl -u my-ielts-sync --no-pager -n 20; exit 1; }

echo "==> 5/5 配置 Caddy 反向代理 + 自动 HTTPS"
cp "$SCRIPT_DIR/Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
sleep 3

echo ""
echo "部署完成，检查健康状态："
curl -sk https://104-233-149-98.sslip.io/api/health || echo "（证书申请中，稍等 1-2 分钟再试）"
