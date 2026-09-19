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

`.env` 里真正被读取的变量只有：`WEB_IMAGE`、`API_IMAGE`、`DATABASE_PASSWORD`、`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`SESSION_SECRET`、`CSRF_SECRET`、`LARK_BASE_URL`、`LARK_APP_ID`、`LARK_APP_SECRET`、`DEFAULT_OWNER`、`DEFAULT_REPORTER`、`DEFAULT_REPORTER_ID`。
执行表与缺陷表已经**不在环境变量里**：管理员在每个测试组的「Lark 检查」页面选择并确认（v0.1.2 起）。旧变量（`LARK_APP_TOKEN`、`LARK_BUG_APP_TOKEN`、`LARK_TABLE_RUNS`、`LARK_TABLE_DEFECTS`）可以留着，代码不读。

三个 `DEFAULT_*` 的分工（v0.1.16 起）：

| 变量 | 作用 | 什么时候生效 |
| --- | --- | --- |
| `DEFAULT_OWNER` | 执行表 `负责人` 是**文本列**时写进去的名字 | 只对遗留的文本列 |
| `DEFAULT_REPORTER` | 执行表 `报告人` 是**文本列**时写进去的名字 | 只对遗留的文本列 |
| `DEFAULT_REPORTER_ID` | 人员列 `报告人` / `反馈人` 的 open_id | **页面「设置」还没配过时的兜底** |

写端按**该测试组目标表已存的 schema 指纹**逐表决定发显示名还是发 open_id：人员列只接受 `ou_` 开头的 open_id，拿不到就整列省略（不发名字，避免 Lark 拒掉整行）。页面「设置」里配的值存在 `lark_people` 表里，**优先于** `DEFAULT_REPORTER_ID`。`DEFAULT_REPORTER_ID` 若不是合法的 `ou_` 开头值会被忽略（当作没配）。

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
  .venv/bin/python -m pytest -q          # 期望 544 passed（v0.1.18；v0.1.17 是 518）
cd ../frontend
npx vitest run                            # 期望 344 passed（31 文件；v0.1.17 是 337）；CI 的 verify 会跑它，见 §26 的抖动修复
npm run build                             # tsc -b + vite build；产物 index-CTEWkm6u.js / index-D_Bm_Re5.css（v0.1.18），部署后拿来比对
npx playwright test                       # 期望 37 passed（v0.1.18 实测 37 passed / 11.0s）
cd ..

# 2) 推送 main 和版本 tag（推送 tag 才会触发镜像发布）
#    本机 origin 是 https 且没有存凭据，所以显式用 SSH 地址推送，
#    或者先执行一次 git remote set-url origin git@github.com:wanglz111/qa-board.git
git push git@github.com:wanglz111/qa-board.git main
git tag -a v0.1.16 -m "v0.1.16"
git push git@github.com:wanglz111/qa-board.git v0.1.16
```

测试库不是常驻的：容器 `testdeck-task2-postgres`（`127.0.0.1:5433`，`testdeck/testdeck/testdeck_test`）可能处于 Exited，`docker start testdeck-task2-postgres` 几秒后 `pg_isready` 就绪即可。后端套件跑不起来时先看这里，别当成"环境没准备好"跳过。

推送必须走 SSH：本机 `origin` 是 https 且没有存凭据，`git push origin …` 会直接报 `could not read Username for 'https://github.com'`。用上面的 `git@github.com:wanglz111/qa-board.git` 地址推，或先把 origin 换成 SSH 地址。SSH 走 `~/.ssh/config` 里 github.com 的 443 端口配置，开箱即用。

远端现在是 `main` = `4381bbe`，标签 `v0.1.16`。已合并的 `feature/cloud-testdeck` 本地分支已删除；**远端同名分支还在**，因为 GitHub 上这个仓库的默认分支仍指向它，`git push --delete` 会报 `refusing to delete the current branch`。要清掉它：先把默认分支改成 `main`（仓库 Settings → General → Default branch），再执行

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
sed -i -E 's|^(WEB_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.15|; s|^(API_IMAGE=ghcr\.io/[^:]+):.*|\1:v0.1.15|' .env

# 拉取并重启；migrate 服务会在 db 健康后自动跑 alembic upgrade head + bootstrap
sudo docker compose --env-file .env -f docker-compose.yml up -d --pull always
sudo docker compose --env-file .env -f docker-compose.yml ps
```

服务器上已经放好了 `deploy.sh`，上面三步可以合成一条：`./deploy.sh v0.1.15`。

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

## 16. 这次交付做了什么（v0.1.8）

v0.1.7 把表头**类型**修对了，但列序和主列修不了：Lark 只在字段**创建的那一刻**决定它落在第几列，主列固定取最先创建的那个字段，这两样都**没有 API 可以改**。线上那两张表就是 v0.1.6 及更早按字母序生成的——`优先级` 占着主列，后面全部错位，bug 表还多了一个空「单选」列（同样删不掉）。所以能装下参考表的只有「换一张表」。

- 新增 `POST /api/groups/{id}/lark/provision/rebuild`：按参考表列序新建该角色的数据表（`用例` / `问题描述` 在第一列即主列），把本组指向它，丢掉写入审批，并把该角色**全部**本地结果重新排队，交给当前写入端重写一遍——于是新表里是类型正确的列、带截图、且不带 `【自动提】` 的行。只清被重建那一侧已存的记录 id，没动的那张表不会因此多出重复行。
- 新表命名为 `<原名>（表头修正）`，与它替换掉的表可以并排区分；**旧表不会被删除**，本工具也没有删表/删列的 API，需要人工清理。
- 「Lark 检查」页新增「重建数据表（表头修正）」：默认**不勾选**任何角色，对话框会写出每个角色当前在哪张表、将被哪张表替换；重建后页面会跟着本组走到新表，并把被替换的那张从可选列表里去掉，避免「保存选择」再把旧表写回去。
- 重建不与正在写表的任务抢跑：有 job 在飞就返回 409 等它写完；没有审批时同样拒绝（这条在 v0.1.9 被放开，原因见下节）。
- 提交 `38399fb`，tag `v0.1.8`；GitHub Actions [#35198414348](https://github.com/wanglz111/qa-board/actions/runs/35198414348) 成功，镜像已推到 GHCR。
- 服务器执行 `./deploy.sh v0.1.8`：`.env` 备份为 `.env.bak-20260917-161459`，无新迁移（`alembic_version` 仍是 `0011_case_reference_assets`），api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.8`。

升级后的实测结果（真实域名 + 真实 Lark 数据）：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.8` |
| 部署的 SPA 资源 | `index-B2Lx5Uy0.js` / `index-DEPbX85t.css`，与本地 `v0.1.9` 工作区构建产物一致（前端未再改动） |
| `GET /health/ready` | 200 `{"ok":true}` |
| `POST /api/groups/<id>/lark/provision/rebuild`（role=execution） | 200，本组执行表指向新建的 `tblhvnitk1I661Kd`「执行记录（表头修正）」 |
| 新执行表表头（Lark 直读 `bitable/v1/apps/.../tables/tblhvnitk1I661Kd/fields`） | `用例`(文本, **主列**) `结果`(单选：通过/不通过/阻塞/未执行) `优先级`(单选：P0/P1/P2/P3) `负责人`(文本) `截图`(附件) `控制台`(文本) `报告人`(文本) `日期`(DateTime `yyyy/MM/dd`)——与参考表 `tblHQfoGkECqrsBZ` 的列序、类型、选项名逐项一致 |
| `POST .../rebuild`（role=bug，同一轮） | **409**「请先确认写入，再重建数据表」——第一次重建已经清走审批，这条前置校验把第二张表挡在门外（api 日志同轮的 `200` 与 `409` 就是这两次调用） |
| bug 表 | 仍是旧的 `tblUWgX6amSJvAOr`「冒烟测试bug表」：`优先级` 占主列、列序错、残留一个空「单选」列 |
| `lark_targets.confirmed_at` | 空——重建换掉了目标，写入审批按设计失效，需要重新确认 |
| `sync_jobs` | 5 条 pending、`error_kind='target_changed'`：等重新确认后被释放 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.7`（本次无 schema 变更，可直接回滚；但已重建的执行表不会因此回退，旧表 `tblqk65OnxaVkGBD` 仍在）。

## 17. 这次交付做了什么（v0.1.9）

v0.1.8 上线后，管理员在同一轮里重建执行表（**200**），紧接着重建 bug 表却被 **409「请先确认写入，再重建数据表」** 挡住——bug 表因此一直留在旧结构上。

