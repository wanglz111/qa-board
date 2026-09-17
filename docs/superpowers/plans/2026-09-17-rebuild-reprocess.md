# 重建数据表的重复重写防护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「重建数据表」不能对一张表头已经正确的表再点第二次——那会新建一张一样的表并把本组全部记录重写一遍；同时让对话框在动手前说清楚会重写多少条。

**Architecture:** 后端新增一个「这张表已经是参考布局吗」的判断（列序 + 主列 + 每列类型），命中就 409 并给出逃生口 `force`；再让 `GET /lark/provision` 带上「重建会重写多少条」的计数，前端把它显示在对话框里，并提供「强制重建」勾选。

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy；React + TypeScript + Vitest。

**现场证据（2026-09-17，线上）:** live base 里出现过 `执行记录（表头修正）（表头修正）` 与 `冒烟测试bug表（表头修正）（表头修正）`——在已经修正过的表上又重建了一次。每重建一次都会 requeue 该角色全部结果并重写，20 个用例就是 20 条 create + 每条截图的 upload。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `backend/app/lark/provision.py`（改） | `layout_matches` 判断；`RebuildTableRequest.force`；计划响应带 `rebuild` 计数 |
| `backend/tests/test_lark_provision.py`（改） | 已是参考布局时 409、`force` 可越过、计数正确 |
| `frontend/src/api.ts`（改） | `RebuildTablePayload.force`；`ProvisionPlan.rebuild` |
| `frontend/src/components/HeaderSetup.tsx`（改） | 对话框显示条数与「强制重建」 |
| `frontend/src/components/HeaderSetup.test.tsx`（改） | 条数与 `force` 断言 |

---

### Task 1: 表已经是参考布局时拒绝重建

**Files:**
- Modify: `backend/app/lark/provision.py`
- Test: `backend/tests/test_lark_provision.py`

- [ ] **Step 1: 写失败的测试**

在 `backend/tests/test_lark_provision.py` 末尾追加：

```python
def _reference_layout(role: str) -> list[dict[str, Any]]:
    """The headers a table this tool just built would answer with."""

    return [
        {
            "field_id": f"fld-{index}",
            "field_name": name,
            "type": ROLE_SCHEMA[role][name].type_id,
            # Lark reports which column is the primary one, and the order alone
            # cannot tell: 用例 first is exactly what makes the layout right.
            "is_primary": index == 0,
        }
        for index, name in enumerate(schema_order(role))
    ]


def test_rebuilding_a_table_already_in_the_reference_layout_is_refused(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields = _reference_layout("execution")

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 409, response.text
    assert "已经是参考表头" in response.json()["detail"]
    # Nothing was created: a refusal must not leave a spare table behind.
    assert lark_fake.created_tables == []


def test_force_rebuilds_a_table_that_already_looks_right(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields = _reference_layout("execution")

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True, "force": True},
    )

    assert response.status_code == 200, response.text
    assert lark_fake.created_tables


def test_a_table_whose_headers_are_in_the_wrong_order_still_rebuilds(
    lark_fake, authenticated_client, provision_group
):
    """The case the feature exists for: 优先级 first, everything else off."""

    rows = _reference_layout("execution")
    lark_fake.fields = [rows[2], rows[0], *rows[1:2], *rows[3:]]

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 200, response.text
```

文件顶部若还没有这些 import，补上：

```python
from typing import Any

from app.lark.provision import ROLE_SCHEMA, schema_order
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_provision.py -q -k reference_layout -k "refused or force or wrong_order"`
Expected: FAIL — 第一个测试拿到 200（现在不看布局就重建），也没有 `force` 字段。

- [ ] **Step 3: 实现**

`backend/app/lark/provision.py` 里 `rebuilt_table_name` 之前加：

```python
def layout_matches(fields: Iterable[dict[str, Any]], role: str) -> bool:
    """Whether a table already carries the reference headers.

    Rebuilding such a table builds an identical one and rewrites every row of
    the role for nothing — which is exactly what a second click on 重建 does.
    The order alone is not enough: 用例 first is what makes the layout right,
    and Lark reports that as the primary flag on the first column.
    """

    rows = list(fields)
    order = schema_order(role)
    if [str(field.get("field_name") or "") for field in rows] != order:
        return False
    if not rows or not rows[0].get("is_primary"):
        # Without the primary flag we cannot claim the layout is right, and a
        # refusal based on a guess would be worse than letting it run.
        return False
    return all(
        ROLE_SCHEMA[role][name].matches(field) for name, field in zip(order, rows)
    )
```

`RebuildTableRequest` 加字段：

```python
class RebuildTableRequest(BaseModel):
    role: str
    acknowledge: bool = False
    # 表头已经正确时重建是白建一张表、白写一遍全部记录，所以默认拒绝。
    # 确实要一张干净的新表时，管理员显式越过这道闸。
    force: bool = False
```

