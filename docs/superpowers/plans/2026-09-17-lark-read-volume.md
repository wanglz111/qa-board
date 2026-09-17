# Lark 读请求瘦身 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「打开一个用例」的 Lark 请求从实测 9 次降到 2 次，把一轮 20 个用例的请求量从约 180 次降到个位数，并让旧表截图不再每次回源。

**Architecture:** 四件事从下往上叠：(1) 进程内复用同一个 `LarkClient`（token 复用 + 连接复用）；(2) `read_draft_state` 对同一个 base 只读一次，历史面板不再为「表名」去读 fields；(3) 新增 `app/lark/cache.py` 做表记录快照的 TTL 缓存，由本进程的写入口主动失效，并在同步队列排空时失效一次；(4) 旧表附件按 `file_token` 落盘缓存，响应头允许浏览器私有缓存。

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy / httpx（`MockTransport` 测试替身）/ pytest。本计划不改前端。

**Baseline（2026-09-17 实测，线上真实表）:** 打开一个用例 = `GET /apps/{base}`×2 + `GET /apps/{base}/tables`×2 + `{执行表}/fields` + `{缺陷表}/fields` + `{执行表}/records` + `{缺陷表}/records` + token 交换 = **9 次**。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `backend/app/lark/client.py`（改） | 复用同一个 client；token 到期前续期；调用日志有界 |
| `backend/app/lark/target.py`（改） | `read_draft_state`：同一个 base 只读一次 |
| `backend/app/lark/names.py`（新建） | 只读表名/库名的轻量读取，给历史面板用，不读 fields |
| `backend/app/lark/cache.py`（新建） | 表记录快照的 TTL 缓存与失效 |
| `backend/app/lark/attachments.py`（新建） | 附件字节落盘缓存 |
| `backend/app/lark/history.py`（改） | 历史面板走轻量读取 + 快照；附件走落盘缓存 |
| `backend/app/lark/reconcile.py`（改） | live 读取走同一份快照 |
| `backend/app/execution.py`（改） | 提交/预留/提交复测后失效快照 |
| 复测与 `/sync` 路由所在文件（改） | 写入口与「队列排空」时失效快照 |
| `backend/tests/test_lark_client.py`（新建） | client 复用与 token 续期单测 |
| `backend/tests/test_lark_cache.py`（新建） | 快照的命中/过期/失效单测 |
| `backend/tests/test_lark_history.py`（改） | 请求清单断言 |
| `backend/tests/conftest.py`（改） | 每个测试前清空共享 client 与快照 |

---

### Task 1: 复用同一个 LarkClient

`get_lark_client()` 现在每次都 `build_lark_client()`，于是每个 HTTP 请求都要换一次 tenant token、新建一个 httpx 连接池。这个任务让它返回进程内唯一的 client，并让 token 在快到期时才重取。

**Files:**
- Modify: `backend/app/lark/client.py`
- Test: `backend/tests/test_lark_client.py`（新建）

- [ ] **Step 1: 写失败的测试**

新建 `backend/tests/test_lark_client.py`：

```python
from dataclasses import replace

import app.lark.client as lark_client_module
from app.config import settings


def _configured():
    return replace(
        settings,
        lark_base_url="https://open.feishu.test",
        lark_app_id="test-app-id",
        lark_app_secret="test-app-secret",
    )


def test_get_lark_client_hands_out_one_client_for_the_process(monkeypatch):
    monkeypatch.setattr(lark_client_module, "global_settings", _configured())
    lark_client_module.reset_shared_client()
    try:
        assert lark_client_module.get_lark_client() is lark_client_module.get_lark_client()
    finally:
        lark_client_module.reset_shared_client()


def test_reset_shared_client_builds_a_new_one(monkeypatch):
    monkeypatch.setattr(lark_client_module, "global_settings", _configured())
    lark_client_module.reset_shared_client()
    try:
        first = lark_client_module.get_lark_client()
        lark_client_module.reset_shared_client()
        assert lark_client_module.get_lark_client() is not first
    finally:
        lark_client_module.reset_shared_client()


def test_the_token_is_exchanged_once_and_renewed_only_when_it_lapses(lark_fake):
    client = lark_fake.client
    token_path = "/open-apis/auth/v3/tenant_access_token/internal"
    lark_fake.requests.clear()

    client.list_tables("app-exec")
    client.list_fields("app-exec", "tbl-runs")

    assert [r for r in lark_fake.requests if r["path"] == token_path] == [
        {"method": "POST", "path": token_path}
    ]

    # The double never sends ``expire``, so the client falls back to the
    # documented two hours. Put the deadline in the past: the next calls renew
    # exactly once instead of once per request.
    client._token_expires_at = 0.0
    client.list_tables("app-exec")
    client.list_fields("app-exec", "tbl-runs")

    assert len([r for r in lark_fake.requests if r["path"] == token_path]) == 2
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_client.py -q`
Expected: FAIL — `module 'app.lark.client' has no attribute 'reset_shared_client'`；第三个测试还会因为 token 每次重取而失败。

