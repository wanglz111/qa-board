# TestDeck Foundation And Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each completed task must be committed immediately; never stage real `.env` files.

**Goal:** Run a standalone, single-admin web application that can import one MD/CSV/JSON file per independent test group, including multiple files in one selection.

**Architecture:** FastAPI with PostgreSQL and Alembic owns auth, group snapshots, and import transactions. React/Vite provides login, group selection, and per-file preview/field mapping; execution data is deferred to Plan 02. No runtime dependency on TestDeck master or any external directory.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2, Alembic, psycopg 3, pytest, React 19, TypeScript, Vite, Vitest, PostgreSQL 16.

---

## Scope And File Ownership

- `backend/pyproject.toml`: backend dependencies, formatting and test commands.
- `backend/app/config.py`, `db.py`, `main.py`: env contract, database session, application and health endpoints.
- `backend/app/models.py`, `backend/alembic/`: admin, group, group case, import ticket tables and migrations.
- `backend/app/auth.py`, `backend/app/bootstrap.py`: admin login/logout, HttpOnly cookie, CSRF verification and idempotent admin bootstrap.
- `backend/app/importers/{schema,csv_file,json_file,markdown_file}.py`: source parsing and validation; no HTTP/DB access.
- `backend/app/groups.py`: preview tickets, transactional confirmation and group listing.
- `frontend/src/{api,App,views/Login,views/Groups,views/Import}.tsx`: login, group picker and import workflow.
- `backend/tests/`, `frontend/src/**/*.test.tsx`: focused unit, API and interaction tests.

Use `backend/tests/conftest.py` to create an isolated PostgreSQL test database via `TEST_DATABASE_URL`; never fall back to `DATABASE_URL` for DB integration tests and never load the user's production `.env.production`. Root `.env.example` comes in Plan 03. Choose and pin dependency versions when initializing lockfiles, then commit generated lockfiles with Task 1. An installer command is allowed to generate lockfiles. After Task 1, activate `backend/.venv/bin/activate` for every subsequent plain `python`, `pytest` and `alembic` command. Docker Compose v5.1.3 and global pytest are present on the current machine, but the backend dependencies are not yet installed.

### Task 1: Backend Skeleton And Health

**Files:** Create `backend/pyproject.toml`, `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/db.py`, `backend/app/main.py`, `backend/tests/conftest.py`, `backend/tests/test_health.py`.

- [ ] Write `backend/tests/test_health.py` first:

```python
from fastapi.testclient import TestClient
from app.main import app

def test_liveness_does_not_disclose_configuration():
    response = TestClient(app).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
```

- [ ] Initialize `backend/pyproject.toml` with pinned FastAPI, uvicorn, SQLAlchemy, psycopg, Alembic, argon2-cffi, Pillow, openpyxl, pytest and httpx dependencies and install into `backend/.venv`; then run `cd backend && .venv/bin/python -m pytest tests/test_health.py -q`. Expected failure: `app.main` is absent, not a missing dependency.
- [ ] Create FastAPI application with the entire liveness contract:

```python
from fastapi import FastAPI

app = FastAPI(title="TestDeck")

@app.get("/health/live")
def live() -> dict[str, bool]:
    return {"ok": True}
```

  In `config.py`, require `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `CSRF_SECRET` at startup, with no default credential values. In test `conftest.py`, set nonworking dummy values before importing `app.main`:

```python
import os
os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.test")
os.environ.setdefault("ADMIN_PASSWORD", "test-password")
os.environ.setdefault("SESSION_SECRET", "test-only-session-secret-32-characters")
os.environ.setdefault("CSRF_SECRET", "test-only-csrf-secret-32-characters")
```

  Later DB tests use `TEST_DATABASE_URL` and an isolated PostgreSQL service. Create `/health/ready` that checks `SELECT 1` without reporting DB credentials. No route imports `progress.json`.
- [ ] Run `cd backend && .venv/bin/python -m pytest tests/test_health.py -q && .venv/bin/python -m compileall -q app`; expect one pass and clean compilation. Commit only Task 1 files: `git add backend && git commit -m "feat: scaffold standalone FastAPI backend"`.

### Task 2: Versioned Group Storage

**Files:** Create `backend/app/models.py`, `backend/alembic.ini`, `backend/alembic/env.py`, `backend/alembic/versions/0001_groups.py`, `backend/tests/test_groups_model.py`.

- [ ] Write failing PostgreSQL test `backend/tests/test_groups_model.py`:

```python
def test_same_case_number_is_allowed_in_different_groups(db_session, make_group_case):
    first = make_group_case(db_session, group_name="0918", code="B-001")
    second = make_group_case(db_session, group_name="0922", code="B-001")
    db_session.commit()
    assert first.id != second.id
    assert first.group_id != second.group_id
