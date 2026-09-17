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

### 4.1 本地：验证 → 打 tag

```bash
cd /home/lucascool/qa-board

# 1) 和 CI 一致的验证（后端需要一个本地 PostgreSQL 测试库）
cd backend
TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test \
  .venv/bin/python -m pytest -q          # 期望 316 passed
cd ../frontend
npx vitest run                            # 期望 116 passed（16 文件）
npm run build
cd ..

# 2) 推送 main 和版本 tag（推送 tag 才会触发镜像发布）
#    本机 origin 是 https 且没有存凭据，所以显式用 SSH 地址推送，
#    或者先执行一次 git remote set-url origin git@github.com:wanglz111/qa-board.git
git push git@github.com:wanglz111/qa-board.git main
git tag -a v0.1.5 -m "v0.1.5"
git push git@github.com:wanglz111/qa-board.git v0.1.5
```

推送必须走 SSH：本机 `origin` 是 https 且没有存凭据，`git push origin …` 会直接报 `could not read Username for 'https://github.com'`。用上面的 `git@github.com:wanglz111/qa-board.git` 地址推，或先把 origin 换成 SSH 地址。SSH 走 `~/.ssh/config` 里 github.com 的 443 端口配置，开箱即用。

远端现在是 `main` = `d64cbef`，标签 `v0.1.6`。已合并的 `feature/cloud-testdeck` 本地分支已删除；**远端同名分支还在**，因为 GitHub 上这个仓库的默认分支仍指向它，`git push --delete` 会报 `refusing to delete the current branch`。要清掉它：先把默认分支改成 `main`（仓库 Settings → General → Default branch），再执行

```bash
git push git@github.com:wanglz111/qa-board.git --delete feature/cloud-testdeck
```

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
sed -i -E 's|^(WEB_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.6|; s|^(API_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.6|' .env

# 拉取并重启；migrate 服务会在 db 健康后自动跑 alembic upgrade head + bootstrap
sudo docker compose --env-file .env -f docker-compose.yml up -d --pull always
sudo docker compose --env-file .env -f docker-compose.yml ps
```

服务器上已经放好了 `deploy.sh`，上面三步可以合成一条：`./deploy.sh v0.1.6`。

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
sed -i -E 's|^(WEB_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.5|; s|^(API_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.5|' .env
sudo docker compose --env-file .env -f docker-compose.yml up -d --pull always
```

或者直接用 `.env.bak-*` 覆盖回去。迁移只向前：如果新版本带了不兼容的 schema 变更，回滚镜像并不能回滚数据库，这种情况要先恢复备份。

注意 `0011_case_reference_assets` 只新增表和列，回滚到 v0.1.3 或更早不影响旧功能（新表留着不用），但如果线上已经开始导入带图用例包，回滚会丢掉这些图片的入口。v0.1.5 / v0.1.6 都没有 schema 变更，从 v0.1.6 回滚到 v0.1.5 可以直接执行，不必恢复数据库。

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

1. Cloudflare 源站只开了 80（Flexible SSL）。想升级成 Full(Strict) 需要在源站加证书或让 nginx 直接上 443。
2. 没有自动部署：tag 推送只发布镜像，服务器更新是手动一条命令（有意如此，避免未经确认自动升级）。

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

## 13. 这次交付做了什么（v0.1.5）

- 把 `main` 从 `adcf60e` 推进到 `f4d11e4`（6 个提交），并打了 `v0.1.5`：执行页里待提交的缺陷截图可以点缩略图全屏预览（复用 `reference-gallery-dialog` 的呈现，`Escape` 和关闭按钮都能关，打开时抢焦点所以不会触发执行台快捷键；不做轮播、下载或新标签页）。
- 同一批提交收紧了 Lark 的写入与对账：
  - 修掉了原先第 9 节列出的「超时认领可能误认旧行」。创建执行记录超时后的认领不再按用例编号匹配，而是要求 `用例`、`结果`、`控制台` 全部相等、且 `日期` 相等——`日期` 取的是本次尝试的 `created_at` 毫秒值，所以表里遗留的同名旧行不会再被认领，认领不到就停在 `uncertain` 交人工。失败方向落在安全的一侧，代价是「远端其实写成功了、但比对不上」也会变成 `uncertain`，需要在「Lark 检查」页点一次同步重试，这类待同步数可能比以前略多。
  - 对账改用 `SyncJob.new_exec_record_id` 作为主键配对，不再受 Lark 返回顺序影响。
  - 写到 Lark「用例」列和「问题描述」列的内容改为 `用例编号 + 标题`，内部重测标签（`-R…`）不再出现在 Lark 里，均有测试锁定。
