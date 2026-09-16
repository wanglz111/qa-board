# TestDeck Lark Connection And Per-Group Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run tests and commit after every task; never point a test at a real Lark tenant.

**Goal:** Let the administrator paste a Lark wiki or base link, choose an execution table and a bug table per test group, store both in PostgreSQL, and force an explicit re-confirmation before a group's target changes.

**Architecture:** Table identity leaves `app/config.py` and moves into `lark_targets` (one row per group) plus an append-only `lark_target_revisions`. A pure parser turns a pasted URL into a base token without network access; the Lark client resolves wiki nodes read-only. Every write and read path (outbox, worker, history) resolves the group's row instead of the environment. Changing a target requires a server-side acknowledgement, clears `confirmed_at`, and parks already-queued sync jobs until the administrator re-points them.

**Tech Stack:** FastAPI, httpx, SQLAlchemy/PostgreSQL/Alembic, React + Vitest, Playwright.

---

## Behaviour Decisions

- **Credentials stay in the environment.** Only `LARK_BASE_URL`, `LARK_APP_ID` and `LARK_APP_SECRET` remain; every table identifier moves to `lark_targets`. The Lark application must be added as a collaborator of each target document, otherwise reads and field creation fail with a permission error.
- **Two roles, one or two bases.** `execution_base_token` and `bug_base_token` are separate columns, so a group may point both roles at one base (both tokens equal) or at two bases. Both roles are required: a group without a defect table cannot record a failure, so the page offers 「新建数据表」 instead of allowing an empty defect role.
- **Many test sets may share one table.** The group is the unit of binding, so sharing is expressed by pointing several groups at the same base and table; nothing is global and nothing is exclusive.
- **Storage starts empty.** The database and every table hold test data only, so `0009_lark_targets` drops `group_lark_confirmations` with no backfill and no preserved approvals.
- **No polling.** The page reads live state when it opens, when the group changes and when the administrator clicks 刷新; fingerprints are stored so a read is not repeated on every render.

## File Ownership

- `backend/app/lark/link.py`: pure URL to `LarkLink` parsing; no network and no database.
- `backend/app/lark/target.py`: resolve, fingerprint, diff and persist one group's target.
- `backend/app/lark/client.py`: adds the read-only wiki node lookup; the record audit stays GET/POST-only.
- `backend/app/lark/{history,outbox,confirmation}.py`, `backend/app/worker.py`: read the stored target instead of environment tables.
- `backend/app/models.py`, `backend/alembic/versions/0009_lark_targets.py`: new storage.
- `frontend/src/views/LarkCheck.tsx`, `frontend/src/components/TargetChangeDialog.tsx`, `frontend/src/api.ts`: the connection page.
- `backend/tests/{conftest,test_lark_link,test_lark_target,test_lark_outbox,test_lark_history}.py`, `frontend/src/views/LarkCheck.test.tsx`, `frontend/e2e/lark-check.spec.ts`: coverage.

### Task 1: Per-Group Target Storage

**Files:** Create `backend/alembic/versions/0009_lark_targets.py`, `backend/tests/test_lark_target_model.py`; modify `backend/app/models.py`.

- [ ] **Step 1: Write the failing model test**

```python
import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models import LarkTarget, LarkTargetRevision


def _target(group_id, execution_table_id: str) -> LarkTarget:
    return LarkTarget(
        group_id=group_id,
        source_url="https://tenant.larksuite.com/wiki/node1?table=tbl-a",
        execution_base_token="app-exec",
        execution_base_name="执行库",
        execution_table_id=execution_table_id,
        execution_table_name="执行记录",
        bug_base_token="app-bug",
        bug_base_name="缺陷库",
        bug_table_id="tbl-bugs",
        bug_table_name="缺陷记录",
        target_fingerprint="app-exec|tbl-a|app-bug|tbl-bugs",
        schema_fingerprint=None,
    )


def test_one_target_row_per_group(db_session, imported_group):
    db_session.add(_target(imported_group.id, "tbl-a"))
    db_session.commit()
    db_session.add(_target(imported_group.id, "tbl-b"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_revisions_accumulate_per_group(db_session, imported_group):
    for fingerprint in ("f1", "f2"):
        db_session.add(
            LarkTargetRevision(
                group_id=imported_group.id, target_fingerprint=fingerprint
            )
        )
    db_session.commit()
    count = db_session.scalar(select(func.count()).select_from(LarkTargetRevision))
    assert count == 2


def test_confirmation_starts_empty(db_session, imported_group):
    target = _target(imported_group.id, "tbl-a")
    db_session.add(target)
    db_session.commit()
    assert target.confirmed_at is None
    assert target.selected_at is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_target_model.py -q`
Expected: FAIL with `ImportError: cannot import name 'LarkTarget'`.

- [ ] **Step 3: Add the models and the migration**

In `backend/app/models.py`, delete `GroupLarkConfirmation` and add:

