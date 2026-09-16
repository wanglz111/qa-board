# TestDeck Lark History And Image Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run tests and commit after every task; never use live old Lark tables for write tests.

**Goal:** Show verified legacy Lark history and table names without modifying old records or bugs; append only new attempts, publish Docker images from the independent GitHub project, and start with Compose plus one .env.

**Architecture:** A read-only Lark adapter and historical-reference path are separate from the new-attempt worker. Group confirmation pins actual base/table names and verified field types before outbound writes. A PostgreSQL outbox tracks new create results and uncertain timeouts. GitHub Actions publishes web/api images to GHCR; Compose performs first-start migration/bootstrap and runs on persistent volumes.

**Tech Stack:** FastAPI, requests/httpx, SQLAlchemy/PostgreSQL, React, Docker Compose, Caddy, GitHub Actions and GHCR.

---

## File Ownership

- `backend/app/lark/{client,history,fields,write}.py`: API requests, old record/attachment matching, schema inspection, new-only create adapter.
- `backend/app/lark/confirmation.py`, `backend/app/models.py`, `backend/alembic/versions/0003_lark.py`: per-group confirmed destination; legacy refs never used as write targets.
- `backend/app/lark/outbox.py`, `backend/app/worker.py`: PostgreSQL job leases, create/reconcile, bounded retry and pause on uncertain result.
- `frontend/src/views/LarkCheck.tsx`, `frontend/src/components/LegacyHistory.tsx`: actual base/table names and previous failure view.
- `backend/tests/test_lark_{history,confirmation,outbox}.py`, `frontend/src/views/LarkCheck.test.tsx`: mock Lark API and audit every HTTP method; test code must never use the user credential file.
- `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/Caddyfile`, `infra/Caddyfile`, `compose.yaml`, `.env.example`, `.github/workflows/publish.yml`, `docs/DEPLOYMENT.md`: build/publish/one-command pull, health/backup/rollback.

### Task 1: Read-Only Lark Metadata And Historic Records

**Files:** Create `backend/app/lark/{client,fields,history}.py`, `backend/tests/test_lark_history.py`; modify `backend/app/main.py`.

- [ ] Write a failing adapter test using mock transport:

```python
def test_old_b001_is_not_b001_retest_and_adapter_never_writes(lark_fake):
    lark_fake.records = [{"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}},
                         {"record_id": "new1", "fields": {"用例": "B-001-R0918-01 Login", "结果": "通过"}}]
    history = lark_fake.history_for("B-001")
    assert history.original[0]["record_id"] == "old1"
    assert history.retests[0]["record_id"] == "new1"
    assert not any(method in ("PUT", "PATCH", "DELETE") for method in lark_fake.record_methods)
```

- [ ] Run `cd backend && python -m pytest tests/test_lark_history.py -q`; expected failure: Lark adapter absent.
- [ ] Implement Lark international token exchange (POST to the authentication endpoint is allowed), read-only `GET /open-apis/bitable/v1/apps/{app_token}` and `GET .../tables/{table_id}` metadata, paginated `GET .../fields` and `GET .../records`. The history adapter never POSTs to a **record** endpoint and never PUT/PATCH/DELETEs records. Parse `用例` text at beginning using an exact case-code boundary and optional `-R...` suffix; keep unknown/duplicate ambiguity visible. Rank only by verified Lark date or modification metadata, otherwise report uncertain, not invented “latest”. Match old bug using definite case-code prefix in `问题描述` or explicit link; include description/status, never close it. Add authenticated `GET /api/lark/history/{history_ref_id}/attachments/{index}` to proxy only confirmed old attachment tokens after Lark read permission check, with private no-store headers; resolve file token server-side and never expose it in URL or logs. `GET /api/lark/check` returns actual base name, execution/bug table names, required field types and read errors, not app secrets or raw credentials. Add `lark_fake` fixture in `backend/tests/conftest.py` that injects a mock HTTP transport, records each request method/path, provides `history_for(code)`, and never calls real credentials.
- [ ] Run `cd backend && python -m pytest tests/test_lark_history.py -q`; include paginated >500 records, `B-001` vs `B-0010`, missing columns, multiple ambiguous matches, old attachment 401/no raw token exposure, record GET-only audit, and missing `LARK_TABLE_RUNS`/DEFECTS. Commit `git add backend && git commit -m "feat: inspect actual Lark table names and old failures read-only"`.

