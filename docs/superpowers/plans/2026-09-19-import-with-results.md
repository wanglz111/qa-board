# 用例 + 实测结果 一次导入（含第三份提示词）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一份 12 列 CSV（用例 + `执行结果` + `实测过程`）一次导入就同时落成用例与执行记录，并把「实测过程」写进 Lark 执行表新列；同时交付第三份提示词，让 AI 把「已有用例 + 本轮实测」转译成这份文件。

**Architecture:** 结果列在**解析层**成为 `ParsedCase.result/evidence` 两个规范字段（与 10 个既有字段同级），在**确认导入时**物化成 `Attempt`（`source='import'`），随后完全复用既有 `attempt → SyncJob → Lark` 通道；「留空」不建 attempt，因此 Lark 天然不出现该行。`实测过程` 落在新增的 `attempts.evidence`，由写端填进执行表新增的必填列。

**Tech Stack:** FastAPI + SQLAlchemy 2 / Alembic / PostgreSQL（本地测试库 127.0.0.1:5433）/ pytest；React + TypeScript + Vite / vitest。

**Spec:** `docs/superpowers/specs/2026-09-19-import-with-results-design.md`（本计划从该 spec 推导，执行时两份一起读）

## Global Constraints

- 列契约固定 12 列，**前 10 列一字不改**，结果两列追加在末尾：
  `用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程`
- `执行结果` 只接受 `通过` / `不通过` / `未执行` / 空。**「阻塞」明文拒绝**，不静默映射（`AttemptCreate` 与 DB CHECK 都只认这三种）。
- `执行结果` 为空 = 未测 = **不建 attempt**（这是「留白」的全部机制）。
- 不新增 update/回写能力；Lark 只收有结论的行。
- `RUN_SCHEMA` 的列顺序是承重约定：新列**追加在末尾**，保证与参考表的 8 列前缀逐列一致。
- `backend/app/prompts/ai-case-results.md` 与 `docs/AI-CASE-RESULT-PROMPT.md` 必须**逐字节相同**（`test_shipped_prompts_match_the_docs` 强制）。
- Lark 活表的「实测过程」列必须先补、再同步；顺序颠倒会让已入队 job 因 `target_fingerprint`（含 schema 指纹）变化全部 park。见 spec §1.4/§6。
- 后端测试（**先确认本地测试库起了**）：
  ```bash
  docker start testdeck-task2-postgres   # 已运行会报 already running，无害；起好约 3 秒
  cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' \
    .venv/bin/python -m pytest -q
  ```
  单文件：把 `-q` 换成 `-q tests/test_x.py`。**不要**因为连不上就跳过 backend 套件（容器常见状态是 Exited，不是不存在）。
- 前端：`cd frontend && npx vitest run <file>`；**vitest 不做类型检查**，每个前端任务结束必须另跑 `cd frontend && npx tsc -b`。
- 提交信息风格照仓库：`<type>(<scope>): <祈使句>`，正文说清为什么。

---

## File Structure

| 文件 | 职责 | 本计划中的改动 |
|---|---|---|
| `backend/app/importers/schema.py` | 导入文件 → `ParsedCase` 的唯一规范层 | `FIELDS`/`ALIASES`/`ParsedCase` 加 `result`/`evidence` |
| `backend/app/groups.py` | 预览/确认导入、建组 | `_group_case` 排除结果列；`ConfirmImport.import_results`；物化 attempt |
| `backend/app/models.py` | ORM 模型 | `Attempt.evidence`；`ck_attempts_source` 放开 `import`；`LOCAL_SOURCES` |
| `backend/alembic/versions/0017_attempt_evidence.py` | 迁移 | 新列 + 新 CHECK |
| `backend/app/execution.py` | attempt 的读写 API | `AttemptCreate.evidence`、`_commit_attempt`、`_attempt_payload`、`_matching_attempt` |
| `backend/app/lark/fields.py` | 必填列类型表 | `REQUIRED_RUN_FIELD_TYPES` 加 `实测过程` |
| `backend/app/lark/provision.py` | 建/修/补齐表头 | `RUN_SCHEMA` 末尾加 `实测过程` |
| `backend/app/lark/write.py` | Lark 行字段组装 | `execution_fields` 写 `实测过程` |
| `backend/app/lark/outbox.py` | 同步队列 | 三处 `source` 过滤改用 `LOCAL_SOURCES` |
| `backend/app/lark/reconcile.py` | 对账 | 两处 `source` 过滤改用 `LOCAL_SOURCES` |
| `backend/app/prompts.py` + `backend/app/prompts/ai-case-results.md` + `docs/AI-CASE-RESULT-PROMPT.md` | 第三份提示词 | 新建/注册 |
| `docs/IMPORT-FORMAT.md` | 导入格式规范 | 记录两列与物化规则 |
| `frontend/src/api.ts` | API 类型与调用 | `ImportPreview` 新字段、`confirm` 新参数、`SubmitPayload.evidence` |
| `frontend/src/views/Import.tsx` | 导入页 | 检出结果摘要 + 勾选框 |
| `frontend/src/components/OutcomeForm.tsx` | 结果表单 | 「实测过程」文本域 |
| `frontend/src/components/History.tsx` | 执行历史 | 展示 evidence、`import` 徽标 |

---

## Task 1: 解析层认「执行结果 / 实测过程」，建组不再被新字段炸

**Files:**
- Modify: `backend/app/importers/schema.py`（`FIELDS` 34-46、`ALIASES` 48-53、`ParsedCase` 17-31、`normalize_record` 104-156）
- Modify: `backend/app/groups.py:499-505`（`_group_case`）
- Test: `backend/tests/test_importers.py`、`backend/tests/test_groups_api.py`

**Interfaces:**
- Consumes: 无
- Produces: `ParsedCase.result: str | None`、`ParsedCase.evidence: str | None`（后续 Task 3 物化 attempt 时读这两个字段）；`_group_case` 对这两个字段免疫

- [ ] **Step 1: 写失败测试** — 在 `backend/tests/test_importers.py` 末尾追加：

```python
RESULT_CSV = (
    "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
    'LOGIN-001,1,账号密码登录,登录,P0,Smoke,存在已注册账号,user=qa01,"1. 打开登录页\n2. 点击登录",'
    '"1. 页面: 跳转到工作台",通过,"1. 实测跳转耗时 1.2s\n2. token 已写入"\n'
    "LOGIN-002,2,密码错误登录,登录,P1,Smoke,,,"
    '"1. 打开登录页\n2. 输入错误密码",'
    '"1. 提示: 账号或密码错误",,留档：本轮未复验\n'
)


def test_csv_reads_the_two_outcome_columns():
    cases = parse_file("result.csv", RESULT_CSV.encode("utf-8"))

    assert [case.result for case in cases] == ["通过", None]
    assert cases[0].evidence == "1. 实测跳转耗时 1.2s\n2. token 已写入"
    # 结果为空的行仍然带着留档文本：它只是没有结论，不是没有过程记录。
    assert cases[1].evidence == "留档：本轮未复验"
    assert cases[0].raw["执行结果"] == "通过"


def test_outcome_columns_are_optional():
    cases = parse_file("plain.csv", fixture_bytes("group14.csv"))

    assert cases[0].result is None
    assert cases[0].evidence is None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_importers.py -k outcome`
Expected: FAIL — `AttributeError: 'ParsedCase' object has no attribute 'result'`

- [ ] **Step 3: 最小实现** — `backend/app/importers/schema.py`

`ParsedCase` 加两个字段（放在 `prototype_note` 之后、`raw` 之前）：

```python
    prototype_note: str | None
    # The outcome columns. A case is a spec; 通过/不通过/未执行 belong to an
    # execution, so these two travel to the attempt materialiser instead of
    # into the case row (see groups._group_case).
    result: str | None
    evidence: str | None
    raw: dict[str, Any]
```

`FIELDS` 加 `"result", "evidence"`：

```python
FIELDS = (
    "code",
    "position",
    "title",
    "module",
    "layer",
    "priority",
    "preconditions",
    "test_data",
    "steps",
    "expected",
    "prototype_note",
    "result",
    "evidence",
)
```

`ALIASES` 加两组（`本轮实测结果` 是 0918 那份交付文件用的列名）：

```python
    "result": ("result", "执行结果", "实测结果", "本轮实测结果"),
    "evidence": ("evidence", "实测过程", "过程记录", "实测说明"),
```

`normalize_record` 的 `ParsedCase(...)` 加两个参数：

```python
        prototype_note=values["prototype_note"],
        result=values["result"],
        evidence=values["evidence"],
        raw=dict(record),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_importers.py`
Expected: PASS（含既有 20 个用例）

- [ ] **Step 5: 写回归测试确认建组会炸** — 在 `backend/tests/test_groups_api.py` 追加：

```python
RESULT_BOOK = (
    "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
    'B-001,1,管理员登录,账户,P0,Smoke,,,"1. 打开登录页","1. 页面: 进入工作台",通过,"1. 实测 1.2s"\n'
    "B-002,2,密码错误登录,账户,P1,Smoke,,,"
    '"1. 输入错误密码","1. 提示: 密码错误",,留档：本轮未复验\n'
)


def test_confirm_still_builds_the_group_when_the_file_carries_results(
    authenticated_client, db_session
):
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("result.csv", RESULT_BOOK.encode("utf-8"), "text/csv")},
    )
    assert preview.status_code == 200
    assert preview.json()["count"] == 2

    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "结果列回归"},
    )

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["count"] == 2
    # 预览把两列带给页面（Task 8 用它算摘要），值来自新字段而不是 raw。
    assert preview.json()["cases"][0]["result"] == "通过"
    assert preview.json()["cases"][0]["evidence"] == "1. 实测 1.2s"
    # 预览的两个数字决定页面要不要给"一并写入执行结果"：这里一条有结论、一条只有过程。
    assert preview.json()["result_count"] == 1
    assert preview.json()["evidence_only_count"] == 1
```

