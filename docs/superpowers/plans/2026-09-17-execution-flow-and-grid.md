# 执行台续做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Dispatch one implementer subagent per task, then a spec-compliance reviewer, then a code-quality reviewer — sequentially, never two implementers in parallel.

**Goal:** 修掉「保存后不跳转」与「提交后输入框残留」，把 Lark 缺陷行的「问题描述」前缀搬进「备注」，并在执行台侧栏加一套按颜色区分的用例进度方格（含画中画内的进度行）。

**Spec（权威行为定义）:** `docs/superpowers/specs/2026-09-17-execution-flow-and-grid-design.md`

**Tech Stack:** React 19 + TypeScript + Vitest + Testing Library（前端）；Python 3.12 + FastAPI + SQLAlchemy + pytest（后端）；Playwright（e2e）。

**分支:** `feature/execution-flow-and-grid`（从 `main` 切出）。**不要**在 `main` 上实现。

---

## 环境与命令（每个任务都用这套，已实测）

```bash
# 后端（测试库容器 testdeck-task2-postgres 已在 127.0.0.1:5433 运行）
cd /home/lucascool/qa-board/backend
TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' \
  .venv/bin/python -m pytest -q                       # 全量：基线 424 passed
TEST_DATABASE_URL='...' .venv/bin/python -m pytest tests/test_lark_outbox.py -q   # 单文件

# 前端
cd /home/lucascool/qa-board/frontend
npx vitest run src/executionCursor.test.ts            # 全量基线：161 passed / 17 files
npx vitest run                                        # 全量
npm run build                                         # tsc -b && vite build

# e2e（dev server 由 playwright 自动拉起在 127.0.0.1:4173）
cd /home/lucascool/qa-board/frontend && npx playwright test
```

**基线（开工前实测，不要把它当回归）：** 后端 `424 passed`；前端 `161 passed (17 files)`。

**通用约定：**
- 每个任务先写失败的测试，再实现，再全量回归，最后提交（TDD，不许倒序）。
- 每个任务一个 commit，提交信息用任务里给的那条。
- 改文件用 edit/write 工具；如果用 shell（sed/python）改过某个文件，**下一次 edit 前必须先 read**（否则报 `FS_STALE_VERSION`）。
- 注释风格跟着仓库走：解释「为什么」，不解释「是什么」；英文注释（现有代码全是英文注释）。
- 完成后跑 `git diff --check`，必须干净。

---

### Task 1: 前端纯函数——「下一条未测」与收紧后的起点规则

**Files:**
- Modify: `frontend/src/executionCursor.ts`
- Test: `frontend/src/executionCursor.test.ts`

**背景（子代理必读）：** `executionCursor.ts` 是执行台的「光标」纯函数模块。`GroupCase.latest_result` 为 `null` 表示该用例**没测过**；`"未执行"`（跳过）也算测过。当前 `startIndexFor` 会回到记忆里那条用例——**哪怕它已经测过**；新需求要求只在那条仍未测时才回去。

- [ ] **Step 1: 改/写失败的测试**

在 `frontend/src/executionCursor.test.ts` 里：
1. 把现有 `it("returns to the case being looked at when it still exists", ...)`（用 `CASES` 里的 `"B-002"`，它是 `不通过` 即已测）改成断言**新规则**：已测的记忆条目不再回去，落到第一条未测（`2`），并改写标题为 `"falls back to the first unrun case once the remembered case is done"`。
2. 新增：`"returns to the remembered case while it is still unrun"` —— `startIndexFor(CASES, { groupId: GROUP, code: "B-004" }, GROUP)` 返回 `3`（B-004 是第 4 条、`latest_result` 为 `null`）。
   > **实施期修正（Task 1 评审）**：原稿写 `"B-003"` 返回 `2`，但 B-003 既是记忆项又是第一条未测用例——把记忆分支整段删掉也照样通过，测不出东西。改用 `B-004`：删掉分支会退化成 `2` 而失败。
   > 注意：`startIndexFor(cases, cursor: Cursor | null, groupId: string)` 是**三参数**签名，`Cursor` 形如 `{ groupId, code }`；现有的「忽略别的组的游标」测试就在这个文件里，照它的写法传参。
3. 新增 `nextUntestedIndex` 的 5 条测试（用同一个 `CASES` 数组与 `caseWith` 辅助函数）：

```ts
import { nextUntestedIndex, startIndexFor, allTested } from "./executionCursor";

it("advances to the first unrun case after the current one", () => {
  // CASES: B-001 通过, B-002 不通过, B-003 null, B-004 null
  expect(nextUntestedIndex(CASES, 1)).toBe(2);
});

it("wraps around to the earliest unrun case", () => {
  // 从最后一条（B-004 未测）出发：其后没有，环绕回到 B-003
  expect(nextUntestedIndex(CASES, 3)).toBe(2);
});

it("reports nowhere to go once every case has a result", () => {
  const done = [caseWith("B-001", "通过"), caseWith("B-002", "未执行")];
  expect(nextUntestedIndex(done, 0)).toBeNull();
});

it("has nowhere to go in an empty group", () => {
  expect(nextUntestedIndex([], 0)).toBeNull();
});

it("treats a negative index as 'from the beginning'", () => {
  expect(nextUntestedIndex(CASES, -1)).toBe(2);
});
```

