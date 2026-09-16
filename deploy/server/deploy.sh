#!/usr/bin/env bash
# TestDeck 服务器更新脚本：把 .env 里的两个镜像 tag 换成指定版本，然后拉取并重启。
#
# 用法（在服务器上执行）：
#   ./deploy.sh v0.1.3                     # 部署指定版本
#   ./deploy.sh                            # 只按 .env 里当前的 tag 拉取最新镜像
#   ./deploy.sh v0.1.3 /home/ubuntu/testdeck
#
# 脚本只改 .env 里的 WEB_IMAGE/API_IMAGE 两行，改动前留一份带时间戳的备份。
# 数据库卷、截图卷和管理员账号都不受影响；迁移由 migrate 服务自动执行。
set -euo pipefail

TAG="${1:-}"
DIR="${2:-/home/ubuntu/testdeck}"

cd "$DIR"

if [ -n "$TAG" ]; then
  backup=".env.bak-$(date +%Y%m%d-%H%M%S)"
  cp .env "$backup"
  sed -i -E \
    -e "s|^(WEB_IMAGE=ghcr\.io/[^:]+):.*$|\1:${TAG}|" \
    -e "s|^(API_IMAGE=ghcr\.io/[^:]+):.*$|\1:${TAG}|" \
    .env
  echo "镜像 tag 已改为 ${TAG}（原 .env 备份为 ${backup}）"
fi

grep -E '^(WEB_IMAGE|API_IMAGE)=' .env

sudo docker compose --env-file .env -f docker-compose.yml up -d --pull always
sudo docker compose --env-file .env -f docker-compose.yml ps

echo "等待健康检查…"
for _ in $(seq 1 30); do
  if curl -fsS -m 5 https://testdeck.gleaftex.com/health/ready >/dev/null; then
    echo "健康检查通过：$(curl -fsS -m 5 https://testdeck.gleaftex.com/health/ready)"
    exit 0
  fi
  sleep 5
done

echo "健康检查未通过，请查看日志：" >&2
echo "  sudo docker compose --env-file .env -f docker-compose.yml logs --tail=100 migrate api web" >&2
exit 1