- [ ] **Step 6: 跑它确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_groups_api.py -k carries_results`
Expected: FAIL — `TypeError: 'result' is an invalid keyword argument for GroupCase`。TestClient 会直接把服务端异常抛出来，所以看不到 500 响应体；真因是 `_group_case` 用 `**asdict(case)` 直通（spec §1.4）

- [ ] **Step 7: 修 `_group_case`，并让预览报出两个计数** — `backend/app/groups.py`：

```python
def _group_case(case: ParsedCase) -> GroupCase:
    # The outcome columns belong to the attempt, not the case row: spreading
    # them here is a TypeError, and dropping 未测 rows later is the whole
    # point of keeping them apart.
    fields = asdict(case)
    fields.pop("result")
    fields.pop("evidence")
    return GroupCase(
        **fields,
        expect_absent=[],
        visual_check="text_and_visual",
    )
```

同一个文件里，`preview_import` 的非 casebook 分支补两个计数（Task 8 的导入页读它们，spec §5.1）：

```python
        preview = {
            "count": len(text_cases),
            "cases": [_case_payload(case) for case in text_cases[:10]],
            "fields": sorted({str(key) for case in text_cases for key in case.raw}),
            # 结果列不是普通留档列：这两条数字决定导入页要不要给出"一并写入执行
            # 结果"，以及有没有"只有过程、没有结论"的行会被静默留档。
            "result_count": sum(1 for case in text_cases if case.result),
            "evidence_only_count": sum(
                1 for case in text_cases if case.evidence and not case.result
            ),
        }
```

- [ ] **Step 8: 跑目标文件 + 整个后端套件**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: 全绿（`test_importers.py`、`test_groups_api.py`、`test_casebook.py`、`test_bundle_import_api.py` 都覆盖导入路径）

- [ ] **Step 9: 提交**

```bash
git add backend/app/importers/schema.py backend/app/groups.py \
  backend/tests/test_importers.py backend/tests/test_groups_api.py
git commit -m "feat(import): read the outcome columns without spreading them into the case row

The two new columns are canonical ParsedCase fields, so a file that carries
results parses for free; _group_case drops them before it builds a GroupCase,
which is what keeps the existing import path working."
```

---

## Task 2: `attempts.evidence` + `source='import'`（模型 + 迁移）

**Files:**
- Modify: `backend/app/models.py:133-175`（`Attempt`）、`:210-235` 之后位置放常量
- Create: `backend/alembic/versions/0017_attempt_evidence.py`
- Modify: `backend/tests/test_migrations.py:36-38`（head 断言）
- Test: `backend/tests/test_attempt_outcome.py`（新建）

**Interfaces:**
- Consumes: 无
- Produces: `Attempt.evidence: str | None`；`app.models.LOCAL_SOURCES: tuple[str, ...] = ("execution", "import")`（Task 3 用它写 `source`，Task 4 用它过滤）

- [ ] **Step 1: 写失败测试** — 新建 `backend/tests/test_attempt_outcome.py`：

```python
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

import pytest

from app.models import Attempt, LOCAL_SOURCES


def test_an_imported_attempt_keeps_its_evidence(db_session, make_group_case):
    case = make_group_case(db_session, group_name="0918", code="B-001")
    attempt = Attempt(
        group_case=case,
        label="B-001",
        sequence=1,
        state="committed",
        result="通过",
        evidence="1. 实测底色 rgb(19,23,30)",
        source="import",
        idempotency_key="import:abc:B-001",
    )
    db_session.add(attempt)
    db_session.commit()

    stored = db_session.scalar(select(Attempt).where(Attempt.id == attempt.id))
    assert stored.evidence == "1. 实测底色 rgb(19,23,30)"
    assert stored.source == "import"


def test_the_local_sources_are_the_two_rows_we_own():
    assert LOCAL_SOURCES == ("execution", "import")


def test_an_unknown_source_is_refused_by_the_database(db_session, make_group_case):
    case = make_group_case(db_session, group_name="0918", code="B-002")
    db_session.add(
        Attempt(
            group_case=case,
            label="B-002",
            sequence=1,
            state="committed",
            result="通过",
            source="borrowed",
            idempotency_key="borrowed-1",
        )
    )
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
```

- [ ] **Step 2: 跑它确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_attempt_outcome.py`
Expected: FAIL — `ImportError: cannot import name 'LOCAL_SOURCES'`（首个失败点）

- [ ] **Step 3: 改模型** — `backend/app/models.py`

`Attempt.__table_args__` 的 source CHECK 放开：

```python
        CheckConstraint(
            "source IN ('execution', 'reconcile', 'import')", name="ck_attempts_source"
        ),
```

`Attempt` 加字段（放在 `console_text` 之后，语义上两者是两列不同的证据）：

```python
    console_text: Mapped[str | None] = mapped_column(Text)
    # 实测过程 as the operator wrote it: the row's evidence narrative, which the
    # writer puts into Lark's own 实测过程 column. 控制台 keeps the console dump.
    evidence: Mapped[str | None] = mapped_column(Text)
```

在 `Attempt` 类之后加常量（单处定义，outbox 与 reconcile 都从这里取）：

```python
# Every attempt this tool creates locally: one a person ran, one materialised
# from an imported result. Both are ours to queue and to diff against the
# table; 'reconcile' rows were adopted from the table and mirror it.
LOCAL_SOURCES: tuple[str, ...] = ("execution", "import")
```

- [ ] **Step 4: 写迁移** — 新建 `backend/alembic/versions/0017_attempt_evidence.py`：

```python
"""Give an attempt its evidence column, and let an imported row say so.

Revision ID: 0017_attempt_evidence
Revises: 0016_lark_people
Create Date: 2026-09-19
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0017_attempt_evidence"
down_revision: str | None = "0016_lark_people"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attempts", sa.Column("evidence", sa.Text(), nullable=True))
    # 导入的行必须能与"人跑出来的行"区分开，否则执行历史与导出报表里
    # 41 条转译结果看起来像手工逐条点的。
    op.drop_constraint("ck_attempts_source", "attempts", type_="check")
    op.create_check_constraint(
        "ck_attempts_source", "attempts", "source IN ('execution', 'reconcile', 'import')"
    )


def downgrade() -> None:
    op.drop_constraint("ck_attempts_source", "attempts", type_="check")
    op.create_check_constraint(
        "ck_attempts_source", "attempts", "source IN ('execution', 'reconcile')"
    )
    op.drop_column("attempts", "evidence")
```

- [ ] **Step 5: 更新迁移测试的 head 断言** — `backend/tests/test_migrations.py:36-38`：

```python
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            "0017_attempt_evidence"
        )
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_attempt_outcome.py tests/test_migrations.py`
Expected: PASS

- [ ] **Step 7: 跑整个后端套件（迁移被 conftest 走 `upgrade head`，任何漏改都会在这里现形）**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add backend/app/models.py backend/alembic/versions/0017_attempt_evidence.py \
  backend/tests/test_attempt_outcome.py backend/tests/test_migrations.py
git commit -m "feat(attempts): add the evidence column and an import source

An imported row has to be tellable apart from a hand-run one in history and
in the exported report, exactly like a reconcile-adopted row already is."
```

---

## Task 3: 确认导入时物化 attempt

**Files:**
- Modify: `backend/app/groups.py`（`ConfirmImport` 39-44、`confirm_import` 102-171、新增 `_materialize_attempts`）
- Modify: `docs/IMPORT-FORMAT.md`（§2 字段字典、§3 校验、新小节）
- Test: `backend/tests/test_groups_api.py`

**Interfaces:**
- Consumes: `ParsedCase.result/evidence`（Task 1）、`LOCAL_SOURCES`（Task 2）、`app.execution.allocate_attempt(db, group_case, *, label=None) -> Attempt`
- Produces: `POST /api/import/confirm` 请求体多一个 `import_results: bool = True`，响应多一个 `attempt_count: int`；模块级 `_materialize_attempts(db, group_cases, parsed_cases, group_id) -> int`（`group_id` 用于生成**按组作用域**的幂等键；Task 3 实施期裁决修正，原写的是文件哈希）

- [ ] **Step 1: 写失败测试** — 在 `backend/tests/test_groups_api.py` 追加：

```python
THREE_OUTCOMES = (
    "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
    'B-001,1,管理员登录,账户,P0,Smoke,,,"1. 打开登录页","1. 页面: 进入工作台",通过,"1. 实测 1.2s"\n'
    "B-002,2,未绑定拦截,账户,P0,Smoke,,,"
    '"1. 直访业务页","1. 页面: 被拦截",,\n'
    'B-003,3,邀请码校验,账户,P1,Smoke,,,"1. 输入邀请码",'
    '"1. 页面: 回显推荐人",不通过,"1. 实测回显 8+8，设计稿 6+6"\n'
)


def import_with_results(client, name="结果导入"):
    preview = client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", THREE_OUTCOMES.encode("utf-8"), "text/csv")},
    )
    assert preview.status_code == 200
    return preview, client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": name},
    )


def test_confirm_materialises_only_the_rows_that_carry_a_result(
    authenticated_client, db_session
):
    preview, confirm = import_with_results(authenticated_client)

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["attempt_count"] == 2  # B-002 留空 → 不建 attempt

    attempts = db_session.scalars(select(Attempt).order_by(Attempt.label)).all()
    assert [attempt.label for attempt in attempts] == ["B-001", "B-003"]
    assert [attempt.result for attempt in attempts] == ["通过", "不通过"]
    assert attempts[0].source == "import"
    assert attempts[0].evidence == "1. 实测 1.2s"
    assert attempts[0].console_text is None
    # 不通过必须带 note（execution.AttemptCreate 的既有规则），导入用实测过程兜。
    assert attempts[1].note == "1. 实测回显 8+8，设计稿 6+6"
    assert attempts[0].idempotency_key.startswith("import:")