- [ ] **Step 3: 实现**

`backend/app/lark/client.py` 顶部 imports 换成：

```python
from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import Settings, settings as global_settings
```

常量区（`PAGE_SIZE = 500` 之后）补上：

```python
# A tenant token is good for two hours. Renew inside the margin so a long-
# running worker never races the expiry, and fall back to the documented two
# hours when Lark omits ``expire``.
TOKEN_EXPIRY_MARGIN_SECONDS = 300
DEFAULT_TOKEN_TTL_SECONDS = 7200
# The process keeps one client for its whole life, so the call log has to be
# bounded; the audit only ever reads the tail.
CALL_LOG_LIMIT = 1000
```

`get_lark_client` 换成：

```python
_shared_client: LarkClient | None = None
_shared_lock = threading.Lock()


def get_lark_client() -> LarkClient:
    """The process's one client, so a token and a connection pool are reused.

    Reading a group costs several calls in a row, and every one of them used to
    open a connection and exchange a fresh tenant token. One client per process
    removes both; ``_token_value`` renews the token when it lapses.
    """

    global _shared_client
    if _shared_client is None:
        with _shared_lock:
            if _shared_client is None:
                _shared_client = build_lark_client()
    return _shared_client


def reset_shared_client() -> None:
    """Drop the process client. Tests use it; no runtime path should need to."""

    global _shared_client
    with _shared_lock:
        if _shared_client is not None:
            _shared_client.close()
        _shared_client = None
```

`LarkClient.__init__` 里的 `self.calls` 与 token 两行换成：

```python
        self.calls: deque[LarkCall] = deque(maxlen=CALL_LOG_LIMIT)
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = threading.Lock()
```

`_token_value` 换成：

```python
    def _token_value(self) -> str:
        if not self.app_id or not self.app_secret:
            raise LarkError("Lark credentials are not configured")
        if self._token is not None and time.monotonic() < self._token_expires_at:
            return self._token
        with self._token_lock:
            # Another thread may have renewed it while this one waited.
            if self._token is not None and time.monotonic() < self._token_expires_at:
                return self._token
            payload = self._send(
                "POST",
                TOKEN_PATH,
                json={"app_id": self.app_id, "app_secret": self.app_secret},
                authenticated=False,
            )
            token = payload.get("tenant_access_token")
            if not token:
                raise LarkError("Lark token exchange returned no token")
            try:
                ttl = int(payload.get("expire") or DEFAULT_TOKEN_TTL_SECONDS)
            except (TypeError, ValueError):
                ttl = DEFAULT_TOKEN_TTL_SECONDS
            self._token = str(token)
            self._token_expires_at = time.monotonic() + max(
                ttl - TOKEN_EXPIRY_MARGIN_SECONDS, 60
            )
            return self._token
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_client.py -q`
Expected: PASS（3 passed）

- [ ] **Step 5: 跑全套确认没有回归**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: PASS（以 347 passed 为基线）

- [ ] **Step 6: 提交**

```bash
git add backend/app/lark/client.py backend/tests/test_lark_client.py
git commit -m "perf(lark): reuse one client and renew the token instead of re-buying it"
```

---

### Task 2: `read_draft_state` 同一个 base 只读一次

两个角色通常落在同一个 base，现在 `app_metadata` 与 `list_tables` 各调两次、结果完全相同。

**Files:**
- Modify: `backend/app/lark/target.py`（`read_draft_state`）
- Test: `backend/tests/test_lark_target.py`（追加）

- [ ] **Step 1: 写失败的测试**

在 `backend/tests/test_lark_target.py` 末尾追加：

