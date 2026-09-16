# TestDeck Lark Table Header Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run tests and commit after every task; never point a test at a real Lark tenant. This plan needs `2026-09-16-04-lark-connection.md` to be complete first.

**Goal:** When a bound table is missing required headers, offer a 「设置表头」 button that creates exactly the missing fields (and, on request, a grid view) after an explicit confirmation — and never create anything automatically.

**Architecture:** A pure `provision_plan` function turns the live field list into a list of fields that would be created; the API only ever creates fields that were named in the approved request. Field type choices live in one table so the writer's expectations and the creator agree. Creating a whole table is a separate endpoint used only when a base has no suitable table, and every write re-reads the target afterwards so the schema fingerprint and the write approval are refreshed honestly.

**Tech Stack:** FastAPI, httpx, SQLAlchemy/PostgreSQL, React + Vitest.

---

## File Ownership

- `backend/app/lark/provision.py`: the plan builder, the field type table and the two provisioning endpoints.
- `backend/app/lark/client.py`: adds create-only field, table and view calls; the record audit stays GET/POST-only.
- `backend/tests/test_lark_provision.py`: the missing-field, idempotency, permission and no-record-write contracts.
- `frontend/src/components/HeaderSetup.tsx`, `frontend/src/views/LarkCheck.tsx`: the button and its confirmation.

### Task 1: Plan The Missing Headers

**Files:** Create `backend/app/lark/provision.py`, `backend/tests/test_lark_provision.py`.

- [ ] **Step 1: Write the failing plan test**

```python
from app.lark.provision import PROVISION_FIELD_TYPES, provision_plan


def test_plan_lists_only_the_missing_required_fields():
    existing = [{"field_name": "用例", "type": 1}, {"field_name": "自定义列", "type": 1}]
    plan = provision_plan(existing, "execution")
    names = [field["name"] for field in plan]
    assert "用例" not in names
    assert "自定义列" not in names
    assert names == sorted(set(names))
    assert set(names) == {"结果", "优先级", "负责人", "报告人", "日期", "截图", "控制台"}


def test_plan_is_empty_when_every_header_exists():
    existing = [
        {"field_name": name, "type": PROVISION_FIELD_TYPES[name]}
        for name in PROVISION_FIELD_TYPES
    ]
    assert provision_plan(existing, "execution") == []
    assert provision_plan(existing, "bug") == []


def test_bug_plan_only_covers_the_defect_table():
    names = {field["name"] for field in provision_plan([], "bug")}
    assert names == {"问题描述", "进展状态", "优先级", "反馈时间", "备注", "反馈人"}


def test_plan_marks_date_and_attachment_types():
    plan = {field["name"]: field for field in provision_plan([], "execution")}
    assert plan["日期"]["type"] == 5
    assert plan["截图"]["type"] == 17
    assert plan["结果"]["type"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_provision.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.lark.provision'`.

- [ ] **Step 3: Write the plan builder**

Create `backend/app/lark/provision.py`:

```python
from __future__ import annotations

from typing import Any, Iterable

from app.lark.fields import (
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    field_types,
    type_name,
)


ROLE_REQUIRED = {
    "execution": REQUIRED_RUN_FIELD_TYPES,
    "bug": REQUIRED_BUG_FIELD_TYPES,
}

# Every created header is a plain type the writer can already fill. 结果/优先级
# stay text instead of single-select so no option vocabulary has to be guessed,
# and 日期/截图 must be their real types or the writer cannot fill them.
PROVISION_FIELD_TYPES: dict[str, int] = {
    "用例": 1,
    "结果": 1,
    "优先级": 1,
    "负责人": 1,
    "报告人": 1,
    "日期": 5,
    "截图": 17,
    "控制台": 1,
    "问题描述": 1,
    "进展状态": 1,
    "反馈时间": 5,
    "备注": 1,
    "反馈人": 1,
}


def _properties(type_id: int) -> dict[str, Any]:
    if type_id == 5:
        return {"date_formatter": "yyyy/MM/dd", "auto_fill": False}
    return {}


def provision_plan(fields: Iterable[dict[str, Any]], role: str) -> list[dict[str, Any]]:
    """The headers that would be added to one role's table, sorted by name.

    A header that already exists with any type is left alone: this never
    rewrites a column the administrator already uses.
    """

    existing = field_types(fields)
    required = ROLE_REQUIRED[role]
    return [
        {
            "name": name,
            "type": PROVISION_FIELD_TYPES[name],
            "type_name": type_name(PROVISION_FIELD_TYPES[name]),
            "properties": _properties(PROVISION_FIELD_TYPES[name]),
        }
        for name in sorted(required)
        if name not in existing
    ]


def table_fields(role: str) -> list[dict[str, Any]]:
    """The full header set for a brand-new table of one role."""

    return [
        {
            "field_name": name,
            "type": PROVISION_FIELD_TYPES[name],
            "property": _properties(PROVISION_FIELD_TYPES[name]),
        }
        for name in sorted(ROLE_REQUIRED[role])
    ]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_provision.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/lark/provision.py backend/tests/test_lark_provision.py
git commit -m "feat: plan the Lark headers a table is missing"
```