def test_confirm_rejects_a_result_outside_the_enum(authenticated_client, db_session):
    body = THREE_OUTCOMES.replace(",不通过,", ",阻塞,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", body.encode("utf-8"), "text/csv")},
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "非法结果"},
    )

    assert confirm.status_code == 422
    assert "B-003" in confirm.json()["detail"]
    assert "只接受" in confirm.json()["detail"]
    # 拒绝是整体回滚：组与 attempt 都不许留下。
    assert db_session.scalars(select(Group)).all() == []


def test_confirm_rejects_a_failure_without_evidence(authenticated_client, db_session):
    body = THREE_OUTCOMES.replace(',不通过,"1. 实测回显 8+8，设计稿 6+6"', ",不通过,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", body.encode("utf-8"), "text/csv")},
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "缺过程"},
    )

    assert confirm.status_code == 422
    assert confirm.json()["detail"] == "Case B-003 is a failure without 实测过程"
    assert db_session.scalars(select(Group)).all() == []


def test_import_results_false_ignores_the_outcome_columns(authenticated_client, db_session):
    body = THREE_OUTCOMES.replace(",不通过,", ",阻塞,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", body.encode("utf-8"), "text/csv")},
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={
            "ticket_id": preview.json()["ticket_id"],
            "name": "只要用例",
            "import_results": False,
        },
    )

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["attempt_count"] == 0
    assert db_session.scalars(select(Attempt)).all() == []
```

在文件头部补上需要的 import（与既有风格一致）：
`from app.models import Attempt, Group`（`Group` 已在文件里，只需补 `Attempt`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_groups_api.py -k "materialises or enum or without_evidence or import_results_false"`
Expected: FAIL — `KeyError: 'attempt_count'`

- [ ] **Step 3: 实现物化** — `backend/app/groups.py`

顶部 import 区加：

```python
from app.execution import allocate_attempt
from app.importers.schema import ImportErrorDetail, ParsedCase, parse_file
```

（`ImportErrorDetail` / `ParsedCase` / `parse_file` 已在该文件按别名导入，按实际名字补齐即可；只新增 `allocate_attempt` 一行。）

`ConfirmImport`：

```python
class ConfirmImport(BaseModel):
    ticket_id: UUID
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    mapping: dict[str, str] = Field(default_factory=dict)
    # Materialise the outcome columns as attempts. The flag exists so the same
    # file can still be imported as cases only, and so a file whose results are
    # wrong can be pulled in without hand-editing it.
    import_results: bool = True
```

新增模块级函数（放在 `confirm_import` 之前）：

```python
# What the attempt layer accepts. 「阻塞」 is a legal option in the Lark table's
# select column but not a state this tool records, so it is refused loudly
# instead of being mapped onto something it is not.
IMPORT_RESULTS = ("通过", "不通过", "未执行")


def _materialize_attempts(
    db: Session, group_cases: list[GroupCase], parsed_cases: list[ParsedCase], group_id: UUID
) -> int:
    """Turn every row that carries a conclusion into a committed attempt.

    A row without one stays 未测: no attempt means no execution record, so the
    board shows it blank and Lark never sees it — that is the whole mechanism
    behind "失败用例留空，等我亲自校验".
    """

    created = 0
    for group_case, case in zip(group_cases, parsed_cases, strict=True):
        result = (case.result or "").strip()
        evidence = (case.evidence or "").strip() or None
        if not result:
            continue
        if result not in IMPORT_RESULTS:
            raise ImportErrorDetail(
                f"Case {case.code} has invalid result: {result}"
                "（只接受 通过/不通过/未执行）"
            )
        if result == "不通过" and not evidence:
            raise ImportErrorDetail(f"Case {case.code} is a failure without 实测过程")
        attempt = allocate_attempt(db, group_case)
        attempt.state = "committed"
        attempt.result = result
        attempt.note = evidence if result == "不通过" else None
        attempt.console_text = None
        attempt.evidence = evidence
        attempt.source = "import"
        # Scoped to this group, so a repeat import becomes a new group instead
        # of a collision: the preview warns about a repeat and lets the operator
        # decide, and a file-hash key turned that second confirm into an
        # unhandled unique violation.
        attempt.idempotency_key = f"import:{group_id}:{case.code}"
        created += 1
    return created
```

`confirm_import` 内，在 `group = Group(...)` 之前把 `parsed_cases` 备好（casebook 分支没有结果列，置空）：

```python
    if ticket.parsed.get("casebook"):
        document = _parse_casebook_or_422(ticket.original_file)
        group_cases, written = _casebook_group_cases(document, group_id)
        parsed_cases: list[ParsedCase] = []
        asset_count = len(document.assets)
        link_count = sum(len(case.references) for case in document.cases)
    else:
        parsed_cases = _parse_or_422(source_name, ticket.original_file, payload.mapping or None)
        group_cases = [_group_case(case) for case in parsed_cases]
        asset_count = 0
        link_count = 0
```

在 `db.add(group)` 之后、`ticket.consumed_at = now` 之前插入：

```python
    attempt_count = 0
    if payload.import_results and parsed_cases:
        try:
            attempt_count = _materialize_attempts(
                db, group_cases, parsed_cases, group_id
            )
        except ImportErrorDetail as error:
            # Nothing is half-written: the ticket stays usable and the operator
            # fixes the file instead of hunting a group that imported by halves.
            db.rollback()
            raise HTTPException(status_code=422, detail=str(error)) from None
```

响应体加 `"attempt_count": attempt_count`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_groups_api.py`
Expected: PASS

- [ ] **Step 5: 更新导入格式文档** — `docs/IMPORT-FORMAT.md`

- §2 字段字典表尾追加两行：

```markdown
| result | 执行结果 | `result` `执行结果` `实测结果` `本轮实测结果` | 否；非空时该行会在确认导入时生成一条执行记录 |
| evidence | 实测过程 | `evidence` `实测过程` `过程记录` `实测说明` | 否；`执行结果=不通过` 时必填 |
```

- §3 硬性校验追加两条：

```markdown
- `执行结果` 只能是 `通过` / `不通过` / `未执行`（**不支持「阻塞」**）；其它写法整份拒绝并指出用例编号。
- `执行结果=不通过` 且 `实测过程` 为空 → 拒绝。
```

- 新增 §10（放在 §9 之后）：

```markdown
## 10. 结果列怎么进系统

`执行结果` 非空的行，在「确认导入」时生成一条**执行记录**（结果 + 实测过程），随后走既有的「同步」把它写进 Lark 执行表。
`执行结果` 留空的行**只建用例**：界面里它是未测，Lark 里不会出现这一行——这正是「先导通过的、失败的留白等人亲自复验」的用法。

顺序要求：如果 Lark 执行表还没有「实测过程」列，**先在 Lark 检查页补齐并重新确认目标，再导入、再同步**。反过来（先同步后加列）会让已入队的行因目标指纹变化全部挂起，需要人工重新指向。
```

- [ ] **Step 6: 跑整个后端套件**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add backend/app/groups.py docs/IMPORT-FORMAT.md backend/tests/test_groups_api.py
git commit -m "feat(import): materialise an attempt per row that carries a conclusion

A blank result is not an attempt with 未执行 written into it: it is no
attempt at all, which is how the nine rows the operator wants to re-verify
stay out of Lark until they are actually run."
```

---

## Task 4: 同步与对账把 `import` 行算作本地行

**Files:**
- Modify: `backend/app/lark/outbox.py:130`、`:187`、`:529`
- Modify: `backend/app/lark/reconcile.py:243`、`:426`
- Test: `backend/tests/test_lark_outbox.py`、`backend/tests/test_lark_reconcile.py`

**Interfaces:**
- Consumes: `app.models.LOCAL_SOURCES`（Task 2）、`source='import'` 的 attempt（Task 3）
- Produces: `enqueue_group_attempts` 与对账的本地行集合都包含 `import` 行

- [ ] **Step 1: 写失败测试** — 在 `backend/tests/test_lark_outbox.py` 追加（该文件已 import `Attempt` 与 outbox 函数，按文件现有 import 列表补 `read_sync`）：

```python
def test_enqueue_group_attempts_includes_imported_rows(
    db_session, confirmed_group, add_case
):
    case = add_case(confirmed_group.id, code="B-002", title="导入的通过")
    db_session.add(
        Attempt(
            group_case=case,
            label="B-002",
            sequence=1,
            state="committed",
            result="通过",
            evidence="1. 实测 1.2s",
            source="import",
            idempotency_key="import:deadbeef:B-002",
        )
    )
    db_session.commit()

    assert enqueue_group_attempts(db_session, confirmed_group.id) == 1
    # 面板的"待同步"计数读的是同一个白名单，漏改这里就会出现"队列 0 条、
    # 却显示还有 1 条待同步"。
    assert read_sync(confirmed_group.id, db_session)["pending_attempts"] == 1
```

在 `backend/tests/test_lark_reconcile.py` 追加（紧挨既有的 `test_the_diff_ignores_attempts_that_came_from_the_table`，与它形成对照）：

