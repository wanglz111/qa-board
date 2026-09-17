# 执行进度续做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做了一半关掉网页，重开时不要回到第一个用例：默认落在本组第一个没有结果的用例，并且回到上次正在看的那一条。

**Architecture:** 进度一直都在服务端（`attempts` 表 + `GET /progress`），丢的只是「光标」。所以后端只做一件事：让 `GET /api/groups/{id}/cases` 带着每个用例的最新结果；前端不再固定 `caseIndex = 0`，改为按「上次看的那条 → 第一个未测」的顺序选起点，并用 `localStorage` 记住光标。全程不读 Lark。

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy（后端）；React + TypeScript + Vitest + Testing Library（前端）。

**为什么不用 Lark 当来源:** 写进表里的行没有任何字段带 group id（工具靠 `(用例, 结果, 控制台, 日期)` 认自家行），多组共表时按编号做差集会把 A 组的结果算成 B 组已测；而且 Lark 是异步落库，刚提交完就刷新会读到旧状态。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `backend/app/groups.py`（改） | `GET /groups/{id}/cases` 带上 `latest_result` |
| `backend/tests/test_groups_api.py`（改） | 断言每个用例带着自己的最新结果 |
| `frontend/src/api.ts`（改） | `GroupCase.latest_result` 类型 |
| `frontend/src/executionCursor.ts`（新建） | 光标读写 + 「起点是哪一条」的纯函数 |
| `frontend/src/executionCursor.test.ts`（新建） | 纯函数单测 |
| `frontend/src/views/Execution.tsx`（改） | 选组与切用例时使用光标；「本组已全部测过」提示 |
| `frontend/src/views/Execution.test.tsx`（改） | 起点、记忆、全部测过三种行为 |

---

### Task 1: `GET /groups/{id}/cases` 带上每个用例的最新结果

**Files:**
- Modify: `backend/app/groups.py`（`list_group_cases`）
- Test: `backend/tests/test_groups_api.py`

- [ ] **Step 1: 写失败的测试**

在 `backend/tests/test_groups_api.py` 末尾追加：

```python
def test_each_case_carries_its_own_latest_result(authenticated_client, csv_book):
    preview = preview_csv(authenticated_client, csv_book).json()
    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "0918"},
    ).json()
    group_id = created["id"]

    saved = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-002/attempts",
        json={"result": "通过", "idempotency_key": "cursor-1"},
    )
    assert saved.status_code == 201, saved.text

    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    by_code = {case["code"]: case["latest_result"] for case in cases}

    assert by_code["B-002"] == "通过"
    assert by_code["B-001"] is None
    # 未执行的用例也算「已经有了结果」，否则它会一直被当成没测过。
    skipped = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-003/attempts",
        json={"result": "未执行", "idempotency_key": "cursor-2"},
    )
    assert skipped.status_code == 201, skipped.text
    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    assert {case["code"]: case["latest_result"] for case in cases}["B-003"] == "未执行"
```

> `preview_csv` 与 `csv_book` 是本文件既有的 helper 与 fixture（见 `test_group_listing_and_cases_are_ordered`）：`csv_book` 是 CSV 字节，`preview_csv` 拿 ticket，`confirm` 之后才拿到组。`group14.csv` 的编号是 B-001…B-014，所以上面用到的三个编号都存在。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest "tests/test_groups_api.py::test_each_case_carries_its_own_latest_result" -q`
Expected: FAIL — `KeyError: 'latest_result'`

- [ ] **Step 3: 实现**

`backend/app/groups.py` 的 `list_group_cases`：在 `cases = db.scalars(...).all()` 之后、`return [...]` 之前插入：

```python
    # One row per case: its highest-sequence committed attempt. The same shape
    # group_progress counts, but kept per case so the page can open on the
    # first case nobody has run instead of always on the first row.
    latest_sequences = (
        select(
            Attempt.group_case_id,
            func.max(Attempt.sequence).label("sequence"),
        )
        .where(Attempt.state == "committed")
        .group_by(Attempt.group_case_id)
        .subquery()
    )
    latest_result = {
        row[0]: row[1]
        for row in db.execute(
            select(Attempt.group_case_id, Attempt.result).join(
                latest_sequences,
                (Attempt.group_case_id == latest_sequences.c.group_case_id)
                & (Attempt.sequence == latest_sequences.c.sequence),
            )
        ).all()
    }