### Task 2: Explicit Per-Group Write Confirmation

**Files:** Create `backend/app/lark/confirmation.py`, `backend/alembic/versions/0003_lark.py`, `backend/tests/test_lark_confirmation.py`, `frontend/src/views/LarkCheck.tsx`, `frontend/src/views/LarkCheck.test.tsx`; modify `backend/app/models.py`, `frontend/src/views/Execution.tsx`.

- [ ] Write a failing test:

```python
def test_cannot_queue_external_write_before_confirm(client, imported_group, known_table_names):
    submit = client.post(f"/api/groups/{imported_group}/cases/B-001/attempts",
                         json={"result": "通过", "idempotency_key": "check-1"})
    assert submit.status_code == 201
    assert client.get(f"/api/groups/{imported_group}/sync").json()["queued"] == 0
    check = client.get("/api/lark/check").json()
    assert check["base_name"] == known_table_names["base_name"]
```

- [ ] Run `cd backend && python -m pytest tests/test_lark_confirmation.py -q`; expected failure: confirmation and sync endpoints absent.
- [ ] Migration adds `GroupLarkConfirmation(group_id UNIQUE, base_token, execution_table_id, bug_table_id, base_name, execution_table_name, bug_table_name, schema_fingerprint, confirmed_at)` and `LarkHistoryRef(group_case_id, table_id, old_record_id, observed_at, certainty, snapshot JSONB)`. Only historical ref is read-only. `POST /api/groups/{id}/lark/confirm` takes exact fingerprint from `GET /api/lark/check` and rejects changed targets/schema or missing mandatory field types (409); group confirmation is invalidated if target changes. UI shows actual API-read names and a checkbox/toggle “允许向上述旧表新增本组记录”, followed by clear confirmation command; never turn on writes from imported data alone. After confirmation the admin can explicitly queue previously saved local attempts.
- [ ] Run backend/frontend focused tests for rejection before confirmation, altered fingerprint and re-confirmation. Commit `git add backend frontend && git commit -m "feat: require actual Lark table-name approval per group"`.

### Task 3: New-Attempt-Only PostgreSQL Outbox

**Files:** Create `backend/app/lark/{outbox,write}.py`, `backend/app/worker.py`, `backend/tests/test_lark_outbox.py`; modify `backend/app/models.py`, `backend/alembic/versions/0003_lark.py`, `backend/app/execution.py`.

- [ ] Write failing fake-client test:

```python
def test_old_records_and_bugs_are_never_updated(fake_lark, confirmed_group, failed_attempt):
    from app.worker import process_one_job
    process_one_job(fake_lark, failed_attempt)
    assert fake_lark.created_execution == 1
    assert fake_lark.created_bug == 1
    assert not fake_lark.put_calls and not fake_lark.delete_calls
    assert fake_lark.old_bug_status == "待修复"
```