### Task 2: Create Fields, A View Or A Whole Table

**Files:** Modify `backend/app/lark/client.py`, `backend/app/lark/provision.py`, `backend/app/main.py`, `backend/tests/test_lark_provision.py`, `backend/tests/conftest.py`.

- [ ] **Step 1: Write the failing endpoint test**

```python
def test_setting_headers_creates_only_the_approved_fields(
    lark_fake, authenticated_client, imported_group
):
    lark_fake.fields = [{"field_name": "用例", "type": 1}]
    preview = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/provision"
    ).json()
    names = [field["name"] for field in preview["roles"]["execution"]]
    assert "用例" not in names

    body = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "日期"],
            "create_view": False,
            "acknowledge": True,
        },
    ).json()
    assert body["created_fields"] == ["日期", "结果"]
    assert [field["field_name"] for field in lark_fake.created_fields] == ["日期", "结果"]
    assert not lark_fake.record_requests


def test_setting_headers_refuses_an_unapproved_request(
    lark_fake, authenticated_client, imported_group
):
    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": False,
            "acknowledge": False,
        },
    )
    assert response.status_code == 409
    assert not lark_fake.created_fields


def test_setting_headers_is_idempotent(lark_fake, authenticated_client, imported_group):
    payload = {
        "role": "execution",
        "field_names": ["结果"],
        "create_view": False,
        "acknowledge": True,
    }
    first = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields", json=payload
    ).json()
    second = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields", json=payload
    ).json()
    assert first["created_fields"] == ["结果"]
    assert second["created_fields"] == []
    assert len(lark_fake.created_fields) == 1


def test_creating_a_table_returns_its_new_id(lark_fake, authenticated_client, imported_group):
    body = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-bug",
            "table_name": "缺陷记录",
            "acknowledge": True,
        },
    ).json()
    assert body["table"]["table_id"] == "tbl-new"
    assert body["table"]["name"] == "缺陷记录"
    assert len(lark_fake.created_tables[0]["fields"]) == 6
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_provision.py -q`
Expected: FAIL with 404 for `/api/groups/{id}/lark/provision`.

- [ ] **Step 3: Add the create calls and the endpoints**

Add to `LarkClient` in `backend/app/lark/client.py`. Each one records its call and raises `LarkError` on a non-zero code, exactly like `create_record`:

```python
    def create_field(
        self, app_token: str, table_id: str, name: str, type_id: int, properties: dict[str, Any]
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"field_name": name, "type": type_id}
        if properties:
            body["property"] = properties
        return self._post_json(
            f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields", body
        )

    def create_view(self, app_token: str, table_id: str, name: str) -> dict[str, Any]:
        return self._post_json(
            f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/views",
            {"view_name": name, "view_type": "grid"},
        )

    def create_table(
        self, app_token: str, name: str, fields: list[dict[str, Any]]
    ) -> dict[str, Any]:
        return self._post_json(
            f"/open-apis/bitable/v1/apps/{app_token}/tables",
            {"table": {"name": name, "default_view_name": "主视图", "fields": fields}},
        )
```

Factor the shared POST handling out of `create_record` into `_post_json(path, body) -> dict[str, Any]` (records the call, converts `httpx.TimeoutException` to `LarkTimeout`, other `httpx.HTTPError` to `LarkError`, rejects a non-zero Lark `code`, returns the `data` dict) and make `create_record` call it. A permission failure must surface as a readable `LarkError`, so include the Lark `msg` in the raised message but never the request body or credentials.

Append the endpoints to `backend/app/lark/provision.py`:

```python
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.target import TargetDraft, read_draft_state, serialize_target, target_for
from app.models import Group


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


def _role_table(target, role: str) -> tuple[str, str]:
    if role == "execution":
        return target.execution_base_token, target.execution_table_id
    return target.bug_base_token, target.bug_table_id


def _require_group_target(db: Session, group_id: UUID):
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    target = target_for(db, group_id)
    if target is None:
        raise HTTPException(status_code=409, detail="尚未选择该组的 Lark 表")
    return target


@router.get("/groups/{group_id}/lark/provision")
def read_provision_plan(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    target = _require_group_target(db, group_id)
    roles: dict[str, Any] = {}
    for role in ("execution", "bug"):
        base_token, table_id = _role_table(target, role)
        fields = client.list_fields(base_token, table_id)
        roles[role] = provision_plan(fields, role)
    return {
        "roles": roles,
        "target": serialize_target(target),
    }


class ProvisionFieldsRequest(BaseModel):
    role: str
    field_names: list[str]
    create_view: bool = False
    acknowledge: bool = False


@router.post("/groups/{group_id}/lark/provision/fields")
def provision_fields(
    group_id: UUID,
    payload: ProvisionFieldsRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    if not payload.acknowledge:
        raise HTTPException(status_code=409, detail="需确认后才会创建表头")
    if payload.role not in ROLE_REQUIRED:
        raise HTTPException(status_code=422, detail="未知的表角色")
    target = _require_group_target(db, group_id)
    base_token, table_id = _role_table(target, payload.role)
    planned = {field["name"]: field for field in provision_plan(
        client.list_fields(base_token, table_id), payload.role
    )}
    created: list[str] = []
    for name in sorted(set(payload.field_names)):
        field = planned.get(name)
        if field is None:
            # Already present or not part of this role's schema: never invent one.
            continue
        client.create_field(base_token, table_id, name, field["type"], field["properties"])
        created.append(name)
    if payload.create_view:
        client.create_view(base_token, table_id, "TestDeck")
    try:
        state = read_draft_state(
            client,
            TargetDraft(
                execution_base_token=target.execution_base_token,
                execution_table_id=target.execution_table_id,
                execution_view_id=target.execution_view_id,
                bug_base_token=target.bug_base_token,
                bug_table_id=target.bug_table_id,
            ),
        )
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None
    target.schema_fingerprint = state["schema_fingerprint"]
    # A structure change invalidates the earlier write approval.
    target.confirmed_at = None
    db.commit()
    db.refresh(target)
    return {
        "created_fields": created,
        "schema_errors": state["schema_errors"],
        "target": serialize_target(target),
    }


class ProvisionTableRequest(BaseModel):
    role: str
    base_token: str
    table_name: str
    acknowledge: bool = False


@router.post("/groups/{group_id}/lark/provision/table")
def provision_table(
    group_id: UUID,
    payload: ProvisionTableRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    if not payload.acknowledge:
        raise HTTPException(status_code=409, detail="需确认后才会新建数据表")
    if payload.role not in ROLE_REQUIRED:
        raise HTTPException(status_code=422, detail="未知的表角色")
    _require_group_target(db, group_id)
    try:
        table = client.create_table(
            payload.base_token, payload.table_name, table_fields(payload.role)
        )
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"新建数据表失败：{error}") from None
    return {
        "table": {
            "table_id": str(table.get("table_id") or ""),
            "name": str(table.get("name") or payload.table_name),
        },
        "role": payload.role,
    }
```

Register the router in `backend/app/main.py`. Extend `FakeLark`: `self.created_fields: list[dict]`, `self.created_views: list[dict]`, `self.created_tables: list[dict]`, `self.field_create_error = False`, and `handle()` branches for `POST .../fields`, `POST .../views` and `POST .../tables` that record the parsed body, append to `self.fields` so re-reads see the new header, and return `{"code": 0, "data": {"field": ..., "view": ..., "table": {"table_id": "tbl-new", "name": ...}}}`. A `POST` must never reach a `/records` path in these tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_provision.py tests/test_no_legacy_writes.py -q`
Expected: PASS. The record audit is still empty for every provisioning test.

- [ ] **Step 5: Commit**

```bash
git add backend/app/lark/provision.py backend/app/lark/client.py backend/app/main.py backend/tests/test_lark_provision.py backend/tests/conftest.py
git commit -m "feat: create approved Lark headers, views and tables on request"
```

### Task 3: The 「设置表头」 Button

**Files:** Create `frontend/src/components/HeaderSetup.tsx`, `frontend/src/components/HeaderSetup.test.tsx`; modify `frontend/src/views/LarkCheck.tsx`, `frontend/src/views/LarkCheck.test.tsx`, `frontend/src/api.ts`, `frontend/src/styles.css`.

- [ ] **Step 1: Write the failing component test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { HeaderSetup } from "./HeaderSetup";

const PLAN = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  }
};

it("lists exactly what will be created before creating it", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [] });
  render(<HeaderSetup groupId="g1" loadPlan={vi.fn().mockResolvedValue(PLAN)} provision={provision} onChanged={vi.fn()} />);

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("结果");
  expect(dialog).toHaveTextContent("日期");
  expect(provision).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));
  expect(provision).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ role: "execution", field_names: ["结果", "日期"], acknowledge: true })
  );
});

it("stays hidden when the table already has every header", async () => {
  render(<HeaderSetup groupId="g1" loadPlan={vi.fn().mockResolvedValue({ roles: { execution: [], bug: [] } })} provision={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("表头完整");
  expect(screen.queryByRole("button", { name: "设置表头" })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/components/HeaderSetup.test.tsx`