```

并在返回的字典里加一行：

```python
            "latest_result": latest_result.get(case.id),
```

确认 `groups.py` 顶部已导入 `func` 与 `Attempt`（`func` 在 `group_progress` 所在的 `app/execution.py` 里用过；`groups.py` 若没有就从 `sqlalchemy` 补 `func`，从 `app.models` 补 `Attempt`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_groups_api.py -q`
Expected: PASS

- [ ] **Step 5: 跑全套**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest -q`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add backend/app/groups.py backend/tests/test_groups_api.py
git commit -m "feat(execution): report each case's own latest result"
```

---

### Task 2: 光标工具与「第一个未测用例」

把「起点是哪一条」抽成纯函数，先单测再接线。

**Files:**
- Modify: `frontend/src/api.ts`（`GroupCase` 类型）
- Create: `frontend/src/executionCursor.ts`
- Test: `frontend/src/executionCursor.test.ts`（新建）

- [ ] **Step 1: 改类型**

`frontend/src/api.ts` 的 `GroupCase` 加一个字段（放在 `reference_assets` 之前）：

```typescript
  // The latest committed result for this case, or null when nobody has run it.
  // 「未执行」 is a result too: a case the operator deliberately skipped is not
  // an untested one.
  latest_result: AttemptResult | null;
```

- [ ] **Step 2: 写失败的测试**

新建 `frontend/src/executionCursor.test.ts`：

```typescript
import { startIndexFor, allTested } from "./executionCursor";
import type { GroupCase } from "./api";

function caseWith(code: string, latest: GroupCase["latest_result"]): GroupCase {
  return {
    id: code,
    code,
    position: 1,
    title: code,
    module: null,
    layer: null,
    priority: null,
    preconditions: null,
    test_data: null,
    steps: null,
    expected: null,
    expect_absent: [],
    visual_check: "text_and_visual",
    prototype_note: null,
    reference_assets: [],
    latest_result: latest
  };
}

const CASES = [
  caseWith("B-001", "通过"),
  caseWith("B-002", "不通过"),
  caseWith("B-003", null),
  caseWith("B-004", null)
];

it("opens on the first case nobody has run", () => {
  expect(startIndexFor(CASES, null)).toBe(2);
});

it("counts a skipped case as done", () => {
  const cases = [caseWith("B-001", "未执行"), caseWith("B-002", null)];
  expect(startIndexFor(cases, null)).toBe(1);
});

it("returns to the case being looked at when it still exists", () => {
  expect(startIndexFor(CASES, "B-002")).toBe(1);
});

it("falls back to the first untested case for a code that is gone", () => {
  expect(startIndexFor(CASES, "B-999")).toBe(2);
});

it("stays on the last case when the whole group is done", () => {
  const done = [caseWith("B-001", "通过"), caseWith("B-002", "通过")];
  expect(startIndexFor(done, null)).toBe(1);
  expect(allTested(done)).toBe(true);
  expect(allTested(CASES)).toBe(false);
  expect(allTested([])).toBe(false);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/executionCursor.test.ts`
Expected: FAIL — `Failed to resolve import "./executionCursor"`

- [ ] **Step 4: 实现**

新建 `frontend/src/executionCursor.ts`：