```

- [ ] Run `cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test python -m pytest tests/test_groups_model.py -q`; expected failure: `GroupCase` and fixture are absent. Start an isolated test Postgres container first if port 5433 is free; otherwise choose an unused port and use its URL.
- [ ] Define `Admin(id UUID, email UNIQUE, password_hash, created_at)`, `Group(id UUID, name, source_name, source_sha256, source_format, source_version, created_at)`, `GroupCase(id UUID, group_id FK ON DELETE CASCADE, code, position, title, module, layer, priority, preconditions, test_data, steps, expected, raw JSONB)`, and `ImportTicket(id UUID, file_sha256, original_file BYTEA, parsed JSONB, expires_at, consumed_at, created_at)`. Saving the capped original bytes enables remapping at confirmation; consumed/expired ticket bytes are purged. Add only group-scoped uniqueness:

```python
UniqueConstraint("group_id", "code", name="uq_group_case_code")
UniqueConstraint("group_id", "position", name="uq_group_case_position")
```

  Add SQLAlchemy relationships and test fixtures in `conftest.py` (`db_session` rolled back after each test and `make_group_case(session,group_name,code)` factory). Migration `0001_groups.py` creates the exact tables/indexes; `alembic/env.py` uses application metadata and `DATABASE_URL`.
- [ ] Run `cd backend && alembic upgrade head && python -m pytest tests/test_groups_model.py -q`; expect pass. Run twice to prove upgrades are idempotent. Commit `backend/app/models.py backend/alembic* backend/tests/` with `git commit -m "feat: add independent group schema and migrations"`.

### Task 3: Single-Admin Auth

**Files:** Create `backend/app/auth.py`, `backend/app/bootstrap.py`, `backend/tests/test_auth.py`, `backend/tests/test_bootstrap.py`; modify `backend/app/main.py`, `backend/app/models.py`.

- [ ] Write failing API test with `backend/tests/test_auth.py`:

```python
def test_admin_login_cookie_and_no_registration(client, seeded_admin):
    login = client.post("/api/auth/login", json={"email": "admin@example.test", "password": "test-password"})
    assert login.status_code == 200
    assert "httponly" in login.headers["set-cookie"].lower()
    assert client.get("/api/auth/me").json()["email"] == "admin@example.test"
    assert client.post("/api/auth/register", json={}).status_code == 404
```

- [ ] Run `cd backend && python -m pytest tests/test_auth.py -q`; expected failure: login route absent.
- [ ] Implement `bootstrap(session,config)` in `backend/app/bootstrap.py` using `ADMIN_EMAIL` and Argon2id `ADMIN_PASSWORD`; if an admin already exists, neither reset its hash nor create a second admin. Ensure one command `python -m app.bootstrap` calls it using configured database and exits 0. Login sets `HttpOnly; SameSite=Lax` session cookie (Secure when HTTPS); logout invalidates server-side session. `/api/auth/me` returns only email. CSRF token is delivered to the same-origin frontend via `GET /api/auth/csrf` and verified on POST/PUT/DELETE with header `X-CSRF-Token`. Reject non-admin API access with 401; check session expiry.
- [ ] Run `cd backend && python -m pytest tests/test_auth.py -q`; add tests for wrong password, CSRF rejection, logout and second bootstrap preserving password hash; all pass before commit. Commit `git add backend/app backend/tests && git commit -m "feat: secure single-administrator login"`.

### Task 4: Three Format Parsers

**Files:** Create `backend/app/importers/schema.py`, `csv_file.py`, `json_file.py`, `markdown_file.py`, `backend/tests/test_importers.py`, `backend/tests/fixtures/{group14.csv,old14.json,cases_book.md,report.md}`. Test fixtures must be created inside this repository; examples from another directory are inspected manually once, never read via a hard-coded runtime path.

- [ ] Write failing parser test:

```python
from app.importers.schema import parse_file

def test_each_file_is_one_group_not_one_case():
    md = ("#### B-001 · Login\n| 字段 | 内容 |\n| --- | --- |\n"
          "| 用例编号 | B-001 |\n| 执行步骤 | Open page |\n"
          "| 预期结果 | Visible |").encode("utf-8")
    cases = parse_file("book.md", md)
    assert len(cases) == 1 and cases[0].code == "B-001"
```

- [ ] Run `cd backend && python -m pytest tests/test_importers.py -q`; expected failure: `parse_file` absent.
- [ ] Implement `parse_file(name: str, content: bytes, mapping: dict[str,str] | None = None) -> list[ParsedCase]`; `ParsedCase` has `code, position, title, module, layer, priority, preconditions, test_data, steps, expected, raw`. CSV uses `csv.DictReader(io.StringIO(content.decode("utf-8-sig")))`; JSON accepts either top-level array or `{"cases": [...]}`; Markdown parser recognizes H4 case headings plus their field tables, or case tables with explicit `编号/标题/步骤/预期` columns. Decode HTML `<br>` in Markdown fields; ignore summaries and report tables. Provide canonical mapping for `id/order/title/checkpoints` and Chinese CSV keys. Reject unsupported/ambiguous boundaries, empty file, missing code/title, duplicate code or position, file over configured 10 MB, and more than 5000 cases with descriptive `ImportErrorDetail`. No default-to-empty success.
- [ ] Run `cd backend && python -m pytest tests/test_importers.py -q`; test UTF-8 BOM CSV, 14-case old JSON object, one Markdown book with two H4 cases, a case table, rejection of `report.md`, invalid bytes, duplicates, mapping variations. All pass before `git add backend/app/importers backend/tests && git commit -m "feat: parse complete CSV JSON and Markdown case books"`.

### Task 5: Preview Tickets And Atomic Import

**Files:** Create `backend/app/groups.py`, `backend/tests/test_groups_api.py`; modify `backend/app/main.py`.

- [ ] Write failing API test:

```python
from app.models import Group