> **实施期修正（Task 1 评审）**：实际落地的测试比上面这 5 条多 3 条，都是评审要求补的变异杀手——`"looks strictly after the current case before wrapping"`（`[未测, 通过, 未测]` 从 `1` 出发必须得 `2`，naive 的 `findIndex` 会得 `0`）、`"treats an out-of-range start as the beginning of the group"`（唯一未测在最后一行、`from = length` 与 `99` 都必须得 `2`）、`"does not fall back to the current case when it is the only one left"`（`[通过, 未测]` 从 `1` 出发必须是 `null`）。最终该文件 20 条断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/executionCursor.test.ts`
Expected: FAIL —— `nextUntestedIndex` 不是一个函数 / 起点断言 2 !== 1。

- [ ] **Step 3: 实现**

在 `frontend/src/executionCursor.ts` 里：
1. `startIndexFor` 里的记忆分支改成「只有那条仍未测才用」：

```ts
  const rememberedCode = cursor && cursor.groupId === groupId ? cursor.code : null;
  if (rememberedCode) {
    const remembered = cases.findIndex((item) => item.code === rememberedCode);
    // A remembered case that already has a result is not where the work is:
    // resuming on it would park the operator on a finished row, which is the
    // one thing this page must never do.
    if (remembered >= 0 && !isDone(cases[remembered])) return remembered;
  }
```

2. 在 `allTested` 之前新增：

```ts
// The next case nobody has run, starting after `from` and wrapping once to the
// top of the group. `null` means there is no unrun case other than `from`
// itself, which is the caller's signal to stay put; whether the group is
// finished stays `allTested`'s call. A `from` outside the array behaves like
// `-1`: the search starts at the top.
export function nextUntestedIndex(cases: GroupCase[], from: number): number | null {
  const start = Math.max(from, -1);
  for (let index = start + 1; index < cases.length; index += 1) {
    if (!isDone(cases[index])) return index;
  }
  // The wrap stops before `from`, and `cases.length` (not `length - 1`) is the
  // bound: an out-of-range `from` must fall back to `-1`, and capping at
  // `length - 1` would then never inspect the group's last row.
  const ceiling = Math.min(start, cases.length);
  for (let index = 0; index < ceiling; index += 1) {
    if (!isDone(cases[index])) return index;
  }
  return null;
}
```

> 环绕循环必须**不含** `from` 自己：`from` 刚被保存过，正常情况下已有结果；若它仍无结果（保存失败等），也不该原地跳回自己。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/executionCursor.test.ts`
Expected: PASS（全部通过）。