```python
class LarkTarget(Base):
    """The real Lark destination of one test group, selected by an administrator.

    ``confirmed_at`` is the write approval; a changed ``target_fingerprint``
    clears it so a re-pointed group can never inherit earlier consent.
    """

    __tablename__ = "lark_targets"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    source_url: Mapped[str] = mapped_column(String, nullable=False)
    execution_base_token: Mapped[str] = mapped_column(String, nullable=False)
    execution_base_name: Mapped[str] = mapped_column(String, nullable=False)
    execution_table_id: Mapped[str] = mapped_column(String, nullable=False)
    execution_table_name: Mapped[str] = mapped_column(String, nullable=False)
    execution_view_id: Mapped[str | None] = mapped_column(String)
    execution_view_name: Mapped[str | None] = mapped_column(String)
    bug_base_token: Mapped[str] = mapped_column(String, nullable=False)
    bug_base_name: Mapped[str] = mapped_column(String, nullable=False)
    bug_table_id: Mapped[str] = mapped_column(String, nullable=False)
    bug_table_name: Mapped[str] = mapped_column(String, nullable=False)
    schema_fingerprint: Mapped[str | None] = mapped_column(String)
    target_fingerprint: Mapped[str] = mapped_column(String, nullable=False)
    selected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LarkTargetRevision(Base):
    """Every distinct target a group has ever used, newest last.

    History and reconciliation read old tables through this log, so a table
    that was swapped away stays reachable instead of disappearing.
    """

    __tablename__ = "lark_target_revisions"
    __table_args__ = (
        UniqueConstraint("group_id", "target_fingerprint", name="uq_lark_revision"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    execution_base_token: Mapped[str] = mapped_column(String, nullable=False)
    execution_table_id: Mapped[str] = mapped_column(String, nullable=False)
    bug_base_token: Mapped[str] = mapped_column(String, nullable=False)
    bug_table_id: Mapped[str] = mapped_column(String, nullable=False)
    target_fingerprint: Mapped[str] = mapped_column(String, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

Add `target_fingerprint` to `SyncJob` (used in Task 5):

```python
    target_fingerprint: Mapped[str | None] = mapped_column(String)
```

Create `backend/alembic/versions/0009_lark_targets.py` with `revision = "0009_lark_targets"` and `down_revision = "0008_sync_jobs"`. `upgrade()` creates `lark_targets`, creates `lark_target_revisions` (including `UniqueConstraint("group_id", "target_fingerprint", name="uq_lark_revision")`), adds `sa.Column("target_fingerprint", sa.String(), nullable=True)` to `sync_jobs`, and drops `group_lark_confirmations`; `downgrade()` reverses all four operations. Follow the column style of `0008_sync_jobs.py` (UUID primary keys, `DateTime(timezone=True)`, `server_default=sa.text("now()")`, `ondelete="CASCADE"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_target_model.py tests/test_migrations.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/alembic/versions/0009_lark_targets.py backend/tests/test_lark_target_model.py
git commit -m "feat: store one Lark target and revision log per test group"
```

### Task 2: Paste-A-Link Parser

**Files:** Create `backend/app/lark/link.py`, `backend/tests/test_lark_link.py`.

- [ ] **Step 1: Write the failing parser test**

```python
import pytest

from app.lark.link import LarkLinkError, parse_lark_link

WIKI_URL = (
    "https://test-dlfvy3y2svp1.jp.larksuite.com/wiki/FEQQwK3YtiJG9KkKbZrjm08upsg"
    "?table=tblTtOHN29SoDsWU&view=vewzrLrwRG"
)


def test_parses_wiki_link_with_table_and_view():
    link = parse_lark_link(WIKI_URL)
    assert link.kind == "wiki"
    assert link.source_id == "FEQQwK3YtiJG9KkKbZrjm08upsg"
    assert link.table_id == "tblTtOHN29SoDsWU"
    assert link.view_id == "vewzrLrwRG"
    assert link.host == "test-dlfvy3y2svp1.jp.larksuite.com"


def test_parses_base_link_without_query():
    link = parse_lark_link("https://tenant.larksuite.com/base/bascnAbc123")
    assert (link.kind, link.source_id, link.table_id, link.view_id) == (
        "base",
        "bascnAbc123",
        None,
        None,
    )


@pytest.mark.parametrize(
    "url",
    [
        "https://tenant.larksuite.com/docx/doxcnAbc",
        "https://tenant.larksuite.com/sheets/shtcnAbc",
        "https://tenant.larksuite.com/wiki/",
        "https://evil.example.com/wiki/node1",
        "https://larksuite.com.evil.example.com/wiki/node1",
        "not-a-url",
        "https://tenant.larksuite.com/wiki/node1?table=notatable",
    ],
)
def test_rejects_anything_that_is_not_a_bitable_link(url):
    with pytest.raises(LarkLinkError):
        parse_lark_link(url)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_link.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.lark.link'`.

- [ ] **Step 3: Write the parser**

```python
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse


# Only these tenants may be addressed, so a pasted URL can never become a
# request against an attacker-chosen host.
ALLOWED_SUFFIXES = ("larksuite.com", "feishu.cn")
CONTENT_KINDS = ("wiki", "base")
TABLE_ID = re.compile(r"^tbl[A-Za-z0-9]+$")
VIEW_ID = re.compile(r"^vew[A-Za-z0-9]+$")


class LarkLinkError(ValueError):
    """The pasted text is not a readable Lark Bitable link."""


@dataclass(frozen=True)
class LarkLink:
    host: str
    kind: str
    source_id: str
    table_id: str | None
    view_id: str | None


def _host_is_allowed(host: str) -> bool:
    return any(
        host == suffix or host.endswith(f".{suffix}") for suffix in ALLOWED_SUFFIXES
    )


def parse_lark_link(url: str) -> LarkLink:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise LarkLinkError("请粘贴 Lark 文档链接")
    host = parsed.hostname.lower()
    if not _host_is_allowed(host):
        raise LarkLinkError("只支持 larksuite.com 或 feishu.cn 的文档链接")

    segments = [part for part in parsed.path.split("/") if part]
    if len(segments) != 2 or segments[0] not in CONTENT_KINDS:
        raise LarkLinkError("链接不是多维表格（wiki 或 base），无法读取表头")

    query = parse_qs(parsed.query)
    table_id = (query.get("table") or [None])[0]
    view_id = (query.get("view") or [None])[0]
    if table_id is not None and not TABLE_ID.match(table_id):
        raise LarkLinkError("链接里的 table 参数不是多维表格数据表")
    if view_id is not None and not VIEW_ID.match(view_id):
        raise LarkLinkError("链接里的 view 参数不是多维表格视图")

    return LarkLink(
        host=host,
        kind=segments[0],
        source_id=segments[1],
        table_id=table_id,
        view_id=view_id,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_link.py -q`