`rebuild_table` 里，在 `current_name` 的那段校验之后、`new_name = rebuilt_table_name(...)` 之前插入：

```python
    try:
        live_fields = client.list_fields(base_token, table_id)
    except LarkError as error:
        raise HTTPException(
            status_code=409, detail=f"读取数据表字段失败：{error}"
        ) from None
    if not payload.force and layout_matches(live_fields, payload.role):
        raise HTTPException(
            status_code=409,
            detail=(
                "这张表已经是参考表头（列序、主列与类型都对），重建只会新建一张一样的表"
                "并把全部记录重写一遍；如果确实要一张干净的新表，请勾选「强制重建」"
            ),
        )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_provision.py -q`
Expected: PASS。既有重建测试用的是 `provision_group`（表里只有一列 `用例`）或自己设定的字段，`layout_matches` 对它们为假，所以不会被误拦；若某个既有测试恰好构造了完整布局，就在它的请求里加 `"force": True` 并注明原因。

- [ ] **Step 5: 提交**

```bash
git add backend/app/lark/provision.py backend/tests/test_lark_provision.py
git commit -m "fix(lark): refuse to rebuild a table that already has the reference headers"
```

---

### Task 2: 计划响应带上「会重写多少条」

**Files:**
- Modify: `backend/app/lark/provision.py`（`read_provision_plan`）
- Test: `backend/tests/test_lark_provision.py`

- [ ] **Step 1: 写失败的测试**

在 `backend/tests/test_lark_provision.py` 末尾追加：

```python
def test_the_plan_says_how_many_rows_a_rebuild_would_rewrite(
    lark_fake, authenticated_client, provision_group
):
    cases = authenticated_client.get(f"/api/groups/{provision_group.id}/cases").json()
    codes = [case["code"] for case in cases][:2]
    assert len(codes) == 2, "这个 fixture 需要至少两条用例"

    first = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/{codes[0]}/attempts",
        json={"result": "通过", "idempotency_key": "rebuild-count-1"},
    )
    assert first.status_code == 201, first.text
    second = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/{codes[1]}/attempts",
        json={
            "result": "不通过",
            "note": "登录按钮没反应",
            "idempotency_key": "rebuild-count-2",
        },
    )
    assert second.status_code == 201, second.text

    plan = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()

    # 执行表重写每一条本地结果；缺陷表只重写「不通过」的那一条。
    assert plan["rebuild"] == {"execution": 2, "bug": 1}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest "tests/test_lark_provision.py::test_the_plan_says_how_many_rows_a_rebuild_would_rewrite" -q`
Expected: FAIL — `KeyError: 'rebuild'`

- [ ] **Step 3: 实现**

`backend/app/lark/provision.py` 加一个计数函数（放在 `rebuild_table` 之后）：

```python
def _rebuild_counts(db: Session, group_id: UUID) -> dict[str, int]:
    """How many rows a rebuild of each role would write again.

    Every committed result of the group is re-filed into the execution table;
    only the failed ones raise a defect row.
    """

    committed = (
        select(func.count(Attempt.id))
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == group_id, Attempt.state == "committed")
    )
    failed = committed.where(Attempt.result == "不通过")
    return {
        "execution": int(db.scalar(committed) or 0),
        "bug": int(db.scalar(failed) or 0),
    }
```

`read_provision_plan` 的返回里加一行（放在 `"roles": roles,` 之后即可）：

```python
        # 重建之前先说清楚它会重写多少条：一次重建 = 新建一张表 + 把这些行
        # 全部再写一遍（含截图上传）。
        "rebuild": _rebuild_counts(db, group_id),
```

确认 `provision.py` 已导入 `Attempt`、`GroupCase`、`func`（`from app.models import Group` 那一行附近补全）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_provision.py -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/app/lark/provision.py backend/tests/test_lark_provision.py
git commit -m "feat(lark): say how many rows a rebuild would write again"
```

---

### Task 3: 对话框显示条数并允许强制重建

**Files:**
- Modify: `frontend/src/api.ts`、`frontend/src/components/HeaderSetup.tsx`
- Test: `frontend/src/components/HeaderSetup.test.tsx`

- [ ] **Step 1: 改类型**

`frontend/src/api.ts`：

```typescript
export type RebuildTablePayload = {
  role: TableRole;
  acknowledge: boolean;
  // 表头已经正确时默认拒绝重建；勾了「强制重建」才带这个。
  force?: boolean;
};
```

`ProvisionPlan` 加一个字段：

```typescript
  // How many rows a rebuild of each role would write again.
  rebuild?: Record<TableRole, number>;
