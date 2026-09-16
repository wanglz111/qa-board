# TestDeck 自托管部署

目标：在一台只有 Docker 与一个 `.env` 的服务器上启动 TestDeck——不克隆仓库、不改镜像、不需要 registry 登录。

## 1. 一次性准备

1. **让 GHCR 包可公开拉取**：在 GitHub 仓库的 Packages 页面，对 `qa-board-api` 与 `qa-board-web` 分别执行
   *Package settings → Change visibility → Public*。私有包需要服务器先 `docker login ghcr.io`，就不再是“只靠 Compose + .env”的部署方式。
2. **准备域名**：把 `DOMAIN` 指向服务器公网 IP 的 A/AAAA 记录。证书由 Compose 内的代理自动申请；
   首次启动前请确认 80/443 未被占用，且 DNS 已经生效。
3. **生成密钥**（不要把输出贴进聊天或提交到 Git）：

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 48   # CSRF_SECRET
openssl rand -base64 24   # DATABASE_PASSWORD
```

## 2. 服务器上的唯一文件

创建 `/opt/testdeck/.env`（可用仓库根的 `.env.example` 作为模板，示例里的值都不可用）：

```ini
WEB_IMAGE=ghcr.io/<owner>/qa-board-web:v0.1.0
API_IMAGE=ghcr.io/<owner>/qa-board-api:v0.1.0
DATABASE_PASSWORD=<上一步生成>
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<强密码，仅首次初始化使用>
SESSION_SECRET=<上一步生成>
CSRF_SECRET=<上一步生成>
DOMAIN=testdeck.example.com
LARK_BASE_URL=https://open.larksuite.com
LARK_APP_ID=<Lark 应用 ID>
LARK_APP_SECRET=<Lark 应用密钥>
LARK_APP_TOKEN=<旧执行记录所在多维表格 token>
LARK_BUG_APP_TOKEN=<旧缺陷所在多维表格 token>
LARK_TABLE_RUNS=<旧执行记录表 id>
LARK_TABLE_DEFECTS=<旧缺陷表 id>
```

`LARK_TABLE_RUNS`/`LARK_TABLE_DEFECTS` 必须指向**旧表**；旧的变量名
`LARK_TABLE_RECORDS`/`LARK_TABLE_BUGS` 仍可识别，但会被 `/api/lark/check` 标为需要修正的配置。

## 3. 启动

```bash
docker compose --env-file .env -f compose.yaml up -d --pull always
docker compose --env-file .env -f compose.yaml ps
curl -fsS https://$DOMAIN/health/ready
```

启动顺序由 Compose 保证：数据库通过健康检查后，一次性的 `migrate` 服务执行
`alembic upgrade head && python -m app.bootstrap`；API 与 worker 在迁移成功后才启动。
bootstrap 是幂等的：重启不会覆盖已存在的管理员密码或测试组。

## 4. 首次登录后的检查

1. 用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录，确认没有注册入口。
2. 打开 **Lark 检查** 页：确认显示的多维表格名、执行表名、缺陷表名与字段类型和旧表一致。
3. 勾选“允许向上述旧表新增本组记录”并确认；确认前执行结果只保存在本地。
4. 执行一条用例，确认“已保存到本地”与“Lark 同步”状态分别显示。
5. 备份演练（见下）后才算部署完成。

## 5. 状态与排障

```bash
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs --tail=100 migrate api worker
docker compose --env-file .env -f compose.yaml exec api python -c "import app.main"
```

同步状态可在用例页与 Lark 检查页查看：待同步 / 已同步 / 失败 / 待人工确认。
“待人工确认”表示远端写入超时且无法唯一匹配，必须人工核对后再处理，系统不会自动重发。

## 6. 备份与恢复演练

```bash
# 备份（数据库 + 私有截图卷）
docker compose --env-file .env -f compose.yaml exec -T db \
  pg_dump -U testdeck testdeck | gzip > /srv/backup/testdeck-$(date +%F).sql.gz
docker run --rm -v testdeck_screenshots:/data -v /srv/backup:/backup alpine \
  tar czf /backup/testdeck-screenshots-$(date +%F).tar.gz -C /data .

# 恢复演练（在临时 Compose 项目中执行，确认可用后再动生产）
gunzip -c /srv/backup/testdeck-YYYY-MM-DD.sql.gz | \
  docker compose --env-file .env -f compose.yaml exec -T db psql -U testdeck -d testdeck_restore
```

恢复后至少要检查：管理员能登录、测试组与用例数量一致、截图仍可打开、
`/api/groups/{id}/sync` 的待同步数量与备份前一致。

## 7. 升级与回滚

```bash
# 升级到新版本：只改 .env 里的两个镜像 tag
docker compose --env-file .env -f compose.yaml up -d --pull always

# 回滚：把 tag 改回上一个版本，再执行同一条命令
docker compose --env-file .env -f compose.yaml up -d --pull always
```

镜像同时带有 `vX.Y.Z` 与 `sha-<commit>` 两类标签，回滚只需要改回已知可用的 tag。
迁移只向前执行；回滚镜像前请确认新版本迁移没有引入不兼容的 schema 变更。

## 8. 安全要点

- 只有代理服务对外发布端口，数据库、API、worker 都只在 Compose 内部网络。
- 截图不在公开路径下，必须携带管理员会话才能读取，响应固定 `private, no-store`。
- 同步只会**新增**执行记录；不通过时新增缺陷，旧记录与旧缺陷永不被修改或关闭。
- 日志与 API 响应不会包含 Lark token、应用密钥或会话密钥。
