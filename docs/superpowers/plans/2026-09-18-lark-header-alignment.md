# Lark 表头对齐与人员配置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让缺陷表的默认表头列序与团队交接用的模板库一致，让执行记录的负责人/报告人成为人员列，并把这两个人员的 open_id 搬到页面可配置（存数据库），最后清掉线上测试库被粘贴串列污染的数据。

**Architecture:** 后端三处改动互相咬合——`provision.py` 的 `ROLE_SCHEMA` 字典顺序就是列序的唯一真源；新增 `lark_people` 单行表承载两个 open_id，由 `app/lark/people.py` 解析（DB 优先、env `DEFAULT_REPORTER_ID` 兜底）后注入 `app/lark/write.py` 的写字段函数；前端新增一个「设置」视图直接读写这两个 id。表头列序的改动**不**影响已确认目标（`schema_fingerprint` 用 `sorted()`，顺序变化不改指纹）。

**Tech Stack:** FastAPI + SQLAlchemy 2 + Alembic + Postgres（后端）；Vitest + Testing Library + React 19（前端）；Lark 多维表格 OpenAPI v1。

**Spec:** `docs/superpowers/specs/2026-09-18-lark-header-alignment-requirements.md`

## Global Constraints

以下约束对每一个任务都成立，逐条来自已确认的决策（spec §7）：

1. **只改缺陷（bug）角色的列序。** 执行记录的列序保持 `用例/结果/优先级/负责人/截图/控制台/报告人/日期` 不动。
2. **缺陷表的新列序（模板库 `tblzunPHVfBwx13V` 顺序）**：`问题描述 / 优先级 / 进展状态 / 反馈时间 / 反馈人 / 跟进人 / 备注 / 截图`。
3. **不改任何选项词表。** `PASS_RESULT_OPTIONS` / `RUN_PRIORITY_OPTIONS` / `BUG_PRIORITY_OPTIONS` / `BUG_STATUS_OPTIONS` 的**内容**一律不动（只改列序）。
4. **所有人员列一律 `{"multiple": True}`**（`PERSON_PROPERTY` 保持原值，不新增变体）。
5. **open_id 只接受 `ou_` 开头**：`^ou_[A-Za-z0-9_-]{1,64}$`。不接受姓名、邮箱、union_id。
6. **配置全局一份**，不按测试组区分。
7. **env `DEFAULT_REPORTER_ID` 保留**，仅作"页面还没配过时的兜底"。
8. **迁移编号必须是 `0016_*`**（当前 head 是 `0015_import_ticket_autovacuum`），且必须同步 `backend/tests/test_migrations.py` 的两处硬编码（`EXPECTED_TABLES` 和 `version_num` 断言）。
9. **后端测试命令**（本地 Postgres 已在 5433 运行）：
   `cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest -q`
10. **前端测试命令**：`cd frontend && npx vitest run`；类型检查包含在 `npm run build`（= `tsc -b && vite build`）里，**vitest 全绿不能替代类型检查**，交付前必须单独跑 `cd frontend && npx tsc -b`。
11. **不重建、不删除任何用户数据表**（Task 8 的清理除外，且只删指定的 3 张空表）。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `backend/app/lark/provision.py` | 改 | `BUG_SCHEMA` 列序、`RUN_SCHEMA` 两列类型、上方注释 |
| `backend/tests/test_lark_provision.py` | 改 | 参考列序断言、同类型换序测试、新增人员列测试与 retype 测试 |
| `backend/app/models.py` | 改 | 新增 `LarkPeople` 模型 |
| `backend/alembic/versions/0016_lark_people.py` | 建 | 建 `lark_people` 单行表 |
| `backend/tests/test_migrations.py` | 改 | `EXPECTED_TABLES` + `version_num` 断言 |
| `backend/app/lark/people.py` | 建 | 单行配置的读取/保存/解析 + `GET/PUT /api/lark/people` |
| `backend/app/main.py` | 改 | 注册 people 路由 |
| `backend/app/lark/write.py` | 改 | `execution_fields` 接 `owner_id` |
| `backend/app/lark/outbox.py` | 改 | `run_job` 接 `owner_id` 并透传 |
| `backend/app/worker.py` | 改 | 人员 id 从数据库解析（替换只读 env） |
| `backend/tests/test_lark_outbox.py` | 改 | 负责人写 id 的用例 |
| `backend/tests/test_lark_people.py` | 建 | 设置 API 与解析规则的用例 |
| `frontend/src/api.ts` | 改 | `LarkPeople` 类型 + 两个客户端方法 |
| `frontend/src/views/Settings.tsx` | 建 | 人员设置视图 |
| `frontend/src/views/Settings.test.tsx` | 建 | 视图用例 |
| `frontend/src/App.tsx` | 改 | 新增「设置」导航项 |
| `frontend/src/components/HeaderSetup.tsx` | 改 | 重建弹窗里的缺陷表列序文案 |
| `backend/scripts/lark_cleanup.py` | 建 | 线上测试库清理脚本（默认 dry-run） |
| `findings.md` | 改 | §1 引用的缺陷表列序 |

---

## Task 1: 缺陷表列序对齐模板表

**Files:**
- Modify: `backend/app/lark/provision.py:94-127`（`RUN_SCHEMA` 上方的注释 + `BUG_SCHEMA`）
- Modify: `backend/tests/test_lark_provision.py:268-295`（参考列序测试）、`:1255-1279`（同类型换序测试）
- Modify: `frontend/src/components/HeaderSetup.tsx:857-860`（重建弹窗文案）
- Modify: `findings.md:35`

**Interfaces:**
- Consumes: 无（本任务是链条起点）
- Produces: `schema_order("bug")` 返回 `["问题描述","优先级","进展状态","反馈时间","反馈人","跟进人","备注","截图"]`，供 `table_fields()` / `provision_plan()` / `retype_plan()` / `layout_matches()` 使用

- [ ] **Step 1: 改坏现有断言，确认它现在会红**

把 `backend/tests/test_lark_provision.py` 里 `test_a_created_table_keeps_the_reference_column_order` 的 `expected` 与文档字符串改成模板顺序：

```python
def test_a_created_table_keeps_the_reference_column_order(
    lark_fake, authenticated_client, provision_group
):
    """A generated table reads in the same order as the hand-built one.

    Read off the template base the team hands over on 2026/09/18: the
    execution table is 用例 结果 优先级 负责人 截图 控制台 报告人 日期, and the
    defect table is 问题描述 优先级 进展状态 反馈时间 反馈人 跟进人 备注 截图.
    Sorting the names instead is what put 优先级/反馈人/… at the front and
    问题描述 last.
    """

    expected = {
        "execution": ["用例", "结果", "优先级", "负责人", "截图", "控制台", "报告人", "日期"],
        "bug": ["问题描述", "优先级", "进展状态", "反馈时间", "反馈人", "跟进人", "备注", "截图"],
    }
```