```python
def test_the_diff_counts_imported_attempts_as_local(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    from app.execution import allocate_attempt

    case = authenticated_client.get(f"/api/groups/{confirmed_group.id}/cases").json()[0]
    group_case = db_session.scalar(select(GroupCase).where(GroupCase.code == case["code"]))
    attempt = allocate_attempt(db_session, group_case)
    attempt.state = "committed"
    attempt.result = "通过"
    attempt.source = "import"
    attempt.idempotency_key = f"import:deadbeef:{group_case.code}"
    db_session.commit()
    lark_fake.records = []

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/reconcile?source=live"
    ).json()

    # 导入的行是本工具的产物，不是从表里借来的：它必须出现在本地侧，
    # 否则"Lark 里少了这一行"这类真实差异会被静默吃掉。
    assert [row["key"] for row in body["rows"]] == [group_case.code]
    assert body["rows"][0]["status"] == "local_only"
```

（该文件已 import `select` 与 `Attempt`；补 `GroupCase` 到 `from app.models import ...`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_lark_outbox.py -k imported_rows tests/test_lark_reconcile.py -k imported_attempts`
Expected: FAIL — 计数为 0 / `body["rows"] == []`

- [ ] **Step 3: 实现** — 五处过滤改用常量

`backend/app/lark/outbox.py`：

```python
from app.models import LOCAL_SOURCES, Attempt, Group, SyncJob
```

- `enqueue_attempt_job` 内：`or attempt.source not in LOCAL_SOURCES`
- `enqueue_group_attempts` 内：`Attempt.source.in_(LOCAL_SOURCES),`
- `read_sync` 内：`Attempt.source.in_(LOCAL_SOURCES),`

`backend/app/lark/reconcile.py`：同样把 `Attempt.source == "execution"` 改成 `Attempt.source.in_(LOCAL_SOURCES)`（`:243` 的 `_attempts`、`:426` 的删除前锁定），并 import 该常量。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_lark_outbox.py tests/test_lark_reconcile.py`
Expected: PASS（含既有 `test_the_diff_ignores_attempts_that_came_from_the_table`，它仍然只把 `reconcile` 行排除）

- [ ] **Step 5: 跑整个后端套件**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add backend/app/lark/outbox.py backend/app/lark/reconcile.py \
  backend/tests/test_lark_outbox.py backend/tests/test_lark_reconcile.py
git commit -m "fix(lark): treat imported attempts as rows this tool owns

The whitelist was one value repeated in five places; it is now LOCAL_SOURCES
and covers both a hand-run row and one materialised from an import, so the
queue, the pending count and the reconcile diff agree again."
```

---

## Task 5: 「实测过程」列进 Lark 执行表（表头 + 写端）

**Files:**
- Modify: `backend/app/lark/fields.py:50-59`（`REQUIRED_RUN_FIELD_TYPES`）
- Modify: `backend/app/lark/provision.py:112-131`（`RUN_SCHEMA`）
- Modify: `backend/app/lark/write.py:107-127`（`execution_fields`）
- Modify: `backend/tests/conftest.py:775-779`（`FIXTURE_SCHEMA_FINGERPRINT`）
- Modify: `backend/tests/test_lark_target.py:157-161`、`backend/tests/test_lark_provision.py:107`、`:281`
- Test: `backend/tests/test_lark_outbox.py`

**Interfaces:**
- Consumes: `Attempt.evidence`（Task 2）
- Produces: 执行表第 9 列 `实测过程`（文本）；`execution_fields` 输出键 `实测过程`

- [ ] **Step 1: 写失败测试** — 在 `backend/tests/test_lark_outbox.py` 追加：

```python
def test_the_run_row_carries_the_evidence_column(db_session, local_attempt):
    local_attempt.evidence = "1. 实测遮罩 rgba(0,0,0,.65)"
    local_attempt.console_text = "console dump"
    db_session.commit()

    fields = execution_fields(
        local_attempt,
        local_attempt.group_case,
        owner="待指派",
        reporter="qa",
    )

    assert fields["实测过程"] == "1. 实测遮罩 rgba(0,0,0,.65)"
    # 两列互不顶替：控制台仍然是控制台。
    assert fields["控制台"] == "console dump"


def test_the_run_row_writes_an_empty_evidence_cell(db_session, local_attempt):
    fields = execution_fields(
        local_attempt, local_attempt.group_case, owner="待指派", reporter="qa"
    )

    assert fields["实测过程"] == ""
```

（`execution_fields` 已在该文件 import；`local_attempt` 是既有 fixture。）

在 `backend/tests/test_lark_provision.py` 追加：

```python
def test_the_manual_evidence_column_is_required_and_last():
    from app.lark.fields import REQUIRED_RUN_FIELD_TYPES
    from app.lark.provision import RUN_SCHEMA, schema_order

    assert REQUIRED_RUN_FIELD_TYPES["实测过程"] == (1,)
    assert schema_order("execution")[-1] == "实测过程"
    assert RUN_SCHEMA["实测过程"].type_id == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_lark_outbox.py -k evidence tests/test_lark_provision.py -k manual_evidence`
Expected: FAIL — `KeyError: '实测过程'`

- [ ] **Step 3: 实现三处** — 全部**追加在末尾**（列顺序是承重约定，见 spec §4.4）

`backend/app/lark/fields.py`，`REQUIRED_RUN_FIELD_TYPES` 末尾：

```python
    "控制台": (1,),
    # 人工写的实测过程：导入时来自文件的 `实测过程` 列，手工执行时来自结果表单。
    "实测过程": (1,),
```

`backend/app/lark/provision.py`，`RUN_SCHEMA` 末尾（在 `"日期"` 之后）：

```python
    "日期": FieldSpec(5, DATE_PROPERTY),
    # Appended, never inserted: the first eight names are the reference table's
    # columns in its own order, and a new column must not shift them.
    "实测过程": FieldSpec(1),
```

`backend/app/lark/write.py`，`execution_fields` 的 `fields` 字典：

```python
        "控制台": attempt.console_text or "",
        # An empty string, not a missing key: the column is required in every
        # table this tool builds, and a run without evidence still owns the cell.
        "实测过程": attempt.evidence or "",
```

- [ ] **Step 4: 修它拉动的四处断言**

`backend/tests/conftest.py:775-779`：

```python
FIXTURE_SCHEMA_FINGERPRINT = (
    "优先级:3|实测过程:1|截图:17|报告人:1|控制台:1|日期:5|用例:1|结果:3|负责人:1"
    "||"
    "优先级:3|反馈人:11|反馈时间:5|备注:1|截图:17|跟进人:11|进展状态:3|问题描述:1"
)
```

`backend/tests/test_lark_target.py:160`（`lark_fake.fields` 少了 `截图`，现在也少 `实测过程`；`REQUIRED` 的字典顺序把它排在最后）：

```python
    assert execution.json()["schema_errors"] == [
        "缺少必填字段「截图」",
        "缺少必填字段「实测过程」",
    ]
```

`backend/tests/test_lark_provision.py:107`：

```python
    assert set(names) == {"结果", "优先级", "负责人", "报告人", "日期", "截图", "控制台", "实测过程"}
```

`backend/tests/test_lark_provision.py:281`：

```python
        "execution": [
            "用例", "结果", "优先级", "负责人", "截图", "控制台", "报告人", "日期", "实测过程",
        ],
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_lark_provision.py tests/test_lark_target.py tests/test_lark_outbox.py`
Expected: PASS

- [ ] **Step 6: 跑整个后端套件**（`REQUIRED` 是全局契约，任何靠 8 列夹具的地方都会在这里现形）

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: 全绿；若还有红点，逐个按"少了一列 `实测过程`"的方向补断言，不要放宽 `REQUIRED`

- [ ] **Step 7: 提交**

```bash
git add backend/app/lark/fields.py backend/app/lark/provision.py backend/app/lark/write.py \
  backend/tests/conftest.py backend/tests/test_lark_target.py \
  backend/tests/test_lark_provision.py backend/tests/test_lark_outbox.py
git commit -m "feat(lark): give the run table a 实测过程 column