- 本地验证：后端 `315 passed`，前端 `113 passed`（16 文件）+ `npm run build` 通过。
- GitHub Actions 运行 [#35185335706](https://github.com/wanglz111/qa-board/actions/runs/35185335706) 成功：`verify` 与两个 `publish` 都是 success，镜像 `v0.1.5` 与 `sha-f4d11e4821d7c876020d86a7d1d2f9ecbc269e92` 已推到 GHCR。
- 服务器执行 `./deploy.sh v0.1.5`：`.env` 备份为 `.env.bak-20260917-132742`，`migrate` 退出码 0（本次没有新迁移，`alembic_version` 仍是 `0011_case_reference_assets`），api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.5`；部署前另做了数据库备份 `backup-2026-09-17-132543.sql.gz`。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.5` |
| 镜像 digest | 运行中 api `sha256:5c3168d4…`、web `sha256:cc73088a…`，与 GHCR `v0.1.5` 一致 |
| 一次性 `migrate` | 退出码 0，`alembic_version` = `0011_case_reference_assets` |
| `GET /health/ready` | 200 `{"ok":true}` |
| 匿名 `GET /api/groups` | 401 |
| 管理员登录 + `/api/auth/me` + `/api/auth/csrf` | 200，升级后管理员未被重置 |
| 带会话 `/api/groups`、`/api/groups/<id>/cases` | 200（1 个测试组、14 条用例） |
| `/api/groups/<id>/lark/target` | 200，执行表「执行记录」、缺陷表「冒烟测试bug表」仍在 |
| `/api/groups/<id>/reconcile` | 200，live 读取且 `read_errors` 为空 |
| 部署的 SPA 资源 | `index-DEQtQeU9.js` / `index-9buM1eSG.css`，与本地 `v0.1.5` 构建产物一致 |
| 容器日志（api / worker / migrate / nginx-proxy） | 无 error / traceback |
| 另一 vhost `api.gleaftex.com` | 200，未受影响 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.4`（本次无 schema 变更，可直接回滚）。

## 14. 这次交付做了什么（v0.1.6）

- 修掉执行页两个「数字和面板不跟着走」的问题（用户报的两个现象）：
  - 徽标里的「待同步」取的是 `/groups/<id>/sync` 的 `pending_attempts`，而那是本组**累计的本地执行结果数**——通过/不通过都算，早就同步完的也照数，所以一直停在「待同步 3 条」。现在徽标改成 `Lark 目标已确认 · 待同步 <queued> 条 · 已同步 <synced> 条`（与「Lark 检查」页同一口径，`queued` 就是 outbox 里真正在排队的条数），并且保存后在队列清空之前每 3 秒重读一次，数字会在几秒内自己降到 0。`pending_attempts` 仍在响应里，只有「把已保存的本地结果排入同步」按钮和改目标表确认框继续用它。
  - 旧表只读面板原来只在切换用例/测试组时读一次。保存「不通过」时写入先进 outbox、worker 几秒后才落到 Lark，面板读到的还是保存前的快照，于是仍显示「旧表没有该用例的失败记录 / 未匹配到旧缺陷」。现在队列排空时面板自动重读一次，并且来源行右侧加了「刷新」按钮可随时手动重读。
- 顺带修掉「旧缺陷里永远没有我刚提的那条」的真正原因：本工具写进「问题描述」列的缺陷行都带 `【自动提】` 前缀，而读取端解析用例编号的正则锚定在文本开头（且拒绝把 `B-005` 当成 `B-0050`），这些自动行一律解析不出编号、永远匹配不上——线上两条自动行（`B-005`、`B-001-Rgroup-4e98c0-01`）都复现并验证过。现在读取端先剥掉开头的 `【…】` 再走同一套解析，边界规则不变。
- 本地验证：后端 `316 passed`，前端 `116 passed`（16 文件）+ `npm run build` 通过；`git diff --check` 干净。
- GitHub Actions 运行 [#35188895059](https://github.com/wanglz111/qa-board/actions/runs/35188895059) 成功：`verify` 与两个 `publish` 都是 success，镜像 `v0.1.6` 与 `sha-d64cbef` 已推到 GHCR。
- 服务器执行 `./deploy.sh v0.1.6`：`.env` 备份为 `.env.bak-20260917-141656`，部署前数据库备份 `backup-2026-09-17-141655.sql.gz`；`migrate` 退出码 0（本次没有新迁移，`alembic_version` 仍是 `0011_case_reference_assets`），api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.6`。

升级后的实测结果（真实域名 + 真实 Lark 数据）：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.6` |
| 一次性 `migrate` | 退出码 0，`alembic_version` = `0011_case_reference_assets` |
| `GET /health/ready` | 200 `{"ok":true}` |
| 匿名 `GET /api/groups` | 401 |
| 管理员登录（复用升级前的会话 cookie）+ `/api/auth/me` | 200，升级未重置管理员 |
| `GET /api/groups/<id>/cases/B-005/lark-history` | `bugs` 里返回自家缺陷行 `recvvsev7JZ2it`（`matched_by` = `问题描述`，状态 待修复）；升级前同一请求是 `bugs: []` |
| 部署的 API 容器内 `parse_labelled_case_reference("【自动提】B-005 …")` | `CaseReference(code='B-005', retest_label=None)` |
| 部署的 SPA 资源 | `index-BR2MEcCX.js` / `index-DchAbWUx.css`，与本地 `v0.1.6` 构建产物一致 |
| 浏览器实测（桌面 1440）执行页徽标 | `Lark 目标已确认 · 待同步 0 条 · 已同步 3 条`（升级前恒为「待同步 3 条」） |
| 浏览器实测 B-005 旧表只读面板 | 显示「旧缺陷 待修复 /【自动提】B-005 发售阶段期次表与名额公式」；点一次「刷新」读取时间从 14:20:24 变 14:20:28，可手动重读 |
| 容器日志（api / worker） | 无 error / traceback |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.5`（本次无 schema 变更，可直接回滚）。

## 15. 这次交付做了什么（v0.1.7）

对着线上看板提出的三件事：表头类型与列序、截图链路、`【自动提】`。

- 把 `main` 推进到 `537ad51` 并打了 `v0.1.7`：**自动生成的表头与参考表对齐**。参考表用 `.env` 里的应用凭证 live 探测过（2026-09-17）：

  | 角色 | 参考表 | 表头（按列序） |
  | --- | --- | --- |
  | 执行 | `tblHQfoGkECqrsBZ`（测试流程记录） | `用例`(文本) `结果`(单选：通过/不通过/阻塞/未执行) `优先级`(单选：P0-P3) `负责人`(文本) `截图`(附件) `控制台`(文本) `报告人`(文本) `日期`(DateTime `yyyy/MM/dd`) |
  | 缺陷 | `tblbiGnPAOh8ilsl`（bug 报告） | `问题描述`(文本) `进展状态`(单选：待修复/修复中/待验收/验收不通过/验收通过，待上线/已上线/需求确认/无效 bug/暂不处理) `跟进人`(人员) `优先级`(单选：P0/P1/P2) `截图`(附件) `反馈人`(人员) `反馈时间`(DateTime) `备注`(文本) |

  新建数据表现在按这张表的列序创建（`用例`/`问题描述` 在第一列，即主列），不再按字母序；`结果`/`优先级`/`进展状态` 是单选且选项名逐字一致，`反馈人`/`跟进人` 是人员列，`截图` 是附件列。已经存在但类型不对的列由管理员在「Lark 检查 → 修正表头类型」显式转换（列序与主列无法通过 API 修改，这一类表要用 v0.1.8 的「重建数据表」）。
- **截图链路打通**：结果保存后浏览器把图片 POST 到 `/api/attempts/<id>/screenshots`，worker 用 `drive/v1/medias/upload_all`（`parent_type=bitable_image`，`parent_node` 取该记录所在多维表格的 app_token）换成 `file_token`，再写进 `截图` 列的 `[{"file_token": …}]`；执行历史里也能直接看到缩略图（`attempt` 载荷带上本组截图）。写行前有一个 15 秒的「等证据」窗口，每张图片落盘都会把它往后推，所以先保存结果、再传图片的常规操作不会丢掉附件。
  之前「传了图片哪都看不到」的直接原因是 **worker 容器没挂 `/data` 卷**：图片是 api 写进 `screenshots` 卷的，只有 worker 需要把它们读出来上传，而它看不到这些文件，附件列因此永远是空的。`compose.yaml`、`deploy/server/docker-compose.yml` 和服务器上的 `docker-compose.yml` 都补了这一个卷。
- `【自动提】` 不再出现：写入端把它从缺陷 `备注` 里去掉了（现在是「由用例 &lt;编号&gt; 提交（结果：&lt;结果&gt;）」），读取端会把开头的 `【…】` 标签剥掉再解析用例编号，所以早先带前缀的旧行既匹配得上、页面上也不会再显示这个徽标。
- 本地验证：后端 `339 passed`，前端 `123 passed`（16 文件）+ `npm run build` 通过。
- 服务器执行 `./deploy.sh v0.1.7`：`.env` 备份为 `.env.bak-20260917-153833`，api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.7`（两个镜像构建于 `2026-09-17T07:37Z`）。

升级后的实测结果（真实域名 + 真实 Lark 数据）：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.7` |
| api / worker 卷 | 两个容器都挂着 `testdeck_screenshots:/data` |
| `GET /api/groups/<id>/cases/B-005/lark-history` | 旧缺陷 `description` 已是「B-005 发售阶段期次表与名额公式\n…」，不再带 `【自动提】` |
| 执行表新行 `recvvsF3Lnv8k5` | `截图` 列有真实附件（`file_token` + 下载 url），`用例` 是不带 `-R…` 的干净标题 |
| 缺陷表新行 `recvvsF4igbpV5` | `备注` = 「由用例 B-005 提交（结果：不通过）\n…」，`截图` 列有附件，`反馈人` 是人员列（open_id） |
| 旧行（v0.1.6 及更早写的） | 仍是旧内容：`问题描述` 带 `【自动提】`、没有附件、`用例` 带 `-R…` 后缀 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.6`（本次无 schema 变更，可直接回滚）。