- [ ] **Step 2: 跑这个测试，确认它变红**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_provision.py::test_a_created_table_keeps_the_reference_column_order -q
```
Expected: FAIL，`assert ['问题描述', '进展状态', '跟进人', '优先级', '截图', '反馈人', '反馈时间', '备注'] == ['问题描述', '优先级', ...]`

- [ ] **Step 3: 改 `BUG_SCHEMA` 的顺序与注释**

`backend/app/lark/provision.py`，把注释块第 99-106 行的缺陷表部分和 `BUG_SCHEMA` 换成：

```python
# A header's type per role. 结果/优先级/进展状态 are single-select with the same
# vocabulary a person picks from in Lark, 反馈人/跟进人/负责人/报告人 are person
# columns, and 截图 is an attachment. Leaving them text is what made the
# generated tables unreadable next to the hand-built ones.
#
# The order is load-bearing: a new table is created from these headers in this
# order, and it is the column order of the table the team hands over. The
# execution table follows the reference base (用例 first and primary, then the
# result, the priority, the owner, the screenshot, the console, the reporter,
# the date). The defect table follows the template base an administrator
# pastes rows from (问题描述 first and primary, then the priority, the status,
# the reported time, the reporter, the assignee, the remark, the screenshot) —
# a different order is what makes a pasted block land one column to the left
# and silently mint junk options on every single-select column. Sorting these
# names instead is what made the generated headers come out
# 优先级/反馈人/反馈时间/… — nothing like the table beside them.
RUN_SCHEMA: dict[str, FieldSpec] = {
    "用例": FieldSpec(1),
    "结果": FieldSpec(3, _select(PASS_RESULT_OPTIONS)),
    "优先级": FieldSpec(3, _select(RUN_PRIORITY_OPTIONS)),
    "负责人": FieldSpec(1),
    "截图": FieldSpec(17),
    "控制台": FieldSpec(1),
    "报告人": FieldSpec(1),
    "日期": FieldSpec(5, DATE_PROPERTY),
}

BUG_SCHEMA: dict[str, FieldSpec] = {
    "问题描述": FieldSpec(1),
    "优先级": FieldSpec(3, _select(BUG_PRIORITY_OPTIONS)),
    "进展状态": FieldSpec(3, _select(BUG_STATUS_OPTIONS)),
    "反馈时间": FieldSpec(5, DATE_PROPERTY),
    "反馈人": FieldSpec(11, PERSON_PROPERTY),
    "跟进人": FieldSpec(11, PERSON_PROPERTY),
    "备注": FieldSpec(1),
    "截图": FieldSpec(17),
}
```

> 注意 `RUN_SCHEMA` 这次原样保留（Task 2 才改它的两列类型），这里一并列出只是为了让替换块完整。

- [ ] **Step 4: 跑 Step 2 的命令，确认变绿**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 修同类型换序测试**

`backend/tests/test_lark_provision.py:1255-1279`。`用例` 是 text(1)，`负责人` 在本任务的 schema 里仍是 text(1)，**但 Task 2 会把它改成 person(11)**，那时这条测试就会因为类型不匹配而"碰巧通过"，失去它存在的意义。现在就把它换成两个永远同类型的列：

```python
def test_a_table_reordered_within_one_type_still_rebuilds(
    lark_fake, authenticated_client, provision_group
):
    """Isolate the ordered-name clause.

    The alphabetical table above is also caught by the type comparison: 用例's
    spec never pairs with 优先级's live type, so a loosened name check still
    rebuilds it by accident. Two columns that share a type, swapped, leave every
    pairwise type in place — only the name comparison can tell this table from
    the reference layout, so this is what pins that clause.

    用例 and 控制台 are the pair: both are plain text, so swapping them keeps
    every pairwise type intact no matter what the person columns' types are.
    """

    rows = _reference_layout("execution")
    rows[0], rows[5] = rows[5], rows[0]  # 用例 and 控制台 are both text columns.
    rows[0]["is_primary"] = True  # The swapped-in first column leads the table.
    rows[5]["is_primary"] = False
    lark_fake.fields = rows

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 200, response.text
    assert lark_fake.created_tables
```

- [ ] **Step 6: 跑整个 provision 测试文件**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_provision.py -q
```
Expected: PASS（全绿）

- [ ] **Step 7: 改前端重建弹窗的列序文案**

`frontend/src/components/HeaderSetup.tsx:857-860`，把缺陷表那段列序换成模板顺序：

```tsx
            <p className="inline-status">
              新建一张表头顺序和类型都正确的新表（执行记录表为 用例 / 结果 / 优先级 /
              负责人 / 截图 / 控制台 / 报告人 / 日期，缺陷记录表为 问题描述 / 优先级 /
              进展状态 / 反馈时间 / 反馈人 / 跟进人 / 备注 / 截图），并把本组指向它。
              结果、优先级、进展状态是下拉框，截图和人员是对应类型的字段。
            </p>
```

- [ ] **Step 8: 改 `findings.md` 里引用旧列序的那一行**

`findings.md:35` 起的那条把缺陷表列写成 `问题描述/进展状态/跟进人/优先级/截图/反馈人/反馈时间/备注`，顺序已变。把括号里的列清单替换为：

```
`问题描述/优先级/进展状态/反馈时间/反馈人/跟进人/备注/截图`
```

- [ ] **Step 9: 跑前端测试与类型检查**

Run:
```bash
cd frontend && npx vitest run && npx tsc -b
```
Expected: 全绿，无类型错误

- [ ] **Step 10: 提交**

```bash
git add backend/app/lark/provision.py backend/tests/test_lark_provision.py \
  frontend/src/components/HeaderSetup.tsx findings.md
git commit -m "feat(lark): align the defect table's column order with the template base"
```

---

## Task 2: 执行记录的负责人/报告人改成人员列

**Files:**
- Modify: `backend/app/lark/provision.py:107-116`（`RUN_SCHEMA` 两列）
- Modify: `backend/tests/test_lark_provision.py`（新增两个用例；`:1300-1315` 的注释）

**Interfaces:**
- Consumes: Task 1 的 `RUN_SCHEMA` 字典（顺序不变）
- Produces: `ROLE_SCHEMA["execution"]["负责人"].type_id == 11`、`["报告人"].type_id == 11`，指定给 `FieldSpec(11, PERSON_PROPERTY)`

- [ ] **Step 1: 写失败的测试——新建执行表时两列是人员列**

追加到 `backend/tests/test_lark_provision.py`（放在 `test_a_new_execution_table_gives_the_attachment_a_null_property` 之后）：

```python
def test_a_new_execution_table_makes_its_people_person_columns(
    lark_fake, authenticated_client, provision_group
):
    """负责人/报告人 hold a person, not a name.

    A person column only accepts ``[{"id": "<open_id>"}]``, so the column has to
    be created as one: a text column keeps receiving the display name and Lark
    never links the person.
    """

    authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "execution",
            "base_token": "app-exec",
            "table_name": "执行记录",
            "acknowledge": True,
        },
    )

    fields = {
        field["field_name"]: field for field in lark_fake.created_tables[0]["fields"]
    }
    assert fields["负责人"] == {
        "field_name": "负责人",
        "type": 11,
        "property": {"multiple": True},
    }
    assert fields["报告人"] == {
        "field_name": "报告人",
        "type": 11,
        "property": {"multiple": True},
    }
```

- [ ] **Step 2: 写失败的测试——修正类型计划会认出文本的负责人**

追加到同文件（放在 `test_a_retype_plan_reports_an_existing_header_with_the_wrong_type` 一类用例附近；若没有同名用例，就追加在文件末尾）：

```python
def test_the_retype_plan_offers_to_convert_a_text_owner_into_a_person_column():
    """The live tables carry 负责人/报告人 as text, so the plan has to name them.

    An existing table cannot be rebuilt into this without re-filing its rows,
    and a table with real data should be converted in place instead — that is
    what this plan drives.
    """

    fields = [
        {"field_id": "fld-用例", "field_name": "用例", "type": 1},
        {"field_id": "fld-结果", "field_name": "结果", "type": 3},
        {"field_id": "fld-优先级", "field_name": "优先级", "type": 3},
        {"field_id": "fld-负责人", "field_name": "负责人", "type": 1},
        {"field_id": "fld-截图", "field_name": "截图", "type": 17},
        {"field_id": "fld-控制台", "field_name": "控制台", "type": 1},
        {"field_id": "fld-报告人", "field_name": "报告人", "type": 1},
        {"field_id": "fld-日期", "field_name": "日期", "type": 5},
    ]

    plan = {row["name"]: row for row in retype_plan(fields, "execution")}

    assert set(plan) == {"负责人", "报告人"}
    assert plan["负责人"]["type"] == 11
    assert plan["负责人"]["current_type"] == 1
    assert plan["负责人"]["properties"] == {"multiple": True}
    assert plan["报告人"]["type"] == 11
```