Required, appended after 日期 so the reference table's first eight columns
keep their order, and written from attempt.evidence — 控制台 stays the
console dump it has always been."
```

---

## Task 6: 执行 API 接受并回显 `evidence`

**Files:**
- Modify: `backend/app/execution.py:29-42`（`AttemptCreate`）、`:57-77`（`_attempt_payload`）、`:79-97`（`_matching_attempt`）、`:148-154`（`_commit_attempt`）
- Test: `backend/tests/test_execution.py`

**Interfaces:**
- Consumes: `Attempt.evidence`（Task 2）
- Produces: `POST /api/groups/{gid}/cases/{code}/attempts` 与 `POST /api/attempts/{id}/submit` 接受 `evidence: str | None`；attempt 响应体含 `"evidence"`（Task 8 的表单与历史展示读它）

- [ ] **Step 1: 写失败测试** — 在 `backend/tests/test_execution.py` 追加：

```python
def test_submitting_an_attempt_stores_and_returns_the_evidence(
    authenticated_client, imported_group
):
    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/cases/B-001/attempts",
        json={
            "result": "不通过",
            "note": "绑定框未拦截",
            "evidence": "1. 直访业务页未被拦截\n2. .ody-bind 不存在",
            "idempotency_key": "evidence-1",
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["evidence"] == "1. 直访业务页未被拦截\n2. .ody-bind 不存在"


def test_the_same_idempotency_key_with_different_evidence_is_a_conflict(
    authenticated_client, imported_group
):
    url = f"/api/groups/{imported_group.id}/cases/B-001/attempts"
    payload = {
        "result": "通过",
        "evidence": "1. 实测 1.2s",
        "idempotency_key": "evidence-2",
    }
    assert authenticated_client.post(url, json=payload).status_code == 201

    changed = dict(payload, evidence="1. 实测 1.5s")
    assert authenticated_client.post(url, json=changed).status_code == 409
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_execution.py -k evidence`
Expected: FAIL — 响应里没有 `evidence`（`KeyError`）

- [ ] **Step 3: 实现** — `backend/app/execution.py`

`AttemptCreate`：

```python
class AttemptCreate(BaseModel):
    result: Literal["通过", "不通过", "未执行"]
    note: str | None = None
    console_text: str | None = None
    # 实测过程：与 note（失败原因）分开，两者都要有，因为 Lark 里它们落在
    # 不同的列；导入的行把它们一起填。
    evidence: str | None = None
    idempotency_key: str
```

`_attempt_payload`：加 `"evidence": attempt.evidence,`

`_commit_attempt`：加 `attempt.evidence = payload.evidence`

`_matching_attempt` 的幂等比较：加 `or existing.evidence != payload.evidence`（否则同 key 改过程文本会被静默忽略）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_execution.py tests/test_retest.py`
Expected: PASS

- [ ] **Step 5: 跑整个后端套件**

```bash
cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q
```

Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add backend/app/execution.py backend/tests/test_execution.py
git commit -m "feat(execution): carry 实测过程 on the attempt payload

The result form needs a column of its own: note is why it failed, evidence
is what was observed, and Lark keeps them in two different cells."
```

---

## Task 7: 第三份提示词（用例 + 结果）

**Files:**
- Create: `backend/app/prompts/ai-case-results.md`、`docs/AI-CASE-RESULT-PROMPT.md`（**两份内容逐字节相同**）
- Modify: `backend/app/prompts.py:15-30`、`backend/tests/test_ai_prompts.py:16-26`

**Interfaces:**
- Consumes: 12 列契约（Task 1/3）
- Produces: `GET /api/ai-prompts` 的第三条 `id="case-results"`（前端 `AiPromptPanel` 自动多一张卡，无需前端改动）

- [ ] **Step 1: 写失败测试** — 改 `backend/tests/test_ai_prompts.py`：

```python
    assert [prompt["id"] for prompt in prompts] == ["cases", "casebook", "case-results"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_ai_prompts.py`
Expected: FAIL — `['cases', 'casebook'] != ['cases', 'casebook', 'case-results']`

- [ ] **Step 3: 写提示词正文** — 新建 `backend/app/prompts/ai-case-results.md`，全文如下（`docs/AI-CASE-RESULT-PROMPT.md` 必须是它的一份逐字节拷贝）：

````markdown
# AI 转译「已有用例 + 实测结果」· 提示词（TestDeck 可直接导入）

用法：

1. 把下面「第一部分」整段复制给 AI 作为系统提示词，然后：
   - 如果你手上是**一份已经带实测结论的用例文档**（例如一轮冒烟交付），把它整段贴在 `【已有用例】`，`【本轮实测结果】` 留空即可；
   - 如果用例和实测记录是**两份材料**，分别贴进 `【已有用例】` 与 `【本轮实测结果】`。
2. 让 AI 输出的内容存成 `.csv` 文件（UTF-8 编码）。
3. 打开系统的「导入」页上传，预览会告诉你「检出 N 条执行结果」，确认导入时会把它们一起写成执行记录。
4. 只想先导入通过的用例：在提示词末尾加一句「**所有 `不通过` 的用例把 `执行结果` 留空**」——留空的行只建用例，不建执行记录。

本文档是**转译**用的提示词。要让 AI 从需求**生成**用例，用 `AI-CASE-PROMPT.md`；要带设计稿图，用 `AI-CASEBOOK-PROMPT.md`。

---

## 第一部分：提示词（整段复制）

你是一名资深测试工程师。请把我提供的**已有用例**和**本轮实测结果**整理成可以直接导入测试管理系统的测试用例 CSV。

**你的工作是转译，不是重写。** 下面三条是整个任务里最重要的纪律，违反任何一条这份文件都作废：

1. 每一列的原文（编号、标题、前置条件、测试数据、执行步骤、预期结果）**逐字保留**；不得改写、精简、润色、合并、拆分、补全或删减任何一条用例。
2. 我没有给你的用例，**一条都不要编**；我没测过的东西，**一格都不要填**。
3. 结果两列只写我真实给出的观测，不要把「应该没问题」「符合预期」这类判断写进去。

**输出格式（硬性要求）**

1. 只输出 CSV 文本本身。不要任何解释、前言、总结、标题、Markdown 表格，也不要用 ``` 代码块包起来。
2. 第一行必须是下面这个表头，12 列，顺序和文字都不能改，不要增删列：

```
用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程
```

3. 每行一条用例，**原文有多少条就输出多少条**（包括没通过的和没测的，一条都不能少）；文件内 `用例编号` 唯一、`执行顺序` 唯一。
4. `用例编号` 优先沿用原文；原文没有编号时才按 `<模块英文大写>-<三位数字>` 补，例如 `LOGIN-001`，且不得与已有编号冲突。
5. `执行顺序` 按原文的出现顺序从 1 连续递增，不要跳号、不要重复、不要按结果重排。
6. 步骤、预期结果、实测过程有多行时，用**英文双引号包住整个单元格**并在格内换行；单元格里出现逗号、引号、换行都必须加双引号，引号本身写成 `""`。
7. 不要使用 `<br>`、`<div>` 等 HTML 标签；不要用全角逗号 `，` 代替分隔用的半角逗号；不要给单元格加多余空格。

**结果两列怎么填（本提示词的核心）**

| 列 | 怎么填 |
| --- | --- |
| 执行结果 | 只能填 `通过` / `不通过` / `未执行`，或**留空**。原文写 ✅ / Pass / OK / 成功 → `通过`；❌ / Fail / NG / 失败 → `不通过`；未测 / 未执行 / TBD / `-` → `未执行`；我要求先不导入结论的用例 → **留空**。**不要写「阻塞」**：系统不接受这个值，写了整份会被拒绝。 |
| 实测过程 | 把原文里我写下的观测**搬运**过来，一字不改：选择器、实测值、报错原文、口径标签、复现路径。**禁止**写「验证通过」「符合预期」「正常」「功能可用」这类判断词；原文没有观测就留空。 |

- **留空 = 未测**：导入时系统不会为留空的用例建执行记录（只建用例）。所以我让你留空的，就是我不想现在导入结论的那些。
- `执行结果` 填 `不通过` 时，`实测过程` **必须有值**，否则导入端会拒绝这份文件。
- `实测过程` 只放文字：不要放图片、图片链接、base64、附件。
- 原文里混在「预期结果」中的实测插注（例如「实测为 8+8」）**要搬到 `实测过程`**，不要留在预期结果里；预期结果只保留设计稿/PRD 的期望。

**其余列的填写规范**

| 列 | 要求 |
| --- | --- |
| 用例编号 | 逐字保留；原文没有时才按上面的规则补 |
| 执行顺序 | 按原文顺序从 1 连续编号 |
| 用例标题 | 逐字保留；原文只有「测试项」这类短语也照抄，不要扩写、不要加编号 |
| 所属模块 | 用原文的分组标题（如 `前端-国际化/多语言`）；同一模块写法必须完全一致 |
| 优先级 | 原文有就照抄；没有就自行判定：`P0` 主流程或阻塞级、`P1` 重要分支、`P2` 边界/文案/体验项。**逐行必须有值**，不能整列省略 |
| 执行分层 | 只填英文枚举 `Smoke` / `Core` / `Regression`；这一轮是冒烟轮就整列 `Smoke`。**逐行必须有值，且必须是英文枚举**（写「冒烟层」不合格） |
| 前置条件 | 逐字保留；原文没有就留空 |
| 测试数据 | 逐字保留；原文没有就留空 |
| 执行步骤 | 逐字保留；原文一步一行或几步挤在一格都照抄，行首的 `1.` / `1)` 保持原样即可 |
| 预期结果 | 逐字保留（含 `[UI]` / `[接口]` 这类口径标签）；实测内容搬到 `实测过程` |

**输出前自检（逐条核对，不满足就改）**

1. 表头是否与规定完全一致，12 列、顺序未变？
2. 原文的用例条数与输出行数是否一致（不多不少，**包括没通过的**）？
3. 每一列的原文是否**逐字**保留？有没有我背着你优化过的句子、合并过的用例、重排过的顺序？
4. `用例编号` 是否唯一、`执行顺序` 是否 1..N 连续？
5. 单元格里的逗号、引号、换行是否都在双引号内？引号是否写成了 `""`？
6. `执行结果` 是否只用了 `通过` / `不通过` / `未执行` / 空 四种写法（没有 `✅`、`❌`、`阻塞`、`Pass`、`失败`）？
7. 每一行 `不通过` 是否都带 `实测过程`？
8. `优先级`、`执行分层` 两列是否**逐行**都有合法值（不是抽查）？
9. 是否残留 `<br>`、全角逗号、代码块围栏或任何解释性文字？

**输出示例（下面是合法的 3 行文件；实际按我的材料输出全部用例）**

```
用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程
LOGIN-001,1,账号密码登录,登录,P0,Smoke,存在已注册账号,user=qa01 / pass=Test@1234,"1. 打开登录页
2. 输入账号密码
3. 点击登录","1. 页面: 跳转到工作台
2. 接口: 返回登录态 token",通过,"1. 实测页面跳转耗时 1.2s
2. token 已写入 localStorage"
LOGIN-002,2,密码错误登录,登录,P1,Smoke,存在已注册账号,user=qa01 / pass=wrong,"1. 打开登录页
2. 输入错误密码
3. 点击登录","1. 页面: 停留在登录页
2. 提示: 显示「账号或密码错误」",,
LOGIN-003,3,账号为空登录,登录,P2,Core,,user= 留空,"1. 打开登录页
2. 账号留空
3. 点击登录","1. 页面: 停留在登录页
2. 提示: 显示「请输入账号」",不通过,"1. 实测点登录无任何提示
2. 输入框未进入错误态"
```

（第 2 行是「留空、当作未测」的写法；第 3 行是「不通过必须有实测过程」的写法。两种都是合法输入。）

【已有用例】
（在这里粘贴你手上的用例：CSV / Markdown / 表格粘贴都行；如果它已经带实测结论，就贴在这里，并把【本轮实测结果】留空）

【本轮实测结果】
（在这里粘贴单独的执行记录：用例编号 + 结果 + 观测原文；没有就留空）

【需求】
（可选：PRD / 页面说明 / 接口文档，用来帮你判断优先级与分层；不提供也不影响转译）

---

## 第二部分：导入规则速查（人工参考；AI 即使读到也不得放宽第一部分）

> 本节是给人看的补充说明，**不是对第一部分的放宽**。完整规则见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md)。

- 只接受 `.csv` / `.json` / `.md`，UTF-8，单文件 ≤10MB、≤5000 条；导入器层面必填的只有 `用例编号` 与 `用例标题`。
- `优先级` 写成 `P0/P1/P2` 之外的值会静默落成默认 `P2`；`执行分层` 只认 `Smoke`/`Core`/`Regression`。
- `执行结果` 非空的行在确认导入时生成**执行记录**，`实测过程` 落到「实测过程」字段；留空的行只建用例（界面显示未测，Lark 不出现这一行）。
- `执行结果` 只认 `通过`/`不通过`/`未执行`；**「阻塞」不被接受**（系统侧结果枚举里没有它）。
- `执行结果=不通过` 且 `实测过程` 为空 → 整份拒绝并指出用例编号。
- 导入页预览会显示「检出 N 条执行结果（其中 M 条仅有过程、将只留档）」，确认时可取消勾选，改为只建用例。
- 系统记录的日期是**导入时刻**；要保留真实执行日期，请把日期写进 `实测过程` 文本里。
- **顺序**：如果 Lark 执行表还没有「实测过程」列，先在「Lark 检查」页补齐表头并重新确认目标，再导入、再同步。

## 第三部分：黄金样例

下面这份文件已经过真实解析器验证（`parse_file` 读到 3 条用例、2 条结果），可以作为验收参照：

```csv
用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程
LOGIN-001,1,账号密码登录,登录,P0,Smoke,存在已注册账号,user=qa01 / pass=Test@1234,"1. 打开登录页
2. 输入账号密码
3. 点击登录","1. 页面: 跳转到工作台
2. 接口: 返回登录态 token",通过,"1. 实测页面跳转耗时 1.2s
2. token 已写入 localStorage"
LOGIN-002,2,密码错误登录,登录,P1,Smoke,存在已注册账号,user=qa01 / pass=wrong,"1. 打开登录页
2. 输入错误密码
3. 点击登录","1. 页面: 停留在登录页
2. 提示: 显示「账号或密码错误」",,
LOGIN-003,3,账号为空登录,登录,P2,Core,,user= 留空,"1. 打开登录页
2. 账号留空
3. 点击登录","1. 页面: 停留在登录页
2. 提示: 显示「请输入账号」",不通过,"1. 实测点登录无任何提示
2. 输入框未进入错误态"
```

### 常见错误写法（转译型任务的高频坑）

| 写法 | 问题 |
| --- | --- |
| 把原文的用例「优化」了一版（改标题、合并步骤） | 转译任务的失败模式就是这一条：交付物与被测材料对不上，评审无法复核 |
| 只输出通过的用例，把不通过的删掉 | 用例条数对不上原文；要留空就留空，不能删行 |
| `执行结果` 写 `✅` / `❌` / `Pass` / `失败` | 不是枚举值，整份被拒绝 |
| `执行结果` 写「阻塞」 | 系统不支持，整份被拒绝；阻塞原因写进 `实测过程`、结果写 `未执行` 或留空 |
| `实测过程` 写「验证通过」「功能正常」 | 判断词不是观测，复验时没有任何可核对的信息 |
| `不通过` 的行 `实测过程` 留空 | 导入端拒绝；失败必须带观测原文 |
| 把实测插注留在「预期结果」里 | 预期结果是设计稿口径、`实测过程` 是实测口径，混在一起后两列都不可信 |
| `优先级` / `执行分层` 整列留空或写中文分层 | 落成默认值或丢失；必须逐行、英文枚举 |
| 过程文本里塞图片、base64、图片链接 | 导入文件不认图片；图片在「执行结果」里单独上传 |
| 按结果重排用例顺序 | `执行顺序` 必须跟原文一致，重排后与原始交付物无法逐条对账 |
````

- [ ] **Step 4: 造出 docs 侧的那份拷贝并注册** — 两条必须同时满足：文件内容逐字节相同，文件名字段一致

```bash
cd /home/lucascool/qa-board
cp backend/app/prompts/ai-case-results.md docs/AI-CASE-RESULT-PROMPT.md
cmp backend/app/prompts/ai-case-results.md docs/AI-CASE-RESULT-PROMPT.md && echo "IDENTICAL"
```

`backend/app/prompts.py` 的 `PROMPTS` 追加第三条：

```python
    {
        "id": "case-results",
        "title": "已有用例 + 实测结果 → 可导入格式",
        "summary": "把已经跑过一轮的用例连同结果与实测过程一起转译成可导入文件，通过的带结果入库，没结论的留空。",
        "filename": "AI-CASE-RESULT-PROMPT.md",
        "path": PROMPT_DIR / "ai-case-results.md",
    },
```

- [ ] **Step 5: 用真实解析器验证黄金样例** — 把提示词第三部分那段 CSV 存到临时文件并解析：

```bash
cd backend && .venv/bin/python -c "
import re, sys
sys.path.insert(0, '.')
from app.importers.schema import parse_file
text = open('app/prompts/ai-case-results.md', encoding='utf-8').read()
block = re.findall(r'\`\`\`csv\n(.*?)\`\`\`', text, re.DOTALL)[-1]
cases = parse_file('golden.csv', block.encode('utf-8'))
print('PARSED', len(cases))
print([(c.code, c.result, (c.evidence or '')[:12]) for c in cases])
assert len(cases) == 3, len(cases)
assert [c.result for c in cases] == ['通过', None, '不通过']
assert cases[0].evidence.startswith('1. 实测页面跳转耗时 1.2s')
print('GOLDEN OK')
"
```

Expected: `PARSED 3` + `GOLDEN OK`

- [ ] **Step 6: 跑提示词与导入测试**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q tests/test_ai_prompts.py tests/test_importers.py`
Expected: PASS（三条 id、`【需求】` 存在、两份 markdown 逐字节一致）

- [ ] **Step 7: 跑整个后端套件 + 提交**

```bash
cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q
git add backend/app/prompts.py backend/app/prompts/ai-case-results.md \
  docs/AI-CASE-RESULT-PROMPT.md backend/tests/test_ai_prompts.py
git commit -m "docs(prompts): add the transcription prompt for cases plus results

The third card asks the model to transcribe, not rewrite: the failure mode
for this job is a tidied-up case file that no longer matches what was run."
```

---

## Task 8: 前端（导入页摘要 + 勾选框、实测过程输入、历史展示）

**Files:**
- Modify: `frontend/src/api.ts:22-34`（`ImportPreview`）、`:484-489`（`confirm`）、`PreviewCase`/`SubmitPayload`/`Attempt` 类型
- Modify: `frontend/src/views/Import.tsx`（`Props.confirm`、每个文件的 state、预览摘要与勾选框）
- Test: `frontend/src/views/Import.test.tsx`
- Modify: `frontend/src/components/OutcomeForm.tsx`（表单字段）
- Test: `frontend/src/components/OutcomeForm.test.tsx`
- Modify: `frontend/src/components/History.tsx`（`evidence` 展示与 `import` 徽标）
- Test: `frontend/src/components/History.test.tsx`

**Interfaces:**
- Consumes: preview 的 `result_count` / `evidence_only_count`、`cases[].result|evidence`（Task 1）；confirm 的 `import_results`（Task 3）；attempt 的 `evidence`（Task 6）
- Produces: 用户可见的「检出 N 条执行结果」摘要与取消勾选通道

- [ ] **Step 1: 写失败测试** — 三个文件各加一条，用法照它们自己的既有用例：`Import.test.tsx` 是 `render(<ImportView preview={…} confirm={…} onImported={…} />)`，文件输入 `选择用例文件`、组名 `组名`、按钮 `确认导入`；`OutcomeForm.test.tsx` 用现成的 `renderForm()`，接不上时退化成 `render(<OutcomeForm … />)`，按钮 `保存结果`。

**`frontend/src/views/Import.test.tsx`**（记得把 `waitFor` 加进 `@testing-library/react` 的 import）：

```tsx
it("shows the detected results and lets the operator skip them", async () => {
  const previewSpy = vi.fn().mockResolvedValue({
    ticket_id: "ticket",
    detected_format: "csv",
    count: 2,
    cases: [
      { code: "B-001", title: "登录", module: "账户", result: "通过", evidence: "1. 实测 1.2s" },
      { code: "B-002", title: "拦截", module: "账户", result: null, evidence: "留档：本轮未复验" }
    ],
    fields: ["用例编号", "执行结果", "实测过程"],
    errors: [],
    warnings: [],
    result_count: 1,
    evidence_only_count: 1
  });
  const confirmSpy = vi.fn().mockResolvedValue({ id: "g1", count: 2, attempt_count: 1 });
  render(<ImportView preview={previewSpy} confirm={confirmSpy} onImported={vi.fn()} />);

  await userEvent.upload(
    screen.getByLabelText("选择用例文件"),
    new File(["用例编号,执行结果\nB-001,通过"], "outcomes.csv", { type: "text/csv" })
  );

  expect(await screen.findByText(/检出 1 条执行结果/)).toBeTruthy();
  expect(screen.getByText(/其中 1 条仅有过程，将只留档/)).toBeTruthy();

  await userEvent.type(screen.getByLabelText("组名"), "结果导入");
  await userEvent.click(screen.getByLabelText("一并写入执行结果"));
  await userEvent.click(screen.getByRole("button", { name: "确认导入" }));

  await waitFor(() =>
    expect(confirmSpy).toHaveBeenCalledWith("ticket", "结果导入", {}, false)
  );
});
```

**`frontend/src/components/OutcomeForm.test.tsx`**：

```tsx
it("saves the 实测过程 text alongside the console output", async () => {
  const { onSave } = renderForm();

  await userEvent.type(screen.getByLabelText("实测过程"), "1. 实测遮罩 rgba(0,0,0,.65)");
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: "保存结果" }));

  expect(onSave).toHaveBeenCalledWith({
    result: "通过",
    note: null,
    consoleText: null,
    evidence: "1. 实测遮罩 rgba(0,0,0,.65)"
  });
});
```

**`frontend/src/components/History.test.tsx`**（给 `attempt()` 工厂的返回对象补上 `evidence: null`）：

```tsx
it("marks an imported row and shows its evidence", () => {
  render(
    <History
      attempts={[
        { ...attempt("attempt-3", "B-002", "import"), evidence: "1. 实测遮罩 rgba(0,0,0,.65)" }
      ]}
    />
  );

  const row = screen.getByRole("listitem");
  expect(within(row).getByText("来自导入结果")).toHaveClass("attempt-source");
  expect(within(row).getByText(/实测遮罩/)).toBeInTheDocument();
});
```

两个连带契约变更，别落下：

- `OutcomeForm.test.tsx` 里**既有**的 `expect(onSave).toHaveBeenCalledWith({ result, note, consoleText })`（`:74`）会因为 `SaveInput` 多一个键而失败；`SaveInput` 加 `evidence` 的同一处把它补成 `evidence: null`。
- 若 `api.ts` 的 `Attempt["source"]` 是字面量联合而不是 `string`，把 `"import"` 加进去（`History.test.tsx` 的工厂签名是 `Attempt["source"]`，不加 `tsc -b` 会报错）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/Import.test.tsx src/components/OutcomeForm.test.tsx src/components/History.test.tsx`
Expected: FAIL — 找不到「检出 1 条执行结果」，`confirm` 只被调用 3 个参数