```

- [ ] **Step 2: 写失败的测试**

在 `frontend/src/components/HeaderSetup.test.tsx` 末尾追加：

```tsx
it("says how many rows a rebuild would rewrite and can force one", async () => {
  const { rebuild } = renderRebuild({
    loadPlan: vi
      .fn()
      .mockResolvedValue({ ...COMPLETE, rebuild: { execution: 4, bug: 2 } })
  });

  await userEvent.click(await screen.findByRole("button", { name: "重建数据表（表头修正）" }));
  expect(await screen.findByText(/将重新写入 4 条记录/)).toBeVisible();
  expect(screen.getByText(/将重新写入 2 条记录/)).toBeVisible();

  await userEvent.click(screen.getByRole("checkbox", { name: "重建执行记录数据表" }));
  expect(rebuild).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("checkbox", { name: "强制重建" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(rebuild).toHaveBeenCalledWith("g1", {
    role: "execution",
    acknowledge: true,
    force: true
  });
});

it("does not force a rebuild unless the box is ticked", async () => {
  const { rebuild } = renderRebuild();

  await userEvent.click(await screen.findByRole("button", { name: "重建数据表（表头修正）" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建执行记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(rebuild).toHaveBeenCalledWith("g1", {
    role: "execution",
    acknowledge: true,
    force: false
  });
});
```

（`renderRebuild` 已经存在，见该文件「rebuilds the ticked role's table and names the one it replaces」一节。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/HeaderSetup.test.tsx`
Expected: FAIL — 找不到「将重新写入」文本，`force` 也没有传。

- [ ] **Step 4: 实现**

`frontend/src/components/HeaderSetup.tsx`：

加状态：

```tsx
  const [rebuildForce, setRebuildForce] = useState(false);
```

`openRebuildDialog` 里把 `setRebuildTicked({ execution: false, bug: false });` 之后补
`setRebuildForce(false);`。

`runRebuild` 里调用处改成：

```tsx
          const result = await rebuild(groupId, {
            role,
            acknowledge: true,
            force: rebuildForce
          });
```

对话框里，勾选列表那一行的 `→ {rebuiltNameOf(...)}` 之后补上条数：

```tsx
                      <span className="header-setup-type">
                        → {rebuiltNameOf(tableNames?.[role] ?? "")}
                        {plan?.rebuild ? `，将重新写入 ${plan.rebuild[role]} 条记录` : ""}
                      </span>
```

在勾选列表之后、「取消 / 重建」按钮之前加：

```tsx
            <label className="header-setup-row">
              <input
                type="checkbox"
                checked={rebuildForce}
                onChange={() => setRebuildForce((current) => !current)}
              />
              <span className="header-setup-name">强制重建</span>
              <span className="header-setup-type">
                表头已经正确时也会重建（会再新建一张表并重写全部记录）
              </span>
            </label>
```

`rebuildForce` 也要进 `runRebuild` 的依赖视野——它是组件内 state，闭包即可，无需额外处理。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/HeaderSetup.test.tsx`
Expected: PASS

- [ ] **Step 6: 跑前端全套与构建**

Run: `cd frontend && npx vitest run && npm run build`
Expected: PASS + 构建通过

- [ ] **Step 7: 提交**

```bash
git add frontend/src/api.ts frontend/src/components/HeaderSetup.tsx frontend/src/components/HeaderSetup.test.tsx
git commit -m "feat(lark): show the rewrite count before a rebuild and let it be forced"
```

---

## 上线与实测（按 `docs/HANDOFF-RELEASE.md`）

- [ ] 前后端全套 + 构建全绿。
- [ ] 打 tag、等镜像、`./deploy.sh <tag>`。
- [ ] 线上手工验一次：对当前（名字带双后缀）那张表点「重建数据表」→ 应该被 409 拒绝并说明原因；勾「强制重建」→ 才会真的建新表。
- [ ] 在 `docs/HANDOFF-RELEASE.md` 追加一节，并记下两条人工清理项：两张表名里的多余后缀、以及那条 `端到端截图链路验证` 记录。

## Self-Review

- **Spec coverage:** 用户要的两点都落位 —— 「重建前提示会重写多少条」→ Task 2 + Task 3；「避免重复重建造成写放大」→ Task 1（默认拒绝，`force` 才越过）。
- **Placeholder scan:** 无 TBD/TODO；每个代码步骤都给了完整代码。
- **Type consistency:** `force` 在 Task 1（后端字段）、Task 3（TS 类型与请求体）同名；`rebuild` 计数在 Task 2 定义、Task 3 读取；`_rebuild_counts` / `layout_matches` 只在各自任务内定义与使用。
- **已知取舍:** `layout_matches` 依赖 Lark 返回的 `is_primary`。测试替身默认不带这个字段，所以闸门在既有测试里恒为「放行」——这是刻意的方向：宁可让管理员多重建一次，也不因为猜不出主列而挡住真正需要的重建。新测试通过显式构造带 `is_primary` 的字段列表来覆盖闸门本身。