Expected: PASS (9 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/lark/link.py backend/tests/test_lark_link.py
git commit -m "feat: parse pasted Lark wiki and base links without network access"
```

### Task 3: Resolve A Pasted Link Into Selectable Tables

**Files:** Create `backend/app/lark/target.py`, `backend/tests/test_lark_target.py`; modify `backend/app/lark/client.py`, `backend/app/main.py`, `backend/tests/conftest.py`.

- [ ] **Step 1: Write the failing resolve test**

```python
def test_resolve_returns_base_tables_and_the_linked_table(
    lark_fake, authenticated_client
):
    lark_fake.wiki_nodes["node-1"] = {"obj_type": "bitable", "obj_token": "app-exec"}
    body = authenticated_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    ).json()
    assert body["base_token"] == "app-exec"
    assert body["base_name"] == "执行库"
    assert {table["table_id"] for table in body["tables"]} == {"tbl-runs", "tbl-bugs"}
    assert body["selected"]["table_id"] == "tbl-runs"
    assert body["selected"]["view_id"] == "vew-main"
    assert "用例" in body["execution_fields"]
    assert body["read_errors"] == []


def test_resolve_rejects_a_wiki_node_that_is_not_a_bitable(
    lark_fake, authenticated_client
):
    lark_fake.wiki_nodes["node-doc"] = {"obj_type": "docx", "obj_token": "doxcn1"}
    response = authenticated_client.post(
        "/api/lark/resolve",
        json={"url": "https://tenant.larksuite.com/wiki/node-doc"},
    )
    assert response.status_code == 422
    assert "多维表格" in response.json()["detail"]