- [ ] **Step 3: 改类型与调用** — `frontend/src/api.ts`

```ts
export type ImportPreview = {
  ticket_id: string;
  detected_format: string;
  count: number;
  cases: PreviewCase[];
  fields: string[];
  errors: string[];
  warnings: string[];
  // 结果列不是"随便一列留档"：这两条数字决定导入页要不要给出勾选框。
  result_count?: number;
  evidence_only_count?: number;
  title?: string | null;
  reference_asset_count?: number;
  reference_link_count?: number;
  prototype_version?: string | null;
};
```

`confirm` 加第四个参数（默认 `true`，旧调用点行为不变）：

```ts
  confirm: (
    ticketId: string,
    name: string,
    mapping: Record<string, string>,
    importResults = true
  ) =>
    mutation<{ id: string; count: number; attempt_count: number }>("/api/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket_id: ticketId,
        name,
        mapping,
        import_results: importResults
      })
    }),
```

`PreviewCase` 加 `result: string | null; evidence: string | null;`；`SubmitPayload` 与 `Attempt` 加 `evidence?: string | null;`。

- [ ] **Step 4: 改导入页** — `frontend/src/views/Import.tsx`

- `Props.confirm` 签名同步成四参；
- 每个文件的 state 增 `writeResults: boolean`，预览回来后置为 `(preview.result_count ?? 0) > 0`；
- 预览摘要区（`preview-summary` 内）追加：