- [ ] **Step 3: 跑这两个测试，确认它们红**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_provision.py -q -k "person_columns or text_owner"
```
Expected: 两条都 FAIL（第一条断言 `type == 11` 但拿到 `1`；第二条 `set(plan) == set()` 为空）

- [ ] **Step 4: 改 `RUN_SCHEMA` 的两列**

`backend/app/lark/provision.py`，把 `RUN_SCHEMA` 里的两行改成：

```python
    "负责人": FieldSpec(11, PERSON_PROPERTY),
    "截图": FieldSpec(17),
    "控制台": FieldSpec(1),
    "报告人": FieldSpec(11, PERSON_PROPERTY),
```

- [ ] **Step 5: 跑 Step 3 的命令，确认变绿**

Run: 同 Step 3
Expected: PASS

- [ ] **Step 6: 更新那条"类型不对就重建"用例的注释**

`backend/tests/test_lark_provision.py:1306` 现在是：

```python
    rows[3]["type"] = 3  # 负责人 is a person column, not 单选.
```

改注释让它名实相符（行为不变）：

```python
    rows[3]["type"] = 3  # 负责人 是人员列 (11)，单选 (3) 是错的。
```

- [ ] **Step 7: 跑整个 provision 测试文件**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_provision.py -q
```
Expected: PASS（全绿，含 Task 1 改过的换序用例）

- [ ] **Step 8: 提交**

```bash
git add backend/app/lark/provision.py backend/tests/test_lark_provision.py
git commit -m "feat(lark): create 负责人/报告人 as person columns"
```

---

## Task 3: `lark_people` 单行表与迁移 0016

**Files:**
- Modify: `backend/app/models.py`（在 `ReconcileMark` 之后追加）
- Create: `backend/alembic/versions/0016_lark_people.py`
- Modify: `backend/tests/test_migrations.py:15-39`、`:170`、`:198-199`

**Interfaces:**
- Consumes: 无
- Produces: `app.models.LarkPeople`，字段 `id: int`、`reporter_open_id: str | None`、`owner_open_id: str | None`、`updated_at: datetime`；表 `lark_people` 只允许 `id = 1`

- [ ] **Step 1: 写失败的测试——迁移后表存在且 head 是 0016**

`backend/tests/test_migrations.py`，把 `EXPECTED_TABLES` 加上 `lark_people`（保持集合内字母序）：

```python
EXPECTED_TABLES = {
    "admin_sessions",
    "admins",
    "alembic_version",
    "attempts",
    "case_reference_assets",
    "case_reference_links",
    "group_cases",
    "groups",
    "import_tickets",
    "lark_history_refs",
    "lark_people",
    "lark_target_revisions",
    "lark_targets",
    "reconcile_marks",
    "screenshots",
    "sync_jobs",
}
```

并把三处版本号断言从 `"0015_import_ticket_autovacuum"` 改成 `"0016_lark_people"`（`:38`、`:170`、`:199`）。