- [ ] Run `cd backend && python -m pytest tests/test_lark_outbox.py -q`; expected failure: worker absent.
- [ ] Add `SyncJob(id UUID, attempt_id UNIQUE, state pending/running/synced/failed/uncertain, lease_until, retry_count, next_retry_at, new_exec_record_id, new_bug_record_id, error_kind, created_at)`. Confirmed group creates a job in the same transaction as a **new** committed attempt, or explicit `POST /api/groups/{id}/sync/enqueue` creates jobs for older local attempts using `ON CONFLICT DO NOTHING`. Worker claims due tasks via `SELECT ... FOR UPDATE SKIP LOCKED` with a bounded lease. Use only record-create API for new execution fields `用例/结果/优先级/负责人/报告人/日期/截图/控制台`; on new failure create new bug `问题描述/进展状态/优先级/反馈时间/备注/反馈人` preserving `【自动提】` marker. Never PATCH/PUT/DELETE legacy IDs or bugs. Store returned new record ID before starting bug create. On timeout after POST, query target table for unique attempt label; if exactly one match bind its ID, if no provable outcome set `uncertain` and stop automatic POST retry until administrator reviews. Retriable known failure uses bounded exponential delay; worker restart reclaims expired leases. `GET /api/groups/{id}/sync` includes failed/uncertain count and redacted error. Fake `fake_lark`, `confirmed_group`, `failed_attempt` test fixtures are defined in `backend/tests/conftest.py`; fake client audits outbound methods and preserves original bug status.
- [ ] Run `cd backend && python -m pytest tests/test_lark_outbox.py -q`; test timeout after remote create, worker restart, two concurrent workers, failure before exec create, partial bug failure and old-ID no-write audit. Commit `git add backend && git commit -m "feat: append only new Lark attempts with reconciled retries"`.

### Task 4: Show Old Result Versus Current Attempts

**Files:** Create `frontend/src/components/LegacyHistory.tsx`, `frontend/src/components/LegacyHistory.test.tsx`; modify `frontend/src/views/{Execution,LarkCheck}.tsx`, `frontend/src/styles.css`.

- [ ] Write failing view test:

```tsx
it("keeps legacy failure separate from this group's progress", async () => {
  render(<LegacyHistory code="B-001" loadHistory={loadLegacyFailure} />);
  expect(await screen.findByText("上次失败：绑定未触发")).toBeVisible();
  expect(screen.queryByText("本组已失败")).not.toBeInTheDocument();
});
```

- [ ] Run `cd frontend && npm test -- --run`; expected failure: `LegacyHistory` absent.
- [ ] Provide “旧表只读记录”, “本组测试”, “复测” distinct views with source table name/read time and old bug status; show uncertain match rather than faking a previous failure. Add “复测” command that starts a new label through Plan 02 API and navigates to its form; once saved, show local status immediately and outbound sync status separately. A passing retest never displays an action claiming to close old bug. Keep long descriptions and attachment thumbnails responsive.
- [ ] Run frontend suite and Playwright desktop/360px screenshots for one old failure + passing retest, ambiguous history and unavailable Lark. Commit `git add frontend && git commit -m "feat: present read-only old failures and new retest history"`.

### Task 5: Image Build, Compose, And Automatic Initialization

**Files:** Create `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/Caddyfile`, `infra/Caddyfile`, `compose.yaml`; modify `backend/app/bootstrap.py`, `backend/tests/test_bootstrap.py` from Plan 01; create root `.env.example`.

- [ ] Write failing bootstrap regression test:

```python
def test_second_boot_keeps_admin_and_group(db_session, seed_admin_group, config):
    old_hash, old_group_id = seed_admin_group
    bootstrap(db_session, config)
    bootstrap(db_session, config)
    assert db_session.query(Admin).one().password_hash == old_hash
    assert db_session.query(Group).one().id == old_group_id
```