```tsx
{(item.preview.result_count ?? 0) > 0 ? (
  <span className="preview-results">
    {` · 检出 ${item.preview.result_count} 条执行结果`}
    {item.preview.evidence_only_count
      ? `（其中 ${item.preview.evidence_only_count} 条仅有过程，将只留档）`
      : ""}
  </span>
) : null}
```

- 摘要下方给勾选框：

```tsx
{(item.preview.result_count ?? 0) > 0 ? (
  <label className="preview-import-results">
    <input
      type="checkbox"
      checked={item.writeResults}
      onChange={(e) => patch(item.key, { writeResults: e.target.checked })}
    />
    一并写入执行结果
  </label>
) : null}
```

- 提交处：`await confirm(item.preview.ticket_id, item.name, item.mapping, item.writeResults);`

- [ ] **Step 5: 改结果表单** — `frontend/src/components/OutcomeForm.tsx`

在「控制台输出」文本域之后加一个同构的文本域（同样的 label + textarea + onChange 结构，不要复用同一个 state）：

```tsx
<label className="field">
  <span>实测过程</span>
  <textarea
    value={form.evidence}
    onChange={(e) => setForm({ ...form, evidence: e.target.value })}
    placeholder="观测原文：选择器、实测值、报错原文"
  />
</label>
```

并把 `evidence` 放进提交的 payload（`console_text` 那里已经有的地方并列加一行）。

- [ ] **Step 6: 改执行历史** — `frontend/src/components/History.tsx`

`source === "reconcile"` 已有徽标分支（`:34`），并列加：

```tsx
{attempt.source === "import" ? <span className="tag">导入</span> : null}
```

并在该行展示 `attempt.evidence`（有值才渲染，样式沿用相邻的 `note` 展示）。

- [ ] **Step 7: 跑测试确认通过 + 类型检查**

Run:
```bash
cd frontend && npx vitest run src/views/Import.test.tsx src/components/OutcomeForm.test.tsx src/components/History.test.tsx
cd frontend && npx tsc -b
```
Expected: 测试 PASS；`tsc -b` **无输出**（vitest 不做类型检查，这一步不能省）

- [ ] **Step 8: 跑全量前端测试 + 提交**

```bash
cd frontend && npx vitest run
git add frontend/src/api.ts frontend/src/views/Import.tsx frontend/src/views/Import.test.tsx \
  frontend/src/components/OutcomeForm.tsx frontend/src/components/OutcomeForm.test.tsx \
  frontend/src/components/History.tsx frontend/src/components/History.test.tsx
git commit -m "feat(web): show the detected results before an import writes them

The count and the checkbox make the one irreversible part of the import
visible: a file that carries conclusions becomes execution records, and
unticking the box keeps the upload cases-only."
```

---

## Task 9: 验收测试落地（两条集成 + 黄金样例回归 + e2e 几何 + 文档一句）

**为什么是这些**：Task 4/5/6/7/8 的评审各留下一条"缺口真实但当时不在授权范围内"的结论，控制者把它们集中到本任务一次落地。
**实施期已修正的两处（本文件里的代码片段已同步）**：①`fake_lark.created_records` 混装执行行与缺陷行，计数须按表分类；②提示词里以 12 列表头开头的围栏有三个，第三个是单行片段，筛选须要求"带数据行"。
**注意**：原计划的"起服务 + 打真 Lark"人工步骤**已改为交付说明里的交接步骤**——往真人 Lark 表里写行是本工作区之外的外部副作用，不由本会话执行。

**Files:**
- Modify: `backend/tests/conftest.py`（抽出 `confirm_group_target` 工厂，`confirmed_group` 改为复用它）
- Modify: `backend/tests/test_lark_outbox.py`（两条集成测试）
- Modify: `backend/tests/test_ai_prompts.py`（黄金样例回归 + 函数重命名）
- Modify: `docs/IMPORT-FORMAT.md`（§2 一句别名规则）
- Modify: `frontend/e2e/import.spec.ts`（preview mock 补两个计数 + 一条几何断言）

**Interfaces:**
- Consumes: `parse_file` / `confirm_import`（`import_results`）/ `enqueue_group_attempts` / `enqueue_attempt_job` / `process_one_job(fake_lark, attempt)` / `fake_lark.created_records` / `Attempt.evidence` / `execution_fields`
- Produces: 提交进仓库的四条验收证据（文件→Lark、手跑→Lark、黄金样例、勾选框几何）+ 一句用户手册规则

- [ ] **Step 1: 先抽 conftest 的目标工厂（避免在测试里复制一段夹具）**

`backend/tests/conftest.py` 现在 `confirmed_group` 里内联构造 `LarkTarget`。抽成工厂，`confirmed_group` 复用它——既有测试就是这次重构的安全网：

```python
@pytest.fixture
def confirm_group_target(db_session):
    """Approve a Lark target for any group, the way the Lark page does."""

    def factory(group_id: UUID) -> Group:
        draft = TargetDraft("app-exec", "tbl-runs", None, "app-bug", "tbl-defects")
        db_session.add(
            LarkTarget(
                group_id=group_id,
                source_url="https://tenant.larksuite.com/wiki/node-1",
                execution_base_token="app-exec",
                execution_base_name="执行库",
                execution_table_id="tbl-runs",
                execution_table_name="执行记录",
                bug_base_token="app-bug",
                bug_base_name="缺陷库",
                bug_table_id="tbl-defects",
                bug_table_name="缺陷记录",
                schema_fingerprint=FIXTURE_SCHEMA_FINGERPRINT,
                target_fingerprint=draft.fingerprint,
                confirmed_at=datetime.now(timezone.utc),
            )
        )
        db_session.commit()
        return db_session.get(Group, group_id)

    return factory


@pytest.fixture
def confirmed_group(db_session, imported_group, confirm_group_target) -> Group:
    return confirm_group_target(imported_group.id)


@pytest.fixture
def outcomes_book() -> str:
    """A three-row text file: two conclusions and one blank row.

    New tests take it from here instead of pasting their own copy; the older
    ``test_groups_api.py`` constant predates it and stays as it is.
    """

    return (
        "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
        'B-001,1,管理员登录,账户,P0,Smoke,,,"1. 打开登录页","1. 页面: 进入工作台",通过,"1. 实测 1.2s"\n'
        "B-002,2,未绑定拦截,账户,P0,Smoke,,,"
        '"1. 直访业务页","1. 页面: 被拦截",,\n'
        'B-003,3,邀请码校验,账户,P1,Smoke,,,"1. 输入邀请码",'
        '"1. 页面: 回显推荐人",不通过,"1. 实测回显 8+8，设计稿 6+6"\n'
    )
```