def test_resolve_reports_a_link_the_app_cannot_read(lark_fake, authenticated_client):
    lark_fake.wiki_error = True
    response = authenticated_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    )
    assert response.status_code == 409
    assert "协作者" in response.json()["detail"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_target.py -q`
Expected: FAIL with 404 for `POST /api/lark/resolve`.

- [ ] **Step 3: Add the wiki lookup, the resolver and the endpoint**

Add to `LarkClient` in `backend/app/lark/client.py`:

```python
    def wiki_node(self, node_token: str) -> dict[str, Any]:
        """Resolve one wiki node to the Bitable app token behind it."""

        data = self._send(
            "GET",
            "/open-apis/wiki/v2/spaces/get_node",
            params={"token": node_token, "obj_type": "wiki"},
        )
        node = data.get("node")
        if not isinstance(node, dict):
            raise LarkError("Lark 未返回 wiki 节点信息")
        return node
```

Create `backend/app/lark/target.py`, the single owner of "what counts as a valid target":

```python
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.fields import (
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    describe_fields,
    missing_required_fields,
    schema_fingerprint,
)
from app.lark.link import LarkLinkError, parse_lark_link
from app.models import Group, LarkTarget, LarkTargetRevision


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


@dataclass(frozen=True)
class TargetDraft:
    execution_base_token: str
    execution_table_id: str
    execution_view_id: str | None
    bug_base_token: str
    bug_table_id: str

    @property
    def fingerprint(self) -> str:
        return "|".join(
            [
                self.execution_base_token,
                self.execution_table_id,
                self.bug_base_token,
                self.bug_table_id,
            ]
        )


def _table_name(tables: list[dict[str, Any]], table_id: str) -> str | None:
    for table in tables:
        if str(table.get("table_id")) == table_id:
            name = table.get("name")
            return str(name) if name else None
    return None


def resolve_link(client: LarkClient, url: str) -> dict[str, Any]:
    """Turn a pasted link into one base plus its selectable tables.

    Read-only: a wiki node lookup, the base metadata and the table/field
    listings are the only requests.
    """

    try:
        link = parse_lark_link(url)
    except LarkLinkError as error:
        raise LookupError(str(error)) from None

    base_token = link.source_id
    if link.kind == "wiki":
        try:
            node = client.wiki_node(link.source_id)
        except LarkError:
            raise PermissionError(
                "无法读取该 wiki 文档，请把 Lark 应用加为文档协作者后重试"
            ) from None
        if str(node.get("obj_type")) != "bitable":
            raise LookupError("该链接指向的不是多维表格")
        base_token = str(node.get("obj_token") or "")
        if not base_token:
            raise LookupError("该 wiki 文档没有关联多维表格")

    try:
        base = client.app_metadata(base_token)
        tables = client.list_tables(base_token)
    except LarkError as error:
        raise PermissionError(f"无法读取多维表格：{error}") from None

    selected = link.table_id if _table_name(tables, link.table_id or "") else None
    selected = selected or (str(tables[0].get("table_id")) if tables else None)
    fields = client.list_fields(base_token, selected) if selected else []

    return {
        "source_url": url,
        "host": link.host,
        "base_token": base_token,
        "base_name": str((base.get("app") or {}).get("name") or ""),
        "tables": [
            {
                "table_id": str(table.get("table_id")),
                "name": str(table.get("name") or ""),
            }
            for table in tables
        ],
        "selected": {
            "table_id": selected,
            "table_name": _table_name(tables, selected or ""),
            "view_id": link.view_id,
            "view_name": None,
        },
        "execution_fields": describe_fields(fields),
        "required_execution_fields": sorted(REQUIRED_RUN_FIELD_TYPES),
        "schema_errors": missing_required_fields(fields, REQUIRED_RUN_FIELD_TYPES),
        "read_errors": [],
    }


def read_draft_state(client: LarkClient, draft: TargetDraft) -> dict[str, Any]:
    """Read both tables' live names and fields; never returns credentials."""

    execution_base = client.app_metadata(draft.execution_base_token)
    bug_base = client.app_metadata(draft.bug_base_token)
    execution_tables = client.list_tables(draft.execution_base_token)
    bug_tables = client.list_tables(draft.bug_base_token)
    execution_fields = client.list_fields(
        draft.execution_base_token, draft.execution_table_id
    )
    bug_fields = client.list_fields(draft.bug_base_token, draft.bug_table_id)

    execution_table_name = _table_name(execution_tables, draft.execution_table_id)
    bug_table_name = _table_name(bug_tables, draft.bug_table_id)
    read_errors: list[str] = []
    if execution_table_name is None:
        read_errors.append(f"Lark 中找不到执行记录表 {draft.execution_table_id}")
    if bug_table_name is None:
        read_errors.append(f"Lark 中找不到缺陷表 {draft.bug_table_id}")

    schema_errors = missing_required_fields(execution_fields, REQUIRED_RUN_FIELD_TYPES)
    schema_errors += missing_required_fields(bug_fields, REQUIRED_BUG_FIELD_TYPES)
    return {
        "execution_base_name": str((execution_base.get("app") or {}).get("name") or ""),
        "execution_table_name": execution_table_name,
        "bug_base_name": str((bug_base.get("app") or {}).get("name") or ""),
        "bug_table_name": bug_table_name,
        "execution_fields": describe_fields(execution_fields),
        "bug_fields": describe_fields(bug_fields),
        "schema_errors": schema_errors,
        "read_errors": read_errors,
        "schema_fingerprint": (
            None
            if schema_errors
            else f"{schema_fingerprint(execution_fields)}||{schema_fingerprint(bug_fields)}"
        ),
    }


def target_diff(previous: LarkTarget | None, draft: TargetDraft) -> dict[str, Any]:
    """Which identity parts differ from the stored target."""

    next_identity = {
        "execution_base_token": draft.execution_base_token,
        "execution_table_id": draft.execution_table_id,
        "bug_base_token": draft.bug_base_token,
        "bug_table_id": draft.bug_table_id,
    }
    if previous is None:
        return {
            "changed": False,
            "changed_keys": [],
            "previous": None,
            "next": next_identity,
        }
    previous_identity = {key: getattr(previous, key) for key in next_identity}
    changed_keys = sorted(
        key for key, value in next_identity.items() if previous_identity[key] != value
    )
    return {
        "changed": bool(changed_keys),
        "changed_keys": changed_keys,
        "previous": previous_identity,
        "next": next_identity,
    }


class ResolveRequest(BaseModel):
    url: str


@router.post("/lark/resolve")
def resolve(
    payload: ResolveRequest,
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    try:
        return resolve_link(client, payload.url)
    except LookupError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
```

Register the router in `backend/app/main.py`: `from app.lark.target import router as lark_target_router` plus `app.include_router(lark_target_router)`.

Extend `FakeLark` in `backend/tests/conftest.py`: add `self.wiki_nodes: dict[str, dict[str, Any]] = {}`, `self.wiki_error = False`, and

```python
        self.wiki_url = "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs&view=vew-main"
        self.bases = {
            "app-exec": ("执行库", [("tbl-runs", "执行记录"), ("tbl-bugs", "缺陷记录")]),
            "app-bug": ("缺陷库", [("tbl-defects", "缺陷记录")]),
            "app-token": ("旧版测试管理", [("tbl-runs", "执行记录"), ("tbl-defects", "缺陷记录")]),
        }
```

Handle `/open-apis/wiki/v2/spaces/get_node` in `handle()`: return `{"code": 1770003, "msg": "no permission"}` when `self.wiki_error`, otherwise `{"code": 0, "data": {"node": self.wiki_nodes[request.url.params["token"]]}}`. Make `/tables` and `/apps/{token}` answer from `self.bases` instead of the two hard-coded names, and add a `/views` listing returning `[{"view_id": "vew-main", "view_name": "主视图", "view_type": "grid"}]`. Keep the existing `app-token`, `tbl-runs` and `tbl-defects` values so the history and outbox suites keep passing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_target.py tests/test_lark_history.py -q`
Expected: PASS. The record audit still reports `["GET"]` for record paths.

- [ ] **Step 5: Commit**

```bash
git add backend/app/lark/target.py backend/app/lark/client.py backend/app/main.py backend/tests/test_lark_target.py backend/tests/conftest.py
git commit -m "feat: resolve a pasted Lark link into selectable tables read-only"
```

### Task 4: Save A Target Behind An Enforced Change Acknowledgement

**Files:** Modify `backend/app/lark/target.py`, `backend/tests/test_lark_target.py`, `backend/tests/conftest.py`; delete `backend/app/lark/confirmation.py`, `backend/tests/test_lark_confirmation.py`; modify `backend/app/main.py`.

- [ ] **Step 1: Write the failing test**

```python
from sqlalchemy import select

from app.models import LarkTargetRevision


def _payload(table_id: str, *, expected_previous_fingerprint=None, acknowledge=False):
    return {
        "source_url": "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs",
        "execution_base_token": "app-exec",
        "execution_table_id": table_id,
        "execution_view_id": None,
        "bug_base_token": "app-bug",
        "bug_table_id": "tbl-defects",
        "expected_previous_fingerprint": expected_previous_fingerprint,
        "acknowledge_change": acknowledge,
    }


def _save(client, group_id, *, table_id: str, acknowledge: bool = False):
    response = client.put(
        f"/api/groups/{group_id}/lark/target",
        json=_payload(
            table_id, expected_previous_fingerprint=None, acknowledge=acknowledge
        ),
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_changing_a_table_needs_an_acknowledged_diff(
    lark_fake, authenticated_client, imported_group
):
    first = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    previous = first["target"]["target_fingerprint"]
    assert first["target"]["execution_table_id"] == "tbl-runs"

    refused = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload("tbl-bugs", expected_previous_fingerprint=previous),
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["reason"] == "target_changed"
    assert refused.json()["detail"]["diff"]["changed_keys"] == ["execution_table_id"]
    assert refused.json()["detail"]["diff"]["previous"]["execution_table_id"] == "tbl-runs"

    accepted = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload(
            "tbl-bugs",
            expected_previous_fingerprint=previous,
            acknowledge=True,
        ),
    )
    assert accepted.status_code == 200
    assert accepted.json()["target"]["execution_table_id"] == "tbl-bugs"


def test_a_stale_page_cannot_switch_a_table_silently(
    lark_fake, authenticated_client, imported_group
):
    first = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    _save(authenticated_client, imported_group.id, table_id="tbl-bugs", acknowledge=True)
    stale = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload(
            "tbl-runs",
            expected_previous_fingerprint=first["target"]["target_fingerprint"],
            acknowledge=True,
        ),
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["reason"] == "stale_page"


def test_changing_a_table_clears_the_write_approval(
    lark_fake, authenticated_client, imported_group, db_session
):
    first = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    assert first["confirmation_cleared"] is False
    switched = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload(
            "tbl-bugs",
            expected_previous_fingerprint=first["target"]["target_fingerprint"],
            acknowledge=True,
        ),
    ).json()
    assert switched["target"]["confirmed"] is False


def test_confirm_requires_a_clean_schema(
    lark_fake, authenticated_client, imported_group
):
    lark_fake.fields = lark_fake.fields[:1]
    saved = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    assert saved["target"]["schema_fingerprint"] is None
    blocked = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/target/confirm",
        json={
            "allow_writes": True,
            "target_fingerprint": saved["target"]["target_fingerprint"],
        },
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]


def test_revisions_keep_the_previous_table_readable(
    lark_fake, authenticated_client, imported_group, db_session
):
    _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    _save(authenticated_client, imported_group.id, table_id="tbl-bugs", acknowledge=True)
    fingerprints = db_session.scalars(
        select(LarkTargetRevision.target_fingerprint).where(
            LarkTargetRevision.group_id == imported_group.id
        )
    ).all()
    assert len(fingerprints) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_target.py -q`
Expected: FAIL with 404 for `PUT /api/groups/{id}/lark/target`.

- [ ] **Step 3: Implement the target endpoints**

Append to `backend/app/lark/target.py`:

```python
from datetime import datetime, timezone

from sqlalchemy import select


def target_for(db: Session, group_id: UUID) -> LarkTarget | None:
    return db.scalar(select(LarkTarget).where(LarkTarget.group_id == group_id))


def _record_revision(db: Session, group_id: UUID, draft: TargetDraft) -> None:
    existing = db.scalar(
        select(LarkTargetRevision).where(
            LarkTargetRevision.group_id == group_id,
            LarkTargetRevision.target_fingerprint == draft.fingerprint,
        )
    )
    if existing is None:
        db.add(
            LarkTargetRevision(
                group_id=group_id,
                execution_base_token=draft.execution_base_token,
                execution_table_id=draft.execution_table_id,
                bug_base_token=draft.bug_base_token,
                bug_table_id=draft.bug_table_id,
                target_fingerprint=draft.fingerprint,
            )
        )


def serialize_target(target: LarkTarget | None) -> dict[str, Any] | None:
    if target is None:
        return None
    return {
        "group_id": target.group_id,
        "source_url": target.source_url,
        "execution_base_token": target.execution_base_token,
        "execution_base_name": target.execution_base_name,
        "execution_table_id": target.execution_table_id,
        "execution_table_name": target.execution_table_name,
        "execution_view_id": target.execution_view_id,
        "execution_view_name": target.execution_view_name,
        "bug_base_token": target.bug_base_token,
        "bug_base_name": target.bug_base_name,
        "bug_table_id": target.bug_table_id,
        "bug_table_name": target.bug_table_name,
        "schema_fingerprint": target.schema_fingerprint,
        "target_fingerprint": target.target_fingerprint,
        "selected_at": target.selected_at,
        "confirmed_at": target.confirmed_at,
        "confirmed": target.confirmed_at is not None,
    }


class TargetRequest(BaseModel):
    source_url: str = ""
    execution_base_token: str
    execution_table_id: str
    execution_view_id: str | None = None
    bug_base_token: str
    bug_table_id: str
    # The client sends the fingerprint it saw, so a concurrent tab that already
    # moved the group is rejected instead of silently overwriting it.
    expected_previous_fingerprint: str | None = None
    acknowledge_change: bool = False


def _draft_from(payload: TargetRequest) -> TargetDraft:
    return TargetDraft(
        execution_base_token=payload.execution_base_token,
        execution_table_id=payload.execution_table_id,
        execution_view_id=payload.execution_view_id,
        bug_base_token=payload.bug_base_token,
        bug_table_id=payload.bug_table_id,
    )


def _require_group(db: Session, group_id: UUID) -> None:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")


@router.get("/groups/{group_id}/lark/target")
def read_target(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _require_group(db, group_id)
    target = target_for(db, group_id)
    if target is None:
        return {"target": None, "live": None, "read_errors": []}
    draft = TargetDraft(
        execution_base_token=target.execution_base_token,
        execution_table_id=target.execution_table_id,
        execution_view_id=target.execution_view_id,
        bug_base_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )
    try:
        live = read_draft_state(client, draft)
    except LarkError as error:
        return {
            "target": serialize_target(target),
            "live": None,
            "read_errors": [str(error)],
        }
    return {
        "target": serialize_target(target),
        "live": live,
        "read_errors": live["read_errors"],
    }


@router.put("/groups/{group_id}/lark/target")
def save_target(
    group_id: UUID,
    payload: TargetRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _require_group(db, group_id)
    draft = _draft_from(payload)
    previous = target_for(db, group_id)
    diff = target_diff(previous, draft)
    if diff["changed"]:
        if not payload.acknowledge_change:
            raise HTTPException(
                status_code=409, detail={"reason": "target_changed", "diff": diff}
            )
        if previous is None or payload.expected_previous_fingerprint != previous.target_fingerprint:
            raise HTTPException(
                status_code=409, detail={"reason": "stale_page", "diff": diff}
            )

    try:
        state = read_draft_state(client, draft)
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None
    if state["read_errors"]:
        raise HTTPException(status_code=409, detail="；".join(state["read_errors"]))

    confirmation_cleared = bool(previous and diff["changed"] and previous.confirmed_at)
    target = previous or LarkTarget(group_id=group_id)
    target.source_url = payload.source_url
    target.execution_base_token = draft.execution_base_token
    target.execution_base_name = state["execution_base_name"]
    target.execution_table_id = draft.execution_table_id
    target.execution_table_name = state["execution_table_name"] or ""
    target.execution_view_id = draft.execution_view_id
    target.bug_base_token = draft.bug_base_token
    target.bug_base_name = state["bug_base_name"]
    target.bug_table_id = draft.bug_table_id
    target.bug_table_name = state["bug_table_name"] or ""
    target.schema_fingerprint = state["schema_fingerprint"]
    target.target_fingerprint = draft.fingerprint
    target.selected_at = datetime.now(timezone.utc)
    if diff["changed"]:
        # A changed destination can never inherit the previous write approval.
        target.confirmed_at = None
    db.add(target)
    _record_revision(db, group_id, draft)
    db.commit()
    db.refresh(target)
    return {
        "target": serialize_target(target),
        "live": state,
        "diff": diff,
        "confirmation_cleared": confirmation_cleared,
    }


class ConfirmTargetRequest(BaseModel):
    allow_writes: bool = False
    target_fingerprint: str


@router.post("/groups/{group_id}/lark/target/confirm")
def confirm_target(
    group_id: UUID,
    payload: ConfirmTargetRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _require_group(db, group_id)
    if not payload.allow_writes:
        raise HTTPException(status_code=409, detail="需勾选允许向该表新增本组记录")
    target = target_for(db, group_id)
    if target is None:
        raise HTTPException(status_code=409, detail="尚未选择该组的 Lark 表")
    if target.target_fingerprint != payload.target_fingerprint:
        raise HTTPException(status_code=409, detail="目标表已变化，请重新读取后再确认")
    draft = TargetDraft(
        execution_base_token=target.execution_base_token,
        execution_table_id=target.execution_table_id,
        execution_view_id=target.execution_view_id,
        bug_base_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )
    try:
        state = read_draft_state(client, draft)
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None
    if state["read_errors"] or state["schema_errors"]:
        raise HTTPException(
            status_code=409,
            detail="；".join(state["read_errors"] + state["schema_errors"]),
        )
    target.schema_fingerprint = state["schema_fingerprint"]
    target.confirmed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(target)
    return serialize_target(target)
```

Delete `backend/app/lark/confirmation.py`, its import and `include_router` line in `backend/app/main.py`, and `backend/tests/test_lark_confirmation.py`. Replace the `confirmed_group` fixture in `conftest.py`:

```python
@pytest.fixture
def confirmed_group(db_session, imported_group) -> Group:
    draft = TargetDraft("app-exec", "tbl-runs", None, "app-bug", "tbl-defects")
    db_session.add(
        LarkTarget(
            group_id=imported_group.id,
            source_url="https://tenant.larksuite.com/wiki/node-1",
            execution_base_token="app-exec",
            execution_base_name="执行库",
            execution_table_id="tbl-runs",
            execution_table_name="执行记录",
            bug_base_token="app-bug",
            bug_base_name="缺陷库",
            bug_table_id="tbl-defects",
            bug_table_name="缺陷记录",
            schema_fingerprint="schema-fixture",
            target_fingerprint=draft.fingerprint,
            confirmed_at=datetime.now(timezone.utc),
        )
    )
    db_session.commit()
    return imported_group
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_target.py -q`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit**

```bash
git add -A backend/app backend/tests
git commit -m "feat: require an acknowledged diff before a group changes tables"
```

### Task 5: Write Paths Read The Stored Target

**Files:** Modify `backend/app/lark/outbox.py`, `backend/app/worker.py`, `backend/app/lark/history.py`, `backend/app/config.py`, `.env.example`, `backend/tests/test_lark_outbox.py`, `backend/tests/test_lark_history.py`, `backend/tests/test_no_legacy_writes.py`.

- [ ] **Step 1: Write the failing test**

```python
def test_queued_jobs_stop_when_the_group_switches_tables(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    from app.lark.target import target_for

    target = target_for(db_session, confirmed_group.id)
    _job(db_session, failed_attempt).target_fingerprint = target.target_fingerprint
    db_session.commit()

    target.execution_table_id = "tbl-bugs"
    target.target_fingerprint = "app-exec|tbl-bugs|app-bug|tbl-defects"
    target.confirmed_at = None
    db_session.commit()

    assert process_one_job(fake_lark, failed_attempt) == "pending"
    assert _job(db_session, failed_attempt).error_kind == "target_changed"
    assert fake_lark.created_execution == 0


def test_repointing_parked_jobs_is_an_explicit_administrator_action(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    from app.lark.target import target_for

    _job(db_session, failed_attempt).target_fingerprint = "stale"
    db_session.commit()
    assert process_one_job(fake_lark, failed_attempt) == "pending"

    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/retry"
    ).json()
    assert body["repointed"] == 1
    assert (
        _job(db_session, failed_attempt).target_fingerprint
        == target_for(db_session, confirmed_group.id).target_fingerprint
    )
    assert process_one_job(fake_lark, failed_attempt) == "synced"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_outbox.py -q`
Expected: FAIL — `SyncJob.target_fingerprint` is never compared and `/sync/retry` returns no `repointed` key.

- [ ] **Step 3: Replace the environment target with the stored one**

Replace `group_is_confirmed` and `_job_for` in `backend/app/lark/outbox.py`:

```python
def group_is_confirmed(db: Session, group_id: UUID) -> bool:
    target = target_for(db, group_id)
    return target is not None and target.confirmed_at is not None


def _job_for(db: Session, attempt: Attempt) -> SyncJob:
    job = db.scalar(
        select(SyncJob).where(SyncJob.attempt_id == attempt.id).with_for_update()
    )
    if job is None:
        target = target_for(db, attempt.group_case.group_id)
        job = SyncJob(
            attempt_id=attempt.id,
            state="pending",
            target_fingerprint=target.target_fingerprint if target else None,
        )
        db.add(job)
        db.flush()
    return job
```

Add `target_fingerprint` to the values list in `enqueue_group_attempts` (read the target once at the top of the function and return `0` when it is missing or unconfirmed), and replace the stale-approval branch inside `run_job`:

```python
    target = target_for(db, case.group_id)
    if (
        target is None
        or target.confirmed_at is None
        or job.target_fingerprint != target.target_fingerprint
    ):
        # Never post into a destination the administrator has not approved for
        # this group; a swapped table parks the job until a human re-points it.
        job.state = "pending"
        job.error_kind = "target_changed"
        job.lease_until = None
        job.next_retry_at = moment + timedelta(seconds=STALE_CONFIRMATION_SECONDS)
        db.commit()
        return job
```

Add `repoint_parked_jobs` next to `retry_failed_jobs` and call it from `retry_sync`, returning it as `repointed`:

```python
def repoint_parked_jobs(db: Session, group_id: UUID) -> int:
    """Re-aim jobs parked by a table switch at the current target.

    Only an administrator who decided that this group's local results belong in
    the new table may run this; nothing re-points itself.
    """

    target = target_for(db, group_id)
    if target is None:
        return 0
    result = db.execute(
        update(SyncJob)
        .where(
            SyncJob.error_kind == "target_changed",
            SyncJob.attempt_id.in_(
                select(Attempt.id)
                .join(GroupCase, Attempt.group_case_id == GroupCase.id)
                .where(GroupCase.group_id == group_id)
            ),
        )
        .values(
            state="pending",
            error_kind=None,
            retry_count=0,
            next_retry_at=_now(),
            target_fingerprint=target.target_fingerprint,
        )
    )
    db.commit()
    return int(result.rowcount or 0)
```

In `backend/app/worker.py`, build one gateway per job from that job's target while keeping `process_one_job`'s signature so the existing suite stays valid:

```python
def build_gateway(target: LarkTarget, client: LarkClient) -> HttpLarkWriteGateway:
    return HttpLarkWriteGateway(
        client,
        run_app_token=target.execution_base_token,
        run_table_id=target.execution_table_id,
        bug_app_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )


def run_once(
    db: Session, gateway_factory=None, *, client=None, reporter: str | None = None
) -> str | None:
    job = claim_next_job(db)
    if job is None:
        db.commit()
        return None
    attempt = db.get(Attempt, job.attempt_id)
    target = target_for(db, attempt.group_case.group_id) if attempt else None
    db.commit()
    if attempt is None or target is None:
        return None
    shared_client = client or build_lark_client()
    build = gateway_factory or (lambda resolved: build_gateway(resolved, shared_client))
    return process_one_job(build(target), attempt, db=db, reporter=reporter)
```

`build_gateway` in `worker.py` no longer reads `settings`; `main()` passes the shared client into `run_once` instead of a prebuilt gateway.

In `backend/app/lark/history.py`, `read_lark_state(client)` becomes `read_target_state(client, target: LarkTarget)` built on `read_draft_state`, `case_lark_history` resolves `target_for(db, group_id)` and returns `read_errors=["该组尚未选择 Lark 表"]` when the row is missing, `_upsert_reference` records `table_id=target.execution_table_id`, and `GET /api/lark/check` is deleted. In `backend/app/config.py` and `.env.example`, delete `LARK_APP_TOKEN`, `LARK_BUG_APP_TOKEN`, `LARK_TABLE_RUNS`, `LARK_TABLE_DEFECTS`, `lark_legacy_alias_used`, `lark_table_records` and `lark_table_bugs`, keeping `LARK_BASE_URL`, `LARK_APP_ID` and `LARK_APP_SECRET`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest -q`
Expected: PASS, including `test_no_legacy_writes.py`, which still proves the record audit is GET/POST-only.

- [ ] **Step 5: Commit**

```bash
git add -A backend .env.example
git commit -m "feat: sync, history and worker resolve the per-group Lark target"
```

### Task 6: The Connection Page

**Files:** Create `frontend/src/components/TargetChangeDialog.tsx`, `frontend/src/components/TargetChangeDialog.test.tsx`; modify `frontend/src/views/LarkCheck.tsx`, `frontend/src/views/LarkCheck.test.tsx`, `frontend/src/api.ts`, `frontend/src/App.tsx`, `frontend/src/styles.css`, `frontend/e2e/lark-check.spec.ts`.

- [ ] **Step 1: Write the failing view test**

```tsx
it("asks for confirmation before switching a group to another table", async () => {
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, confirmation_cleared: false });
  renderCheck({
    resolve: vi.fn().mockResolvedValue(RESOLVED),
    saveTarget,
    loadTarget: vi.fn().mockResolvedValue(TARGET_STATE)
  });

  await userEvent.type(screen.getByLabelText("Lark 文档链接"), RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));
  await userEvent.selectOptions(await screen.findByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("执行记录");
  expect(dialog).toHaveTextContent("tbl-runs → tbl-bugs");
  expect(saveTarget).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
  expect(saveTarget).toHaveBeenLastCalledWith(
    GROUP.id,
    expect.objectContaining({ acknowledge_change: true })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/views/LarkCheck.test.tsx`
Expected: FAIL — the `resolve`, `saveTarget` and `loadTarget` props and the dialog do not exist.

- [ ] **Step 3: Build the page**

Add to `frontend/src/api.ts`:

```ts
export type LarkResolved = {
  source_url: string;
  base_token: string;
  base_name: string;
  tables: { table_id: string; name: string }[];
  selected: { table_id: string | null; table_name: string | null; view_id: string | null };
  execution_fields: Record<string, string>;
  required_execution_fields: string[];
  schema_errors: string[];
};

export type LarkTarget = {
  group_id: string;
  source_url: string;
  execution_base_token: string;
  execution_base_name: string;
  execution_table_id: string;
  execution_table_name: string;
  bug_base_token: string;
  bug_base_name: string;
  bug_table_id: string;
  bug_table_name: string;
  schema_fingerprint: string | null;
  target_fingerprint: string;
  confirmed_at: string | null;
  confirmed: boolean;
};

export type LarkTargetState = {
  target: LarkTarget | null;
  live: { schema_errors: string[]; read_errors: string[] } | null;
  read_errors: string[];
};

export type LarkTargetPayload = {
  source_url: string;
  execution_base_token: string;
  execution_table_id: string;
  execution_view_id?: string | null;
  bug_base_token: string;
  bug_table_id: string;
  expected_previous_fingerprint?: string | null;
  acknowledge_change?: boolean;
};
```

and to the `api` object:

```ts
  resolveLark: (url: string) =>
    mutation<LarkResolved>("/api/lark/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    }),
  larkTarget: (groupId: string) =>
    request<LarkTargetState>(`/api/groups/${groupId}/lark/target`),
  saveLarkTarget: (groupId: string, payload: LarkTargetPayload) =>
    mutation<{ target: LarkTarget; confirmation_cleared: boolean }>(
      `/api/groups/${groupId}/lark/target`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    ),
  confirmLarkTarget: (groupId: string, targetFingerprint: string) =>
    mutation<LarkTarget>(`/api/groups/${groupId}/lark/target/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow_writes: true, target_fingerprint: targetFingerprint })
    }),
```

Delete `larkCheck`, `larkConfirmation`, `confirmLark`, `LarkCheck`, `LarkConfirmation`, `LarkConfirmationState` and `LarkConfirmPayload` together with their call sites in `App.tsx`.

`TargetChangeDialog.tsx` renders a conditionally-mounted overlay rather than calling `HTMLDialogElement.showModal`, which jsdom does not implement:

```tsx
type Side = { execution_table_name: string; execution_table_id: string; bug_table_name: string; bug_table_id: string };

type Props = {
  previous: Side | null;
  next: Side;
  pendingAttempts: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};
```

It is labelled `role="dialog"` `aria-modal="true"`, lists each changed part as `旧 → 新`, and states the consequences: queued jobs park until re-pointed, the write approval is cleared, and the group's `pendingAttempts` local records reach the new table only when the administrator re-queues them.

`LarkCheck.tsx` keeps the group selector and the write-approval/sync controls, and adds the link field with a 「读取表格」 button, two role selectors fed from `resolved.tables` (the bug role may reuse the execution base or come from a second resolved link), the detected field list with `schema_errors`, and a 「保存选择」 button. When `saveTarget` fails with a 409 whose `detail.diff.changed` is true it opens `TargetChangeDialog`; 「确认切换」 re-sends the same payload with `acknowledge_change: true` and `expected_previous_fingerprint` from the loaded target. Update `LarkCheck.test.tsx` to mock the four new props and `e2e/lark-check.spec.ts` to stub `/api/lark/resolve` and `/api/groups/*/lark/target`, adding one scenario that types a URL, switches the execution table and accepts the dialog.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --run && npm run build`
Expected: PASS with a clean production build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src frontend/e2e
git commit -m "feat: add the Lark connection page with a table change confirmation"
```

## Final Delivery Evidence

Run `cd backend && python -m pytest -q`, `cd frontend && npm test -- --run && npm run build`, `cd frontend && npx playwright test`, and `git diff --check`. Confirm from the fake Lark request log that resolving a link issues only GETs, that switching a table parks a queued job instead of writing to it, and that no record path ever receives PUT, PATCH or DELETE. Verify `grep -rn "LARK_TABLE_RUNS\|LARK_APP_TOKEN" backend/app .env.example` is empty. Record each task's commit hash in `task_plan.md` before starting the next task.