- [ ] **Step 2: 跑它，确认红**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_migrations.py -q
```
Expected: FAIL —— 表集合里多了 `lark_people` 但库中没有，且 `version_num` 还是 `0015_import_ticket_autovacuum`

- [ ] **Step 3: 加模型**

`backend/app/models.py` 末尾追加（`CheckConstraint` / `Integer` / `String` / `func` / `DateTime` 都已经在该文件的 import 里）：

```python
class LarkPeople(Base):
    """The open ids this deployment writes into Lark person columns.

    One row, always. 报告人 and 反馈人 are the same person on both sides of a
    group's target and 负责人 is one placeholder the team fills in later, so
    there is nothing to key by — the CHECK constraint is what keeps "which row"
    from becoming a second decision. An unset id is NULL, never a name: a person
    column refuses anything that is not an open id, and the writer omits the
    column instead of failing the whole row.
    """

    __tablename__ = "lark_people"
    __table_args__ = (CheckConstraint("id = 1", name="ck_lark_people_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    reporter_open_id: Mapped[str | None] = mapped_column(String)
    owner_open_id: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
```

- [ ] **Step 4: 写迁移**

`backend/alembic/versions/0016_lark_people.py`：

```python
"""Store the open ids the writer puts into Lark person columns.

Revision ID: 0016_lark_people
Revises: 0015_import_ticket_autovacuum
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0016_lark_people"
down_revision: str | None = "0015_import_ticket_autovacuum"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 报告人/反馈人和负责人对每一个测试组都是同两个人，所以这张表只有一行。
    # 单行由 CHECK 钉死：读配置的地方就不需要再决定「读哪一行」。
    # 未配置是 NULL 而不是空串，写端据此把该列整个省略——人员列只吃 open id，
    # 塞一个显示名进去会让整行 create 失败。
    op.create_table(
        "lark_people",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("reporter_open_id", sa.String(), nullable=True),
        sa.Column("owner_open_id", sa.String(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_lark_people_singleton"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("lark_people")
```

- [ ] **Step 5: 跑迁移测试，确认绿**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_migrations.py -q
```
Expected: PASS（含 upgrade→downgrade→upgrade 的往返）

- [ ] **Step 6: 跑整个后端测试，确认没有别的表被这步影响**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest -q
```
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add backend/app/models.py backend/alembic/versions/0016_lark_people.py backend/tests/test_migrations.py
git commit -m "feat(db): add the lark_people singleton table"
```

---

## Task 4: 人员 open_id 的解析（DB 优先，env 兜底）

**Files:**
- Create: `backend/app/lark/people.py`
- Create: `backend/tests/test_lark_people.py`

**Interfaces:**
- Consumes: Task 3 的 `app.models.LarkPeople`
- Produces（Task 5、Task 6 依赖，签名逐字一致）：
  - `OPEN_ID: re.Pattern[str]`
  - `SINGLETON_ID: int = 1`
  - `read_people(db: Session) -> LarkPeople`
  - `resolved_reporter_open_id(db: Session) -> str | None`
  - `resolved_owner_open_id(db: Session) -> str | None`
  - `save_people(db: Session, *, reporter_open_id: str | None, owner_open_id: str | None) -> LarkPeople`

- [ ] **Step 1: 写失败的测试**

`backend/tests/test_lark_people.py`：

```python
from dataclasses import replace

import pytest
from sqlalchemy import select

from app.config import settings
from app.lark import people
from app.models import LarkPeople


@pytest.fixture
def env_reporter(monkeypatch):
    """The environment fallback, as a deployment that never opened the page has it.

    ``replace`` 是仓库里既有的造 settings 副本的写法（见 ``conftest.py`` 的
    ``upload_dir`` fixture）；``people`` 模块自己 import 了 ``settings``，
    所以要打在它身上，不能打全局那个。
    """

    monkeypatch.setattr(
        people, "settings", replace(settings, default_reporter_id="ou_from_env")
    )


def test_an_unset_row_falls_back_to_the_environment_reporter(env_reporter, db_session):
    """A deployment that never opened the page keeps writing what it always did."""

    assert people.resolved_reporter_open_id(db_session) == "ou_from_env"
    # 负责人 has no environment fallback: nothing ever configured one.
    assert people.resolved_owner_open_id(db_session) is None


def test_a_saved_reporter_wins_over_the_environment(env_reporter, db_session):
    people.save_people(
        db_session, reporter_open_id="ou_from_page", owner_open_id="ou_owner"
    )

    assert people.resolved_reporter_open_id(db_session) == "ou_from_page"
    assert people.resolved_owner_open_id(db_session) == "ou_owner"


def test_clearing_the_page_field_falls_back_to_the_environment_again(
    env_reporter, db_session
):
    people.save_people(
        db_session, reporter_open_id="ou_from_page", owner_open_id="ou_owner"
    )
    people.save_people(db_session, reporter_open_id="", owner_open_id="")

    assert people.resolved_reporter_open_id(db_session) == "ou_from_env"
    assert people.resolved_owner_open_id(db_session) is None


def test_saving_twice_keeps_one_row(db_session):
    people.save_people(db_session, reporter_open_id="ou_one", owner_open_id=None)
    people.save_people(db_session, reporter_open_id="ou_two", owner_open_id=None)

    rows = db_session.scalars(select(LarkPeople)).all()
    assert [row.reporter_open_id for row in rows] == ["ou_two"]
```

- [ ] **Step 2: 跑它，确认红**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_people.py -q
```
Expected: FAIL with `ModuleNotFoundError: No module named 'app.lark.people'`

- [ ] **Step 3: 写模块**

`backend/app/lark/people.py`：

```python
"""The Lark people this deployment writes into person columns.

A person column only accepts ``[{"id": "<open_id>"}]``, so the writer needs the
two open ids and nothing else. They live in one row of ``lark_people`` because
they are the same people for every test group; the environment variable
``DEFAULT_REPORTER_ID`` stays as the fallback for a deployment that has not
opened the settings page yet.

The HTTP surface lives here too: this module owns the row, so the endpoint that
edits it is the only other thing that has to know the shape.
"""

from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.models import LarkPeople


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# Every token is interpolated into a request the writer sends as-is, and Lark
# only ever mints open ids in this shape. Refusing anything else here is what
# keeps a display name ("Max") or a union id out of a column that reads neither.
OPEN_ID = re.compile(r"^ou_[A-Za-z0-9_-]{1,64}$")

SINGLETON_ID = 1


def _stored(db: Session) -> LarkPeople | None:
    return db.get(LarkPeople, SINGLETON_ID)


def read_people(db: Session) -> LarkPeople:
    """The single settings row, created empty on first read."""

    row = _stored(db)
    if row is None:
        row = LarkPeople(id=SINGLETON_ID)
        db.add(row)
        db.flush()
    return row


def resolved_reporter_open_id(db: Session) -> str | None:
    """The id 反馈人/报告人 receive: what the page saved, else the env fallback."""

    row = _stored(db)
    if row is not None and row.reporter_open_id:
        return row.reporter_open_id
    return settings.default_reporter_id or None


def resolved_owner_open_id(db: Session) -> str | None:
    """The id 负责人 receives.

    There is no environment fallback: no deployment ever configured one, and
    inventing an owner is worse than leaving the column empty — which is what
    the operator asked for until the case is handed to a lead.
    """

    row = _stored(db)
    return (row.owner_open_id if row is not None else None) or None


def save_people(
    db: Session, *, reporter_open_id: str | None, owner_open_id: str | None
) -> LarkPeople:
    """Write both ids, or NULL for "not configured"; never a name."""

    row = read_people(db)
    row.reporter_open_id = reporter_open_id or None
    row.owner_open_id = owner_open_id or None
    db.commit()
    db.refresh(row)
    return row


class PeopleRequest(BaseModel):
    reporter_open_id: str = ""
    owner_open_id: str = ""


def _checked(label: str, value: str) -> str | None:
    text_value = value.strip()
    if text_value and OPEN_ID.match(text_value) is None:
        raise HTTPException(
            status_code=422,
            detail=f"{label} 要填本应用名下的 open_id（ou_ 开头），不能填姓名或邮箱",
        )
    return text_value or None


def _payload(db: Session, stored: LarkPeople) -> dict[str, Any]:
    """What the page shows: what it saved, and what will actually be written."""

    return {
        "reporter_open_id": stored.reporter_open_id or "",
        "owner_open_id": stored.owner_open_id or "",
        "env_reporter_open_id": settings.default_reporter_id or "",
        "effective_reporter_open_id": resolved_reporter_open_id(db) or "",
        "effective_owner_open_id": resolved_owner_open_id(db) or "",
    }


@router.get("/lark/people")
def read_people_settings(db: Annotated[Session, Depends(get_db)]) -> dict[str, Any]:
    stored = read_people(db)
    db.commit()
    return _payload(db, stored)


@router.put("/lark/people")
def save_people_settings(
    payload: PeopleRequest, db: Annotated[Session, Depends(get_db)]
) -> dict[str, Any]:
    stored = save_people(
        db,
        reporter_open_id=_checked("报告人", payload.reporter_open_id),
        owner_open_id=_checked("负责人", payload.owner_open_id),
    )
    return _payload(db, stored)
```

- [ ] **Step 4: 跑 Step 2 的命令，确认绿**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/app/lark/people.py backend/tests/test_lark_people.py
git commit -m "feat(lark): resolve the person open ids from a saved row, env as fallback"
```

---

## Task 5: 人员配置的 HTTP 接口

**Files:**
- Modify: `backend/app/main.py:9-31`
- Modify: `backend/tests/test_lark_people.py`（追加接口用例）

**Interfaces:**
- Consumes: Task 4 的 `app.lark.people.router`、`OPEN_ID`
- Produces: `GET /api/lark/people` 与 `PUT /api/lark/people`，响应体形状
  `{"reporter_open_id": str, "owner_open_id": str, "env_reporter_open_id": str, "effective_reporter_open_id": str, "effective_owner_open_id": str}`

- [ ] **Step 1: 写失败的接口测试**

追加到 `backend/tests/test_lark_people.py`：

```python
def test_the_settings_page_reads_and_writes_both_ids(authenticated_client, db_session):
    assert authenticated_client.get("/api/lark/people").json() == {
        "reporter_open_id": "",
        "owner_open_id": "",
        "env_reporter_open_id": "",
        "effective_reporter_open_id": "",
        "effective_owner_open_id": "",
    }

    saved = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_reporter", "owner_open_id": "ou_owner"},
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["reporter_open_id"] == "ou_reporter"
    assert saved.json()["owner_open_id"] == "ou_owner"
    assert saved.json()["effective_reporter_open_id"] == "ou_reporter"
    assert saved.json()["effective_owner_open_id"] == "ou_owner"


def test_a_name_where_an_open_id_belongs_is_refused(authenticated_client, db_session):
    """A person column refuses a display name, so the page must refuse it first."""

    response = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "Max", "owner_open_id": ""},
    )

    assert response.status_code == 422, response.text
    assert "ou_" in response.json()["detail"]


def test_an_empty_box_clears_the_saved_id(authenticated_client, db_session):
    authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_reporter", "owner_open_id": ""},
    )

    cleared = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "", "owner_open_id": ""},
    )

    assert cleared.json()["reporter_open_id"] == ""
    assert cleared.json()["effective_reporter_open_id"] == ""


def test_the_page_needs_an_admin_session(client):
    assert client.get("/api/lark/people").status_code == 401
```

> `authenticated_client` 与 `client` fixture 已存在于 `backend/tests/conftest.py`（其它 router 测试在用）。若 `client` 这个名字不同，用同文件里其它测试所使用的未登录 fixture 名。

- [ ] **Step 2: 跑它，确认红**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_people.py -q
```
Expected: FAIL —— `GET /api/lark/people` 返回 404

- [ ] **Step 3: 注册路由**

`backend/app/main.py`，import 段加一行（按字母序插在 `lark_outbox` 前后都行，这里紧跟 `history`）：

```python
from app.lark.people import router as lark_people_router
```

`include_router` 段加一行：

```python
app.include_router(lark_people_router)
```

- [ ] **Step 4: 跑 Step 2 的命令，确认绿**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 跑 migration + people + auth 相关测试，确认没有回归**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_people.py tests/test_migrations.py -q
```
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add backend/app/main.py backend/tests/test_lark_people.py
git commit -m "feat(lark): serve the person settings over /api/lark/people"
```

---

## Task 6: 写入链路接上负责人 open_id

**Files:**
- Modify: `backend/app/lark/write.py:95-128`（`execution_fields`）
- Modify: `backend/app/lark/outbox.py:315-392`（`run_job`）
- Modify: `backend/app/worker.py:50-82`（`process_one_job`）
- Modify: `backend/tests/test_lark_outbox.py`（追加用例）

**Interfaces:**
- Consumes: Task 4 的 `resolved_reporter_open_id(db)`、`resolved_owner_open_id(db)`
- Produces:
  - `execution_fields(attempt, case, *, owner, reporter, attachments=None, person_fields=None, reporter_id=None, owner_id=None) -> dict[str, Any]`
  - `run_job(db, job, gateway, attempt, *, reporter, owner=None, reporter_id=None, owner_id=None, now=None) -> SyncJob`

- [ ] **Step 1: 写失败的测试——负责人列收到配置的 id**

追加到 `backend/tests/test_lark_outbox.py`（紧挨 `test_a_person_typed_owner_column_...` 那条）：

```python
def test_the_owner_column_receives_the_configured_open_id(failed_attempt):
    """负责人 is a person column now, so a display name there is a refused write."""

    fields = execution_fields(
        failed_attempt,
        failed_attempt.group_case,
        owner="待指派",
        reporter="Max",
        attachments=[],
        person_fields={"负责人", "报告人"},
        reporter_id="ou_reporter",
        owner_id="ou_owner",
    )

    assert fields["负责人"] == [{"id": "ou_owner"}]
    assert fields["报告人"] == [{"id": "ou_reporter"}]


def test_an_unconfigured_owner_stays_a_display_name_on_a_text_column(failed_attempt):
    """A legacy text column keeps receiving the name it always has."""

    fields = execution_fields(
        failed_attempt,
        failed_attempt.group_case,
        owner="待指派",
        reporter="Max",
        attachments=[],
        person_fields=set(),
        owner_id="ou_owner",
    )

    assert fields["负责人"] == "待指派"
```

- [ ] **Step 2: 跑它，确认红**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_outbox.py -q -k "owner_column_receives or unconfigured_owner"
```
Expected: FAIL with `TypeError: execution_fields() got an unexpected keyword argument 'owner_id'`

- [ ] **Step 3: 给 `execution_fields` 加参数**

`backend/app/lark/write.py`，把签名与 `负责人` 那一行改成：

```python
def execution_fields(
    attempt: Attempt,
    case: GroupCase,
    *,
    owner: str,
    reporter: str,
    attachments: list[str] | None = None,
    person_fields: set[str] | None = None,
    reporter_id: str | None = None,
    owner_id: str | None = None,
) -> dict[str, Any]:
    people = person_fields or set()
    fields: dict[str, Any] = {
        "用例": f"{case.code} {case.title}",
        "结果": attempt.result or "",
        "优先级": _priority(case.priority, RUN_PRIORITY_OPTIONS),
        # 负责人 and 报告人 are two separate columns. Both are person columns in
        # every table this tool builds, and then only a configured open id may
        # fill them — 负责人, which carries the deployment's placeholder, is left
        # empty there instead of failing the create. A table that still has them
        # as text keeps receiving the display name it always has.
        "负责人": _person_field_value(
            "负责人", text=owner, person_fields=people, open_id=owner_id
        ),
        "报告人": _person_field_value(
            "报告人", text=reporter, person_fields=people, open_id=reporter_id
        ),
        "日期": _milliseconds(attempt.created_at),
        # A run with no screenshot writes an empty attachment list: the column
        # is attachment-typed in every table this tool builds.
        "截图": _attachment_value(attachments or []),
        "控制台": attempt.console_text or "",
    }
    # An omitted key, not a null one, is how a column the writer cannot fill
    # stays out of the request.
    return {name: value for name, value in fields.items() if value is not None}
```

- [ ] **Step 4: 跑 Step 2 的命令，确认绿**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 5: 写失败的测试——worker 从数据库取 id**

先在 `backend/tests/test_lark_outbox.py` 的 import 段加一行（放在 `from app.lark.outbox import (...)` 之后）：

```python
from app.lark.people import save_people
```

再追加用例：

```python
def test_the_worker_takes_the_person_ids_from_the_saved_settings(
    fake_lark, failed_attempt, confirmed_group, db_session
):
    """The page's saved ids are what the create carries, not the env value.

    ``confirmed_group`` stores a fingerprint whose 负责人/报告人 are text — the
    live tables' shape before the conversion. Flipping them to person columns
    (11) here is what a re-read of a converted table produces, and the writer
    shapes its value from that stored fingerprint alone.
    """

    target = _stored_target(db_session, confirmed_group.id)
    target.schema_fingerprint = (
        "优先级:3|报告人:11|日期:5|结果:3|用例:1|截图:17|控制台:1|负责人:11"
        "||"
        "优先级:3|反馈人:11|反馈时间:5|备注:1|截图:17|跟进人:11|进展状态:3|问题描述:1"
    )
    db_session.commit()

    save_people(db_session, reporter_open_id="ou_reporter", owner_open_id="ou_owner")

    process_one_job(fake_lark, failed_attempt)

    fields = fake_lark.created_records[0]["fields"]
    assert fields["负责人"] == [{"id": "ou_owner"}]
    assert fields["报告人"] == [{"id": "ou_reporter"}]
```

> `_stored_target` 是本文件已有的 helper（带 `expire_all()`），直接复用。**不要**为了让测试变绿去改 `FIXTURE_SCHEMA_FINGERPRINT`——它是别的用例共用的基线，改了会连带影响一片测试。

- [ ] **Step 6: 跑它，确认红**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_outbox.py -q -k "person_ids_from_the_saved_settings"
```
Expected: FAIL —— 负责人 缺字段或值仍来自 env

- [ ] **Step 7: `run_job` 透传 `owner_id`**

`backend/app/lark/outbox.py`，改 `run_job` 签名与 `execution_fields` 调用：

```python
def run_job(
    db: Session,
    job: SyncJob,
    gateway: LarkWriteGateway,
    attempt: Attempt,
    *,
    reporter: str,
    owner: str | None = None,
    reporter_id: str | None = None,
    owner_id: str | None = None,
    now: datetime | None = None,
) -> SyncJob:
```

```python
        fields = execution_fields(
            attempt,
            case,
            owner=owner or reporter,
            reporter=reporter,
            attachments=attachments,
            person_fields=run_people,
            reporter_id=reporter_id,
            owner_id=owner_id,
        )
```

- [ ] **Step 8: `worker.py` 改成从数据库解析**

`backend/app/worker.py`，import 段加：

```python
from app.lark.people import resolved_owner_open_id, resolved_reporter_open_id
```

`process_one_job` 的 `run_job(...)` 调用改成：

```python
    run_job(
        session,
        job,
        gateway,
        attempt,
        # 负责人/报告人 are display names in the hand-run rows; the sign-in
        # address is only the fallback when no name is configured.
        reporter=reporter or settings.default_reporter or settings.admin_email,
        owner=settings.default_owner,
        # The open ids live in the settings row the page writes; the environment
        # value is only what a deployment that never opened that page still has.
        reporter_id=resolved_reporter_open_id(session),
        owner_id=resolved_owner_open_id(session),
        now=now,
    )
```

- [ ] **Step 9: 跑整个 outbox + worker 相关测试，确认绿且无回归**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_outbox.py tests/test_group_archive.py -q
```
Expected: PASS

- [ ] **Step 10: 跑整个后端测试**

Run:
```bash
cd backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest -q
```
Expected: PASS

- [ ] **Step 11: 提交**

```bash
git add backend/app/lark/write.py backend/app/lark/outbox.py backend/app/worker.py backend/tests/test_lark_outbox.py
git commit -m "feat(lark): write the configured open ids into the person columns"
```

---

## Task 7: 前端——设置视图与导航

**Files:**
- Modify: `frontend/src/api.ts`（类型 + 两个方法）
- Create: `frontend/src/views/Settings.tsx`
- Create: `frontend/src/views/Settings.test.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: Task 5 的 `GET/PUT /api/lark/people`
- Produces: `export function SettingsView({ load, save }: { load: () => Promise<LarkPeople>; save: (payload: { reporter_open_id: string; owner_open_id: string }) => Promise<LarkPeople> })`

- [ ] **Step 1: 写失败的视图测试**

`frontend/src/views/Settings.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ApiError, type LarkPeople } from "../api";
import { SettingsView } from "./Settings";

const LOADED: LarkPeople = {
  reporter_open_id: "",
  owner_open_id: "",
  env_reporter_open_id: "ou_from_env",
  effective_reporter_open_id: "ou_from_env",
  effective_owner_open_id: ""
};

const SAVED: LarkPeople = {
  reporter_open_id: "ou_reporter",
  owner_open_id: "ou_owner",
  env_reporter_open_id: "ou_from_env",
  effective_reporter_open_id: "ou_reporter",
  effective_owner_open_id: "ou_owner"
};

it("shows what the saved ids will actually be written as", async () => {
  render(<SettingsView load={async () => LOADED} save={vi.fn()} />);

  // The environment fallback is what a save has not overridden yet.
  expect(await screen.findByText(/ou_from_env/)).toBeVisible();
});

it("saves both boxes", async () => {
  const save = vi.fn().mockResolvedValue(SAVED);
  render(<SettingsView load={async () => LOADED} save={save} />);

  await userEvent.type(await screen.findByLabelText("报告人 open_id"), "ou_reporter");
  await userEvent.type(screen.getByLabelText("负责人 open_id"), "ou_owner");
  await userEvent.click(screen.getByRole("button", { name: "保存人员设置" }));

  expect(save).toHaveBeenCalledWith({
    reporter_open_id: "ou_reporter",
    owner_open_id: "ou_owner"
  });
  expect(await screen.findByText("人员设置已保存")).toBeVisible();
});

it("shows the server's refusal verbatim", async () => {
  const save = vi.fn().mockRejectedValue(new ApiError(422, "报告人 要填本应用名下的 open_id（ou_ 开头）"));
  render(<SettingsView load={async () => LOADED} save={save} />);

  await userEvent.type(await screen.findByLabelText("报告人 open_id"), "Max");
  await userEvent.click(screen.getByRole("button", { name: "保存人员设置" }));

  expect(await screen.findByText(/open_id（ou_ 开头）/)).toBeVisible();
});
```

- [ ] **Step 2: 跑它，确认红**

Run:
```bash
cd frontend && npx vitest run src/views/Settings.test.tsx
```
Expected: FAIL —— `Failed to resolve import "./Settings"`

- [ ] **Step 3: 加 api 客户端**

`frontend/src/api.ts`，在 `LarkTargetState` 类型之后插入：

```ts
export type LarkPeople = {
  reporter_open_id: string;
  owner_open_id: string;
  env_reporter_open_id: string;
  effective_reporter_open_id: string;
  effective_owner_open_id: string;
};
```

在 `api` 对象里 `aiPrompts` 之前插入：

```ts
  larkPeople: () => request<LarkPeople>("/api/lark/people"),
  saveLarkPeople: (payload: { reporter_open_id: string; owner_open_id: string }) =>
    mutation<LarkPeople>("/api/lark/people", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
```

- [ ] **Step 4: 写视图**

`frontend/src/views/Settings.tsx`：

```tsx
import { useEffect, useState } from "react";
import { LoaderCircle, Save, Users } from "lucide-react";

import { type LarkPeople } from "../api";

type Props = {
  load: () => Promise<LarkPeople>;
  save: (payload: { reporter_open_id: string; owner_open_id: string }) => Promise<LarkPeople>;
};

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function SettingsView({ load, save }: Props) {
  const [reporter, setReporter] = useState("");
  const [owner, setOwner] = useState("");
  const [state, setState] = useState<LarkPeople | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((loaded) => {
        if (cancelled) return;
        setState(loaded);
        setReporter(loaded.reporter_open_id);
        setOwner(loaded.owner_open_id);
      })
      .catch((reason) => {
        if (!cancelled) setError(messageOf(reason, "读取人员设置失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await save({ reporter_open_id: reporter.trim(), owner_open_id: owner.trim() });
      setState(saved);
      setReporter(saved.reporter_open_id);
      setOwner(saved.owner_open_id);
      setNotice("人员设置已保存");
    } catch (reason) {
      setError(messageOf(reason, "保存人员设置失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel settings-panel">
      <h2><Users size={18} />人员设置</h2>
      <p className="inline-status">
        执行记录的 报告人 / 负责人 和 缺陷记录的 反馈人 都是人员列，只接受本应用名下的
        open_id（<code>ou_</code> 开头）。姓名和邮箱会被 Lark 拒绝，服务端也会先挡下来。
      </p>
      <p className="inline-status">
        报告人一处配置、两侧共用：执行记录的「报告人」和缺陷记录的「反馈人」用的是同一个 id。
        负责人留空就保持空——交给领导之后再填。
      </p>

      <label>
        报告人 open_id
        <input
          aria-label="报告人 open_id"
          value={reporter}
          placeholder={state?.env_reporter_open_id || "ou_..."}
          onChange={(event) => setReporter(event.target.value)}
        />
      </label>
      <label>
        负责人 open_id
        <input
          aria-label="负责人 open_id"
          value={owner}
          placeholder="ou_..."
          onChange={(event) => setOwner(event.target.value)}
        />
      </label>

      <p className="inline-status">
        {`当前实际写入：报告人 `}
        <code>{state?.effective_reporter_open_id || "（空）"}</code>
        {` · 负责人 `}
        <code>{state?.effective_owner_open_id || "（空）"}</code>
        {state && !state.reporter_open_id && state.env_reporter_open_id
          ? "（报告人用的还是环境变量里的兜底值）"
          : ""}
      </p>

      {notice ? <p className="inline-status saved" role="status">{notice}</p> : null}
      {error ? <p className="inline-status error" role="alert">{error}</p> : null}

      <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
        保存人员设置
      </button>
    </section>
  );
}
```

- [ ] **Step 5: 跑 Step 2 的命令，确认绿**

Run: 同 Step 2
Expected: PASS

- [ ] **Step 6: 接进导航**

`frontend/src/App.tsx`：

第 2 行的 lucide import 加上 `Settings`：

```tsx
import { FileSpreadsheet, FileStack, FlaskConical, GitCompare, ListChecks, LogOut, Settings, ShieldCheck, Upload } from "lucide-react";
```

第 11 行之后加视图 import：

```tsx
import { SettingsView } from "./views/Settings";
```

第 13 行的 `View` 联合类型加上 `"settings"`：

```tsx
type View = "execute" | "groups" | "import" | "reports" | "lark" | "reconcile" | "settings";
```

导航按钮加一个（放在「对账」之后）：

```tsx
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><Settings size={17} />设置</button>
```

渲染分支加一个（放在 `view === "reconcile"` 之后、`ImportView` 兜底之前）：

```tsx
        ) : view === "settings" ? (
          <SettingsView load={api.larkPeople} save={api.saveLarkPeople} />
```

- [ ] **Step 7: 跑前端全量测试 + 类型检查 + 构建**

Run:
```bash
cd frontend && npx vitest run && npx tsc -b
```
Expected: 全绿，无类型错误

- [ ] **Step 8: 提交**

```bash
git add frontend/src/api.ts frontend/src/views/Settings.tsx frontend/src/views/Settings.test.tsx frontend/src/App.tsx
git commit -m "feat(web): a settings page for the Lark person open ids"
```

---

## Task 8: 清理线上测试库（运维，需用户在场）

**Files:**
- Create: `backend/scripts/lark_cleanup.py`

**Interfaces:**
- Consumes: `app.lark.fields` 的四个选项常量（`PASS_RESULT_OPTIONS` / `RUN_PRIORITY_OPTIONS` / `BUG_STATUS_OPTIONS` / `BUG_PRIORITY_OPTIONS`）
- Produces: 无代码依赖；产出是清理后的线上表

**背景与判据（全部来自实测，见 spec §4）：**

- 执行记录 `tblGMDjey2ufbUxd`：20 行，其中 8 行是本工具写的（`负责人 == "待指派"`），**12 行**是模板库整块粘进来的，特征是 `负责人` 是一串日期（`2021/01/08` 之类）。
- 缺陷记录 `tblUyjeopEHO8QVx`：17 行，其中 5 行是本工具写的，**12 行**是粘贴的，特征是 `优先级` 是一串日期。
- 单选列被灌了垃圾选项：执行记录.结果 混入 `P0/P2/P1`；执行记录.优先级 混入 `已上线/待修复/修复中/验收通过，待上线/待验收`；缺陷记录.进展状态 混入 `P0/P2/P1`；缺陷记录.优先级 混入 `2021/01/08…2021/01/26`。
- 3 张废表：`数据表`、`Bug表`、`测试流程表`，各 5 行且**全部为空**。

**已实测的两条关键行为（脚本的设计前提）：**

1. `PUT /open-apis/bitable/v1/apps/{app}/tables/{tbl}/fields/{fld}` 带 `property.options` 是**整体替换**，不是合并（实测：4 个选项 → 传 2 个 → 读回 2 个）。
2. `DELETE /open-apis/bitable/v1/apps/{app}/tables/{tbl}` 可以完全删掉一张表（实测 `code 0`）。

- [ ] **Step 1: 写脚本**

`backend/scripts/lark_cleanup.py`：

```python
"""清掉「0918测试任务」里整块粘贴串列留下的垃圾行、垃圾选项和废表。

背景见 docs/superpowers/specs/2026-09-18-lark-header-alignment-requirements.md §4。

用法：

    # 只读，打印将要做什么，不发任何写请求
    backend/.venv/bin/python backend/scripts/lark_cleanup.py

    # 真干（顺序固定：先删行 → 再洗选项 → 最后删废表）
    backend/.venv/bin/python backend/scripts/lark_cleanup.py --apply

环境变量（凭证沿用部署里的那三个）：

    LARK_APP_ID / LARK_APP_SECRET
    LARK_BASE_URL         默认 https://open.larksuite.com
    CLEANUP_BASE_TOKEN    默认 NftVbjo6UamHsFseByPjXHU7pf7
    CLEANUP_EXEC_TABLE    默认 tblGMDjey2ufbUxd
    CLEANUP_BUG_TABLE     默认 tblUyjeopEHO8QVx

为什么顺序不能颠倒：删掉一个还被人引用的选项会连带清空那些单元格的值，
所以错位行必须先走。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any

import httpx

BASE_URL = os.environ.get("LARK_BASE_URL", "https://open.larksuite.com").rstrip("/")
BASE_TOKEN = os.environ.get("CLEANUP_BASE_TOKEN", "NftVbjo6UamHsFseByPjXHU7pf7")
EXEC_TABLE = os.environ.get("CLEANUP_EXEC_TABLE", "tblGMDjey2ufbUxd")
BUG_TABLE = os.environ.get("CLEANUP_BUG_TABLE", "tblUyjeopEHO8QVx")

# 粘贴进来的行，其「错位」特征是某个文本列里躺着一串日期。
# 这比按行号删安全：行号会因为上次删了一半而漂移。
MISPLACED_DATE = re.compile(r"^\d{4}/\d{2}/\d{2}$")

# 每个角色该有几行错位数据。数量对不上就停下来让人看一眼——
# 一个删除脚本最不该做的事是在数据长得不一样时"尽力而为"。
EXPECTED_MISPLACED = 12

# 洗选项的目标词表一律取自产品代码，不在这里抄一份。
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from app.lark.fields import (  # noqa: E402
    BUG_PRIORITY_OPTIONS,
    BUG_STATUS_OPTIONS,
    PASS_RESULT_OPTIONS,
    RUN_PRIORITY_OPTIONS,
)

WASHES: list[tuple[str, str, tuple[str, ...]]] = [
    (EXEC_TABLE, "结果", PASS_RESULT_OPTIONS),
    (EXEC_TABLE, "优先级", RUN_PRIORITY_OPTIONS),
    (BUG_TABLE, "进展状态", BUG_STATUS_OPTIONS),
    (BUG_TABLE, "优先级", BUG_PRIORITY_OPTIONS),
]

JUNK_TABLES = ("数据表", "Bug表", "测试流程表")


class Lark:
    def __init__(self) -> None:
        app_id = os.environ.get("LARK_APP_ID")
        app_secret = os.environ.get("LARK_APP_SECRET")
        if not app_id or not app_secret:
            raise SystemExit("需要 LARK_APP_ID 与 LARK_APP_SECRET")
        self.client = httpx.Client(base_url=BASE_URL, timeout=30.0)
        body = self.client.post(
            "/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        ).json()
        if body.get("code") != 0:
            raise SystemExit(f"取 tenant_access_token 失败：{body.get('msg')}")
        self.headers = {"Authorization": f"Bearer {body['tenant_access_token']}"}

    def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = self.client.request(method, path, headers=self.headers, **kwargs)
        payload = response.json()
        if payload.get("code") != 0:
            raise SystemExit(f"{method} {path} 被拒：code {payload.get('code')} {payload.get('msg')}")
        return payload.get("data") or {}

    def records(self, table: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            params: dict[str, Any] = {"page_size": 500}
            if page_token:
                params["page_token"] = page_token
            data = self.request(
                "GET", f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/records", params=params
            )
            out.extend(data.get("items") or [])
            if not data.get("has_more"):
                return out
            page_token = data.get("page_token")

    def fields(self, table: str) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/fields",
            params={"page_size": 100},
        )
        return data.get("items") or []

    def tables(self) -> list[dict[str, Any]]:
        data = self.request(
            "GET", f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables", params={"page_size": 100}
        )
        return data.get("items") or []


def _text(record: dict[str, Any], name: str) -> str:
    value = (record.get("fields") or {}).get(name)
    return value if isinstance(value, str) else ""


def misplaced(lark: Lark, table: str, column: str) -> list[dict[str, Any]]:
    return [
        record
        for record in lark.records(table)
        if MISPLACED_DATE.match(_text(record, column))
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="真的执行删除；默认只打印")
    args = parser.parse_args()

    lark = Lark()
    plan: dict[str, list[dict[str, Any]]] = {
        "执行记录": misplaced(lark, EXEC_TABLE, "负责人"),
        "缺陷记录": misplaced(lark, BUG_TABLE, "优先级"),
    }

    for label, rows in plan.items():
        print(f"\n=== {label} 错位行 {len(rows)} 条（预期 {EXPECTED_MISPLACED}）===")
        for row in rows[:3]:
            fields = row.get("fields") or {}
            print(f"  {row.get('record_id')}  {json.dumps(fields, ensure_ascii=False)[:150]}")
        if rows:
            print("  …")
        if len(rows) != EXPECTED_MISPLACED:
            print(f"  !! 数量与预期不符，停下来让人核对；本脚本不会「尽力而为」地删。")
            return 1

    print("\n=== 将被洗掉的垃圾选项 ===")
    for table, name, wanted in WASHES:
        live = next((f for f in lark.fields(table) if f.get("field_name") == name), None)
        if live is None:
            print(f"  !! 找不到 {table}.{name}")
            return 1
        current = [o.get("name") for o in (live.get("property") or {}).get("options", [])]
        junk = [option for option in current if option not in wanted]
        print(f"  {table}.{name}: 去掉 {junk} → 留 {list(wanted)}")

    print("\n=== 将被删除的废表 ===")
    junk_tables = [
        table
        for table in lark.tables()
        if table.get("name") in JUNK_TABLES
        and all(not (record.get("fields") or {}) for record in lark.records(table["table_id"]))
    ]
    for table in junk_tables:
        print(f"  {table['table_id']}  {table['name']}")

    if not args.apply:
        print("\n（dry-run：什么都没改。加 --apply 才执行。）")
        return 0

    for label, table, rows in (
        ("执行记录", EXEC_TABLE, plan["执行记录"]),
        ("缺陷记录", BUG_TABLE, plan["缺陷记录"]),
    ):
        ids = [row["record_id"] for row in rows]
        lark.request(
            "POST",
            f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/records/batch_delete",
            json={"records": ids},
        )
        print(f"已删 {label} {len(ids)} 行")

    for table, name, wanted in WASHES:
        live = next(f for f in lark.fields(table) if f.get("field_name") == name)
        lark.request(
            "PUT",
            f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/fields/{live['field_id']}",
            json={
                "field_name": name,
                "type": 3,
                "property": {"options": [{"name": option} for option in wanted]},
            },
        )
        print(f"已洗 {table}.{name}")

    for table in junk_tables:
        lark.request(
            "DELETE", f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table['table_id']}"
        )
        print(f"已删废表 {table['name']}")

    print("\n=== 复查 ===")
    for table, name, wanted in WASHES:
        live = next(f for f in lark.fields(table) if f.get("field_name") == name)
        current = [o.get("name") for o in (live.get("property") or {}).get("options", [])]
        ok = current == list(wanted)
        print(f"  {table}.{name}: {'OK' if ok else '!! 仍有差异'} {current}")
    for label, table in (("执行记录", EXEC_TABLE), ("缺陷记录", BUG_TABLE)):
        print(f"  {label} 剩余行数：{len(lark.records(table))}")
    print(f"  剩余表：{[t['name'] for t in lark.tables()]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: dry-run，把输出贴给用户确认**

Run（把三个凭证换成部署里的值）：
```bash
cd backend && LARK_APP_ID=... LARK_APP_SECRET=... .venv/bin/python scripts/lark_cleanup.py
```
Expected: 打印「执行记录 错位行 12 条」「缺陷记录 错位行 12 条」、4 处待洗选项、3 张待删废表，且以 `（dry-run：什么都没改…）` 结束。**数量不是 12 就停下来问用户，不要加 `--apply`。**

- [ ] **Step 3: 用户确认后执行**

Run: 同 Step 2 命令加 `--apply`
Expected: 复查段全 `OK`；执行记录剩 8 行、缺陷记录剩 5 行；表只剩 `执行记录` 与 `缺陷记录`（外加用户自己的表）

- [ ] **Step 4: 提交脚本**

```bash
git add backend/scripts/lark_cleanup.py
git commit -m "chore(lark): a dry-run-first cleanup for the pasted test rows"
```

---

## Self-Review

**1. Spec coverage**

| Spec 条目 | 落在哪个任务 |
|---|---|
| R1 缺陷表列序对齐模板库 | Task 1（schema + 测试 + 文案） |
| R1 副作用①：`layout_matches` 顺序敏感 | Task 1 Step 6 跑全文件覆盖；spec §1 已向用户说明 |
| R1 副作用②：补表头只能追加到末尾 | 无代码改动（Lark 限制），spec §1 已说明 |
| R1-a 只改列序、不动选项词表 | Global Constraint 3；Task 8 洗选项时用的就是原词表 |
| R1-b `multiple` 保持 true | Global Constraint 4；`PERSON_PROPERTY` 不动 |
| R2 执行记录两列改 person | Task 2 |
| R2 人员列 `multiple` = true | Task 2 Step 1 断言 `{"multiple": True}` |
| R2 改完需重新读取+确认 | 无代码改动（操作步骤），spec §2 已说明 |
| R3 页面配两个 open_id | Task 4（解析）+ Task 5（API）+ Task 7（视图） |
| R3 报告人一处配、两侧共用 | Task 6：`reporter_id` 同时喂 执行.报告人 与 缺陷.反馈人（`bug_fields` 既有路径） |
| R3-a env 保留为兜底 | Task 4 `resolved_reporter_open_id` + Task 5 用例 |
| R3-b 纯 `ou_` 输入框、服务端先挡 | Task 5 `_checked` + Task 7 `code` 提示 |
| R3-c 全局一份 | Task 3 单行表 + CHECK 约束 |
| R4 清理线上测试数据 | Task 8 |
| R4「先删行再洗选项」顺序 | Task 8 脚本的固定顺序 + 文件头注释 |

**2. Placeholder scan**

无 TBD / TODO / "similar to Task N" / "add appropriate error handling"。每个代码步骤都给了可直接落盘的完整代码块；每个 Run 步骤都给了可复制执行的命令与预期结果。唯一需要执行者自带的输入是 Task 8 的三个 Lark 凭证值（步骤里写明了从哪取），以及 Task 8 执行前必须由用户过目 dry-run 输出。

**3. Type consistency**

- `execution_fields(..., owner_id=...)`：Task 6 Step 1 的测试用 `owner_id=`，Step 3 的实现定义 `owner_id`，Step 7 的 `run_job` 透传 `owner_id`，Step 8 的 worker 传 `owner_id=resolved_owner_open_id(session)` —— 四处同名。
- `run_job(..., owner_id=...)` 关键字参数与 `write.execution_fields` 同名，未与既有的 `owner`（显示名）混淆。
- `resolved_reporter_open_id` / `resolved_owner_open_id` 在 Task 4 定义，Task 6 Step 8 按同名 import。
- `LarkPeople` 的 JSON 形状在 Task 5（后端 `_payload`）与 Task 7（前端 `LarkPeople` 类型）逐字段一致：`reporter_open_id` / `owner_open_id` / `env_reporter_open_id` / `effective_reporter_open_id` / `effective_owner_open_id`。
- 迁移 revision 名 `0016_lark_people` 在 Task 3 的迁移文件、`test_migrations.py` 的三处断言里逐字一致。
- 缺陷表目标列序 `问题描述/优先级/进展状态/反馈时间/反馈人/跟进人/备注/截图` 在 Task 1 的代码、断言、文案、`findings.md` 四处逐字一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-18-lark-header-alignment.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
