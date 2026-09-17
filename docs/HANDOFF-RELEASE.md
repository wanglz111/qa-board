# TestDeck 更新 → 发版 → 服务器部署 Handoff

一句话流程：**本地改代码 → 测试 → 合并到 `main` → 打版本 tag 推送 → GitHub Actions 构建并推送镜像到 GHCR → 在服务器上把 `.env` 的两个 tag 改成新版本，`docker compose up -d --pull always`**。

只想发版时可以直接跳到 [第 4 节](#4-一次完整发版复制粘贴)。

## 1. 环境与地址

| 项目 | 值 |
| --- | --- |
| 服务器 | `ubuntu@43.167.241.33`（`sudo` 免密） |
| 登录命令 | `ssh -i ~/.ssh/id_ed25519_github_wanglz111 ubuntu@43.167.241.33` |
| 部署目录 | `/home/ubuntu/testdeck`（只有 `docker-compose.yml` 和 `.env` 两个文件） |
| 镜像 | `ghcr.io/wanglz111/qa-board-api`、`ghcr.io/wanglz111/qa-board-web`（GHCR 包已设为 public，服务器无需 `docker login`） |
| 代码仓库 | `git@github.com:wanglz111/qa-board.git`（public；本机 `origin` 目前仍是 https，见第 4.1 节） |
| 域名 | `https://testdeck.gleaftex.com`（Cloudflare 橙云代理） |
| 边缘代理 | 服务器上已有的 `nginx-proxy` 容器：compose 项目 `nginx`，目录 `/root/nginx`，配置 `/root/nginx/nginx.conf`（挂到容器 `/etc/nginx/conf.d/default.conf`），只发布 80 端口 |
| 共享网络 | `monitor_net`（`nginx` 项目创建的外部网络；TestDeck 的 `web` 容器同时加入它） |
| TestDeck 容器 | `testdeck-web`（Caddy，SPA + 同源反代 `/api`）、`testdeck-api-1`、`testdeck-worker-1`、`testdeck-db-1` |

服务器上**不克隆仓库、不构建镜像、不挂载其他项目目录**；升级只换镜像 tag。

请求链路：浏览器 → Cloudflare（HTTPS）→ nginx-proxy:80（`server_name testdeck.gleaftex.com`）→ `testdeck-web:8080` →（同源 `/api`）→ `testdeck-api:8080` → `db` / Lark。

## 2. 服务器上的文件

本仓库的 `deploy/server/` 是服务器那两个文件的可信副本，改了服务器配置后请同步回这里：

| 仓库文件 | 服务器位置 | 作用 |
| --- | --- | --- |
| `deploy/server/docker-compose.yml` | `/home/ubuntu/testdeck/docker-compose.yml` | 定义 db / migrate / api / worker / web，无 `build:`、不对外发布端口 |
| `deploy/server/env.template` | `/home/ubuntu/testdeck/.env` | 唯一的配置与密钥文件，权限 0600，不进 Git |
| `deploy/server/deploy.sh` | 可选，`scp` 到 `/home/ubuntu/testdeck/deploy.sh` | 改 tag → 拉镜像 → 重启 → 健康检查一条命令完成 |

`.env` 里真正被读取的变量只有：`WEB_IMAGE`、`API_IMAGE`、`DATABASE_PASSWORD`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`CSRF_SECRET`、`LARK_BASE_URL`、`LARK_APP_ID`、`LARK_APP_SECRET`。
执行表与缺陷表已经**不在环境变量里**：管理员在每个测试组的「Lark 检查」页面选择并确认（v0.1.2 起）。旧变量（`LARK_APP_TOKEN`、`LARK_BUG_APP_TOKEN`、`LARK_TABLE_RUNS`、`LARK_TABLE_DEFECTS`）可以留着，代码不读。

## 3. 账号

- 登录地址：`https://testdeck.gleaftex.com`，只有一个管理员，没有注册入口。
- 账号与密码在服务器 `/home/ubuntu/testdeck/.env` 的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`。
- `ADMIN_PASSWORD` **只在第一次启动、数据库里还没有管理员时生效**；之后改 `.env` 无效（`bootstrap` 是幂等的，重启不会覆盖已有管理员）。
- 忘记密码时直接改数据库里的 argon2 哈希（管理员是 `admins` 里的单例行 `singleton_key = 1`）：

```bash
cd /home/ubuntu/testdeck
sudo docker compose --env-file .env -f docker-compose.yml exec -T api python - <<'PY'
from argon2 import PasswordHasher
from sqlalchemy import update
from sqlalchemy.orm import Session
from app.db import engine
from app.models import Admin

with Session(engine) as session:
    session.execute(update(Admin).values(password_hash=PasswordHasher().hash("新的强密码")))
    session.commit()
print("password updated")
PY
```

改完密码后，之前发出去的会话 cookie 仍然有效到 8 小时过期（`SESSION_TTL_SECONDS` 默认 28800）。

## 4. 一次完整发版（复制粘贴）

### 4.1 本地：验证 → 合并 → 打 tag

```bash
cd /home/lucascool/qa-board

# 1) 分支与合并（当前 main 是 feature/cloud-testdeck 的祖先，所以是快进合并）
git checkout main
git merge --ff-only feature/cloud-testdeck

# 2) 和 CI 一致的验证（后端需要一个本地 PostgreSQL 测试库）
cd backend
TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest -q          # 期望 310 passed
cd ../frontend
npx vitest run                            # 期望 112 passed
npm run build
cd ..

# 3) 推送 main 和版本 tag（推送 tag 才会触发镜像发布）
git push origin main
git tag -a v0.1.4 -m "v0.1.4"
git push origin v0.1.4
```

推送偶发失败时的可用写法（本机 `~/.ssh/config` 里 github.com 的 `ProxyCommand` 指向的本地代理可能没开）：

```bash
GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin main
GIT_SSH_COMMAND="ssh -o ProxyCommand=none" git push origin v0.1.4
```

远端现在是 `main` = `adcf60e`，标签 `v0.1.4`。

### 4.2 GitHub Actions：镜像发布

- 工作流：`.github/workflows/publish.yml`，触发条件是 `push tags: v*` 或手动 `workflow_dispatch`。
- `verify` 任务会跑后端 pytest（带 PostgreSQL service）、前端 vitest + build、`docker compose config`。
- `publish` 任务构建两个镜像并推送两个 tag：`vX.Y.Z` 和 `sha-<commit>`（回滚用 sha tag 也行）。
- 查看：`https://github.com/wanglz111/qa-board/actions`。两个 job 都绿了再动服务器。
- 新版本 tag 推送后 GHCR 包默认沿用该包的可见性（当前 public），服务器不需要登录。

### 4.3 服务器：拉新版本

```bash
ssh -i ~/.ssh/id_ed25519_github_wanglz111 ubuntu@43.167.241.33
cd /home/ubuntu/testdeck

# 备份当前 .env，再改两个镜像 tag
cp .env .env.bak-$(date +%F-%H%M%S)
sed -i -E 's|^(WEB_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.4|; s|^(API_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.4|' .env

# 拉取并重启；migrate 服务会在 db 健康后自动跑 alembic upgrade head + bootstrap
sudo docker compose --env-file .env -f docker-compose.yml up -d --pull always
sudo docker compose --env-file .env -f docker-compose.yml ps
```

服务器上已经放好了 `deploy.sh`，上面三步可以合成一条：`./deploy.sh v0.1.4`。

### 4.4 验收（每次发版都做）

```bash
curl -fsS https://testdeck.gleaftex.com/health/ready          # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://testdeck.gleaftex.com/api/groups   # 401（未登录）
```

然后在浏览器里：登录 → 打开一个测试组 → 确认首页/执行台正常。「Lark 检查」页应显示该组已确认的表名。

## 5. 回滚

```bash
cd /home/ubuntu/testdeck
cp .env .env.bak-$(date +%F-%H%M%S)
sed -i -E 's|^(WEB_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.3|; s|^(API_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.3|' .env
sudo docker compose --env-file .env -f docker-compose.yml up -d --pull always
```

或者直接用 `.env.bak-*` 覆盖回去。迁移只向前：如果新版本带了不兼容的 schema 变更，回滚镜像并不能回滚数据库，这种情况要先恢复备份。

注意 `0011_case_reference_assets` 只新增表和列，回滚到 v0.1.3 不影响旧功能（新表留着不用），但如果线上已经开始导入带图用例包，回滚会丢掉这些图片的入口。

## 6. 备份

```bash
cd /home/ubuntu/testdeck
sudo docker compose --env-file .env -f docker-compose.yml exec -T db \
  pg_dump -U testdeck testdeck | gzip > /home/ubuntu/testdeck/backup-$(date +%F).sql.gz
sudo docker run --rm -v testdeck_screenshots:/data -v /home/ubuntu/testdeck:/backup alpine \
  tar czf /backup/screenshots-$(date +%F).tar.gz -C /data .
```

截图卷名是 `testdeck_screenshots`，数据库卷是 `testdeck_pgdata`；`docker compose down`（不带 `-v`）不会删它们。

## 7. nginx（边缘代理）怎么改

配置文件是 `/root/nginx/nginx.conf`（root 所有，容器 `nginx-proxy`），TestDeck 的 server 块已经加好：

```nginx
server {
    listen 80;
    server_name testdeck.gleaftex.com;
    client_max_body_size 110m;         # 截图 20MB / 用例包 ZIP 100MB + multipart 开销
    location / {
        resolver 127.0.0.11 valid=10s ipv6=off;
        set $testdeck_upstream http://testdeck-web:8080;
        proxy_pass $testdeck_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;   # Cloudflare 已终止 TLS
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

改完 reload（`nginx` 项目在 `/root/nginx`）：

```bash
sudo docker exec nginx-proxy nginx -t
sudo docker exec nginx-proxy nginx -s reload
```

要点：

- `nginx-proxy` 和 `testdeck-web` 必须共用 `monitor_net`，否则 nginx 解析不到 `testdeck-web`。
- `X-Forwarded-Proto: https` + 应用里的 `FORWARDED_ALLOW_IPS=*` 是登录不被当成跨站请求的前提。
- 再加域名就照抄一个 server 块，并把新容器加入 `monitor_net`；改之前先 `cp nginx.conf nginx.conf.bak-$(date +%F)`。注意 `nginx.conf` 是**单文件 bind mount**（挂到容器 `/etc/nginx/conf.d/default.conf`）：`sed -i` 会新建 inode，容器里仍是旧文件，必须 `sudo docker exec nginx-proxy nginx -t` 校验后**重建容器**（`sudo bash -c 'cd /root/nginx && docker compose up -d --force-recreate nginx'`）才生效，只 `nginx -s reload` 不够。
- 上传限制必须 ≥ 应用上限：文本用例 10 MB、截图 20 MB、带图用例包 ZIP 100 MB（均为 MiB）。`client_max_body_size` 要覆盖整个 multipart 请求，当前取 110m 留出边界余量；旧部署若仍是 30m，30–100 MB 的合法用例包会在到达 API 前被 413 拒绝。

Cloudflare 侧只需 `testdeck.gleaftex.com` 的 A 记录指向 `43.167.241.33`，橙云开启；源站只有 80 端口，SSL 模式用 **Flexible**，或改成 Full 并在源站上证书。免费版 Cloudflare 的单请求体上限是 100 MB，因此接近上限的用例包可能被边缘拒绝，需要按实际使用调整计划或把包拆小。

## 8. 常见故障

| 现象 | 排查 |
| --- | --- |
| 502 / 504 | `sudo docker logs --tail=50 nginx-proxy`；`sudo docker compose --env-file .env -f docker-compose.yml ps` 看 `testdeck-web` 是否在跑、是否在 `monitor_net` 上 |
| 登录 403 cross-site | 检查 nginx 是否发了 `X-Forwarded-Proto https`、compose 里 `FORWARDED_ALLOW_IPS` 是否为 `*` |
| 上传大文件失败（413） | 先确认 nginx 的 `client_max_body_size` 已调到 110m，并用 `sudo docker exec nginx-proxy grep client_max_body_size /etc/nginx/conf.d/default.conf` 看**容器内**实际值（改完要 `--force-recreate` 才生效，只 reload 无效）；再确认包/截图本身未超过应用上限（ZIP 100 MB、截图 20 MB），以及 Cloudflare 免费版 100 MB 的请求体上限 |
| 容器起不来 | `sudo docker compose --env-file .env -f docker-compose.yml logs --tail=100 migrate api worker`；常见原因是 `.env` 少了必填变量 |
| 拉镜像 401/403 | GHCR 包被改成了 private，需要 `docker login ghcr.io` 或把包改回 public |
| SSH 突然 `Connection closed by ... port 22` | 短时间并发连接过多触发的限流，等几分钟再连；脚本里请用单条长连接而不是并发 ssh |
| 升级后某组「待同步」变多 | 见下：升级前排队、没有记录目标表指纹的任务会被暂停，需要在「Lark 检查」页对该组点一次「同步重试」 |

## 9. 已知未决项

1. **超时认领可能误认旧行**（`backend/app/lark/outbox.py` 的 `LarkTimeout` 分支）：创建执行记录超时后，如果按用例编号能且只能匹配到一行，就把它当作刚创建的那行认领。若目标表里早就有同编号的行（首次执行的标签就是裸编号 `B-001`），这条记录会被误认，任务显示「已同步」但实际没有新增行。表现：`不通过` 的用例也照常新建缺陷行。修法方向是只认领「可证明是新建的行」（记录时间不早于本次尝试，或排除已存快照的 record id），否则保持 `uncertain` 交人工核对。当前版本保留原行为。
2. Cloudflare 源站只开了 80（Flexible SSL）。想升级成 Full(Strict) 需要在源站加证书或让 nginx 直接上 443。
3. 没有自动部署：tag 推送只发布镜像，服务器更新是手动一条命令（有意如此，避免未经确认自动升级）。

## 10. 这次交付做了什么（v0.1.2）

- 把 `feature/cloud-testdeck` 的 62 个提交合并进 `main`（快进），并打了 `v0.1.2`；此前远端只有 `feature/cloud-testdeck`、`v0.1.0`、`v0.1.1`。
- GitHub Actions 运行 [#3](https://github.com/wanglz111/qa-board/actions/runs/35097363739) 成功：`verify`（后端 pytest + 前端 vitest/build + compose 校验）与两个 `publish` 都是 success，镜像 `v0.1.2` 与 `sha-760d9af` 已推到 GHCR，服务器匿名拉取成功。
- 服务器 `/home/ubuntu/testdeck/` 只放 `docker-compose.yml` + `.env`，从公开 GHCR 镜像拉起 4 个容器，未克隆仓库、未改动其他项目。
- 在既有 `nginx-proxy` 上新增 `testdeck.gleaftex.com` 的 server 块（原配置文件已备份为 `/root/nginx/nginx.conf.bak-20260916`），TestDeck 的 `web` 容器加入 `monitor_net`，两边网络打通。其他 server 块、dozzle、sub2api 等未改动。
- 升级前把服务器原文件备份为 `docker-compose.yml.bak-20260916-204637` 与 `.env.bak-20260916-204637`，并让服务器上的 compose 与本仓库 `deploy/server/docker-compose.yml` 保持一致。

升级后的实测结果（全部在真实域名上跑通）：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、db（healthy）、worker、web 全部是 `ghcr.io/wanglz111/qa-board-*:v0.1.2` |
| 一次性 `migrate` | 退出码 0，日志显示 `0008 -> 0009_lark_targets -> 0010_reconcile_marks` |
| `GET /health/ready` | 200 `{"ok":true}` |
| 匿名 `GET /api/groups` | 401 |
| `GET /api/lark/resolve`（0.1.2 才有的 POST 路由） | 405 |
| 带会话 `GET /api/groups/…/reconcile` | 401（路由存在，要求登录） |
| 管理员登录 + `/api/auth/me` | 200，账号在升级后未被重置 |
| multipart 导入预览（2 条用例的 CSV + CSRF） | 200，正确解析 `B-001` / `B-002` |
| 同一请求去掉 CSRF | 403 `Invalid CSRF token` |
| `GET /` | 200，返回 SPA |

## 11. 这次交付做了什么（v0.1.3）

- 修掉「新建数据表」必然失败的问题：Lark 建表接口要求文本、附件字段的 `property` 为 `null`，而 v0.1.2 发的是 `{}`，`截图` 又是附件字段，Lark 因此回 `code 800074088 Attach field property should be null`。现在建表和建字段两条路径都发 `null`，日期字段保留 `date_formatter` / `auto_fill`。
- 建表失败的报错不再只有 `Lark create failed: HTTPStatusError`：现在带上 HTTP 状态、Lark code 和 Lark 原文，确属权限问题时追加「在开放平台开通多维表格权限并发布，并把应用加为该表的可编辑协作者」的提示。
- 本地验证：后端 `248 passed`，前端 `101 passed` + `npm run build` 通过。
- GitHub Actions 运行 [#35103910826](https://github.com/wanglz111/qa-board/actions/runs/35103910826) 成功：`verify` 与两个 `publish` 都是 success，镜像 `v0.1.3` 与 `sha-1485e9c` 已推到 GHCR。
- 服务器执行 `./deploy.sh v0.1.3`：`.env` 已自动备份，`migrate` 退出码 0（本次没有新迁移），api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.3`。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.3` |
| `GET /health/ready` | 200 `{"ok":true}` |
| 匿名 `GET /api/groups` | 401 |
| 容器内 `table_fields("execution")` | `截图` 的 `property` 是 `None`，`日期` 是 `{"date_formatter": "yyyy/MM/dd", "auto_fill": false}` |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.2`。

## 12. 这次交付做了什么（v0.1.4）

- 把 `feature/image-case-bundle-import` 的 12 个提交合并进 `main`（快进到 `adcf60e`），并打了 `v0.1.4`：带图用例包导入（`casebook.json` + `assets/` 图片树 → 用例组，图片按组去重存盘，执行页展示参考图并可放大）。
- 同一提交里修掉一次独立审计提出的 1 项 P1 + 8 项 P2：放大原型图时 Enter 不再误提交「通过」；显式 `null` 不再被当作缺省；NaN／超大坐标／超 int4 的 `position`／损坏或超像素图片／`.` 这类 ZIP 成员名都改成带字段路径的 422，不再 500 或静默接受；locator 图的 focus 不再丢失；写图失败不再残留半写文件；nginx 上传限制与 100 MB 用例包对齐。
- 本地验证：后端 `310 passed`，前端 `112 passed`（16 文件）+ `npm run build` 通过。
- GitHub Actions 运行 [#35172365259](https://github.com/wanglz111/qa-board/actions/runs/35172365259) 成功：`verify` 与两个 `publish` 都是 success，镜像 `v0.1.4` 与 `sha-adcf60e` 已推到 GHCR。
- 服务器执行 `./deploy.sh v0.1.4`：`.env` 备份为 `.env.bak-20260917-100353`，`migrate` 退出码 0（`0010_reconcile_marks -> 0011_case_reference_assets`），api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.4`。
- 服务器 nginx：`testdeck.gleaftex.com` 的 `client_max_body_size` 从 `30m` 调到 `110m`（配置备份 `/root/nginx/nginx.conf.bak-2026-09-17-100735`）。因为该文件是单文件 bind mount，改完必须 `--force-recreate` 容器才生效。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.4` |
| 一次性 `migrate` | 退出码 0，`alembic_version` = `0011_case_reference_assets` |
| `GET /health/ready` | 200 `{"ok":true}` |
| 匿名 `GET /api/groups` | 401 |
| 匿名 `GET /api/case-reference-assets/<uuid>` | 401（新路由存在且要求登录） |
| 40 MB multipart POST 到 `/api/import/preview` | 401（请求体完整上传，未被 nginx 以 413 拦下） |
| 部署的 SPA 资源 | `index-DLiMvKnc.js` / `index-HXJ3eNlt.css`，与本地 `v0.1.4` 构建产物一致 |
| 另一 vhost `api.gleaftex.com` | 200，重建 `nginx-proxy` 未影响其他项目 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.3`。