```typescript
import type { GroupCase } from "./api";

// Where the operator was, so reopening the page returns to the case they were
// reading instead of the first row of the group.
const KEY = "testdeck.execution.cursor";

export type Cursor = { groupId: string; code: string };

export function readCursor(): Cursor | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cursor> | null;
    if (!parsed || typeof parsed.groupId !== "string" || typeof parsed.code !== "string") {
      return null;
    }
    if (!parsed.groupId || !parsed.code) return null;
    return { groupId: parsed.groupId, code: parsed.code };
  } catch {
    // A cursor is a convenience: storage being unavailable or holding junk must
    // never stop the page from opening a case.
    return null;
  }
}

export function writeCursor(cursor: Cursor): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cursor));
  } catch {
    // Same reasoning: a full or blocked storage is not an execution failure.
  }
}

export function clearCursor(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Ignored on purpose.
  }
}

// A case is done once it has a result of any kind — 「未执行」 included: someone
// decided about it, so it is not the case to resume on.
function isDone(item: GroupCase): boolean {
  return (item.latest_result ?? null) !== null;
}

export function startIndexFor(cases: GroupCase[], rememberedCode: string | null): number {
  if (cases.length === 0) return 0;
  if (rememberedCode) {
    const remembered = cases.findIndex((item) => item.code === rememberedCode);
    if (remembered >= 0) return remembered;
  }
  const untested = cases.findIndex((item) => !isDone(item));
  // Everything done: the last row is the most useful place to land, and the
  // page says so out loud rather than pretending there is work left.
  return untested >= 0 ? untested : cases.length - 1;
}

export function allTested(cases: GroupCase[]): boolean {
  return cases.length > 0 && cases.every(isDone);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/executionCursor.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api.ts frontend/src/executionCursor.ts frontend/src/executionCursor.test.ts
git commit -m "feat(execution): add the resume cursor and its start-of-work rule"
```

---

### Task 3: 选组与切用例时使用光标

**Files:**
- Modify: `frontend/src/views/Execution.tsx`
- Test: `frontend/src/views/Execution.test.tsx`

- [ ] **Step 1: 先让既有 fixture 满足新类型**

`frontend/src/views/Execution.test.tsx` 的 `testCase` 换成：

```tsx
function testCase(
  id: string,
  title: string,
  expected: string | null = null,
  code = "B-001",
  latestResult: GroupCase["latest_result"] = null
): GroupCase {
  return {
    id,
    code,
    position: 1,
    title,
    module: "账户",
    layer: "服务层",
    priority: "P0",
    preconditions: null,
    test_data: null,
    steps: "打开登录页并提交凭据",
    expected,
    expect_absent: [],
    visual_check: "text_and_visual",
    prototype_note: null,
    reference_assets: [],
    latest_result: latestResult
  };
}
```

再在 `renderExecution` 之前加一个清理，避免用例之间通过 localStorage 互相影响：

```tsx
beforeEach(() => {
  window.localStorage.clear();
});
```

- [ ] **Step 2: 写失败的测试**

在 `frontend/src/views/Execution.test.tsx` 末尾追加：

```tsx
it("opens on the first case nobody has run, not on the first row", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null),
      testCase("c3", "第三条", null, "B-003", null)
    ]
  });

  expect(await screen.findByText("第二条")).toBeVisible();
  expect(screen.queryByText("第一条")).not.toBeInTheDocument();
});

it("returns to the case that was being looked at", async () => {
  window.localStorage.setItem(
    "testdeck.execution.cursor",
    JSON.stringify({ groupId: "0918-id", code: "B-003" })
  );
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", "通过"),
      testCase("c3", "第三条", null, "B-003", null)
    ]
  });

  expect(await screen.findByText("第三条")).toBeVisible();
});

it("says so when the whole group has been run", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", "未执行")
    ]
  });

  expect(await screen.findByText("本组已全部测过")).toBeVisible();
});

it("remembers the case once it is opened", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  await screen.findByText("第二条");
  expect(window.localStorage.getItem("testdeck.execution.cursor")).toBe(
    JSON.stringify({ groupId: "0918-id", code: "B-002" })
  );
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/Execution.test.tsx`
Expected: 前四个新测试 FAIL（页面仍然停在第一条，「本组已全部测过」不存在，localStorage 为空）。