Expected: FAIL — `HeaderSetup` does not exist.

- [ ] **Step 3: Build the component**

Add to `frontend/src/api.ts`:

```ts
export type ProvisionField = {
  name: string;
  type: number;
  type_name: string;
  properties: Record<string, unknown>;
};

export type ProvisionPlan = {
  roles: { execution: ProvisionField[]; bug: ProvisionField[] };
};

export type ProvisionFieldsPayload = {
  role: "execution" | "bug";
  field_names: string[];
  create_view: boolean;
  acknowledge: boolean;
};
```

and to the `api` object:

```ts
  larkProvisionPlan: (groupId: string) =>
    request<ProvisionPlan>(`/api/groups/${groupId}/lark/provision`),
  provisionLarkFields: (groupId: string, payload: ProvisionFieldsPayload) =>
    mutation<{ created_fields: string[]; schema_errors: string[]; target: LarkTarget }>(
      `/api/groups/${groupId}/lark/provision/fields`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    ),
  createLarkTable: (
    groupId: string,
    payload: { role: "execution" | "bug"; base_token: string; table_name: string; acknowledge: boolean }
  ) =>
    mutation<{ table: { table_id: string; name: string }; role: string }>(
      `/api/groups/${groupId}/lark/provision/table`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    ),
```

`HeaderSetup.tsx` takes `{ groupId, loadPlan, provision, onChanged }`, loads the plan on mount, and renders a compact status line. When both roles are empty it shows 「表头完整」 and no button. Otherwise it shows 「设置表头」, which opens a `role="dialog"` overlay that:

- groups the missing headers per role, showing each name with its `type_name`;
- lets the administrator untick any header (checkbox per row) and keeps a 「同时创建 TestDeck 视图」 checkbox;
- keeps the primary button disabled until at least one header is ticked;
- calls `provision` with the ticked names, the unticked ones omitted, `create_view` from the checkbox and `acknowledge: true`;
- after success shows 「已创建 N 个表头，请重新确认写入」 and calls `onChanged()`, because the server cleared the write approval.

Add a 「新建数据表」 button per role, enabled whenever a base has been resolved, so a role whose base has no suitable table can be created instead of staying empty. It asks for a name (defaulting to 执行记录 or 缺陷记录), then calls `createLarkTable` and hands the returned `table_id` back to `LarkCheck.tsx` so the administrator can save it as the role's table.

In `LarkCheck.tsx` render `<HeaderSetup>` under the field list, wire `onChanged` to reload `api.larkTarget(groupId)`, and pass 「新建数据表」 results into the pending selection state. `LarkCheck.test.tsx` gains one test asserting the whole flow: a table missing headers shows 「设置表头」, a table with a clean schema does not. Style the dialog and the header rows in `frontend/src/styles.css` following the existing `.lark-panel` and `.inline-status` conventions, and re-check the 360px layout for overflow.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --run && npm run build`
Expected: PASS with a clean production build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "feat: offer an explicit header setup button for empty Lark tables"
```

## Final Delivery Evidence

Run `cd backend && python -m pytest -q`, `cd frontend && npm test -- --run && npm run build`, `cd frontend && npx playwright test`, and `git diff --check`. Verify from the fake Lark log that provisioning issues POSTs only to `/fields`, `/views`, `/tables` and never to `/records`, that a second identical request creates nothing, and that `confirmed_at` is null after any structural change. Paste one before/after 360px screenshot of the header dialog into the task record.