- 根因：重建会把本组**指向新表**，而换目标必然丢弃写入审批（这是刻意设计：换表后不该再往新表里静默写）。v0.1.8 又加了一条前置校验「本组没有审批就拒绝重建」，于是**第一次重建亲手造出的状态**否掉了第二次重建。连着重建两张表是常规操作，这条校验是错的。
- 改动（提交 `89742af`）：去掉该前置校验；「正在写表的 job 在飞时等它写完（409）」这一条保留。新增回归测试 `test_rebuilding_one_role_leaves_the_other_role_rebuildable`：先重建执行表（断言 `confirmed:false`），再重建 bug 表（断言 200 且两张表都已换、`confirmed_at` 仍为空）。
- 本地验证：后端 `347 passed`，前端 `131 passed`（16 文件），`npm run build` 通过，`git diff --check` 干净。
- tag `v0.1.9`（指向 `2ce6516`）；GitHub Actions [#35200128634](https://github.com/wanglz111/qa-board/actions/runs/35200128634) success，两个镜像已推到 GHCR。
- 服务器执行 `./deploy.sh v0.1.9`：`.env` 备份为 `.env.bak-20260917-163355`，无新迁移（`alembic_version` 仍是 `0011_case_reference_assets`），api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.9`。重建前另做了一份数据库备份 `backups/backup-2026-09-17-163450.sql.gz`。

升级后的实测结果（真实域名 + 真实 Lark 数据）：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.9` |
| `GET /health/ready` | 200 `{"ok":true}` |
| `POST /api/groups/<id>/lark/provision/rebuild`（role=bug，**同一轮第二次重建**） | 200：新建 `tbllJqe4zDrCQgpW`「冒烟测试bug表（表头修正）」，替换 `tblUWgX6amSJvAOr`，`requeued: 5` |
| `POST /api/groups/<id>/lark/target/confirm` | 200，`confirmed_at` = `2026-09-17T08:35:17Z` |
| `POST /api/groups/<id>/sync/retry` | 200，`{"requeued":0,"released":0,"repointed":5}`——5 条被 `target_changed` 停住的记录重新指向新目标 |
| `GET /api/groups/<id>/sync` | `{"confirmed":true,"queued":0,"synced":5,"failed":0,"parked":0,"uncertain":0}` |
| 新执行表 `tblhvnitk1I661Kd` 表头 | `用例`(文本,**主列**) `结果`(单选) `优先级`(单选 P0-P3) `负责人`(文本) `截图`(附件) `控制台`(文本) `报告人`(文本) `日期`(DateTime) |
| 新 bug 表 `tbllJqe4zDrCQgpW` 表头 | `问题描述`(文本,**主列**) `进展状态`(单选 9 项) `跟进人`(人员) `优先级`(单选 P0-P2) `截图`(附件) `反馈人`(人员) `反馈时间`(DateTime) `备注`(文本) |
| 与参考表逐字段比对（列序 / type / ui_type / 主列 / 选项名逐个 / 多选属性） | 两张表都与参考表 **完全一致**（执行比 `tblHQfoGkECqrsBZ`，缺陷比 `tblbiGnPAOh8ilsl`，含 `反馈人`/`跟进人` 的 `multiple:true`） |
| 新执行表记录（5 条） | `用例` 为干净标题（无 `-R…` 后缀）、`结果`/`优先级` 是单选值、`报告人`=Max、`负责人`=待指派、`日期` 有值；带截图的行 `截图` 列是附件（`file_token` + `name` + 下载 url） |
| 新 bug 表记录（3 条） | `备注` = 「由用例 B-005 提交（结果：不通过）」，**不再有** `【自动提】`；`反馈人` 是人员列（open_id `ou_61dabbc…`）；`截图` 是附件（`file_token` + 下载 url） |
| api / worker 日志 | 部署后 8 分钟内无 error / traceback；三个调用都是 200 |

至此用户提的三件事在线上闭环：`【自动提】` 已消失、自动生成表头（顺序 / 类型 / 内容 / 主列 / 选项）与参考表一致、截图进入 Lark 附件列并在执行历史里可见。

### 需要人工清理（Lark API 没有删表 / 删列接口）

live base `LIhnb0ok7a1TMksi3t1jrVoLpke` 现有 5 张表，其中这两张是本工具早期生成的、表头错的那版，**确认新表数据无误后可删**：

| 表 | 说明 |
| --- | --- |
| `tblqk65OnxaVkGBD`「执行记录」 | 旧执行表（`优先级` 占主列、列序按字母序），已被 `tblhvnitk1I661Kd` 取代 |
| `tblUWgX6amSJvAOr`「冒烟测试bug表」 | 旧 bug 表（同上，且残留一个**空「单选」列，API 删不掉**），已被 `tbllJqe4zDrCQgpW` 取代 |

另有两项：

- `tblOlLZLkeSK7ktG`「数据表」是这个 base 自带的默认表，**不是本工具建的**，留不留由你决定。
- 我为了验证截图链路造过一条**真实的**测试记录（`attempt a327b24e-…`，复测标签 `B-005-Rgroup-4e98c0-01`，一次「不通过」，备注「端到端截图链路验证」）。它已经按预期写进了新执行表和新 bug 表各一行，Lark 没有删除记录的 API，需要你手动删掉这两行。

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.8`（本次无 schema 变更，可直接回滚）。注意已重建的两张表不会因此回退，本组的目标已指向新表。

## 18. 这次交付做了什么（v0.1.10）

起因是「Lark 请求太多」和「做到一半关掉网页又从头开始」。先做了一次审计（用线上凭证给 `client._send` 打点、数真实请求），量出**打开一个用例 = 9 次 Lark 请求**：

| 次数 | 请求 | 用途 |
| --- | --- | --- |
| 2 | `GET /apps/{base}` | 取库名——两个角色同一个库，**同一请求调了两次** |
| 2 | `GET /apps/{base}/tables` | 取表名——同上重复 |
| 2 | `.../{表}/fields` | 只为算 `schema_errors`/指纹，页面并不用 |
| 2 | `.../{表}/records` | 真正要的数据 |
| 1 | `POST /auth/v3/tenant_access_token` | **每个 HTTP 请求都新建 client，于是每次都换 token** |

20 个用例浏览一遍约 180 次，而且每切回一个用例就重读整张表。于是按三份计划、12 个任务实施（每任务「实现 → 规格复核 → 代码质量复核」，复核由独立 subagent 做，多次抓到真问题并复现）：

**1）Lark 读请求瘦身**（`2026-09-17-lark-read-volume.md`，6 个任务）

- 进程内复用同一个 `LarkClient`：token 在到期前才续期（原来基础版是**永久缓存**，worker 跑满 2 小时后每个写入都会失败——这是个潜在故障，被顺手修掉），连接也复用；401 时丢弃缓存 token 并**重试一次**，读、写、附件下载三条路径都覆盖。
- 同一个库只读一次；历史面板不再为「表名」去读 fields（拆出 `names.py`）。
- 新增 60 秒快照（表名 + 记录），由**本进程的写入口**失效，并在 `GET /sync` 报告队列排空时失效一次——api 与 worker 是两个容器，worker 的写入无法失效 api 的内存，这一条是补上跨进程的那段。
- 旧表附件按 `sha256(token)` 落盘缓存 24 小时（sidecar 先写、唯一临时名、长度校验、尽力而为），响应头从 `no-store` 改成 `private, max-age=86400`。

实测（线上真实库）：**冷启动打开一个用例 5 次请求**（token + 库 + 表清单 + 2 张 records），**热缓存再打开 3 个用例 0 次请求**；审计基线是每个用例 9 次。

**2）执行进度续做**（`2026-09-17-execution-resume.md`，3 个任务）

进度从来没丢（`attempts` 一直在，`/progress` 也一直在算），丢的是**光标**：`selectGroup()` 写死 `caseIndex = 0`。现在 `GET /cases` 带上每个用例的 `latest_result`，页面默认落在**第一个没有结果的用例**，并用 `localStorage` 记住上次看的**组和用例**；需要回看时手动切，不做自动前进。保存后会把当前用例的结果就地更新，所以「本组已全部测过」在**完成的那一轮**就会显示，而不是刷新之后。

来源刻意用本地数据、不读 Lark：表里的行没有任何字段带 group id（工具靠 `(用例,结果,控制台,日期)` 认自家行），而这个仓库会反复重导同一份用例书（`B-003` 在每个组里都存在），按编号做差集必然串组。

**3）重建数据表的写放大防护**（`2026-09-17-rebuild-reprocess.md`，3 个任务）

管理员曾在已经修正过的表上又重建了一次，于是线上出现「执行记录（表头修正）（表头修正）」，而每次重建都会把该角色全部记录重写一遍。现在：

- 表头已经是参考布局（列序 + 主列 + 每列类型）时**拒绝重建**（409 并说明原因），要重建得显式勾「强制重建」；列序或主列不对的表照旧可以重建（包括带多余空列的那种——Lark 没有删列 API，重建是唯一出路）。
- 对话框显示「将重新写入 N 条记录」，N 取的是**重建真正会动的 job 数**（`SyncJob`），与重建返回的 `requeued` 恒等；从表里采纳的行（`source="reconcile"`）与目标确认前写入的行不计入，文案也照此改写。
- 对话框每次打开都重读一次计划，所以刚做完用例再来重建时数字是新的。

### 上线记录

- `main` 推进到 `254c36e` 并打 tag `v0.1.10`；GitHub Actions [#35228535028](https://github.com/wanglz111/qa-board/actions/runs/35228535028) success，两个镜像已推到 GHCR。
- 服务器执行 `./deploy.sh v0.1.10`：`.env` 备份为 `.env.bak-20260917-214304`，部署前数据库备份 `backups/backup-<部署时间>.sql.gz`；无新迁移，api / worker / web 全部换成 `ghcr.io/wanglz111/qa-board-*:v0.1.10`。
- 本地验证：后端 **415 passed**，前端 **156 passed**（17 文件）+ `npm run build` 通过，`git diff --check` 干净。Playwright 有 8 条既有失败（`execution.spec.ts` 与 `legacy.spec.ts` 的「…without overflow」），改动前后**逐条相同**，与本次无关。

升级后的实测结果（真实域名 + 真实 Lark 数据）：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 都是 `ghcr.io/wanglz111/qa-board-*:v0.1.10` |
| `GET /health/ready` | 200 `{"ok":true}` |
| 部署的 SPA 资源 | `index-DXBl3AJM.js` / `index-xxRhoqog.css`，与本地 v0.1.10 构建产物一致 |
| `GET /api/groups/<id>/cases` | 14 条用例各自带 `latest_result`（B-001 通过、B-005/B-010 不通过、其余 `null`）——页面因此会停在 B-003 |
| `GET /api/groups/<id>/lark/provision` | `rebuild` = `{"execution": 6, "bug": 4}`，`roles`/`retype` 均为空（表头已完整） |
| `POST .../lark/provision/rebuild`（当前表已是参考布局） | **409**「这张表已经是参考表头（列序、主列与类型都对）…请勾选「强制重建」」，且没有新建任何表 |
| 请求数实测（给 `client._send` 打点） | 冷启动 5 次 / 热缓存 0 次（每个用例 9 次是审计基线） |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.9`（本次无 schema 变更，可直接回滚）。快照与附件缓存都是进程内/磁盘缓存，回滚后自动失效，无需清理。

### 已知未做（有意记录）

- 保存的 UI 尾巴（`setStatus`/`setImages`/`setLastAttemptId`）仍假设「还在原来的组」：保存过程中切组，新页面可能显示旧组的保存确认、清掉新页面暂存的截图，或让「重试上传截图」指向旧组的 attempt。本轮把它从 6 处收到 3 处，剩下的要按「归属哪个用例」来设计。
- `selectGroup` 里的 `loadSync` 没有 requestId 守卫，快速 A→B→C 切组可能把 A 的徽标数字留在 C 上。
- 游标只有一份（不是每组一份），两个标签页共用；单用户下可接受。
- 重建时若把 `reset_jobs_for_rebuilt_table` 改成「补齐缺失 job」，新表还能带上目标确认前写入的行——那会改变重建的语义（写入之前被确认闸门挡住的行），属产品决策，未做。
- 面板失败路径的「不留半写状态」目前依赖 session teardown 回滚；生产正确，但性质不显式。

## 19. 同步卡住时看不到原因、排入同步推不动卡住的行、面板按钮错位（**已上线**：迁移 `0012_sync_job_last_error` 随 v0.1.12 生效，人员列写入随 v0.1.16）

> 本节的标题原先写的是「未发布」，那是写作时的状态。事实上两条线都已上线（`alembic_version` 从 v0.1.12 起就是 `0012` 起步，v0.1.16 到了 `0016`），所以标题与这句话在 v0.1.17 发版时改正。

起源于线上那一条：「不知道原因，一直有这个问题，提交同步不了，大概在 v1.7 就出现了。待同步 3 · 已同步 0 · 失败 1 · 待人工确认 0 · 待管理员处理 3 · 最近错误 create_execution_failed」。

**根因 1：原因被丢掉了。** `lark/client.py` 早就把「HTTP 状态 + Lark 自己的 `code`/`msg` + 权限补救话术」拼成了一句人话，但 `outbox.run_job` 只把内部枚举 `error_kind` 写进库，那句话随异常一起消失，全仓也没有任何 logging。于是面板永远只能显示 `create_execution_failed`——运维无从下手，这正是「不知道原因」的来源，不是偶发。

**根因 2：那个按钮对已存在的卡住行是死的。** `enqueue_group_attempts` 是 `on_conflict_do_nothing(attempt_id)`：这 3 条早就有 job 行了，接口返回 `queued: 0`，页面显示「已排入 0 条」，而它们仍停在 `target_changed`。用户最先点的按钮恰好永远动不了他正看着的行。

**根因 3：写端可能给人员列发纯文本。** `REQUIRED_RUN_FIELD_TYPES` 允许执行表的 `负责人`/`报告人` 是人员列（type 11），`REQUIRED_BUG_FIELD_TYPES` 允许 `反馈人` 是人员列，但 `execution_fields` 一律发字符串。人员列只吃 `[{"id": <open_id>}]`，纯文本被 Lark 拒——确认能过、每次创建都失败、重试永远无效，表现就是 `create_execution_failed`。v0.1.7 把「参考表表头」引进来之后，指向手工表（团队用人员列）就会踩上。

**改动**

- `sync_jobs.last_error`（迁移 `0012_sync_job_last_error`，Text）：每条失败路径都把它记录在案，`GET /api/groups/{id}/sync` 的 `last_error_kind` 与 `last_error` 取自**同一行**（不会出现「类别是 A、原因是 B」）。同步成功后清空；重新排队/重新指向时一并清空，避免留下过期原因。`_reason` 截断到 600 字符，且只可能包含 Lark 的 status/code/msg 与既有话术——不含 token、URL、请求体、记录 id（客户端本来就不把这些放进消息）。
- `POST /api/groups/{id}/sync/enqueue` 现在除了新排入，还会把 `target_changed` 的行重新指向当前目标表、把 `failed` 的行重新排队，返回 `{queued, repointed, requeued}`；页面把「动了多少条」逐项说明。**`uncertain` 一律不碰**：那条可能已经写进远端，再发一次会多出一条记录，仍只走它自己的按钮与勾选。未确认目标仍然 409 拒绝，不会绕过写入审批。
- 写入端按目标表**已存的** schema 指纹判断人员列：是人员列且有 open id → `[{"id": …}]`；是人员列但没有 id（`负责人` 恒为 `待指派` 占位符）→ 该字段从请求里省略（留空照样能建行，发错类型则整行失败）；文本列照旧收显示名。指纹缺失/不合法时退回旧行为，不猜类型。
- 面板显示真实原因（红字一行）；「排入同步」的提示按实际动作逐项列出；执行台徽标在 `失败`/`待管理员处理` 非零时也显示，不再把卡住的队列说成「只是慢」。
- 按钮错位：`.lark-queue` 的四个按钮原本是行内兄弟，`.ghost-button` 是 `inline-flex` + `align-items: center`，而首个子节点是 SVG——替换元素的基线取自身底边，于是带图标的那个按钮比同级高 **2.5px**；再加上 JSX 会把表达式之间的空白去掉，四个按钮本来还是贴在一起的。现在包进 `.lark-queue-actions`（`display:flex; flex-wrap:wrap; align-items:center; gap:10px`）。

**本地验证**

- 后端 `424 passed`（`TEST_DATABASE_URL=… pytest -q`）；迁移 head 断言更新为 `0012_sync_job_last_error`，并断言 `sync_jobs.last_error` 存在。
- 前端 `161 passed`（17 文件）+ `npm run build` 通过；Playwright `lark-check.spec.ts` 8/8 通过，其中新增的用例把「同一行的按钮必须共享同一 top、相邻间距 ≥8px」写成断言——**把 CSS 修复删掉后它确实失败（差值 2.5px）**，不是空断言。
- 复现与验证用的临时页面已删除。

**部署后要做的一件事**：升级后随便点一次「把已保存的本地结果排入同步」，面板会写出每条卡住行的真实原因。若是权限类（`Forbidden` / `permission`），按提示在 Lark 开放平台开通「查看、评论、编辑和管理多维表格」并把应用加为该多维表格的可编辑协作者；若提示字段类型，用「修正表头类型」或「重建数据表」。线上未验证（本轮没有真实 Lark 凭证），首次部署后请按上面这行确认。

## 20. v0.1.12：执行台续做 + 四条保存路径修复 + 附件幂等（已上线）

「执行台续做」这一整条分支（保存后自动前进 / 表单复位 / 缺陷备注带用例 / 进度方格）连同四条保存路径缺陷一起上线。四条缺陷的清单、复现证据与仍开放项在 `docs/superpowers/specs/2026-09-17-execution-flow-and-grid-design.md` 的**附录 G**；本节只记发版与实测。

### 这次改了什么

- **O1** 幂等键带上 group：两个组里的同编号用例不再共用一把 key。此前第二次保存会收到 `409 Idempotency key conflict`，而重试铸出的 key 不变（签名没变）——是卡死的报错循环，不是静默丢结果（附录 G 原先的措辞本轮已更正）。
- **O10** 保存的 `catch` 按错误来源分措辞：行已入库后的读取失败不再喊「保存失败…可重试」；预留路径的**原样**重试保持幂等（预留退租挪到读取链完成之后），**改载荷**重试则明确告知「已经提交过，这次修改没有保存：刷新页面后可重新提交」。
- **O3 / O2** 保存飞行期间禁用 LegacyHistory 的「复测（新标签）」按钮（顺带关掉了「保存落地后自动前进丢掉刚预留的重测」那条入口）；在飞状态由布尔改成计数器，预留的 `finally` 不再释放保存的 spinner。
- **O11** 附件上传按 attempt + 字节 hash 幂等（迁移 `0013_screenshot_content_hash`）：同一张图重传只留**一行一个文件**；两个上传竞争时输家回滚、删掉自己刚写的文件、答赢家那行。**前端未改**——重传从「制造重复」变成「无害重放」。
- **O4** 复核后确认现场代码本来就是「可证新才采纳」（同一用例文本 + 结果 + 控制台 + **同一毫秒的 `日期`**，缺陷表那条超时路径干脆不采纳），findings 里的旧条目用的是旧 API 形状；本轮补了一条「现场有旧行时必须不采纳」的回归测试把它钉住（去掉 `and same_date` 即复现成 `synced`）。
- 新增 `backend/scripts/integration_probe.py`：起真 uvicorn + 真 Postgres（一次性 schema，用完即 drop，不发 Lark 请求），把此前只靠读码得出的 409 分支变成实测。

### 上线记录

- `main` 先推进到 `f9b1bc7`（快进 30 个提交）并打 tag **`v0.1.11`**：GitHub Actions [#35294165817](https://github.com/wanglz111/qa-board/actions/runs/35294165817) success，镜像已进 GHCR；**该版本未部署**。
- O4 / O11 收口后 `main` 推进到 `a882951` 并打 tag **`v0.1.12`**；镜像 `ghcr.io/wanglz111/qa-board-{api,web}:v0.1.12` 已在 GHCR（匿名 `docker manifest inspect` 可见 → `verify` 与两个 `publish` 均通过；同一 commit 另有 `sha-<完整 sha>` 标签）。
- 服务器执行 `./deploy.sh v0.1.12`：`.env` 备份为 `.env.bak-20260918-092916`，部署前数据库备份 `backups/backup-20260918-092915.sql.gz`（137 KB，`gzip -t` 通过）；`migrate` 退出码 0，日志 `0011_case_reference_assets -> 0012_sync_job_last_error -> 0013_screenshot_content_hash`。
- 本地验证（`a882951`）：后端 **446 passed**、前端 **206 passed / 18 files**、`npm run build` 干净、Playwright **25 passed / 0 failed**、集成探针 **9/9**、`git diff --check` 干净。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 全部 `ghcr.io/wanglz111/qa-board-*:v0.1.12`，db healthy |
| `GET /health/ready` | 200 `{"ok":true}`（容器刚起来的瞬间 502，`deploy.sh` 的重试循环随后通过） |
| `alembic_version` | `0013_screenshot_content_hash` |
| `screenshots` 列 / 索引 | 含 `content_hash`；`pg_indexes` 含 `uq_screenshot_attempt_hash` |
| 匿名 `GET /api/groups` | 401 |
| 管理员登录 + `/api/auth/me` | 200 / 200（账号未被重置） |
| 无 CSRF 的 mutation | 403 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.11`（或 `v0.1.10`）。本次只有一个**加列**迁移，回滚镜像后多出的 `content_hash` 列与唯一索引不影响旧版本读写；要彻底回退 schema 可 `alembic downgrade 0012_sync_job_last_error`。

**线上未验证的一件事**：附件去重的真实效果（同一张图重传只落一行）是在本地真服务端探针里验的；线上只验到迁移与索引存在，没有为验证而往生产库写一条测试记录。

## 21. v0.1.13：进度方格挂到当前焦点那一行（已上线）

执行页左侧的用例方格原来渲染在整个测试组列表**之后**，屏幕上那些方块只能靠"离谁近"来说明自己属于哪个组——组一多，读的人得往页面上方回看，才认得出这是谁的进度、还差几条。这次把它挂到**当前选中那一行的下面**。

### 这次改了什么

- `GroupSelector` 新增 `selectedDetail` 插槽，渲染成**选中行的下一个兄弟节点**（在列表内部，不是列表之后）。只有选中行带它，所以面板不会被误读成邻居的，也不会在换组后留在原地过期；`Fragment` 保证 `role="list"` 的直接子节点仍然只有 listitem。
- `Execution.tsx` 把 `CaseGrid` 交给这个插槽，删掉列表末尾那一块。
- 面板沿用选中行自己的左侧 3px 绿色 accent，并去掉独立块原有的顶部分隔线——行 + 方块读成一个块，而不是像多出来一行。
- 测试：两条组件测试锁**位置**（默认夹具里被选中的是第一组、共两组，所以"在焦点行下"和"在列表末尾"是**两个不同的地方**；否则同一组断言在两种实现下都成立）；一条 e2e 锁**几何**（用 `boundingBox` 断言面板顶 ≥ 焦点行底、面板底 ≤ 下一行顶，并断言切组后跟着走、不残留）——同样的 markup 两种实现渲染结果相同，只有排完版的计算盒子能区分。
- 没有 API、数据或文案改动；方格的配色与计数口径未动（网格与执行台计数仍共用 `toneOf`）。

### 一个 dev mock（本次一起进仓库，不是产品代码）

`node frontend/mock-api.mjs` 在 `127.0.0.1:8000` 应答各页面要读的路由——正好是 vite 代理 `/api` 的地址，所以旁边跑 `npm run dev` 不需要改配置，也不需要数据库。用法：先 `node mock-api.mjs`，再 `npm run dev`，浏览器开 dev server 的地址。

- 夹具按线上看板的形状造（20 / 5 / 14 条，第一组 通过2 不通过4 跳过2 未测12），另带一条有执行历史 + 旧表记录 + 命中旧缺陷 + 附件的失败用例、前三条的原型图、以及五种对账状态。
- 「测试用例」组的用例行是**解析** `docs/examples/ai-cases-template.csv` 得到的，不是复制一份，所以示例书改了夹具跟着改；模板只有 3 条，其余按它的列补写。
- 截图与原型是 `node:zlib` 现场编码的真 PNG：仓库里不留二进制、不引依赖，两张图一眼可分。
- 有意不实现的部分：提交只存内存、重启即回到初始态；`reports.xlsx` 答 501 并写明原因（不返回一个坏文件）；Lark 目标保持未确认，页面显示只读态。
- 它不进镜像：`frontend/Dockerfile` 只 `COPY src` 与几个配置文件。

### 上线记录

- `main` 从 `4e8e06d` 推进到 `d88ab0d`（两个提交：`604cc4e` 功能改动、`d88ab0d` dev mock），打 tag **`v0.1.13`**。
- GitHub Actions [#35298728647](https://github.com/wanglz111/qa-board/actions/runs/35298728647) success（`verify` + 两个 `publish`），`head_sha` = `d88ab0dc0bc4`；镜像 `ghcr.io/wanglz111/qa-board-{api,web}:v0.1.13` 与 `sha-d88ab0d…` 已在 GHCR——部署前用匿名 `docker manifest inspect` 确认两个都在（tag 推送后约 3 分钟）。
- 本地验证（`d88ab0d`）：后端 **446 passed**、前端 **208 passed / 18 files**、`npm run build` 干净（产物 `index-CE5uFhWw.js` / `index-B4CUtYad.css`）、Playwright **26 passed**、`git diff --check` 干净。
- 服务器：部署前数据库备份 `backups/backup-20260918-102019.sql.gz`（137 KB，`gzip -t` 通过），`.env` 备份为 `.env.bak-20260918-102034`，`./deploy.sh v0.1.13`，`migrate` 退出码 0（**无新迁移**）。
- 顺手把本节所在的这份文档里过期的数字改对了：§4.1 的期望测试数（316/116 → 446/208，并补上 Playwright 与产物 hash 的用途）、§4.1/§4.3 里会被人直接复制粘贴的版本号、以及"远端 main = …"这一行。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 全部 `ghcr.io/wanglz111/qa-board-*:v0.1.13`，db healthy |
| `GET /health/ready` | 200 `{"ok":true}`（容器刚起来的瞬间 502，`deploy.sh` 的重试循环随后通过） |
| 一次性 `migrate` | 退出码 0；`alembic_version` = `0013_screenshot_content_hash`（与 v0.1.12 相同，本次没有迁移） |
| 匿名 `GET /api/groups` | 401 |
| 部署的 SPA 资源 | `index-CE5uFhWw.js` / `index-B4CUtYad.css` —— 文件名是内容 hash，与本地这次验证过的构建产物同名，即同一份产物 |
| 本次改动的证据 | 线上这两个 bundle 里都能 grep 到 `group-row-detail`（CSS 与 JS 各命中一次） |
| 管理员登录 + `/api/auth/me` | 200 / 200（账号未被重置） |
| 带会话 `GET /api/groups` | 200（8 个测试组）；其中一个组 30 条用例、`progress` 为 `passed 0 / untested 30` |
| `GET /api/groups/<id>/lark/target` | 200（该组尚未选择 Lark 表，`target: null`） |
| api / worker 日志 | 部署后 300 行内无 error / traceback |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.12`（纯前端改动，本次无 schema 变更，可直接回滚）。

**线上没有做的一件事**：这次是纯前端改动，线上只验到"served bundle 与本地验证过的那份同名（内容 hash）+ 新标记确实在生产 bundle 里"，没有在浏览器里登录再走一遍执行页——避免把生产管理员口令写进终端与会话记录。需要视觉确认时，本地 mock 端口（见上节）与线上是同一份构建产物。

## 22. v0.1.14：对账能删掉被删记录的本地行 + 测试组归档（已上线）

两件事一起发：对账侧"表里删了、本地删不掉"的死结，和需求变更时把整组测试组退场的口子。

### 这次改了什么

- **对账（`e21cdcd`）**：管理员提错结果、又在 Lark 里把记录删掉后，本地那一行在对账里只能读成「仅本地」——点「采用表内记录」得到一句「表里没有这条记录」，点「保留本地记录」只是记了个决定，那条记录（以及它喂的进度与报告）永远清不掉：这套工具此前根本没有删除 attempt 的路径。
  - 读：只有当这条 attempt 的上传留下了 record_id、而这个 id 不在**原始**读回的 id 集合里、且上传时的表格指纹等于当前表指纹（仅「当场读表」）时，才标 `remote_deleted`，页面显示「表里已删除」。用原始 id 而不是解析后的行，是因为「用例」字段被改坏的记录仍然是记录，把「看不懂」当「被删了」会诱人去删一条还在表里的本地副本。
  - 写：新的 `delete_local` 会**绕开那 60 秒快照**当场重读一次表复核，再删 attempt（截图与上传记录走外键级联），提交后删磁盘文件，并且**不写 ReconcileMark**——label 会被重新分配，留一条旧 mark 会让下一条同名记录一出生就显示「已核对」、再也勾不动。`remote_deleted` 的行同时忽略此前记下的决定，否则它会一直停在「已核对」而无法操作。
  - 页面把状态叫「表里已删除」（原来混在「仅本地」里），删除按钮只对真会消失的行点亮，并在动手前说清代价。
- **测试组归档（`2bf6b85`）**：需求变更要重排用例时，把一个测试组退场。归档 = `groups.archived_at`（迁移 `0014_group_archive`）留时间戳；默认从 `GET /api/groups` 过滤掉（`include_archived=true` 才带出），而执行/报告/对账/Lark 检查四个页都读这一个接口，所以一处过滤全板干净。读仍然放行——「藏起来」不等于「删掉」。
  - 写：6 个 router 声明同一个 dependency，非 GET 一律 409「该测试组已归档，请先恢复再操作」，`group_id` 或（attempt 级路由）经 attempt 反查；以后新增写路由自动被覆盖。`archive`/`restore` 两条路由本身不在守卫范围，否则恢复永远跑不起来。
  - worker：归档组的待发任务 park 回 `pending`（`error_kind=group_archived`，租约释放），一个字节都不出网；恢复后队列自己接着跑，不用人工重试。
  - **归档不动 Lark**：这个组以前写进表里的记录仍在原表。重新编排后重新导入会得到一个新的测试组（新 short_code、新 label），上一轮的记录会以「仅表里」出现在新组的对账里——要表也干净得在 Lark 侧处理或换一张执行表。这句话写在确认弹窗里。

### 上线记录

- `main` 从 `b14f658` 推进到 `2bf6b85`（两个提交：`e21cdcd`、`2bf6b85`），打 tag **`v0.1.14`**。
- CI：run [#35312976670](https://github.com/wanglz111/qa-board/actions/runs/35312976670) **success**（event `push`、`head_branch` = `v0.1.14`、`head_sha` = `2bf6b85`，05:59:23 → 06:02:17）：`verify` 92s success、`publish (api)` 31s success、`publish (web)` 77s success。
- 镜像：`ghcr.io/wanglz111/qa-board-{api,web}` 的 **`v0.1.14`** 与 **`sha-2bf6b85e71deb573bbc53dba3c96ddc0c777c5a3`** 两个 tag 都已存在（匿名 `docker manifest inspect` 确认；`sha-` 那组是回滚锚点）。
- 「查 CI」这件事本身记一笔：发版当时匿名 GitHub API 配额已经耗尽（`core.remaining = 0`），短间隔轮询只会返回空列表、看起来像「run 还没出现」；本机出口 IP 和同节点的人共用那 60/小时 的桶，很容易被一起烧光。**认证后是 5000/小时**：本机 `~/.bashrc` 里有 `GH_TOKEN`（细粒度 PAT），`source ~/.github-quota.sh` 后用 `ghq` 可以先看认证状态与剩余配额。没 token 时的替代判据是直接看 GHCR 有没有镜像——镜像存在即证明 `verify` 与两个 `publish` 都过了。
- 本地验证（`2bf6b85`）：后端 **472 passed**、前端 **215 passed / 18 files**、`npm run build` 干净（产物 `index-1ZWoocE3.js` / `index-7aFSDEjz.css`）、Playwright **30 passed**、`git diff --check` 干净。
- 服务器：部署前数据库备份 `backups/backup-20260918-140025.sql.gz`（140 KB，`gzip -t` 通过），`.env` 备份为 `.env.bak-20260918-140417`，`./deploy.sh v0.1.14`，`migrate` 退出码 0（**本次有新迁移**：`0013_screenshot_content_hash` → `0014_group_archive`）。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 全部 `ghcr.io/wanglz111/qa-board-*:v0.1.14`，db healthy |
| `GET /health/ready` | 200 `{"ok":true}`（容器刚起来的瞬间 502，`deploy.sh` 的重试循环随后通过） |
| 一次性 `migrate` | 退出码 0；`alembic_version` = `0014_group_archive` |
| 新列 | `groups.archived_at`：`timestamp with time zone`、nullable |
| 数据完好 | `groups` 8 行、其中 `archived_at is not null` **0 行**；`group_cases` 141 行（迁移没有误标任何组） |
| 匿名 `GET /api/groups` | 401 |
| 部署的 SPA 资源 | `index-1ZWoocE3.js` / `index-7aFSDEjz.css` —— 内容 hash 与本地验证过的构建产物同名，即同一份产物 |
| 本次改动的证据 | 生产 JS 里 grep 到 `group-archive-dialog`、`表里已删除`、`删除本地记录`，CSS 里 grep 到 `group-archive-dialog` |
| api / worker / migrate 日志 | 部署后 200 行内无 error / traceback |
| 管理员登录 | **没有在生产上登录**（沿用 v0.1.13 的口径：不把生产口令写进终端与会话记录）。登录态下的行为由本地 472/215/30 与本地 mock 浏览器实测覆盖 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.13`。`0014` 只新增一个可空列、不改任何既有列，旧版本镜像会直接无视它，所以**回滚不需要恢复数据库**；`sha-2bf6b85e71deb573bbc53dba3c96ddc0c777c5a3` 那两个镜像是同一提交的锚点，用来重放这次部署，不是回滚目标。

## 23. v0.1.15：原型长图能缩放了（主窗口与画中画）（已上线）

用例的「原型参考图」通常是一张长截图，而查看器此前用 `object-fit: contain` 适配：图片被压到"整张高度可见"为止，一张 480×1600 的移动端页面在 900px 高的视口里只剩约 185px 宽，字根本读不出来。这次换掉的是**适配模型**，不是加一个放大按钮。

### 这次改了什么

- 图片改为在滚动舞台里按「原始尺寸 × 比例」布局（`frontend/src/imageZoom.ts` 纯函数 + `ImageZoomDialog` 组件）：打开即**适应宽度**，长图直接可读；1:1 保持像素精确；滚动、触控板惯性、翻页交给浏览器，不再手写平移。
- 捏合在浏览器里到达页面时是 ctrl+wheel，而 React 的 wheel 监听是 passive、拦不住它（不拦的话浏览器会缩放整页），所以监听是手工挂的非被动监听；delta 按像素/行/页归一（行模式按像素读会让一格手势小 16 倍）。
- 手势只累积目标比例，画面由 `requestAnimationFrame` 每帧缓动逼近、并逐帧重钉锚点：触控板交来的是粗事件（Windows 精密触控板约 25px/次，原来正好是看得见的 5% 一跳），缓动才让它读成连续运动。浏览器实测：24 次事件渲染 **81 个中间尺寸**、帧时间中位=最大 **17ms**、**无长任务**。适应宽度 / 1:1 / 步进按钮 / 关注点跳转仍是瞬时落地，工具条读数就等于你点的那一档。
- 比舞台窄的图片会被 auto margin 居中，而这个位移随缩放增长会消失——它被算进了锚点数学，否则视图会漂掉半个差值。
- 滚动目标只在舞台真的装得下当前比例时才写：写早了浏览器会拿旧的、更矮的布局把它夹掉（StrictMode 会把副作用跑两遍，"只写一次"从来不是安全的假设）。这是本次实测抓出来的两个真 bug 之一：点关注点后 `scrollTop` 停在 910 而不是 3577。
- 关注点框按归一化坐标叠在图上（无需像素换算即跟随任意缩放）；列表项与查看器里的胶囊都能跳过去、脉冲高亮，并把查看器切成手动模式，之后窗口尺寸变化不会把视图抢回适应宽度。
- 缺陷截图预览复用同一个查看器——失败截图常常和原型一样长。画中画里是同一个组件，会按 PiP 窗口宽度重新适应。

### 上线记录

- `main` 从 `e354202` 推进到 `82a6005`（两个提交：`c13d614` dev mock 换长图、`82a6005` 查看器），打 tag **`v0.1.15`**。这次推送顺带把此前只在本地、且已随 v0.1.14 发布的 3 个提交（`2bf6b85` 测试组归档 + 两个 v0.1.14 文档提交）送上了远端。
- CI：run [#35322143479](https://github.com/wanglz111/qa-board/actions/runs/35322143479) **success**（08:00:04 → 08:03:18，`head_sha` = `82a6005`）：`verify` 115s、`publish (api)` 33s、`publish (web)` 71s。
- 镜像：`ghcr.io/wanglz111/qa-board-{api,web}` 的 **`v0.1.15`** 与 **`sha-82a60052445ac9abcc59d2124238075cd1391ec8`** 四个 tag 都已存在（匿名 `docker manifest inspect` 确认）。
- 本地验证（`82a6005`）：后端 **472 passed**、前端 **251 passed / 20 files**、`npm run build` 干净（产物 `index-BUYWTlKF.js` / `index-BpehFnVH.css`）、Playwright **31 passed**、`git diff --check` 干净。
- 服务器：部署前数据库备份 `backups/backup-20260918-160454.sql.gz`（501 KB，`gzip -t` 通过），`.env` 备份为 `.env.bak-20260918-160513`，`./deploy.sh v0.1.15`，`migrate` 退出码 0（**本次无迁移**）。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 全部 `ghcr.io/wanglz111/qa-board-*:v0.1.15`，db healthy |
| `GET /health/ready` | 200 `{"ok":true}`（容器刚起来的瞬间 502，`deploy.sh` 的重试循环随后通过） |
| 一次性 `migrate` | 退出码 0；`alembic_version` = `0014_group_archive`（与 v0.1.14 相同，本次没有迁移） |
| 匿名 `GET /api/groups` | 401 |
| 部署的 SPA 资源 | `index-BUYWTlKF.js` / `index-BpehFnVH.css` —— 内容 hash 与本地验证过的构建产物同名，即同一份产物 |
| 本次改动的证据 | 生产 JS 里 grep 到 `image-zoom-dialog`（1 次）与 `适应宽度`（1 次），CSS 里 grep 到 `image-zoom-stage`（1 次） |
| 数据完好 | `groups` 14、`group_cases` 617、`attempts` 15、`screenshots` 8（部署前后一致） |
| api / worker / migrate 日志 | 部署后 200 行内 error / traceback 计数 **0 / 0 / 0** |
| 管理员登录 | **没有在生产上登录**（沿用 v0.1.13 / v0.1.14 的口径：不把生产口令写进终端与会话记录）。交互本身在本地 mock（同一份构建产物）用浏览器实测过 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.14`。本次是纯前端改动、无 schema 变更，回滚不需要恢复数据库；`sha-82a6005…` 那两个镜像是同一提交的锚点，用来重放这次部署，不是回滚目标。

### 顺手记一笔：`import_tickets` 占 92 MB（**这里的判断是错的，见 §24**）

查备份时看到 `import_tickets` 15 行占 92 MB，当时写在这里的推断是"每次导入都把整包 payload 留在了表里，库与备份都会线性涨"。**两句都不准**：代码在确认导入（或票据过期）时就把 `original_file` 清成了空字节，`test_ticket_is_one_use_and_expired_ticket_is_rejected` 一直锁着这个行为；`pg_dump` 也只导出存活数据、不含死元组，所以备份变大是真实数据变多（14 组 / 617 条用例），与这 92 MB 无关。真因、修正与处理过程见 §24。

## 24. `import_tickets` 的 92 MB：诊断、存量处理、防复发（**迁移待发布**）

§23 里对这个现象的判断是错的，这一节是查清之后的结论。

### 真因：是 TOAST 里的死元组，不是"payload 没清"

```
             堆         合计      存活   死元组   original_file 存活   parsed 存活
处理前     16 kB       92 MB      15     11       15 字节             1.4 MB
处理后   8192 bytes    416 kB     15      0       15 字节             1.4 MB
```

- 上传的整包是一个 `bytea`，PostgreSQL 把它放进这张表的 **TOAST** 关系；导入确认（或票据过期）时代码会把它清成空字节——**这一步一直是对的**，留着的那一行是墓碑，好让过期的页面拿到一个明确答复而不是 404。
- 清空留下的是 **TOAST 死元组**。判据是 `pg_relation_size`（堆）只有 16 kB、而 `pg_total_relation_size` 是 92 MB——**空间全在 TOAST 里**；存活数据 `original_file` 合计只有 15 字节。
- 为什么一直没人回收：这张表永远只有十几行，而 autovacuum 的默认触发线是 `50 + 0.2 × 存活行` ≈ 53 个死元组，**这张表永远到不了**（生产上 `last_autovacuum` 是 NULL）。于是死 TOAST 一路堆着。
- 顺带修正 §23 的第二处：**备份体积与死元组无关**（`pg_dump` 只导出存活数据），137 KB → 501 KB 是真实数据增长。

### 存量处理（已做：线上 2026-09-18 16:29）

动手前已有一份完整备份（`backups/backup-20260918-160454.sql.gz`，501 KB，`gzip -t` 通过），然后执行：

```bash
sudo docker compose --env-file .env -f docker-compose.yml exec -T db \
  psql -U testdeck -d testdeck -c "VACUUM (FULL, ANALYZE) import_tickets"
```

`VACUUM FULL` 会重写这张表与它的 TOAST，把空间还给操作系统（普通 `VACUUM` 只把空间标成可复用，文件不会缩小）。这条语句拿表级排他锁，而这张表只在导入时被写——执行时线上没有导入在跑。结果：**92 MB → 416 kB**、`n_dead_tup` 11 → 0，存活数据 15 行 / `parsed` 1.4 MB 一字未动。

### 防复发（迁移 `0015_import_ticket_autovacuum`，待发布）

把这张表自己的触发线降下来，让 autovacuum 在少数几次导入之后就来处理它（连同它的 TOAST）：

```sql
ALTER TABLE import_tickets SET (
  autovacuum_vacuum_threshold = 5,
  autovacuum_vacuum_scale_factor = 0);
```

- 表存储参数**不在 ORM 里**：SQLAlchemy 不接受这类 dialect kwarg（试过，直接 `ArgumentError`），所以它写在迁移里，模型上的 docstring 指回这个迁移，避免两处各说一套。
- 测试：`tests/test_migrations.py` 断言 `pg_class.reloptions` 里带着这两个值，**并按 `current_schema()` 限定**——`relname = 'import_tickets'` 在测试库里会同时命中别的 schema 遗留的同名表（第一次就是这么读出 `None` 假阴性的）。
- 这条断言验证过有牙齿：把迁移正文临时改成 `pass`，它当场红；恢复后 5 passed。
- **迁移尚未发布，防复发目前还没生效**。存量那 92 MB 已经当场回收，所以不依赖发版；发版只是让"下一次积累到自己被回收"这件事在线上成立。

### 另一条路（没走，留个记录）

如果以后单次导入的包变得很大（几百兆），更彻底的做法是把 `original_file` 落到磁盘的临时目录、票据只存路径，确认/过期时删文件——那样根本不进 TOAST。现在没走：收益只是"更省数据库空间"，代价是给导入链路引入一套临时文件生命周期（漏删就是磁盘泄漏），当前规模不值当。

## 25. v0.1.16：缺陷表按模板列序 + 人员列可用页面配 open_id（已上线）

计划与需求：`docs/superpowers/plans/2026-09-18-lark-header-alignment.md`、`docs/superpowers/specs/2026-09-18-lark-header-alignment-requirements.md`。16 个提交 / 23 个文件。

### 这次改了什么

1. **缺陷表默认列序**对齐团队交接用的模板多维表格（`问题描述 / 优先级 / 进展状态 / 反馈时间 / 反馈人 / 跟进人 / 备注 / 截图`）。**选项词表不动。**
   - 为什么：之前把模板库整块粘贴进我们的表时列序不一致，值逐列串位，单选列把错位值当新选项自动创建——`优先级` 里混进了 10 个日期串、`进展状态` 里混进了 `P0/P1/P2`，全程不报错。
   - 列序**不在 API 里可改**：Lark 建表时按你给的字段顺序落列、第一个字段即主列，之后只能重建或人工拖动。`schema_fingerprint()` 按**名字**排序，所以改列序**不会**让已确认的目标失效。
2. **执行记录的 `负责人` / `报告人` 建表即人员列**（`FieldSpec(11, PERSON_PROPERTY)`）。
3. **迁移 `0016_lark_people`**：单行表，`CHECK (id = 1)` 钉死；未配置落 `NULL` 而不是空串。
4. **`GET` / `PUT /api/lark/people`** + 页面新增「设置」：两个输入框（报告人 / 负责人 open_id），报告人一处配置、两侧共用（执行表 `报告人` 与缺陷表 `反馈人`）。
   - 只接受本应用名下的 `ou_` 开头 open_id（`^ou_[A-Za-z0-9_-]{1,64}\Z`）；姓名/邮箱/union_id 一律 422。
   - 页面配的值存在 `lark_people` 里，**优先于** `DEFAULT_REPORTER_ID`；后者退化为兜底，且非法值会被忽略。
5. **写入链路**：`write.execution_fields(owner_id=)` → `outbox.run_job(owner_id=)` → `worker` 从数据库解析。人员列拿不到 id 就**整列省略**（不发显示名，否则 Lark 拒掉整行）；文本列行为不变。
6. **页面加载失败时禁止保存**：加载失败会让按钮 disabled、显示「（未知）」而不是「（空）」，避免一次点击把两个已存的 id 静默清空（后端把空串解释为"清空"）。
7. **一次性清理脚本** `backend/scripts/lark_cleanup.py`（默认 dry-run）。

### ⚠️ 一次真实数据事故（已恢复，记在这里）

清理脚本 `--apply` 时，`PUT .../tables/{tbl}/fields/{fld}` 带 `property.options` **重建了整份选项表并重发 option id**，把 **13 行已有单元格的值清空**（执行记录 8 行的 `结果`/`优先级`、缺陷记录 5 行的 `进展状态`/`优先级`）——**连保留下来的那些选项所引用的值也一起没了**。

- 原先的防护（"先删错位行再洗选项"）只覆盖**被删掉的**选项，没有覆盖"整表重建"。
- 当初验证「PUT 是替换不是合并」用的探针表**一行数据都没有**，所以那个行为根本观察不到——**空表上验出来的"安全"是假安全**。
- 发现方式：没有采信脚本自己的"复查 OK"，而是独立重读了一遍线上原始 `fields`。
- 恢复：用清理前的 dump 按 `record_id` 逐行 `batch_update` 写回，再按 `record_id` 独立重读比对，**13/13 与清理前一致**。
- 脚本随后经三轮修复：**快照 → 洗 → 写回 → 独立重读核对**；快照在第一个 PUT 之前落盘（含真实单元格值，跑完应手动删）；逐表写回异常隔离；选项复查进返回值；失败时打印**逐字可粘**的恢复命令（用 `compile` + `bash -n` + 真跑+哨兵三条证据验过）。

### 需要人工做的事（**已做**，记下来备查）

- 缺陷记录表列序：人工拖到模板顺序。
- 执行记录 `负责人`/`报告人`：在 Lark 里改成人员列 —— **改完必须立刻在「Lark 检查」页重新读取并确认**。不重新确认的话，存的 schema 指纹还说"文本"，写端会继续发 `待指派`/`Max` 进人员列 → 每一行都被 Lark 拒、整组卡死。（2026-09-18 已确认线上两列都是 `person multiple=True`。）
- 页面「设置」里配两个 open_id（负责人可留空）。

### 上线记录（2026-09-18）

| 项目 | 结果 |
| --- | --- |
| 合并 | `feat/lark-header-alignment` fast-forward 进 `main`（`02ccc72` → `4381bbe`），线性历史与仓库既有习惯一致 |
| 本地验证（**合并后**重跑） | 后端 `504 passed`；前端 `256 passed (21 files)`；`npm run build` exit 0；`npx playwright test` **31 passed** |
| 构建产物 | `dist/assets/index-li5seUpy.js`（旧版本是 `index-BUYWTlKF.js`） |
| CI | run [#17](https://github.com/wanglz111/qa-board/actions/runs/35337372558) **success**：`verify`、`publish (api)`、`publish (web)` 三个 job 全绿 |
| 镜像 | `ghcr.io/wanglz111/qa-board-{api,web}` 的 `v0.1.16` 与 `sha-4381bbe05f3ed9c26e2f3cca9f474ec5284e8e2b` 两个 tag 都存在（匿名 `docker manifest inspect` 确认） |
| 服务器 | 部署前 `.env` 备份 + 数据库备份（`gzip -t` 通过）；`./deploy.sh v0.1.16`；`migrate` 退出码 **0**，`alembic_version` = **`0016_lark_people`**，`lark_people` 表存在 |
| 容器 | 四个全部 `ghcr.io/wanglz111/qa-board-*:v0.1.16`，api healthy |
| 验收 | `https://testdeck.gleaftex.com/health/ready` → `{"ok":true}`；`/api/groups` 未登录 → **401**；`/api/lark/people` 未登录 → **401** |
| 产物比对 | 线上首页 bundle = **`assets/index-li5seUpy.js`**，与本地构建产物逐字一致 |
| 新接口生产实调 | 管理员登录后 `GET /api/lark/people` 返回 `env_reporter_open_id` / `effective_reporter_open_id` = 服务器 `.env` 的合法 open_id（**说明新加的校验没有改变线上行为**），`owner_*` 为空 |
| 回滚 | `cd /home/ubuntu/testdeck && ./deploy.sh v0.1.15`。`0016` 只新增一张单行表，旧镜像无视它，**回滚不需要恢复数据库** |

### 已知未做（有意记录）

- **清理脚本 `snapshot()` → `record_ids()` 之间的亚窗口**：这段时间新出现的行仍在基线里、不在快照里，既不报警也不恢复。静默窗口从"数秒"缩到"一次 records 列举"，**未完全闭合**。当前脚本已被数量闸锁死（库里 0 条错位行 ≠ 12，dry-run 直接退出 1），不可达；**若将来再用它，这是首要补项**。
- **`batch_update` 未分片**（快照只有 8/5 行，远低于上限；数百行时需要按 500 一批切）。
- **cleanup 脚本新增的两条分支没有仓库内测试**（`tests/` 从不驱动该脚本，验证用的假对象探针只存在于 /tmp 且已删）。
- **`downgrade()` 在整个测试套件里零覆盖**（仓库既有全局缺口，非本次引入）。
- 设置页标题缺兄弟视图都有的 `<p className="eyebrow">`；加载失败后视图内没有"重试"入口（切走再回来会重新挂载）。

## 26. v0.1.17：「Lark 检查」页改成状态条 + 4 步向导，判决按当前选中的表派生（已上线）

计划与规格：`docs/superpowers/plans/2026-09-18-lark-check-page-redesign.md`、`docs/superpowers/specs/2026-09-18-lark-check-page-redesign-design.md`。19 个提交 / 34 个文件（+6798 / −2889）。

### 这次改了什么

**根治用户报的那个 bug：换表后旧表的红字不销。**

- 现象：粘贴链接读取后，在下拉里换执行表，**上一张表**的「缺少必填字段…」红字一直挂着。
- 根因：旧页面把两种**寿命不同**的数据塞进同一个 `resolved` state —— base 级（`tables` / `base_name`，切表后仍有效）与 table 级（`selected` / `execution_fields` / `schema_errors`，切表即失效）。判决被存在 base 级作用域里，于是「针对一张已被丢弃的表」的判决，永久贴在「刚选中的表」头上。旧实现在 `LarkCheck.tsx` 里直接 map `resolved.schema_errors`，**不读当前选中的表**，而 `onChange` 只 `setExecutionTableId`。
- 修法（结构性，不是再加一个清除条件）：判决改由 `probes[`${table_id}:${role}`]` 在**渲染时按当前选中的表**派生；非当前表的判决路径不可达。没校验过的表显示「尚未校验这张表」+ 校验入口 —— 不借邻居表的结论，也不显示空白。链接框被编辑即作废该 role 的 base 与判决（`baseIsCurrent`）。
- 后端新增只读 `POST /api/lark/table-schema`：按 `table_id` + `role` 现读字段并算缺失表头；happy path 只 1 次 Lark 请求，只有读失败时才补一次 `list_tables` 以区分「表没了」(422) 与「没权限」(409)；与 `/lark/resolve` 同 router（继承 admin + 归档组拦截）；两个入参走与保存路径**同一套**路径注入校验。**无迁移、无新增依赖、不写库。**

**顺带：页面从「三块 panel 全摊开」改成「一行状态条 + 4 步向导」**（`LarkCheck.tsx` 849 行 → 336 行）。

- 健康态 = 1 行状态条 + 4 行步骤标题；两条必吵醒的异常（表头失效 / 同步失败·待人工确认）由状态条变红/黄 + **对应步自动展开**定位，不再靠顶部堆红字。
- 946 行的 `HeaderSetup.tsx` 拆成 `components/lark/` 下的三个破坏性弹窗（设置表头 / 修正表头类型 / 重建数据表）+ `StepHeaders`。**三个动作的确认流程与 `acknowledge` 语义逐字保留**：删掉的旧文件里 30 条 CJK 文案，在新 UI 里 0 条缺失；`acknowledge: true` 仍是 4 处。
- 新增 `larkDraft.ts`（纯逻辑，可单测）与 `useLarkDraft` hook（唯一改 draft 的地方）。
- 死代码清理：删除 `.lark-healthy` / `.lark-facts` / `.lark-fields` / `.lark-field` / `.lark-roles`（逐条 grep 证明无引用，且没有动态拼接能重新生成它们）。**共享遮罩行一个字未动**（`.target-change-overlay, .header-setup-overlay, .reconcile-overlay, .group-archive-overlay` 那两行）—— 它们与目标切换 / 对账 / 归档三个弹窗同行，删掉**不会有任何测试变红**，但会让那三个弹窗失去遮罩。

### 本地验证（`c395be3`，即合并进 main 的那一点）

- 后端 **518 passed**；前端 vitest **337 passed / 31 文件**（连跑 3 次全绿）；`npm run build` 通过，产物 **`index-BpPhBQGX.js` / `index-DnO6G41C.css`**；Playwright **37 passed**；`tsc -b --force` exit 0。
- **门 1 是先红后绿**：红输出 `expected <p class="inline-status error" role="alert">缺少必填字段「截图」</p> to be null`，是在**产品代码一行未动、只改测试文件**的那次提交里跑出来的；对应 e2e 用例名是「switching the execution table clears the old table's red banner」。
- 发布前最后一轮复审又抓出并修掉两处，都值得记：
  1. **页面测试有一次 1/3 的抖动。** 唤醒步的自动展开原先只交给一个被动 effect，于是「数据落地的那一帧」`chosen` 还是空的，目标步先被渲染成 `attention`、下一帧才变 `open`；测试是同步断言的，读到的就是 `attention`。这不只是测试问题 —— 它会打中 **CI 的 `verify`**（`publish: needs: verify`），让 tag 推送偶发失败、卡住发版。改成把 `openStep` 派生出来之后：修前 35/1（36 次），修后 **36/36**，全量套件 6/6。
  2. **`readLink` 的失败路径缺代际闸门**：换组时还在飞的 `resolve` 被拒，会在**新组**的页面上凭空印一行旧组的「读取 Lark 表格失败」。成功路径早有这道闸门，失败路径漏了；现在补上（`onError` 之前判断），并配了一条修前必红、修后必绿的用例。

### 上线记录

- `main` 从 `2b373ad` **快进**到 `c395be3`（19 个提交，与仓库既有的线性历史习惯一致），tag **`v0.1.17`**；远端 `main` 与 tag 均已推送（本机 `origin` 仍是 https 且无凭据，照例用 SSH 地址推）。
- CI run [#35379356813](https://github.com/wanglz111/qa-board/actions/runs/35379356813) **success**（`head_sha` = `c395be31a70175bfd92351737840063952d0aaea`，18:17:54 → 18:20:38，约 2 分 44 秒）：`verify` 103s success、`publish (api)` success、`publish (web)` success。
- 镜像 `ghcr.io/wanglz111/qa-board-{api,web}` 的 **`v0.1.17`** 与 **`sha-c395be3…`** 都已存在（匿名 `docker manifest inspect` 确认）。
- 服务器：部署前数据库备份 `backups/backup-2026-09-19-022114.sql.gz`（502005 字节，`gzip -t` 通过），`.env` 由 `deploy.sh` 自动留档为 `.env.bak-<时间戳>`；`./deploy.sh v0.1.17`，`migrate` 退出码 **0**（**本次没有新迁移**）。

升级后的实测结果：

| 检查 | 结果 |
| --- | --- |
| `docker compose ps` | api（healthy）、worker、web 全部 `ghcr.io/wanglz111/qa-board-*:v0.1.17`，db healthy |
| `GET /health/ready` | 200 `{"ok":true}`（容器刚起来的瞬间 502，`deploy.sh` 的重试循环随后通过） |
| 一次性 `migrate` | 退出码 0；`alembic_version` = `0016_lark_people`（与 v0.1.16 相同，本次没有迁移） |
| 数据完好 | `groups` 14、`group_cases` 617、`attempts` 14、`screenshots` 8（部署前后一致） |
| 匿名 `GET /api/groups` | 401 |
| 匿名 `POST /api/lark/table-schema` | **401**（新路由确实存在，且要求管理员）；同路径 `GET` 405（只接受 POST） |
| 部署的 SPA 资源 | `assets/index-BpPhBQGX.js` / `assets/index-DnO6G41C.css` —— 内容 hash 与本地验证过的构建产物同名，即同一份产物 |
| api / worker 日志 | 部署后 300 行内 error / traceback 计数 **0 / 0** |
| 管理员登录 | **没有在生产上登录**（沿用 v0.1.13 起的口径：不把生产口令写进终端与会话记录）；登录后的行为由本地 518/337/37 覆盖 |

回滚：`cd /home/ubuntu/testdeck && ./deploy.sh v0.1.16`。本次**无 schema 变更**，回滚不需要恢复数据库。

### 需要你决定的两件事（有意记录，不藏）

1. **规格 §5.2 与 §4.1 有一处不自洽。** §5.2 把第 ① 步的完成条件写成「两表都已校验并选中」，但 probes 是**会话内**的（§4.1）；于是对**回访**的管理员来说，§1.2 那句「配完（4 步全 ✓）→ 页面自然安静」在结构上达不到 —— 一个已确认且健康的组，第 ① 步仍然是展开的（实测状态 `["open","done","done","done"]`）。门 4 的「健康态预算」仍然成立（1 行状态条 + 4 行标题、健康态无 `role="alert"`，我把第 ① 步展开的更强状态也量过，同样是 0 个 alert）。两条路：**(a)** 接受并写进文档；**(b)** 把 ① 的完成条件放宽成「已选中 &&（两表都 ok ‖ 已有保存目标且 live 健康）」—— 后者不违反「判决只有一个来源」。
2. **同族的一帧闪烁（未修，已记录）。** `chosen` 已经有值之后，若分类又移到另一步，那一步仍会先画一帧 `attention`。从页面测试断言的冷启动路径（`chosen === undefined`）不可达，所以按设计决定留给你；另外 `data-state="attention"` 全仓**没有任何断言**。

### 其他已知未做（都验证过属"可发"，列出来是为了不自嗨）

- **三个弹窗各自带一份 23 行的 `trapFocus`**，外加跨弹窗 import 的 `refusalOf`，形成 `StepHeaders ↔ dialogs` 环形引用。计划逐字冻结了文件清单、把抽公共模块列为备选，所以本轮按计划保留。将来讨论时请注意：这三个弹窗**本来就从 `StepHeaders` import** `messageOf` / `ROLE_LABELS` / `rebuiltNameOf`，所以"抽出来会有设计问题"不是理由；真正的理由是计划逐字冻结了文件清单。
- **backend**：新接口没有一条用例断言 200 响应的**键集合**（加第五个键不会红）；**错类型**判决分支（`fields.py` 的 `字段「…」类型为 …`）全仓**零覆盖** —— 而本页那行红字正是它浮现的地方，属计划缺口。
- **页面 6 条动作路径**（`LarkCheck.tsx` 的 persist / confirm / approve / queue / retry / refresh）没有换组代际守卫，晚到的响应可能把旧组的结果写进新组视图。**与重构前逐字同一结构**（不是本次引入），但和上面第 2 条是同一族，值得单开一条跟进。
- 页面「目标表读取失败」只渲染一行裸 `role="alert"`（同面板标题里有「刷新」按钮可重试）。
- mock 保真度（`mock-api.mjs`）：`required` 未排序（后端排序）、只查字段存在不查类型、新路由没有 `method === "POST"` 守卫。都是计划逐字代码，且前端不读 `required`，纯开发面。
- e2e `lark-check.spec.ts:467` 的 `toContain` 不重试且紧跟一个 fire-and-forget 点击（窗口很窄、未复现抖动），建议改 `await expect.poll(...)`。
- 陈旧注释：`components/lark/StepHeaders.tsx:43` 仍指向已被删除的 `HeaderSetup.tsx`；`styles.css` 里「死规则清理在 Task 7」的注释在 Task 7 做完后过期了。

### 一个环境陷阱（与本次改动无关，但会骗人）

**这个 checkout 里 Playwright 报的是「编译后」的行号，不是源文件行号。** `--list` 会说 `e2e/lark-check.spec.ts:592`，而源码里这个用例在第 `428` 行（对着 `/tmp/playwright-transform-cache-*/` 的产物核过）。所以：**不要拿 Playwright 输出里的行号去 grep 源码**。我在开工前的基线核对里踩到过一次，Task 7 的实现者独立复现了同一现象。

## 27. v0.1.18：一次导入用例 + 实测结果、第三份提示词、执行表新增必填列「实测过程」（**已发布** · tag `v0.1.18` · 2026-09-19）

计划与规格：`docs/superpowers/plans/2026-09-19-import-with-results.md`、`docs/superpowers/specs/2026-09-19-import-with-results-design.md`。**本节写于 `05e3ee6`，当时实测 `git diff --shortstat main...HEAD` = 20 个提交 / 39 个文件 / +1716 −87**（18 条代码与规格 + 2 条本节文档：`f2c0ee8` 新增本节 85 / 0，`05e3ee6` 修正 2 / 2）。**这组数字是「测到它的那个提交」`05e3ee6` 的快照，不是分支尖端的**：此后又追加了若干文档提交（把本节再改一版的、上游补 spec 更正的那条、整支终审的修复波），**需要精确计数时以 `git log --oneline 8c22f0c..HEAD`（要行数就用 `git diff --shortstat 8c22f0c..HEAD`）为准**，别拿这组数去核别的点。

> **本节交付时，`feat/import-with-results` 尚未合并、尚未打 tag、尚未构建镜像、尚未部署**：最后一个**代码**提交是 `5d2c2bf`（`5343dad` 与它之后的几条都只动文档）。发版动作照 §4.1（本地：验证 → 打 tag）、§4.2（Actions：镜像发布）、§4.3 / §4.4 的既有流程走，本节不代跑；也**没有"上线记录"表**（没发生的事不写）。下面那条**四步上线顺序**是功能层面的硬要求，与发版流程是两件事，别混。

### 这次改了什么

**把「导入」从只写用例，扩成「用例 + 可选执行结果」。**

1. **12 列导入契约**（前 10 列一个字未动，结果列追加在末尾）：
   `用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程`

   | 新列 | 别名（进 `ALIASES`） | 取值 |
   |---|---|---|
   | `执行结果` | `实测结果` / `本轮实测结果` / `result` | `通过` / `不通过` / `未执行` / 空 |
   | `实测过程` | `过程记录` / `实测说明` / `evidence` | 自由文本；多行用双引号包格换行 |

   **物化判决只有一处**（spec §4.2，与建组同一个事务）：

   | `执行结果` | attempt | 执行表 |
   |---|---|---|
   | `通过` | 建，`source='import'` | 1 行，结果=通过 |
   | `不通过` | 建；`note` = 实测过程（**空则整份文件拒绝**） | 1 行 + 缺陷表 1 行（既有逻辑，`outbox.py:421-440`） |
   | `未执行` | 建 | 1 行，结果=未执行 |
   | 空 | **不建** | 不出现，只在 `GroupCase.raw` 留档 |

   `阻塞` 不在导入枚举里 → **整份文件拒绝**（不静默映射成别的值）。

   **上面这两处拒绝都是"整份文件级"，不是"跳过坏的那一行"**：`groups.py:136`（结果不在枚举）与 `:141`（`不通过` 没带 `实测过程`）都在物化循环里抛 `ImportErrorDetail`，调用方 `db.rollback()` 后回 **422**（`groups.py:214-218`，注释原文 *"Nothing is half-written: the ticket stays usable"*）——组不会建、ticket 不消费、上传的文件还在，改完可以原样重导。**换来的代价必须写清：41 条结果里只要有一条坏（比如某条 `不通过` 漏了 `实测过程` 列），41 行一行都进不去。**
2. **导入页预览**：检出结果时显示「**检出 N 条执行结果**（其中 M 条仅有过程、将只留档）」+ 勾选框「**一并写入执行结果**」；取消勾选 → 请求体 `import_results=false`，只建用例、不建任何执行记录。
3. **结果表单**新增「**实测过程**」文本域（`components/OutcomeForm.tsx`，占位文案「观测原文：选择器、实测值、报错原文」），与「控制台输出」**并列两个框、不复用同一个**——过程文本不塞 `控制台`。
4. **执行历史**：`source='import'` 的行打「**来自导入结果**」徽标（`components/History.tsx:38`）并显示 `evidence`；"哪几行是转译进来的"这条审计线靠 `source` 辨认。
5. **Lark 执行表**：`RUN_SCHEMA` **末尾追加**文本列「**实测过程**」（前 8 列与参考表逐列一致），同时进 `REQUIRED_RUN_FIELD_TYPES`（`lark/fields.py:60`）；写入侧 `execution_fields` 写 `attempt.evidence or ""`，`控制台` 仍只写 `console_text`，两者不互相顶替。
6. **第三份提示词**：`docs/AI-CASE-RESULT-PROMPT.md` ≡ `backend/app/prompts/ai-case-results.md`（**逐字节相同**，`cmp` → IDENTICAL，由 `test_shipped_prompts_match_the_docs` 守）；`PROMPTS` 第三条 `id="case-results"`、标题「已有用例 + 实测结果 → 可导入格式」。定位是**转译型**（兄弟 `cases` 是生成型）：照抄不重写、编号/标题/步骤/预期逐字保留、不合并不拆分、不删掉没通过的用例；用法段写明「留空 = 不建执行记录」与字面值 `未执行`（会物化成一条记录）的区别。
7. **数据与迁移**：迁移 **`0017_attempt_evidence`**（`attempts.evidence` Text NULL，`down_revision="0016_lark_people"`）；`ck_attempts_source` 放开 `import`，单处定义 `LOCAL_SOURCES = ("execution", "import")`（`models.py:181`），五个过滤点改用它（`outbox.py:131/188/530`、`reconcile.py:244/427`）；幂等键 `import:{group_id}:{code}`——**按组作用域**，同一份文件再导一次是合法的新组，与既有"重复文件只 warning、由人决定"的契约一致（用文件哈希作键会撞唯一约束并抛 500，实施期复现过）。

### ⚠️ 功能上线顺序（硬要求，四步，照着做）

1. **在「Lark 检查」页为执行表补齐「实测过程」列**（走既有「修正表头」/ provision）。
2. **重新读取并确认目标**（上一步的结构变更清空了写批准，必须重新确认）。
3. **导入 12 列文件**（勾着「一并写入执行结果」）。
4. **点「同步」**，把 job 入队。

**为什么不能颠倒**：provision 补齐列时会**清掉目标的写批准**——创建过字段即把 `confirmed_at` 置空（`lark/provision.py:472-474`，注释原文 *"A structure change invalidates the earlier write approval."*）；而写行只在 `confirmed_at is not None` 时才发生，否则 park（`outbox.py:352-359`）。**先入队、后加列 = 已入队的 job 全部 park（目标未确认），要人工重新确认目标。** 这个顺序也写进了「Lark 检查」页文案与新提示词的用法段。

顺带纠正一个容易记错的地方（spec §1.4 初稿就是这么写错的，上游已用 `c44a00d docs(spec): correct why provisioning parks the queued jobs` 修正）：**`target_fingerprint` 只是目标身份，不含 schema** —— 它由 `lark/target.py:57-59` 把 `execution_base_token | execution_table_id | bug_base_token | bug_table_id` 四个 token 拼起来（token 清单在 `:41-46`）；schema 存在**另一个**字段 `LarkTarget.schema_fingerprint`（`models.py:368`，由 `target.py:581` 单独赋值）。所以本次 park 的原因不是"指纹变了"，而是"批准被清了"；park 判定里那第三项（指纹不等）管的是**换表**，不是加列。

### 老 target 的影响（有意破窗，不是 bug）

「实测过程」进了 `REQUIRED_RUN_FIELD_TYPES` 之后，**「Lark 检查」页重读目标时就会在响应体里给出「缺少必填字段「实测过程」」**——`POST /lark/table-schema` 本身**回 200**，缺列消息放在响应体的 `schema_errors` 里（`lark/target.py:296-311`）；**只有重新确认目标时才被整条拒绝、回 409**（抛出点 `lark/target.py:636-640`，文案在 `lark/fields.py:112`）。

**但"拒绝建行"这一步不会发生——建行根本不看 schema。** 入队只要求 `confirmed_at` 非空（`lark/outbox.py:122-146`），`实测过程` 是真正写行时才进请求的（`lark/write.py:126-129`，**永远是空串、不是缺键**）。所以**一个仍处于已确认状态的旧目标照样会入队**：行会在写 Lark 那一步失败（请求里带了一张没有的列），重试超过 `MAX_RETRIES = 5`（`outbox.py:44`、`:250-251`）后 job 变 `failed`。**结论：补齐列之前不要同步**——这不是"点了会红"，是"点下去这一组行会一路失败到底"。

这也是把它设成必填的理由：不设，检查页不会出现这条红字，同样的失败只会以 `create_execution_failed`（外加 `last_error` 里的 Lark 原文）的形式出现在同步队列里，离原因更远。**升级后看到这条红字，按上面第 1、2 步补齐再同步，不要去关校验。**

### 真实的 0918 那批怎么用（50 / 41 / 9）

用法是用户亲口定的，不是设计推的：

1. 导入 **50 条**（**41 条带 `执行结果`、9 条留空**）。
2. 点「同步」。
3. Lark 执行表应出现 **41 行**。**那 9 条待复验的完全不出现**——不是"结果为空的行"，是**根本没有行**（`SyncJob.attempt_id` 是 `NOT NULL + UNIQUE`，与 attempt 无关的 Lark 行在这个模型里不可能存在）。
4. 之后每复验一条，在 qa-board 提交结果并传图，**截图随行写进 Lark 的附件列**（走既有 截图→附件 通道）。

两个既定口径，别当成故障：`日期` = **导入时刻**（不是 0918 的真实执行时间；要真实日期得加第 13 列 `实测时间`，本分支不做）；那 9 条留白在 **Lark 里完全不可见**，只有在 qa-board 网页端能看到 50 条（其中 9 条没结果）。

### 测试保护的真实边界（别把"有测试"说成"自动门"）

在 `5d2c2bf`（本节之上最后一个**代码**提交）的代码上自己复跑（不是转述兄弟任务的数字）：

| 套件 | 结果 | 在 CI 里吗 |
|---|---|---|
| backend `pytest -q` | **543 passed**，2 warnings，35.53s | **在**（`publish.yml` 的 `verify`） |
| 前端 `vitest run` | **31 files / 343 passed** | **在**（同上，`verify`） |
| `npm run build`（`tsc -b && vite build`） | 通过 | **在**（同上，`verify`） |
| e2e `cd frontend && npm run e2e`（`playwright test`） | `import.spec.ts` **2 passed**（desktop / mobile，**手跑**） | **不在** |
| 勾选框几何断言（≤24px、预览不溢出） | 只活在 `frontend/e2e/import.spec.ts` | **不在** |

- 全仓 `.github/workflows/` 只有 `publish.yml`，**里面搜不到 playwright / e2e** —— e2e 是**发版前手跑**的网，不是自动门。几何断言尤其如此：jsdom 没有布局引擎（`getBoundingClientRect` 全 0），它只能住在 e2e 里，vitest 永远看不到它。
- 本分支有几条"锁定现状"型验收测试（黄金样例回归、几何断言），天生先绿；实现时各做过一次**临时变异**（改坏样例 / 临时删 `styles.css` 的两条规则）证明它会红，再 `git checkout --` 还原。
- 顺带一个会骗人的观测（本轮复跑也撞上了）：`playwright test` 对 for 循环里生成的用例报的是**编译后行号**——输出 `import.spec.ts:52:3`，源码里这条用例在**第 30 行**。**别拿 Playwright 输出里的行号去 grep 源码。**

### 已知未决（本分支不修，列出来是为了不自嗨）

1. **`docs/AI-CASE-PROMPT.md:117`（≡ `ai-cases.md`）自相矛盾**：它写「`执行分层` 写中文 → 分层丢失」，而同一份文件 `:41` 写「中文会原样进库」——后者才是真话。**既有缺陷，非本分支引入**；spec §11 与 Task 7 的边界都明令不碰前两份提示词，改了等于把范围扩进无关文档。用户用的是**新的第三份**。
2. **双别名时报错是英文**：`执行结果` 与 `实测结果`（或 `result`）同时出现 → 整份拒绝，用户看到 `Ambiguous source fields for canonical field result`（`importers/schema.py:199`）。与既有 `ImportErrorDetail` 的英文文案一致；**是否本地化未定**。
3. **`lark/reconcile.py:427` 的删除路径零覆盖**（`DELETE_REFUSED_MISSING` 这个分支本就零覆盖，非本次引入）。它恰好是被 `LOCAL_SOURCES` 改到的五个点之一。
4. **`downgrade()` 全局零覆盖**（`backend/tests/` 里 grep `downgrade` 零命中）——包括本次新增的 `0017`：`test_migrations.py` 只验证"空库升级到 head（两次）"与"从 `0004` 升到 head"，**没有一条回退用例**。属仓库既有全局缺口。
5. **`match_bugs` 的读回问题会被本功能撞得更频繁**（`lark/history.py:276`，**另一个计划的范围**）：本功能给每一条"不通过"按既有逻辑在缺陷表开一行，**但缺陷行归到哪个用例名下，靠的是 `match_bugs` 的启发式**——依次是：显式关联字段（`关联用例` / `用例编号`）→ 备注首行是不是本工具写的 `用例：{code}` 标签 → **描述里"长得像编号"的 token**（`_description_match`）→ 备注里任意位置的标签。第三档是概率游戏：缺陷表里散文行越多，"把某行挂到别的用例下"的机会越大。本功能会**批量**往那张表里加行（一批 41 行进表、失败行各开一条缺陷行），等于把撞上这个既有读回的次数放大。**这不是"与本功能无关"**：本分支按 spec §11 只把本地行白名单从 1 个值扩到 2 个，读回语义一个字没动，修它要单开一次改动。

**回滚**：迁移只向前（同 §5）。`0017` 的 `downgrade()` 按代码顺序会先把 `ck_attempts_source` 收紧回 `('execution','reconcile')`，而 Postgres 重建 CHECK 时会校验既有行——**这是读代码得出的推理、本次没有实跑**（见未决项 4：这条回退路径在仓库里零覆盖）：库里只要已有 `import` 行，这一步就会失败；就算它能成功，紧接着的 `drop_column` 也会丢掉导入的实测过程原文。**所以回滚只回镜像、别 downgrade 数据库**：DB 停在 `0017` 对 v0.1.17 的代码是安全的（旧代码不写 `import`，放宽后的 CHECK 仍接受 `execution`/`reconcile`，多出来的列被忽略——同 §5 里 `0011` 那种"只新增列"的情形）。