def test_preview_does_not_insert_and_confirm_creates_a_new_group(client, csv_book, db_session):
    preview = client.post("/api/import/preview", files={"file": ("0918.csv", csv_book, "text/csv")})
    assert preview.status_code == 200
    assert db_session.query(Group).count() == 0
    result = client.post("/api/import/confirm", json={"ticket_id": preview.json()["ticket_id"], "name": "0918"})
    assert result.status_code == 201
    assert result.json()["count"] == 14
```

- [ ] Run `cd backend && python -m pytest tests/test_groups_api.py -q`; expected failure: `/api/import/preview` route absent.
- [ ] Implement `POST /api/import/preview` as multipart one file, returning `ticket_id`, `detected_format`, `count`, `cases[:10]`, `fields`, `errors`; never write a group here. `POST /api/import/confirm` accepts `ticket_id,name,mapping`, reparses the ticket's `original_file` bytes if mapping changes, consumes non-expired ticket, inserts one Group and all GroupCase rows in one DB transaction; a failed case rolls back entire file. `GET /api/groups` returns sorted groups with count and no execution state yet; `GET /api/groups/{id}/cases` returns ordered case snapshots. Re-upload same file creates a new UUID group and a duplicate-file warning, never overwrites old one. Provide `csv_book`, `client` (authenticated with a CSRF header), `db_session` fixtures in `backend/tests/conftest.py`.
- [ ] Run `cd backend && python -m pytest tests/test_groups_api.py -q`; add tests for expiry/one-use ticket, duplicate-file separate UUID, wrong mapping rollback, unauthenticated 401 and CSRF rejection. Commit `git add backend/app backend/tests && git commit -m "feat: preview and transactionally import independent groups"`.

### Task 6: Working Group And Import UI

**Files:** Create `frontend/package.json`, `frontend/package-lock.json`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/api.ts`, `frontend/src/views/{Login,Groups,Import}.tsx`, `frontend/src/views/Import.test.tsx`, `frontend/src/styles.css`.

- [ ] Write failing Vitest/Testing Library test:

```tsx
it("creates one preview for each selected file", async () => {
  const previewSpy = vi.fn().mockResolvedValue({ count: 1 });
  render(<ImportView preview={previewSpy} />);
  const files = [
    new File(["用例编号,用例标题\nB-001,Login"], "0918.csv", { type: "text/csv" }),
    new File(["{\"cases\":[{\"id\":\"C-001\",\"title\":\"Bind\"}]}"], "0922.json"),
  ];
  await userEvent.upload(screen.getByLabelText("选择用例文件"), files);
  expect(previewSpy).toHaveBeenCalledTimes(2);
});
```

- [ ] Initialize `frontend/package.json` with React, TypeScript, Vite, Lucide, Vitest, Testing Library, Playwright and scripts `test`, `build`; run `cd frontend && npm install && npx playwright install chromium`. Then `npm test -- --run`; expected failure: view module absent, not missing dependencies.
- [ ] Build Login, Groups and Import views: login to a same-origin cookie; fetch CSRF token once before mutations; choose multiple `.md/.csv/.json` files using `<input multiple accept=".md,.csv,.json">`; independently show each preview/error, group name and editable mapping selects, confirm each file separately. Show group rows with count/source/version/created date, allow selecting a group and read its ordered cases. Use Lucide icons, visible keyboard focus, status text+color, responsive widths (360px and desktop), and direct workspace first screen. `api.ts` uses `credentials: "same-origin"`, escapes untrusted titles by rendering text nodes, and redirects on 401.
- [ ] Run `cd frontend && npm test -- --run && npm run build`; run `cd backend && python -m pytest -q`; check browser screenshots 360px and desktop with Playwright before commit. Commit `git add frontend backend && git commit -m "feat: ship admin group picker and multi-file import UI"`.

## Checkpoint Before Plan 02

Run all commands fresh: `cd backend && python -m pytest -q`, `cd frontend && npm test -- --run && npm run build`, `git status --short`. Demonstrate two groups with shared `B-001` and distinct UUIDs, 14-case CSV, old 14-case JSON, and a two-case Markdown book. Verify `git check-ignore .env.production` reports ignored and that no real credentials occur in tracked files. Do not claim the one-command production deployment yet: Plan 03 owns published images and Compose verification.