Run: `cd backend && TEST_DATABASE_URL='…testdeck_test' .venv/bin/python -m pytest -q`
Expected: 与改动前同数全绿（这一步不许有任何测试语义变化）

- [ ] **Step 2: 写失败测试——文件 → Lark（含"留空行不出现"）**

`backend/tests/test_lark_outbox.py` 追加（`fake_lark` 用该文件既有夹具，3 行 CSV 用 Step 1 新加的 `outcomes_book`）：

```python
def test_a_results_file_reaches_lark_and_a_blank_row_does_not(
    authenticated_client, fake_lark, confirm_group_target, outcomes_book, db_session
):
    """The whole chain, once: file → attempts → queue → the run table.

    The blank row is the point of the feature — it must produce no run row at
    all, not a row whose 结果 cell happens to be empty.
    """

    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", outcomes_book.encode("utf-8"), "text/csv")},
    ).json()
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "验收"},
    ).json()
    assert confirm["attempt_count"] == 2

    group_id = confirm["id"]
    confirm_group_target(group_id)
    assert enqueue_group_attempts(db_session, group_id) == 2

    attempts = db_session.scalars(
        select(Attempt).where(Attempt.group_case_id.in_(
            select(GroupCase.id).where(GroupCase.group_id == group_id)
        ))
    ).all()
    for attempt in attempts:
        assert process_one_job(fake_lark, attempt) == "synced"

    written = [record["fields"] for record in fake_lark.created_records]
    # ``created_records`` 混装执行行与缺陷行：不通过的 B-003 在 run_job 里还会
    # 另开一条缺陷行，所以这里按表分类计数，而不是假设容器里只有执行行。
    runs = [field for field in written if "用例" in field]
    assert len(runs) == 2
    assert len(written) == 3
    assert sorted(field["用例"] for field in runs) == ["B-001 管理员登录", "B-003 邀请码校验"]
    assert {field["实测过程"] for field in runs} == {"1. 实测 1.2s", "1. 实测回显 8+8，设计稿 6+6"}
    assert all("B-002" not in field["用例"] for field in runs)
```

- [ ] **Step 3: 跑它确认失败**

Run: 目标文件 -k blank_row
Expected: FAIL — `KeyError: 'confirm_group_target'`（工厂还没被 import）或计数不符

- [ ] **Step 4: 写失败测试——手跑提交 → Lark（Task 6 评审点名的缺口）**

同文件追加：

```python
def test_a_hand_run_reaches_lark_with_the_evidence_it_collected(
    authenticated_client, fake_lark, confirmed_group, db_session
):
    """The other write path: a person ran it and typed what they saw."""

    created = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts",
        json={
            "result": "不通过",
            "note": "绑定框未拦截",
            "evidence": "1. 直访业务页未被拦截",
            "idempotency_key": "hand-run-evidence-1",
        },
    )
    assert created.status_code == 201, created.text

    attempt = db_session.scalar(
        select(Attempt).where(Attempt.idempotency_key == "hand-run-evidence-1")
    )
    assert process_one_job(fake_lark, attempt) == "synced"

    fields = fake_lark.created_records[0]["fields"]
    assert fields["实测过程"] == "1. 直访业务页未被拦截"
    assert fields["结果"] == "不通过"
```

- [ ] **Step 5: 黄金样例回归 + 函数重命名**

`backend/tests/test_ai_prompts.py`：把 `test_prompts_endpoint_serves_both_documents` 重命名为 `..._serves_every_document`，并新增一条——**shipped 提示词里的黄金样例必须永远能过真实解析器**（这是提示词对用户的承诺，此前没有任何测试看住它）：

```python
FENCE = re.compile(r"```(?:csv)?\n(?P<body>.*?)```", re.DOTALL)


def test_every_shipped_sample_in_the_prompt_still_parses():
    """提示词里同一份样例出现两次（「输出示例」与「黄金样例」），两份都要能被解析。

    注意：以 12 列表头开头的围栏有三个——第三个是「第一行必须是这个表头」的
    单行片段，不是样例，所以按"必须带数据行"筛掉它。将来再拆出样例会变 3 而报红。
    """

    from app.importers.schema import parse_file

    prompt = next(entry for entry in PROMPTS if entry["id"] == "case-results")
    blocks = [
        match.group("body")
        for match in FENCE.finditer(prompt["path"].read_text(encoding="utf-8"))
        if match.group("body").lstrip().startswith("用例编号,")
        and len(match.group("body").strip().splitlines()) > 1
    ]
    assert len(blocks) == 2, "提示词里有两份样例，两份都要能被解析"
    for index, block in enumerate(blocks, start=1):
        cases = parse_file(f"sample-{index}.csv", block.encode("utf-8"))
        assert [case.code for case in cases] == ["LOGIN-001", "LOGIN-002", "LOGIN-003"]
        assert [case.result for case in cases] == ["通过", None, "不通过"]
```

- [ ] **Step 6: `docs/IMPORT-FORMAT.md` §2 补一句（同名字段不可同时给）**

在字段字典表下方加：

```markdown
同一个字段的多个别名**不要同时出现**（例如 `执行结果` 与 `本轮实测结果` 同时存在）：导入端会判为字段歧义并拒绝整份文件。只保留一列即可。
```

- [ ] **Step 7: `frontend/e2e/import.spec.ts` 补几何断言**

两处：①该文件顶部的 preview mock 要在 `count` 旁加上 `result_count: 2, evidence_only_count: 1`（否则摘要与勾选框在 e2e 里根本不渲染，新 UI 等于零覆盖）；②在既有的 per-viewport 溢出断言旁加一条：

```ts
const checkbox = page.getByLabel("一并写入执行结果");
const box = await checkbox.boundingBox();
expect(box!.height).toBeLessThanOrEqual(24); // 全局 input 规则会把它撑成 42px 满宽方块
expect(await page.getByText(/检出 2 条执行结果/).isVisible()).toBe(true);
```

Run: `cd frontend && npm run e2e -- import.spec.ts`
Expected: PASS（**注意：CI 不跑 e2e**，这是发版前手跑的门，交付说明里要写明）

- [ ] **Step 8: 跑全部套件并提交**

```bash
cd backend && TEST_DATABASE_URL='…testdeck_test' .venv/bin/python -m pytest -q    # 基线 540 + 新增
cd frontend && npx vitest run && npx tsc -b                                        # 基线 343，tsc 零输出
git add backend/tests/conftest.py backend/tests/test_lark_outbox.py \
  backend/tests/test_ai_prompts.py docs/IMPORT-FORMAT.md frontend/e2e/import.spec.ts
git commit -m "test: pin the two paths into Lark, the shipped sample and the checkbox
Adds the acceptance evidence the per-task reviews left owed: a file with
results reaching the run table (and a blank row reaching nothing), a hand-run
row carrying the evidence it collected, the shipped prompt's golden sample
parsed by the real importer, and the checkbox geometry that jsdom cannot see."
```

---

## Task 10: 交付与发版记录（只改文档）

**Files:**
- Modify: `docs/HANDOFF-RELEASE.md`（文末新增一节，照 §16/§25 的体例）

- [ ] **Step 1: 写这一节，必须包含六件事**

1. **新增能力**：12 列导入契约（`执行结果` / `实测过程`）、导入页的「检出 N 条执行结果」与勾选框、结果表单的「实测过程」、执行历史的「来自导入结果」、Lark 执行表新增必填列「实测过程」、第三份提示词 `AI-CASE-RESULT-PROMPT.md`。
2. **上线顺序（硬要求）**：先在 Lark 检查页补齐「实测过程」列 → 重新确认目标 → 再导入 → 再同步。顺序颠倒会让已入队的行因目标指纹变化全部 park（spec §6）。
3. **老 target 的影响**：`实测过程` 进 REQUIRED 后，任何未补齐该列的已确认目标都会报"缺列"并拒绝建行，直到 provision 完成。这是有意破窗。
4. **真实的 0918 使用步骤**：导入 50 条（41 条带结果、9 条留空）→ 同步 → 执行表出现 41 行；之后每复验一条，在 qa-board 提交结果并传图，截图随行写进 Lark 附件列。
5. **测试保护的真实边界**：backend 套件与前端 vitest 都有覆盖；**e2e 不在 CI 里**（`npm run e2e` 手跑）；几何断言属于 e2e。别把"有测试"说成"自动门"。
6. **已知未决（本分支不修）**：`ai-cases.md:117` 那句「分层丢失」与它自己 `:41` 矛盾（既有缺陷）；双别名报错是英文；`reconcile.py:427` 删除路径零覆盖；`downgrade()` 全局零覆盖；`match_bugs` 读回问题会因本功能批量产生缺陷行而更容易被撞上（另一个计划的范围）。

- [ ] **Step 2: 提交**

```bash
git add docs/HANDOFF-RELEASE.md
git commit -m "docs(release): record the case+result import, its prompt and the column order"
```