- [ ] Run `cd backend && python -m pytest tests/test_bootstrap.py -q`; expected failure: bootstrap absent.
- [ ] Backend image uses a locked Python dependency install and runs `uvicorn app.main:app --host 0.0.0.0 --port 8080` for API, `python -m app.worker` for worker, both from the same image. Frontend image builds Vite assets and serves them privately behind proxy. `compose.yaml` uses `image: ${WEB_IMAGE}` / `image: ${API_IMAGE}`, no `build:`, internal db, private `pgdata`/`screenshots` volumes, db healthcheck, one-shot `migrate` service running `alembic upgrade head && python -m app.bootstrap`; API/worker depend on successful migration. Proxy is the only published port service (80/443 for domain mode); health routes do not expose credentials. `.env.example` contains `WEB_IMAGE=ghcr.io/wanglz111/qa-board-web:v0.1.0`, `API_IMAGE=ghcr.io/wanglz111/qa-board-api:v0.1.0`, `DATABASE_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `CSRF_SECRET`, `DOMAIN`, `LARK_BASE_URL`, `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_BUG_APP_TOKEN`, `LARK_TABLE_RECORDS`, `LARK_TABLE_BUGS`; sensitive values in example are nonworking. If actual GitHub owner differs, substitute the published image address in the server's one `.env`.
- [ ] Run `docker compose --env-file .env.example -f compose.yaml config` to verify interpolation without credentials; build disposable local images under the tags from a **separate local test `.env`**, run `docker compose --env-file .env -f compose.yaml up -d --pull never`, restart and verify admin hash/group/screenshot persistence. Published `--pull always` verification belongs to Task 6 after GHCR images exist. Run backend bootstrap test and `git diff --check`. Commit `git add backend/Dockerfile frontend/Dockerfile frontend/Caddyfile infra compose.yaml .env.example backend/app/bootstrap.py backend/tests/test_bootstrap.py && git commit -m "feat: enable one-command image-based Compose startup"`.

### Task 6: Independent GitHub Actions Publishing

**Files:** Create `.github/workflows/publish.yml`, `docs/DEPLOYMENT.md`; add `backend/tests/test_no_legacy_writes.py`.

- [ ] Write failing release-contract test (no old mutation route):

```python
def test_lark_client_has_no_legacy_mutation_calls(lark_fake):
    lark_fake.read_history("B-001")
    assert not any(r.method in ("PUT", "PATCH", "DELETE") for r in lark_fake.requests)
```

- [ ] Run `cd backend && python -m pytest tests/test_no_legacy_writes.py -q`; expected failure before fixture/client audit is wired.
- [ ] Workflow on `v*` tags runs pytest, frontend Vitest/build, Compose config and Docker builds; logs in with `GITHUB_TOKEN` (package write permission) and uses `docker/build-push-action` to publish two version- and commit-tagged GHCR images from this repository only. Compute lowercase image owner from `github.repository_owner` so GHCR path is valid; no old repo checkout. Deployment docs explain public package visibility as a one-time GitHub setting (private package requires registry login and violates the “only Compose + .env” rule), version-pinned `WEB_IMAGE`/`API_IMAGE`, safe secret generation, DNS/HTTPS, `docker compose --env-file .env -f compose.yaml up -d --pull always`, status checks, backup via `pg_dump` plus private screenshots and a restore drill. Never paste actual test credential values into docs or Git history.
- [ ] Run `cd backend && python -m pytest -q`, `cd frontend && npm test -- --run && npm run build`, `docker compose --env-file .env.example -f compose.yaml config`, `git diff --check`; verify the GitHub workflow publishes images on a temporary release tag in the independent repository **only after** remote exists and public package setting is chosen. Then run the real `docker compose --env-file .env -f compose.yaml up -d --pull always` against those published images using test credentials. Commit `git add .github docs backend/tests && git commit -m "ci: publish independent TestDeck images to GHCR"`.

## Final Delivery Evidence

Run the full test suites, Playwright desktop/360px checks, Compose config and actual first/restart test in a safe local/test environment. Inspect fake Lark request log for GET+POST only and zero legacy PUT/PATCH/DELETE, including passing retest leaving old bug unchanged. Verify `git status --short` contains no tracked credential file, check `git ls-files .env .env.production` returns nothing, and list commit hashes for every completed task. Publishing to GHCR and public-domain HTTPS cannot be claimed until independent GitHub remote/package setting, domain and server access are actually supplied; the local workflow/Compose artifacts can be verified without them.