- [ ] **Step 5: 全量前端 + 提交**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run`
Expected: PASS（161+ 通过；若有别的文件因 `startIndexFor` 行为变化而失败，**先报告再改**，不要为了让测试变绿而放宽断言）。

```bash
git add frontend/src/executionCursor.ts frontend/src/executionCursor.test.ts
git commit -m "feat(execution): jump to the next unrun case, and never resume a finished one"
```

---

### Task 2: `OutcomeForm` 增加复位通道

**Files:**
- Modify: `frontend/src/components/OutcomeForm.tsx`
- Test: `frontend/src/components/OutcomeForm.test.tsx`

**背景：** 表单的 `result` / `note` / `consoleText` 是组件内部 state，句柄只暴露了 `setResult` 与 `focusNote`，所以提交成功后输入框里的话不会消失（用户报告的 bug 2），切用例时上一题的失败说明还会被带到下一题提交。

- [ ] **Step 1: 写失败的测试**

在 `frontend/src/components/OutcomeForm.test.tsx` 末尾追加（沿用文件里已有的 `renderForm`/`ref` 写法）：

```tsx
it("clears the result, the note, the console and the validation when reset", async () => {
  const user = userEvent.setup();
  const { ref } = renderForm();

  await user.click(screen.getByRole("button", { name: "不通过" }));
  await user.type(screen.getByLabelText("失败说明"), "绑定未触发");
  await user.type(screen.getByLabelText("控制台输出"), "wallet.bind timeout");

  act(() => ref.current?.reset());

  expect(screen.getByRole("button", { name: "不通过" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("失败说明")).toHaveValue("");
  expect(screen.getByLabelText("控制台输出")).toHaveValue("");
});

it("clears a validation message left behind by an empty submit", async () => {
  const user = userEvent.setup();
  const { ref } = renderForm();

  await user.click(screen.getByRole("button", { name: "保存结果" }));
  expect(screen.getByRole("alert")).toHaveTextContent("请选择执行结果");

  act(() => ref.current?.reset());

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
```
> 若 `renderForm` 没把 label 关联到 textarea，用文件里现有的取法（例如 `screen.getByLabelText("失败说明")` 已能用，`<label>` 包着 `<textarea>`），以现有测试的写法为准；`act` 需要从 `@testing-library/react` 引入。

> **实施期修正（Task 2 两段评审）**：最终该文件 7 条断言，比上面多两处加固，都是评审用变异实测发现的空洞——
> 1. 第一条测试的标题改成 `"resets the result, the note, the console and the validation, leaving the form pristine"`：原断言只看「不通过按钮未按下」，把 `setResult(null)` 改成 `setResult("通过")` 也能通过。补上 `reset()` 之后点「保存结果」必须重新出现 `请选择执行结果` 的告警，才真正钉住「回到初始态」。
> 2. 新增 `"leaves the attachments and the save status to the caller"`：给 `reset()` 里塞一句 `onImagesChange([])` 原本能让 6 条测试全绿，而 Task 3 的「截图上传承失败 → 重试上传截图」正依赖附件存活。该测试必须在真有图片渲染的前提下断言（照文件里既有的 `URL.createObjectURL` 桩写法）。
> 3. 组件里的契约注释也要写清两件事：`reset()` **不碰附件与保存状态**（调用方自己清），以及**只有提交请求被拒才不复位**——「结果已落库但截图上传失败」这条 error 路径**仍然复位**（注意 `tone: "error"` 在 `Execution.tsx` 里有这两种含义，别按 `status.tone` 加守卫）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/OutcomeForm.test.tsx`
Expected: FAIL —— `ref.current.reset is not a function`。

- [ ] **Step 3: 实现**

`frontend/src/components/OutcomeForm.tsx`：
1. 句柄类型加一行：

```ts
export type OutcomeFormHandle = {
  setResult: (result: AttemptResult) => void;
  focusNote: () => void;
  // The caller owns the lifecycle: a save that landed clears the form, and so
  // does moving to another case, because a note typed for case A must never be
  // submitable under case B.
  reset: () => void;
};
```

2. `useImperativeHandle` 里加：

```ts
    reset: () => {
      setResult(null);
      setNote("");
      setConsoleText("");
      setValidation("");
    }
```

- [ ] **Step 4: 跑测试确认通过 + 全量 + 提交**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/OutcomeForm.test.tsx && npx vitest run`
Expected: PASS。

```bash
git add frontend/src/components/OutcomeForm.tsx frontend/src/components/OutcomeForm.test.tsx
git commit -m "feat(execution): give the outcome form a reset the caller controls"
```

---

### Task 3: 执行台接线——保存后自动前进 + 复位 + 确认不再被清掉

**Files:**
- Modify: `frontend/src/views/Execution.tsx`
- Test: `frontend/src/views/Execution.test.tsx`

**背景：** `save()` 提交后只刷新 attempts/progress，从不移动 `caseIndex`；`showCase()` 会把 `status` 清空，所以前进会吃掉「已保存」确认；`save()` 里有多处 `await`，期间操作员仍能点 `CaseDetail` 的 ←/→（那两个按钮在 `submitting` 时**没有** disabled），所以前进基准必须是「保存时那一条的下标」，不能读实时下标。

- [ ] **Step 1: 写失败的测试**

在 `frontend/src/views/Execution.test.tsx` 末尾追加 6 条（沿用文件里的 `renderExecution` / `testCase` / mock 写法；`testCase(id, title, expected, code, latestResult)` 第 5 个参数就是 `latest_result`）：

1. `"moves to the next unrun case after a save"` —— 组内三条：`("c1","第一条",null,"B-001","通过")`、`("c2","第二条",null,"B-002",null)`、`("c3","第三条",null,"B-003",null)`；页面应停在「第二条」；点「通过」后再点「保存结果」→ 断言 `await screen.findByText("第三条")` 可见、且「第二条」不在文档里。
2. `"keeps the save confirmation visible on the case it moved to"` —— 同上提交后，断言 `screen.getByText(/已保存到本地/)` 仍可见，且文案里带着刚保存的编号（`/B-002 已保存到本地/`）。
3. `"wraps to the earliest unrun case when the tail is finished"` —— 用 `window.localStorage.setItem("testdeck.execution.cursor", JSON.stringify({ groupId: "0918-id", code: "B-003" }))` 让页面停在最后一条未测的用例上（三组数据：B-001 未测、B-002 通过、B-003 未测），保存 B-003 后断言跳到「第一条」（B-001）。
4. `"stays put and says the group is finished when nothing is left"` —— 只有一条未测；保存后断言「本组已全部测过」可见且仍在同一条用例上。
5. `"does not submit the previous case's note after moving on"` —— 在第一条的「失败说明」里输入文字，点「下一条用例」（`CaseDetail` 的 `aria-label="下一条用例"`），再点「保存结果」并选择「通过」；断言 `submit` mock 收到的 payload 的 `note` 是 `null`（表单已复位）。
6. `"leaves the case the operator moved to alone when the save lands"` —— **门控回归测试（必写）**：让 `submit` 返回一个手动控制 resolve 的 promise；点「保存结果」开始保存，在它还挂着的时候点「下一条用例」并在新用例的「失败说明」里输入 `"给下一条的话"`；然后 resolve 保存。断言：①页面**仍停在**新用例上（没有被自动前进抢走）；②输入框里**仍然**是 `"给下一条的话"`（reset 没有清掉别人的草稿）。没有这条断言，「保存期间切走 → 草稿被清空」这个镜像 bug 无人看守。

> 测试文件已有 `beforeEach(() => window.localStorage.clear())` 之类的清理，按现有写法来；提交用 `submit` mock 的返回值（`{ id, label, sequence, state: "committed", result, note, console_text, created_at }`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/Execution.test.tsx`
Expected: 新增测试 FAIL（没有前进、没有编号前缀、上一题说明被提交）。

- [ ] **Step 3: 实现**

`frontend/src/views/Execution.tsx`，按顺序改：

1. import 补 `nextUntestedIndex`：

```ts
import { allTested, clearCursor, nextUntestedIndex, readCursor, startIndexFor, writeCursor } from "../executionCursor";
```

2. 在 `const caseRequest = useRef(0);` 附近加一个实时下标 ref：

```ts
  // The live index, so a save that outlives several awaits can tell whether the
  // operator has moved on. `caseIndex` inside `save()` is a render-time
  // snapshot and cannot answer that.
  const caseIndexRef = useRef(0);
```

3. `selectGroup()` 里 `setCaseIndex(start)` 之后加 `caseIndexRef.current = start;`，并在 `setStatus(null)` 附近加 `formRef.current?.reset();`（切组不留上一题的说明）。

4. `showCase` 改签名并加复位/保留状态：

```ts
  async function showCase(index: number, options: { keepStatus?: boolean } = {}) {
    const target = cases[index];
    if (!target || !selectedGroupId) return;
    const requestId = ++caseRequest.current;
    caseIndexRef.current = index;
    setCaseIndex(index);
    writeCursor({ groupId: selectedGroupId, code: target.code });
    setAttempts([]);
    setReserved(null);
    setImages([]);
    // Moving on by hand abandons the previous save message; moving on because
    // the save just landed keeps it, so the operator sees the proof on the case
    // they were sent to.
    if (!options.keepStatus) setStatus(null);
    formRef.current?.reset();
    setLoadingCase(true);
    ...（其余不变）
```

5. `save()` 改成下面的形状（保留现有注释与守卫语义，只加「前进」这条线）：

```ts
  async function save(input: SaveInput) {
    const savedGroupId = selectedGroupId;
    const savedIndex = caseIndex;
    const saved = cases[savedIndex];
    if (!saved || !savedGroupId) return;
    ...
    let advanceTo: number | null = null;
    setSubmitting(true);
    setStatus(null);
    try {
      ...（提交、setLastAttemptId、setReserved(null)、loadAttempts 都不变）
      await refreshProgress(savedGroupId);
      // One array drives both the state and the advance decision: reading the
      // state back would be a render behind, and the decision belongs to this
      // save, not to whatever the page shows next.
      const updated = cases.map((item) =>
        item.code === saved.code ? { ...item, latest_result: attempt.result } : item
      );
      if (loadedGroup.current === savedGroupId) setCases(updated);
      ...
      // （sync 读取与上传不变，但状态文案带上编号）
      setStatus(
        uploaded
          ? {
              tone: "saved",
              text: confirmed
                ? `${saved.code} 已保存到本地 · 将新增到 Lark 旧表`
                : `${saved.code} 已保存到本地 · 尚未确认 Lark 目标表`
            }
          : { tone: "error", text: `${saved.code} 结果已保存到本地，但截图上传失败` }
      );
      if (uploaded) setImages([]);
      // One guard for both effects. `save()` outlives a case switch (it takes
      // several awaits while the ←/→ buttons stay clickable), so by now the form
      // on screen may belong to a *different* case: clearing it would throw away
      // what the operator typed there, and jumping would steal their choice of
      // where to be. This is the mirror of the bug being fixed — a lost draft
      // instead of a misattributed one.
      if (loadedGroup.current === savedGroupId && caseIndexRef.current === savedIndex) {
        formRef.current?.reset();
        advanceTo = nextUntestedIndex(updated, savedIndex);
      }
    } catch (reason) {
      // The submit request itself was rejected: nothing was stored, so the form
      // must keep the note for the retry (spec 二/B.4「保存失败不复位」).
      setStatus({ tone: "error", text: `保存失败：${message(reason)}，可重试` });
    } finally {
      setSubmitting(false);
    }
    // After the spinner is down, so 「保存中」 never covers the case we land on.
    if (advanceTo !== null) await showCase(advanceTo, { keepStatus: true });
  }
```

> `setCases((current) => ...)` 那一段就地更新的旧代码**被 `updated` 取代**，不要再留两份。`allTested(cases)` 的横幅逻辑不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/Execution.test.tsx`
Expected: PASS（19 + 5 条）。

- [ ] **Step 5: 全量 + 构建 + 提交**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run && npm run build`
Expected: 全部 PASS、构建干净。

```bash
git add frontend/src/views/Execution.tsx frontend/src/views/Execution.test.tsx
git commit -m "feat(execution): advance to the next unrun case and hand the form over clean"
```

---

### Task 4: `CaseGrid` 组件（日历式进度方格）

**Files:**
- Create: `frontend/src/components/CaseGrid.tsx`
- Test: `frontend/src/components/CaseGrid.test.tsx`（新建）

**背景：** 需求 4 要一眼看出「哪条测过、哪条没测」。数据现成：`GroupCase.latest_result`（`null`=未测，`通过`/`不通过`/`未执行`）。方格只负责显示与点击跳转，跳转由父组件决定。

- [ ] **Step 1: 写失败的测试**

新建 `frontend/src/components/CaseGrid.test.tsx`，覆盖：
1. 四种颜色：给 4 条用例（`通过` / `不通过` / `未执行` / `null`），断言四个按钮分别带 `passed` / `failed` / `skipped` / `untested` 类名（`toHaveClass`）。
2. 当前用例：`caseIndex={1}` 时第 2 个按钮 `aria-current="true"`。
3. 点击跳转：`onJump` 收到被点按钮的下标。
4. 图例计数与方格一致：断言文案 `通过 1 · 不通过 1 · 跳过 1 · 未测 1`。
5. 每条按钮的可访问名带编号与状态（如 `B-001 通过`），`title` 是 `B-001 管理员登录`。
> fixture 用 `GroupCase` 的完整形状（文件里其它测试有现成的构造写法，可参考 `frontend/src/views/Execution.test.tsx` 的 `testCase`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/CaseGrid.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `frontend/src/components/CaseGrid.tsx`：

```tsx
import type { GroupCase } from "../api";

type Props = {
  cases: GroupCase[];
  caseIndex: number;
  onJump: (index: number) => void;
};

// 「未执行」 is a colour of its own: a case the operator deliberately skipped is
// not the same thing as a case nobody has looked at, and the difference is the
// whole point of the grid.
const TONE_CLASS: Record<string, string> = {
  通过: "passed",
  不通过: "failed",
  未执行: "skipped"
};

function toneClass(latest: GroupCase["latest_result"]): string {
  return (latest && TONE_CLASS[latest]) || "untested";
}

export function CaseGrid({ cases, caseIndex, onJump }: Props) {
  const counts = { passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const item of cases) counts[toneClass(item.latest_result)] += 1;

  return (
    <div className="case-grid-block">
      <ul className="case-grid" aria-label="用例完成情况">
        {cases.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className={`case-square ${toneClass(item.latest_result)}${index === caseIndex ? " current" : ""}`}
              title={`${item.code} ${item.title}`}
              aria-label={`${item.code} ${item.latest_result ?? "未测"}`}
              aria-current={index === caseIndex ? "true" : undefined}
              onClick={() => onJump(index)}
            />
          </li>
        ))}
      </ul>
      <p className="case-grid-legend">
        通过 {counts.passed} · 不通过 {counts.failed} · 跳过 {counts.skipped} · 未测 {counts.untested}
      </p>
    </div>
  );
}
```

> 计数**必须**从 `cases` 现算（与方格同源）；不要另外接收一个 progress 对象，否则两处数字会打架。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/CaseGrid.test.tsx && npx vitest run`
Expected: PASS。

```bash
git add frontend/src/components/CaseGrid.tsx frontend/src/components/CaseGrid.test.tsx
git commit -m "feat(execution): add the per-case result grid"
```

---

### Task 5: 把方格接进侧栏、给 desk 加一行进度、并把样式（含画中画）补齐

**Files:**
- Modify: `frontend/src/views/Execution.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/views/Execution.test.tsx`

**背景（画中画硬事实）：** `usePiP` 只把 `deskHost`（`div.execution-desk`，portal 里的内容）搬进小窗，`aside.execution-groups` 留在主窗口。所以方格放侧栏 → PiP 里看不到；为了 PiP 里也知道进度，在 `execution-toolbar`（属于 desk，会搬进 PiP）里加一行紧凑进度。两处计数必须同源（都从 `cases` 现算）。

- [ ] **Step 1: 写失败的测试**

`frontend/src/views/Execution.test.tsx` 追加：
1. `"shows one square per case with its own colour"` —— 组内 3 条（通过 / 未测 / 未执行），断言 `screen.getAllByRole("button", { name: /^(B-001|B-002|B-003) / })` 里的类名，以及图例文案里的计数。
2. `"jumps to a case by clicking its square"` —— 点第 3 个方格后，「第三条」的标题可见。
3. `"shows the running counts in the desk so the PiP window carries them"` —— 断言工具栏里的进度文案（例如 `screen.getByText(/1\/3/)` 与 `/未测 2/`）存在，且它位于 `.execution-desk` 之内（`document.querySelector(".execution-desk")?.textContent` 包含它）。
4. `"keeps a half-typed note when the current case's own square is clicked"` —— 在当前用例的「失败说明」里输入 `"半截草稿"`，点该用例自己的方格，断言输入框里仍是 `"半截草稿"`（同下标必须短路，否则 `showCase` 会静默清空）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/Execution.test.tsx`
Expected: 新增测试 FAIL。

- [ ] **Step 3: 实现（接线）**

`frontend/src/views/Execution.tsx`：
1. import：`import { CaseGrid } from "../components/CaseGrid";`
2. 侧栏里、`<GroupSelector .../>` 之后：

```tsx
          {cases.length > 0 ? (
            <CaseGrid
              cases={cases}
              caseIndex={caseIndex}
              // Clicking the square of the case already on screen must be a
              // no-op: `showCase` resets the form, so re-entering the current
              // case would silently wipe a half-typed 失败说明.
              onJump={(index) => {
                if (index !== caseIndex) void showCase(index);
              }}
            />
          ) : null}
```
3. 工具栏 `.execution-toolbar` 里、快捷键提示之后加一行（desk 内 → 随 PiP 搬走）：

```tsx
          {cases.length > 0 ? (
            <span className="desk-progress">
              {cases.filter((item) => item.latest_result !== null).length}/{cases.length} · ✓
              {cases.filter((item) => item.latest_result === "通过").length} ✗
              {cases.filter((item) => item.latest_result === "不通过").length} ○
              {cases.filter((item) => item.latest_result === null).length}
            </span>
          ) : null}
```
> 计数口径必须与 `CaseGrid` 一致：`未执行`（跳过）算「已测」但**不计入** ✓ 或 ✗，所以它只体现在 `已测/总数` 里。这样 `已测 + 未测 === 总数` 恒成立，两侧不会打架。

- [ ] **Step 4: 实现（样式）**

`frontend/src/styles.css`（文件是压缩风格，一行一条规则；**跟随现有写法**，在 `.progress-pips` 那一行附近追加）：

```css
.case-grid-block { padding: 12px 18px 0; border-top: 1px solid #e7eaeb; }.case-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20px, 1fr)); gap: 4px; margin: 10px 0 8px; padding: 0; list-style: none; }.case-square { width: 100%; aspect-ratio: 1; min-height: 18px; padding: 0; border: 1px solid #cfd6d8; border-radius: 3px; background: #fff; cursor: pointer; }.case-square.passed { background: #e2f2e9; border-color: #1c6b45; }.case-square.failed { background: #fbe7e5; border-color: #a23b36; }.case-square.skipped { background: #fdf1d5; border-color: #7a6320; }.case-square.untested { background: #fff; }.case-square.current { outline: 2px solid #176b57; outline-offset: 1px; }.case-grid-legend { margin: 0; color: #7a8388; font-size: .7rem; }.desk-progress { color: #5c6a70; font-size: .74rem; font-weight: 700; white-space: nowrap; }
```

PiP 追加（放在 `.pip-surface …` 那一长串里，或紧跟其后另起一条）：

```css
.pip-surface .desk-progress { display: inline-flex; gap: 6px; font-size: .72rem; }.pip-surface .execution-toolbar { flex-wrap: wrap; row-gap: 6px; }
```
> 侧栏的方格**不需要** PiP 规则（它不搬进小窗），但 `.desk-progress` 必须能在 420px 宽下不换行溢出——`white-space: nowrap` + `.pip-surface` 的 `flex-wrap` 已覆盖；**验证时**按 Step 5 的 e2e 断言为准。

- [ ] **Step 5: 跑测试 + 构建 + 提交**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run && npm run build`
Expected: PASS + 构建干净。

```bash
git add frontend/src/views/Execution.tsx frontend/src/styles.css frontend/src/views/Execution.test.tsx
git commit -m "feat(execution): show the result grid in the sidebar and the counts in the desk"
```

---

### Task 6: 后端缺陷行字段重排 + 步骤截断

**Files:**
- Modify: `backend/app/lark/write.py`
- Test: `backend/tests/test_lark_outbox.py`

**背景：** 现在 `问题描述 = "{code} {title}\n{note}"`、`备注 = "由用例 {code} 提交（结果：{result}）\n{console}"`。改成：`问题描述` 只放失败说明；`备注` 放 `用例：{code} {title}` +（可选）`步骤：`（限 100 字）+（可选）`控制台：`。**不再写「结果」**（缺陷行只在 `不通过` 时产生），也不写 `优先级/进展状态/反馈时间/反馈人/截图`（缺陷表各有独立列）。

- [ ] **Step 1: 写失败的测试**

`backend/tests/test_lark_outbox.py`：
1. 改 `test_old_records_and_bugs_are_never_updated` 里对 `问题描述` 的三条断言：`问题描述` **等于** `"绑定未触发"`（`failed_attempt` 的 note），且 `"B-001" not in created["fields"]["问题描述"]`、`"【" not in ...`。
2. 改 `test_the_defect_remark_names_the_case_and_drops_the_marker`：`fields["备注"].splitlines()[0] == "用例：B-001 管理员登录"`（标题以 fixture 里的 `group_case.title` 为准，先读 `conftest.py` 的 `failed_attempt`/`confirmed_group` 确认真实字符串，不要照抄本文档）、`"wallet.bind timeout" in fields["备注"]`、`"控制台：" in fields["备注"]`、`"结果：" not in fields["备注"]`。
3. 改 `test_...`（第 ~308 行那条断言 `bug["fields"]["问题描述"] == "B-001 管理员登录\n登录接口返回 500"`）：改成 `== "登录接口返回 500"`，并加 `bug["fields"]["备注"].startswith("用例：B-001 管理员登录")`。
4. 新增 4 条 `clip_steps` 单测（直接 import `from app.lark.write import clip_steps`）：
   - 短步骤原样返回、不含指针；
   - 恰好 100 字原样返回；
   - 超长时按整行截断并追加 `…（完整步骤见用例 B-001）`，且长度 > 100（指针本身不算在 100 里）；
   - 第一行就超长时硬切到 100 字再追加指针；
   - `None` / 空串返回 `None`。
5. 新增：`不通过` 但 `note` 为空串时 `问题描述` 回落到 `"B-001 管理员登录"`（防出空描述；这条只能直接调 `bug_fields` 构造）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_outbox.py -q`
Expected: FAIL（`clip_steps` 不存在 / 断言不匹配）。

- [ ] **Step 3: 实现**

`backend/app/lark/write.py`：

```python
# A defect row carries the first slice of the steps so a reader can judge what
# was being done, and a pointer back to the case for the rest: writing all of it
# buries the report, writing none of it makes the defect unreproducible.
STEP_CLIP_LIMIT = 100
STEP_CLIP_NOTE = "…（完整步骤见用例 {code}）"


def clip_steps(steps: str | None, code: str, limit: int = STEP_CLIP_LIMIT) -> str | None:
    """The steps a defect row carries: a whole-line prefix plus where to read the rest."""

    text = (steps or "").strip()
    if not text:
        return None
    if len(text) <= limit:
        return text
    # Cut on a line boundary so no step is left half-written; a single line
    # longer than the limit has no boundary to cut on and is clipped outright.
    prefix = ""
    for line in text.splitlines():
        candidate = f"{prefix}\n{line}" if prefix else line
        if len(candidate) > limit:
            break
        prefix = candidate
    if not prefix:
        prefix = text[:limit]
    return f"{prefix}{STEP_CLIP_NOTE.format(code=code)}"
```

`bug_fields()` 里把 `description` / `remark` 两段换成：

```python
    note = (attempt.note or "").strip()
    # The defect table itself answers "with what result": only a failure opens a
    # row here, so repeating 结果 would be noise. 问题描述 keeps the operator's
    # own words and nothing else.
    description = note or f"{case.code} {case.title}"
    lines = [f"用例：{case.code} {case.title}"]
    steps = clip_steps(case.steps, case.code)
    if steps:
        lines.append(f"步骤：{steps}")
    console = attempt.console_text or ""
    if console:
        lines.append(f"控制台：{console}")
    fields: dict[str, Any] = {
        "问题描述": description,
        "进展状态": OPEN_BUG_STATUS,
        "优先级": _priority(case.priority, BUG_PRIORITY_OPTIONS),
        "反馈时间": _milliseconds(attempt.created_at),
        "备注": "\n".join(lines),
        "截图": _attachment_value(attachments or []),
    }
```
> `description = note or ...` 的回落在正常数据流下走不到（`execution.py:35-37` 的校验保证 `不通过` 必有说明），留着是为了不让一条空描述进表；注释要写清这一点。

- [ ] **Step 4: 跑测试确认通过 + 全量后端 + 提交**

Run: `cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_outbox.py -q && ... -m pytest -q`
Expected: PASS（全量 424 passed 上下）。

```bash
git add backend/app/lark/write.py backend/tests/test_lark_outbox.py
git commit -m "feat(lark): keep the defect description clean and move the case into the remark"
```

---

### Task 7: 读回——通过「备注」把本工具新写的缺陷行认回来

**Files:**
- Modify: `backend/app/lark/fields.py`（新增 `REMARK_FIELDS`）
- Modify: `backend/app/lark/history.py`
- Test: `backend/tests/test_lark_history.py`

**背景（不做的后果）：** `match_bugs()` 只在 `问题描述/缺陷描述/描述` 里匹配「开头就是编号」的文本。Task 6 之后编号已经不在 `问题描述` 里了——**不改这一步，本工具新写的缺陷行会永远显示「未匹配到旧缺陷」**。

- [ ] **Step 1: 写失败的测试**

`backend/tests/test_lark_history.py` 追加：
1. `"a defect row this tool wrote is matched through its remark"` —— 记录形如
   `{"record_id": "new1", "fields": {"问题描述": "登录接口返回 500", "备注": "用例：B-001 管理员登录\n步骤：1. 打开登录页\n控制台：wallet.bind timeout", "进展状态": "待修复"}}`，
   断言 `match_bugs(records, "B-001")` 命中它、`matches[0]["matched_by"] == "备注"`、`matches[0]["description"] == "登录接口返回 500"`。
2. `"the remark label keeps the code boundary"` —— 备注为 `"用例：B-0010 另一个用例"` 的行**不得**被 `"B-001"` 命中；`"用例：B-001 管理员登录"` 的行可以。
3. `"a remark without the label is not a match"` —— `{"备注": "B-001 管理员登录"}`（没有 `用例：` 标签）不命中，避免把任意文本当编号。
4. `"existing description matching still works"` —— 旧行（`问题描述` 以编号开头）仍然命中，`matched_by` 仍是字段名。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL='postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test' .venv/bin/python -m pytest tests/test_lark_history.py -q`
Expected: 第 1 条 FAIL（未匹配）。

- [ ] **Step 3: 实现**

`backend/app/lark/fields.py`，在 `DESCRIPTION_FIELDS` 下加：

```python
# The remark is where this tool now files the case a defect came from, so the
# read-back has to look there too — the description carries only the failure.
REMARK_FIELDS = ("备注",)
```

`backend/app/lark/history.py`：
1. import 里补 `REMARK_FIELDS`。
2. 在 `parse_labelled_case_reference` 之后加：

```python
# The remark names the case after a label ("用例：B-001 管理员登录"), so the code
# is not at the start of the text; the same token rules apply from the label on.
CASE_LABEL = re.compile(r"用例\s*[:：]\s*")


def parse_remark_case_reference(text: str | None) -> CaseReference | None:
    if not text:
        return None
    match = CASE_LABEL.search(text)
    if match is None:
        return None
    return parse_case_reference(text[match.end() :])
```

3. `match_bugs()` 里，在 `DESCRIPTION_FIELDS` 那轮之后、`if matched_by is None: continue` 之前插入第三轮：

```python
        if matched_by is None:
            for name in REMARK_FIELDS:
                reference = parse_remark_case_reference(str(fields.get(name) or ""))
                if reference is not None and reference.code == code:
                    matched_by = name
                    break
```

> `description` 的取值逻辑不变（仍是 `DESCRIPTION_FIELDS` 里第一个非空值），所以新行的 `description` 就是失败说明本身。

- [ ] **Step 4: 跑测试确认通过 + 全量后端 + 提交**

Run: 同 Task 6 的两条命令。
Expected: PASS。

```bash
git add backend/app/lark/fields.py backend/app/lark/history.py backend/tests/test_lark_history.py
git commit -m "feat(lark): read our own defect rows back through the remark label"
```

---

### Task 8: e2e 收口

**Files:**
- Modify: `frontend/e2e/execution.spec.ts`
- Modify: `frontend/e2e/pip.spec.ts`（如需要）
- Test: `npx playwright test`

**背景：** 单元测试覆盖不到「真浏览器里保存后真的跳走」和「画中画小窗里真的有进度行」。e2e 的 API 是 mock 的（`page.route("**/api/**")`），所以桩数据要自己给全。

- [ ] **Step 1: 写用例**

`frontend/e2e/execution.spec.ts` 新增一条 `test("a save moves the desk to the next unrun case", ...)`：
1. mock 三条例例（B-001 `通过` / B-002 `null` / B-003 `null`），`/progress` 给 `{passed:1,failed:0,skipped:0,untested:2}`；
2. `GET .../cases/B-002/attempts` 与 `B-003/attempts` 都返回 `[]`；`POST .../cases/B-002/attempts` 返回一条 `result:"通过"` 的 committed attempt；
3. 断言打开时标题是 B-002；点「通过」→ 点「保存结果」→ 断言 B-003 的标题可见、`已保存到本地` 仍可见、侧栏方格 `.case-square.passed` 数量变成 2；
4. 最后断言 `document.documentElement.scrollWidth <= window.innerWidth`（沿用文件里既有的溢出断言写法）。

`frontend/e2e/pip.spec.ts` 的第三条用例里补：断言 PiP 页里 `pipPage.getByText(/1\/1|1\/2/)` 之类的进度行可见（用该文件桩数据算出的真实数字），并保留既有的「无横向溢出」断言。

- [ ] **Step 2: 跑 e2e**

Run: `cd /home/lucascool/qa-board/frontend && npx playwright test`
Expected: 全部 passed（基线 20 条 + 新增）。

- [ ] **Step 3: 提交**

```bash
git add frontend/e2e/execution.spec.ts frontend/e2e/pip.spec.ts
git commit -m "test(e2e): cover auto-advance and the progress line inside the PiP window"
```

---

## 收口（Task 8 之后）

- [ ] 四条门槛一次性跑完并贴输出：`backend pytest -q`、`frontend npx vitest run`、`npm run build`、`npx playwright test`。
- [ ] `git diff --check` 与 `git status --porcelain` 干净。
- [ ] 派一个**独立**的最终 reviewer 子代理（只读）做整体复审：①逐条对照 spec 的行为规格；②区分「实现缺陷」与「spec 本身的缺口」；③允许它说「spec 没写但应该写」。
- [ ] 更新 `task_plan.md` / `progress.md`（勾掉任务、记 commit 与测试数字）。
- [ ] 把实现分支的去留（合并 / PR / 保留）交回人类决定——**不要自己合进 `main`**。


---

## 实施期修正汇总（Task 3–8，权威以 spec 的「二、F」与附录 D1 为准）

本计划正文里 Task 3/4/5 的代码片段在实施与两段评审后有几处**已被证伪或收紧**，后来者请以本节 + spec 为准，不要照抄正文片段：

1. **Task 3 的守卫不是下标而是访问令牌**：`const savedVisit = caseRequest.current`，用例范围的写入用 `loadedGroup.current === savedGroupId && caseRequest.current === savedVisit`；`caseIndexRef` 已删除（下标分不出「一直没走开」与「走开又回到同一下标」）。
2. **Task 3 的迟到写入全部要同一对守卫**，不止跳转：`setAttempts`、`setLastAttemptId`、`setImages([])`、表单复位、`startRetest` 的迟到预留，全部（`503ec7e`、`6309db4`、`ade273d`）。`setStatus` 刻意不门控（它是事件通知、自带编号）。`setCases`/`setSync` 只按组门控（见附录 O9 的残留风险）。
3. **截图没传成功就不前进**：`advanceTo = uploaded ? nextUntestedIndex(updated, savedIndex) : null`（`d94ccf5`）。
4. **Task 4 的组件类型**：`Record<string, string>` 在 `strict` 下 TS7053，必须用字面量联合 `Tone`；并且这套分类只允许存在一份（`frontend/src/caseTone.ts`，网格与 desk 计数共用，`e26e5a7`）。
5. **Task 5 的进度行**：四计数全写出（含跳过），不是 `✓/✗/○` 三符号版（`8c80b7a`）。
6. **Task 5 的 `onJump` 必须短路同下标**；并且 `cases` 进入 state 前要经 `asCaseList()` 挡住非数组载荷（`622fb6b`）。
7. **Task 6/7 的读回规则**：「`备注` 第一行标签权威 + 描述已识别编号则否决松散兜底」（`af72c36` → `8c80b7a`）。计划正文描述的「第三轮扫描」单独一条**不够**，会同时产生错配与漏配。
8. 测试夹具强度：进度/计数类断言的夹具必须让计数**两两不同**，否则 `✓`/`✗` 互换也能全绿（`574ab12` 的夹具缺「未执行」行即为此例）。

9. **（2026-09-18，`22b621a`）附录 G 的 O1/O2/O3/O10 已修**：幂等签名加 `savedGroupId`；`submitting` 改成在飞计数器；`LegacyHistory` 的复测按钮加 `disabled`（同时关掉 O3b 的入口，并让 spec「二、F」第 4 条的收窄在 UI 上不可达）；保存的 catch 按「提交失败」与「提交后读取失败」分别措辞，并把预留退租挪到提交后读取链完成时（否则读取失败后重试会多写一行，`a9b227a`）。独立复审又抓出「改载荷重试 → 409 却仍说可重试」的死胡同，已单独措辞（`d5a1433`），并给在飞计数加了 `finally` 配平与零下限。O1 的症状描述已更正为 409 循环。仍开放：O3b 的剩余形态、O8、O9、O11、O12。详见 spec 附录 G 的状态段。