- [ ] **Step 4: 实现**

`frontend/src/views/Execution.tsx`：

顶部加 import：

```tsx
import { allTested, readCursor, startIndexFor, writeCursor } from "../executionCursor";
```

`selectGroup` 里的这一段：

```tsx
      const result = await loadCases(groupId);
      if (requestId !== caseRequest.current) return;
      setCases(result);
      const first = result[0];
      if (first) {
        const history = await loadAttempts(groupId, first.code);
        if (requestId === caseRequest.current) setAttempts(history);
      }
```

换成：

```tsx
      const result = await loadCases(groupId);
      if (requestId !== caseRequest.current) return;
      setCases(result);
      // Resume where the operator left off, else at the first case nobody has
      // run. This is the whole point of the page: coming back after a break
      // must not mean re-reading the first row of the group.
      const remembered = readCursor();
      const start = startIndexFor(result, remembered?.groupId === groupId ? remembered.code : null);
      setCaseIndex(start);
      const current = result[start];
      if (current) {
        writeCursor({ groupId, code: current.code });
        const history = await loadAttempts(groupId, current.code);
        if (requestId === caseRequest.current) setAttempts(history);
      }
```

`showCase` 里，在 `setCaseIndex(index)` 之后加一行：

```tsx
    writeCursor({ groupId: selectedGroupId, code: target.code });
```

`loadGroups` 那一段的组选择：

```tsx
        const preferred = result.find((group) => group.id === initialGroupId) ?? result[0];
```

换成：

```tsx
        const rememberedGroup = readCursor()?.groupId ?? null;
        const preferred =
          result.find((group) => group.id === initialGroupId) ??
          result.find((group) => group.id === rememberedGroup) ??
          result[0];
```

在 `CaseDetail` 之前加提示（`allTested(cases)` 为真时）：

```tsx
            {allTested(cases) ? (
              <p className="inline-status saved" role="status">本组已全部测过</p>
            ) : null}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/views/Execution.test.tsx`
Expected: PASS

- [ ] **Step 6: 跑前端全套与构建**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS + 构建通过。其他测试文件里手写的 `GroupCase` fixture 会因为新增必填字段而报 TS 错，给它们补 `latest_result: null`（这是类型变动的正常代价，不要把它改成可选来回避）。

- [ ] **Step 7: 提交**

```bash
git add frontend/src/views/Execution.tsx frontend/src/views/Execution.test.tsx
git commit -m "feat(execution): resume at the first unrun case and remember where I was"
```

---

## 上线与实测（按 `docs/HANDOFF-RELEASE.md`）

- [ ] 后端与前端全套 + 构建全绿。
- [ ] 打 tag、等镜像、`./deploy.sh <tag>`。
- [ ] 线上手工走一遍：做到第 5 个用例 → 关掉标签页 → 重开 → 应该停在第 5 个；把前 3 个做掉后重开 → 停在第一个没做的；整组做完 → 出现「本组已全部测过」。
- [ ] 在 `docs/HANDOFF-RELEASE.md` 追加一节。

## Self-Review

- **Spec coverage:** 用户三点都落位 —— ①「重开不要从头开始」→ Task 2 的 `startIndexFor` + Task 3 的 `selectGroup`；②「从第一个没测的用例开始」→ Task 1 的 `latest_result` + Task 2；③「需要时才手动往前」→ 保留既有 `onPrevious`/`onNext`，不做自动前进。
- **Placeholder scan:** 无 TBD/TODO；每个代码步骤都给了完整代码。
- **Type consistency:** `latest_result` 在 Task 1（后端字段）与 Task 2（TS 类型）同名；`startIndexFor` / `allTested` / `readCursor` / `writeCursor` 在 Task 2 定义，Task 3 只用这四个；`testCase` 的新签名在 Task 3 Step 1 定义，后续测试按该签名调用。