```python
def test_reading_a_target_in_one_base_reads_that_base_once(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    """Both roles in one base: the base metadata and its table list are read once."""

    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == confirmed_group.id)
    )
    # ``confirmed_group`` deliberately puts the two roles in different bases
    # (app-exec / app-bug), and reading two different bases once each is already
    # what the code does. This case is the one worth pinning: one operator who
    # points both roles at the same base.
    target.bug_base_token = "app-exec"
    target.bug_base_name = "执行库"
    target.bug_table_id = "tbl-bugs"
    target.bug_table_name = "缺陷记录"
    db_session.commit()
    lark_fake.requests.clear()

    response = authenticated_client.get(f"/api/groups/{confirmed_group.id}/lark/target")

    assert response.status_code == 200, response.text
    paths = [request["path"] for request in lark_fake.requests]
    assert paths.count("/open-apis/bitable/v1/apps/app-exec") == 1
    assert paths.count("/open-apis/bitable/v1/apps/app-exec/tables") == 1
```

> 这个测试只有在**同一个 base** 时才有区分力：`bases` 里 `app-exec` 与 `app-bug` 是两个库，所以上面先把缺陷角色搬进 `app-exec`（`(app-exec, tbl-bugs)` 在该 fixture 的 `field_roles` 里已登记为 bug 角色）。改之前先跑一遍确认它**现在会失败**（计数是 2），否则说明测试没测到东西。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest "tests/test_lark_target.py::test_reading_a_target_in_one_base_reads_that_base_once" -q`
Expected: FAIL — 计数为 2。

- [ ] **Step 3: 实现**

`backend/app/lark/target.py` 的 `read_draft_state` 开头：

```python
def read_draft_state(client: LarkClient, draft: TargetDraft) -> dict[str, Any]:
    """Read both tables' live names and fields; never returns credentials."""

    # Both roles usually live in one base, and reading it twice is two identical
    # round trips. Each distinct base is read once and the second role reuses it.
    base_reads: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}

    def _base(token: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        if token not in base_reads:
            base_reads[token] = (client.app_metadata(token), client.list_tables(token))
        return base_reads[token]

    execution_base, execution_tables = _base(draft.execution_base_token)
    bug_base, bug_tables = _base(draft.bug_base_token)
    execution_fields = client.list_fields(
        draft.execution_base_token, draft.execution_table_id
    )
    bug_fields = client.list_fields(draft.bug_base_token, draft.bug_table_id)
```

（其余行，从 `execution_table_name = _table_name(...)` 到函数结尾，保持不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_target.py -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/app/lark/target.py backend/tests/test_lark_target.py
git commit -m "perf(lark): read one base once when both roles live in it"
```

---

### Task 3: 历史面板不再为「表名」读 fields

`case_lark_history` 为了拿两个表名去读两个表的 fields，然后才读 records。把「只要名字」拆成独立函数。

**Files:**
- Create: `backend/app/lark/names.py`（含两边共用的 `read_bases` helper）
- Modify: `backend/app/lark/target.py`（把 Task 2 的私有 base 记忆换成共用 helper）
- Modify: `backend/app/lark/history.py`（`case_lark_history`）
- Test: `backend/tests/test_lark_history.py`（追加）

- [ ] **Step 1: 写失败的测试**

在 `backend/tests/test_lark_history.py` 末尾追加：

```python
def test_opening_one_case_reads_each_table_once_and_no_fields(
    authenticated_client, lark_fake, confirmed_group
):
    """The read the page repeats most: two record reads and nothing else."""

    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    lark_fake.requests.clear()

    response = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )

    assert response.status_code == 200, response.text
    paths = [
        request["path"] for request in lark_fake.requests if request["method"] == "GET"
    ]
    assert [path for path in paths if path.endswith("/fields")] == []
    assert [path for path in paths if path.endswith("/records")] == [
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/records",
        "/open-apis/bitable/v1/apps/app-bug/tables/tbl-defects/records",
    ]
    body = response.json()
    assert body["source_table_name"] == "执行记录"
    assert body["bug_table_name"] == "缺陷记录"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest "tests/test_lark_history.py::test_opening_one_case_reads_each_table_once_and_no_fields" -q`
Expected: FAIL — GET 清单里出现两条 `/fields`。

- [ ] **Step 3: 实现**

新建 `backend/app/lark/names.py`。**注意**：Task 2 已经在 `target.py` 里写了一份私有的
base 记忆（`base_reads` + `_base`），而这里需要的是**同样两次调用**。所以 helper 放在本模块里由两边共用，
而不是复制第二份——评审明确指出两份私有副本会各自漂移：

```python
"""Table and base names without paying for the schema.

The execution page asks for the same group's table names on every case it
opens. Reading the fields to answer that is a round trip per table that nothing
on the page uses, so names are read on their own.

The base memo lives here as well: ``read_draft_state`` needs exactly the same
two calls per base, and one copy beats two that can drift apart.
"""

from __future__ import annotations

from typing import Any

from app.lark.client import LarkClient, LarkError


def read_bases(
    client: LarkClient, tokens: list[str]
) -> dict[str, tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Each distinct base's metadata and table listing, read once per call."""

    reads: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}
    for token in tokens:
        if token not in reads:
            reads[token] = (client.app_metadata(token), client.list_tables(token))
    return reads


def table_name(tables: list[dict[str, Any]], table_id: str) -> str | None:
    for table in tables:
        if str(table.get("table_id") or "") == table_id:
            name = table.get("name")
            return str(name) if name else None
    return None


def read_target_names(client: LarkClient, target: Any) -> dict[str, Any]:
    """The live names of a target's two tables, never its schema."""

    try:
        reads = read_bases(client, [target.execution_base_token, target.bug_base_token])
    except LarkError as error:
        return {
            "execution_base_name": None,
            "execution_table_name": None,
            "bug_base_name": None,
            "bug_table_name": None,
            "read_errors": [str(error)],
        }

    execution_base, execution_tables = reads[target.execution_base_token]
    bug_base, bug_tables = reads[target.bug_base_token]

    def _base_name(metadata: dict[str, Any]) -> str:
        return str((metadata.get("app") or {}).get("name") or "")

    execution_base_name = _base_name(execution_base)
    bug_base_name = _base_name(bug_base)
    execution_table_name = table_name(execution_tables, target.execution_table_id)
    bug_table_name = table_name(bug_tables, target.bug_table_id)
    read_errors: list[str] = []
    if execution_table_name is None:
        read_errors.append(f"Lark 中找不到执行记录表 {target.execution_table_id}")
    if bug_table_name is None:
        read_errors.append(f"Lark 中找不到缺陷表 {target.bug_table_id}")
    return {
        "execution_base_name": execution_base_name,
        "execution_table_name": execution_table_name,
        "bug_base_name": bug_base_name,
        "bug_table_name": bug_table_name,
        "read_errors": read_errors,
    }
```

同一个任务里把 Task 2 那份私有实现换成共用 helper——`target.py` 的 `read_draft_state` 开头改成：

```python
    reads = read_bases(client, [draft.execution_base_token, draft.bug_base_token])
    execution_base, execution_tables = reads[draft.execution_base_token]
    bug_base, bug_tables = reads[draft.bug_base_token]
    execution_fields = client.list_fields(
        draft.execution_base_token, draft.execution_table_id
    )
    bug_fields = client.list_fields(draft.bug_base_token, draft.bug_table_id)
```

并把 `target.py` 顶部已有的 `_table_name` 用法保持原样（它是另一个函数），只删掉刚加进去的 `base_reads` /
`_base` 局部实现与 `from app.lark.names import read_bases` 的 import。改完 `tests/test_lark_target.py::test_reading_a_target_in_one_base_reads_that_base_once`
必须仍然通过（这正是它存在的意义），否则说明 helper 的语义变了。

`backend/app/lark/history.py` 里 `case_lark_history` 的这一段：

```python
    state = read_target_state(client, target)
    if state["read_errors"]:
        return _unavailable_history(code, state["read_errors"], "Lark 目标表不可读")
```

换成：

```python
    state = read_target_names(client, target)
    if state["read_errors"]:
        return _unavailable_history(code, state["read_errors"], "Lark 目标表不可读")
```

并在 `history.py` 顶部加 `from app.lark.names import read_target_names`。
然后把 `history.py` 自己那份 `read_target_state` 包装函数删掉：这一步之后没有任何调用方了
（`GET /lark/target`、保存路径与 provision 用的是 `target.py` 的 `read_draft_state`——那是**另一个**
函数，仍然需要 fields 来算 `schema_errors` 与指纹，不能删）。顺手清掉 `history.py` 因此不再用到的
import（`read_draft_state`、`TargetDraft`），并确认没有测试引用被删的函数。

> 第一版计划在这里写的是「保留 `read_target_state`」，那是把两个同名概念看混了：真正服务
> `GET /lark/target` 的是 `target.read_draft_state`。实现者按字面保留了它，评审与控制器一起确认它已成死代码。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_history.py -q`
Expected: PASS

- [ ] **Step 5: 更新会被这次改动打破的既有测试**

`tests/test_lark_history.py::test_case_history_endpoint_reports_a_target_that_cannot_be_read` 现在靠
`lark_fake.fields_error = True` 制造「目标表读不了」。新的历史路径不读 fields，所以这个开关不再能触发它——
这不是回归，但测试必须改成让**表名读取**失败，否则它会静静地失去意义。

先在 `backend/tests/conftest.py` 的 `FakeLark.__init__` 里（`self.fields_error = False` 附近）加一个开关：

```python
        # A base the app cannot read at all: metadata and the table listing
        # both refuse, which is what an unreadable target looks like.
        self.bases_error = False
```

在 `handle` 里记录完请求之后（`self.requests.append(...)` 的下一行）加：

```python
        if self.bases_error and "/apps/" in path and "/tables/" not in path:
            return httpx.Response(500, json={"code": 1, "msg": "base unavailable"})
```

然后把那条测试的 `lark_fake.fields_error = True` 换成 `lark_fake.bases_error = True`，
其余断言（`available is False`、`read_errors` 非空、没有读 records）保持不变——它们描述的正是这次要保住的契约。

- [ ] **Step 6: 跑全套**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: PASS。若某个旧测试断言了历史面板的完整请求清单，按新清单更新**断言**，不要为了迁就旧断言把 fields 读加回去。

- [ ] **Step 7: 提交**

```bash
git add backend/app/lark/names.py backend/app/lark/history.py backend/tests/test_lark_history.py backend/tests/conftest.py
git commit -m "perf(lark): read a case's table names without reading the schema"
```

---

### Task 4: 表记录快照的 TTL 缓存

一轮执行会反复读同一张表。加一个 60 秒快照，把一段时间里的重复读合并成一次。

**Files:**
- Create: `backend/app/lark/cache.py`
- Test: `backend/tests/test_lark_cache.py`（新建）
- Modify: `backend/tests/conftest.py`（autouse 清理）

- [ ] **Step 1: 写失败的测试**

新建 `backend/tests/test_lark_cache.py`：

```python
import app.lark.cache as lark_cache


def test_a_second_read_inside_the_ttl_does_not_call_lark_again():
    lark_cache.clear()
    calls = []

    def fetch():
        calls.append(1)
        return [{"record_id": "r1"}]

    first = lark_cache.read_records("app-exec", "tbl-runs", fetch)
    second = lark_cache.read_records("app-exec", "tbl-runs", fetch)

    assert first == second == [{"record_id": "r1"}]
    assert len(calls) == 1


def test_an_expired_snapshot_is_read_again(monkeypatch):
    lark_cache.clear()
    clock = {"now": 1000.0}
    monkeypatch.setattr(lark_cache.time, "monotonic", lambda: clock["now"])
    calls = []

    def fetch():
        calls.append(1)
        return []

    lark_cache.read_records("app-exec", "tbl-runs", fetch)
    clock["now"] += lark_cache.DEFAULT_TTL_SECONDS + 1
    lark_cache.read_records("app-exec", "tbl-runs", fetch)

    assert len(calls) == 2


def test_invalidate_drops_only_that_table():
    lark_cache.clear()
    calls = []

    def fetch_for(table):
        def fetch():
            calls.append(table)
            return []

        return fetch

    lark_cache.read_records("app-exec", "tbl-runs", fetch_for("runs"))
    lark_cache.read_records("app-exec", "tbl-defects", fetch_for("defects"))
    lark_cache.invalidate("app-exec", "tbl-runs")
    lark_cache.read_records("app-exec", "tbl-runs", fetch_for("runs"))
    lark_cache.read_records("app-exec", "tbl-defects", fetch_for("defects"))

    assert calls == ["runs", "defects", "runs"]


def test_the_cached_list_is_not_handed_out_for_mutation():
    lark_cache.clear()
    stored = [{"record_id": "r1"}]
    lark_cache.read_records("app-exec", "tbl-runs", lambda: stored)

    got = lark_cache.read_records("app-exec", "tbl-runs", lambda: [])
    got.append({"record_id": "injected"})

    assert lark_cache.read_records("app-exec", "tbl-runs", lambda: []) == stored
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_cache.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.lark.cache'`

- [ ] **Step 3: 实现**

新建 `backend/app/lark/cache.py`：

```python
"""A short-lived snapshot of one Lark table's records.

The execution page re-reads a group's whole run table every time a case is
opened. One operator works through a group in a single sitting, so a snapshot
that lives for a minute answers every case in that sitting without asking Lark
again.

Two things keep the snapshot honest. This process drops it when it writes
(``POST /attempts`` and its siblings), and the sync queue emptying drops it too
— the worker runs in another container, so that is the one moment this process
learns that a row it queued has landed.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

# Long enough to cover a sitting, short enough that a missed invalidation heals
# by itself.
DEFAULT_TTL_SECONDS = 60.0

_lock = threading.Lock()
_entries: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}


def read_records(
    base_token: str,
    table_id: str,
    fetch: Callable[[], list[dict[str, Any]]],
    *,
    ttl: float | None = None,
) -> list[dict[str, Any]]:
    """The table's records, from the snapshot while it is still fresh."""

    key = (base_token, table_id)
    with _lock:
        entry = _entries.get(key)
        if entry is not None and time.monotonic() < entry[0]:
            # A reader must not be able to edit the snapshot through the list it
            # was handed, so every reader gets its own container.
            return list(entry[1])
    records = fetch()
    with _lock:
        _entries[key] = (
            time.monotonic() + (DEFAULT_TTL_SECONDS if ttl is None else ttl),
            list(records),
        )
    return list(records)


def invalidate(base_token: str, table_id: str) -> None:
    with _lock:
        _entries.pop((base_token, table_id), None)


def invalidate_target(target: Any) -> None:
    """Drop both roles of one group's target."""

    invalidate(target.execution_base_token, target.execution_table_id)
    invalidate(target.bug_base_token, target.bug_table_id)


def clear() -> None:
    with _lock:
        _entries.clear()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_cache.py -q`
Expected: PASS（4 passed）

- [ ] **Step 5: 让测试之间互不污染**

在 `backend/tests/conftest.py` 的 `lark_fake` fixture 之前加：

```python
@pytest.fixture(autouse=True)
def clean_lark_state():
    """No snapshot or shared client survives from one test into the next."""

    import app.lark.cache as lark_cache
    import app.lark.client as lark_client_module

    lark_cache.clear()
    lark_client_module.reset_shared_client()
    yield
    lark_cache.clear()
    lark_client_module.reset_shared_client()
```

- [ ] **Step 6: 提交**

```bash
git add backend/app/lark/cache.py backend/tests/test_lark_cache.py backend/tests/conftest.py
git commit -m "feat(lark): snapshot a table's records for a minute instead of re-reading it"
```

---

### Task 5: 把快照接进读路径，并在写入口失效

历史面板与对账的 live 读取走快照；本进程的写入口（提交结果、预留/提交复测、对账采纳、表头与目标变更）以及「同步队列排空」都失效快照。**没有失效的缓存就是「刚写完看不到自己那条」的复现**，这一步不能省。

**Files:**
- Modify: `backend/app/lark/history.py`、`backend/app/lark/reconcile.py`、`backend/app/execution.py`
- Modify: 复测路由与 `/groups/{id}/sync` 所在文件
- Test: `backend/tests/test_lark_history.py`（追加）

- [ ] **Step 1: 写失败的测试**

在 `backend/tests/test_lark_history.py` 末尾追加：

```python
def test_two_cases_in_a_row_share_one_table_read(
    authenticated_client, lark_fake, confirmed_group
):
    """Working through a group re-reads the same table; the snapshot answers."""

    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}},
        {"record_id": "old2", "fields": {"用例": "B-002 Login", "结果": "通过"}},
    ]
    lark_fake.requests.clear()

    for code in ("B-001", "B-002"):
        response = authenticated_client.get(
            f"/api/groups/{confirmed_group.id}/cases/{code}/lark-history"
        )
        assert response.status_code == 200, response.text

    record_reads = [
        request["path"]
        for request in lark_fake.requests
        if "/records" in request["path"]
    ]
    assert (
        record_reads.count("/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/records")
        == 1
    )


def test_submitting_a_result_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group
):
    """The row this operator just wrote has to be visible on the next read."""

    lark_fake.records = []
    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    lark_fake.records = [
        {"record_id": "mine", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]

    submitted = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts",
        json={
            "result": "不通过",
            "note": "登录按钮没反应",
            "console_text": "",
            "idempotency_key": "key-snapshot-1",
        },
    )
    assert submitted.status_code == 201, submitted.text

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in body["original"]] == ["mine"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_history.py -q`
Expected: 两个新测试 FAIL（还没接快照；第二个读到的是旧快照）。

- [ ] **Step 3: 实现**

`backend/app/lark/history.py` 顶部加 `from app.lark import cache as lark_cache`，并把两次读取换成：

```python
    records = lark_cache.read_records(
        target.execution_base_token,
        target.execution_table_id,
        lambda: client.list_records(
            target.execution_base_token, target.execution_table_id
        ),
    )
```

```python
    bugs = match_bugs(
        lark_cache.read_records(
            target.bug_base_token,
            target.bug_table_id,
            lambda: client.list_records(target.bug_base_token, target.bug_table_id),
        ),
        code,
    )
```

`backend/app/lark/reconcile.py`：live 分支里的 `client.list_records(...)` 同样包一层
`lark_cache.read_records(...)`，并加同一个 import。

`backend/app/execution.py` 加一个 helper（放在 `_attempt_payload` 附近）：

```python
def _drop_lark_snapshot(db: Session, group_id: UUID) -> None:
    """Our own write makes this process's cached view of the tables stale."""

    from app.lark import cache as lark_cache
    from app.lark.target import target_for

    target = target_for(db, group_id)
    if target is not None:
        lark_cache.invalidate_target(target)
```

然后在这些地方各加一行 `_drop_lark_snapshot(db, group_id)`，都放在 `db.commit()` 之后：

1. `create_attempt`（`POST /groups/{group_id}/cases/{code}/attempts`）的 `operation()`。
2. `reserve`（`.../retest`）的 `operation()`。
3. `submit_attempt`（`POST /attempts/{attempt_id}/submit`）：它只有 `attempt_id`，用
   `attempt.group_case.group_id` 作 group id。

对账采纳（`POST .../reconcile/apply`）与表头/目标变更（`provision*`、`target confirm/save`）
同样在提交后失效：这些改动会换表或换列，留着快照一定是错的。

`GET /groups/{group_id}/sync`：在算出计数、返回之前加

```python
    if queued == 0:
        # Nothing is queued, so whatever the page cached before the worker ran
        # is now known to be out of date. The page re-reads the panel right after
        # this call, which is exactly when a stale snapshot would show up.
        target = target_for(db, group_id)
        if target is not None:
            lark_cache.invalidate_target(target)
```

（`queued` 用该函数里已有的排队计数变量名。）

- [ ] **Step 4: 跑相关测试**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_history.py tests/test_lark_reconcile.py tests/test_execution.py tests/test_lark_target.py -q`
Expected: PASS

- [ ] **Step 5: 跑全套**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: PASS。断言「读了几次 records」的旧测试会因命中快照而变少，更新断言并注明它依赖快照。

- [ ] **Step 6: 提交**

```bash
git add backend/app/lark/history.py backend/app/lark/reconcile.py backend/app/execution.py
git commit -m "perf(lark): serve repeat reads from the snapshot and drop it on our own writes"
```

---

### Task 6: 旧表附件落盘缓存

`legacy_attachment` 每次都从 Lark 下载，还带 `Cache-Control: private, no-store`，来回切用例就反复拉同一张图。

**Files:**
- Create: `backend/app/lark/attachments.py`
- Modify: `backend/app/lark/history.py`（`legacy_attachment`）
- Test: `backend/tests/test_lark_history.py`（追加）

- [ ] **Step 1: 写失败的测试**

在 `backend/tests/test_lark_history.py` 末尾追加：

```python
def test_the_same_legacy_attachment_is_downloaded_once(
    authenticated_client, lark_fake, confirmed_group
):
    lark_fake.media["file-old"] = (b"\x89PNG\r\n\x1a\n", "image/png")
    lark_fake.records = [
        {
            "record_id": "old1",
            "fields": {
                "用例": "B-001 Login",
                "结果": "不通过",
                "截图": [
                    {"file_token": "file-old", "name": "shot.png", "type": "image/png"}
                ],
            },
        }
    ]
    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    ref_id = body["original"][0]["ref_id"]
    lark_fake.requests.clear()

    first = authenticated_client.get(f"/api/lark/history/{ref_id}/attachments/0")
    second = authenticated_client.get(f"/api/lark/history/{ref_id}/attachments/0")

    assert first.status_code == 200, first.text
    assert first.content == b"\x89PNG\r\n\x1a\n"
    assert second.content == first.content
    downloads = [
        request["path"]
        for request in lark_fake.requests
        if "/medias/" in request["path"] and request["path"].endswith("/download")
    ]
    assert downloads == ["/open-apis/drive/v1/medias/file-old/download"]
    assert first.headers["cache-control"] == "private, max-age=86400"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest "tests/test_lark_history.py::test_the_same_legacy_attachment_is_downloaded_once" -q`
Expected: FAIL — 下载两次，且 `cache-control` 是 `private, no-store`。

- [ ] **Step 3: 实现**

新建 `backend/app/lark/attachments.py`：

```python
"""Old-table pictures, kept on disk once they have been fetched.

The read-only panel shows the same handful of attachments every time a case is
opened. Lark mints one token per file and the bytes never change, so the second
look is served from disk.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from app.lark.client import LarkClient

DEFAULT_TTL_SECONDS = 86_400.0


def cache_directory(upload_dir: str) -> Path:
    """Beside the screenshots, not inside them: that directory is ours alone."""

    return Path(upload_dir).parent / "lark-attachments"


def cached_download(
    client: LarkClient,
    file_token: str,
    *,
    directory: Path,
    ttl: float = DEFAULT_TTL_SECONDS,
) -> tuple[bytes, str]:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / file_token
    mime_file = directory / f"{file_token}.mime"
    if target.is_file() and time.time() - target.stat().st_mtime < ttl:
        mime = mime_file.read_text(encoding="utf-8") if mime_file.is_file() else ""
        return target.read_bytes(), mime or "application/octet-stream"

    content, mime = client.download_media(file_token)
    # Write beside the final name and rename: a crashed download must never
    # leave a half file that the next read would serve as the picture.
    temporary = directory / f"{file_token}.part-{os.getpid()}"
    temporary.write_bytes(content)
    os.replace(temporary, target)
    mime_file.write_text(mime, encoding="utf-8")
    return content, mime
```

`backend/app/lark/history.py` 的 `legacy_attachment` 里把

```python
        content, content_type = client.download_media(file_token)
```

换成

```python
        content, content_type = cached_download(
            client,
            file_token,
            directory=cache_directory(settings.upload_dir),
        )
```

并把响应头里的 `"Cache-Control": "private, no-store"` 改成
`"Cache-Control": "private, max-age=86400"`，注释写明「这张图的 token 与字节都不会变，所以浏览器可以留着」。
`history.py` 需要 `from app.config import settings` 与
`from app.lark.attachments import cache_directory, cached_download`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_history.py -q`
Expected: PASS

- [ ] **Step 5: 跑全套**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add backend/app/lark/attachments.py backend/app/lark/history.py backend/tests/test_lark_history.py
git commit -m "perf(lark): download a legacy attachment once and let the browser keep it"
```

---

## 上线与实测（按 `docs/HANDOFF-RELEASE.md`）

- [ ] 后端全套 + 前端 `npx vitest run` + `npm run build` 全绿，`git diff --check` 干净。
- [ ] 打 tag（`v0.1.10`），等 `Publish TestDeck images` 成功，再 `./deploy.sh v0.1.10`。
- [ ] 用线上凭证复测（与审计同一手法：给 `client._send` 打点、数路径）：
  - 打开一个用例只剩 `{执行表}/records` + `{缺陷表}/records`（同 base 时 `tables` 一次）。
  - 连续打开 3 个用例：两张 `records` 各只读一次。
  - 提交一条「不通过」，队列排空后再看面板：能看到自己刚写的那条（验证失效链路）。
  - 同一张旧表截图连点两次：`/medias/.../download` 只出现一次。
- [ ] 在 `docs/HANDOFF-RELEASE.md` 追加一节：请求数前后对比、失效策略、回滚 tag。

## Self-Review

- **Spec coverage:** 审计里的 5 类浪费逐条落位 —— ①client 不复用 → Task 1；②同 base 读两遍 → Task 2；③读了不用的 fields → Task 3；④附件无缓存 → Task 6；⑤前端/切回重读整表 → Task 4 + Task 5。
- **Placeholder scan:** 没有 TBD/TODO，每个代码步骤都给了完整代码。少数步骤写「按该函数里已有的变量名」是因为要改的是既有函数的局部变量，执行者扫一眼即可确认；这不是占位符，而是必须的现场判断（我在计划里写明了去哪找）。
- **Type consistency:** `read_records` / `invalidate` / `invalidate_target` / `clear` 在 Task 4 定义，Task 5 只用这四个；`reset_shared_client` 在 Task 1 定义、Task 4 的 conftest 使用；`read_target_names` 只在 Task 3 定义与使用；`cache_directory` / `cached_download` 在 Task 6 定义与使用。
- **Known risk（执行时必须验证）:** api 与 worker 是**两个容器**，worker 的写入无法失效 api 进程内的快照。Task 5 的 `GET /sync` 排空失效正是为此存在；如果实测发现「刚提交看不到自己那条」仍会复现，就把 `DEFAULT_TTL_SECONDS` 降到 15 秒并补一条实测记录。
