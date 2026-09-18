# Lark 检查页重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「连接本组的 Lark 多维表格」重写成「一行状态条 + 4 步向导」，并把 schema 判决从读取时快照改成按当前选中表派生，从而根治红字不销的缺陷。

**Architecture:** 后端加一个只读接口 `POST /api/lark/table-schema`（按 `table_id` + `role` 现读字段并算缺失表头）；前端引入纯逻辑模块 `larkDraft.ts`（draft / probes / verdict / health，全部纯函数，可单测）+ `useLarkDraft` hook（唯一改动状态的地方）；页面拆成 3 个破坏性对话框 + 4 个步骤组件，`LarkCheck.tsx` 只做编排。

**Tech Stack:** React 19 + TypeScript(strict) + Vitest/RTL（前端）· FastAPI + pydantic + pytest（后端）· Playwright（e2e）· 无新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-18-lark-check-page-redesign-design.md`（裁决任何歧义以规格为准；本计划的 §Interfaces 是规格 §4/§6/§7 的可执行展开）

## Global Constraints

以下每一条都是**每个 task 隐含的需求**，逐字取自规格：

1. **判决只有一个来源**：schema verdict 只能来自 `probes[`${table_id}:${role}`]`，渲染时按当前选中的表派生。**禁止**把 `resolved.schema_errors` / `resolved.execution_fields` 当作切表后的判决。
2. **未校验就是未校验**：表没有 probe → 渲染「尚未校验这张表」+ 校验入口；既不许借用别的表的结论，也不许显示空白。
3. **base 必须同源**：`base` 只在 `base.source_url === url.trim()` 时有效；编辑链接框即作废该 role 的 `base` 与判决（`baseIsCurrent`）。
4. **健康态预算**：状态条 1 行 + 4 行步骤标题，页面内**没有** `role="alert"`（异常态允许有）。
5. **两个必须主动提醒的条件**：① `live.schema_errors` 非空 → 状态条变红 + 第 ② 步自动展开；② `sync.failed / uncertain / parked` 任一 > 0 → 状态条变红/黄 + 第 ④ 步自动展开。目标表被别处改过**不**属于提醒条件（保存时 409 已能拦）。
6. **破坏性确认不许被吃掉**：设置表头 / 修正表头类型 / 重建数据表三个动作各自的确认弹窗与 `acknowledge` 流程原样保留；**安全相关文案逐字不改**（非安全说明句可精简）。
7. **零新增运行时依赖**：只允许 `react` / `react-dom` / `lucide-react`（现有）。不许引入状态库、表单库、日期库。
8. **类型门**：`cd frontend && npm run build`（= `tsc -b && vite build`，`strict: true`）必须通过。**vitest 不做类型检查**，所以每步都要跑 build，不能只跑测试。
   **注意 build 覆盖不到 e2e**：`tsconfig.app.json` 只 `include: ["src"]`，`playwright.config.ts` 不在 references 里 → e2e 的 TS 错误只有真跑 `npx playwright test` 才暴露。仓库也没有 lint 脚本、没开 `noUnusedLocals` → 被删掉的死 state 只能用 grep 审计证明（Task 6 里给可执行命令）。
9. **窄屏**：360px 宽不得横向溢出（`document.documentElement.scrollWidth <= window.innerWidth`）；单列容器沿用 `.lark-check-layout`（max-width 900px）。
10. **后端**：`/api/lark/table-schema` 只读、不写库、**不新增迁移**；与 `/lark/resolve` 同一个 router（`dependencies=[Depends(require_admin), Depends(refuse_archived_group)]`）；入参 token 必须走与保存路径同样的路径注入校验；**任何测试都不许打真实 Lark 租户**。
11. **删 CSS 规则前先看它是否与别的弹窗共享选择器行**：`styles.css:161` / `:221` 那两行里，`.header-setup-overlay` / `.header-setup-dialog` 与 `TargetChangeDialog`、对账、归档弹窗**同行**。整行删除会让那三个弹窗失去遮罩，而 **vitest 不会红**。本轮结论：这两行**不动**；只删 `.lark-healthy`、`.lark-facts`、`.lark-fields` / `.lark-field`、`.lark-roles`。注意 `lark-role`（新，保留）与 `lark-roles`（旧，删）的字串陷阱 —— grep 要带词边界。

**环境与命令（已在本机逐条跑过，基线如下）**

```bash
# 前端单测（vitest 默认 watch，必须带 run）
cd /home/lucascool/qa-board/frontend && npx vitest run src/larkDraft.test.ts
# 前端类型 + 产物（基线：✓ built in 1.32s，dist/assets/index-li5seUpy.js）
cd /home/lucascool/qa-board/frontend && npm run build
# e2e（改动后期望 **14 passed = 7 用例 × 2 视口**；Task 7 在原有 6 条上又加了「门 1 回归」与「门 5 第一条吵醒条件」两条。
#      e2e 的类型错误不被 build 覆盖，只能真跑）
cd /home/lucascool/qa-board/frontend && npx playwright test e2e/lark-check.spec.ts
# 后端单测：uv 不在 PATH 上；TEST_DATABASE_URL 必须给（不给会 29 errors）
# 基线（改动前 HEAD）：29 passed in 3.25s（容器 testdeck-task2-postgres 已在 127.0.0.1:5433）
# Task 1 落盘后的期望：43 passed, 2 warnings（含新增用例，含参数化展开；此为 task-01 作者实测值）
# 若 Task 1 之后仍看到 29 → Task 1 没落盘，别往下走
cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_target.py -q
```

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `backend/app/lark/target.py` | 新增 `read_table_schema()` + `TableSchemaRequest` + `POST /lark/table-schema` | 修改 |
| `backend/tests/test_lark_target.py` | 新接口的契约测试 | 修改 |
| `frontend/src/api.ts` | `TableSchema` 类型 + `api.larkTableSchema` | 修改 |
| `frontend/src/larkDraft.ts` | **纯逻辑**：draft / probes / `verdictOf` / `baseIsCurrent` / `effectiveBase` / `describeHealth` / `stepsComplete` | 新建 |
| `frontend/src/larkDraft.test.ts` | 上述纯函数的单测（门 2/3/5 的逻辑层） | 新建 |
| `frontend/src/hooks/useLarkDraft.ts` | 唯一改 draft 的地方：读链接、切表、校验、创建/重建后跟随、切组复位 | 新建 |
| `frontend/src/hooks/useLarkDraft.test.tsx` | hook 单测（门 1/3/7） | 新建 |
| `frontend/src/components/lark/StepSection.tsx` | 步骤外壳（一行标题 + 展开区） | 新建 |
| `frontend/src/components/lark/LarkHealthStrip.tsx` | 状态条（渲染 `Health`，可跳步） | 新建 |
| `frontend/src/components/lark/StepTables.tsx` | 第 ① 步：两个链接 + 读取 + 两个下拉 + 就地 verdict + 保存选择 | 新建 |
| `frontend/src/components/lark/StepHeaders.tsx` | 第 ② 步：plan 摘要 + 三个动作 + 建表入口 | 新建 |
| `frontend/src/components/lark/ProvisionDialog.tsx` | 设置表头（从 HeaderSetup 拆出） | 新建 |
| `frontend/src/components/lark/RetypeDialog.tsx` | 修正表头类型（从 HeaderSetup 拆出） | 新建 |
| `frontend/src/components/lark/RebuildDialog.tsx` | 重建数据表（从 HeaderSetup 拆出） | 新建 |
| `frontend/src/components/lark/StepApprove.tsx` | 第 ③ 步：勾选 + 确认 | 新建 |
| `frontend/src/components/lark/StepSync.tsx` | 第 ④ 步：队列统计 + 动作 + last_error | 新建 |
| `frontend/src/views/LarkCheck.tsx` | 编排：状态条 + 4 步 + 数据加载 + 对话框 | 重写（< 250 行） |
| `frontend/src/views/LarkCheck.test.tsx` | 页面级测试（门 1/4/5/6/8） | 重写 |
| `frontend/src/components/HeaderSetup.tsx` | 拆分后删除 | 删除 |
| `frontend/src/components/HeaderSetup.test.tsx` | 迁到三个对话框各自的测试 | 删除 |
| `frontend/src/styles.css` | 步骤外壳 / 状态条样式；删除 `.lark-roles` 等死样式 | 修改 |
| `frontend/src/App.tsx` | 多传一个 `readTableSchema={api.larkTableSchema}` | 修改 |
| `frontend/e2e/lark-check.spec.ts` | 选择器更新 + 两档视口 | 修改 |
| `frontend/mock-api.mjs` | 新增 `/api/lark/table-schema` 的 mock 响应 | 修改 |

## Interfaces

**这几段是所有 task 的公共契约。任何 task 不许改这里的名字、参数顺序或返回形状；需要改先回来改这一节。**

### 后端

```python
# backend/app/lark/target.py
class TableSchemaRequest(BaseModel):
    base_token: str
    table_id: str
    role: str          # "execution" | "bug"

@router.post("/lark/table-schema")
def table_schema(
    payload: TableSchemaRequest,
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    """200 → {"table_id": str, "fields": {字段名: 类型名}, "required": [str], "schema_errors": [str]}
       422 → 找不到该表 / role 非法 / token 形状非法
       409 → 应用不是协作者（PermissionError）
    """
```

### 前端 API 客户端

```ts
// frontend/src/api.ts
export type TableSchema = {
  table_id: string;
  fields: Record<string, string>;   // 字段名 → 类型名（describe_fields 的输出）
  required: string[];
  schema_errors: string[];
};

// 加在 `export const api = { ... }` 里，紧跟 resolveLark：
larkTableSchema: (baseToken: string, tableId: string, role: TableRole) =>
  mutation<TableSchema>("/api/lark/table-schema", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_token: baseToken, table_id: tableId, role })
  })
```

### 纯逻辑模块

```ts
// frontend/src/larkDraft.ts   —— 无 React、无副作用，全部可单测
import type { LarkResolved, LarkTarget, SyncStatus, Table, TableRole } from "./api";

export type Probe = {
  fields: Record<string, string>;
  required: string[];
  schema_errors: string[];
  read_error?: string;              // 表读不到时的原因
};
export type ProbeSlot = Probe | "loading";
export type LarkBase = {
  base_token: string;
  base_name: string;
  source_url: string;
  tables: Table[];
  read_errors: string[];
  probes: Record<string, ProbeSlot>;   // key = `${table_id}:${role}`
};
export type RoleDraft = { url: string; base: LarkBase | null; tableId: string; viewId: string | null };
export type Draft = { execution: RoleDraft; bug: RoleDraft };
export type Verdict = "unread" | "loading" | "ok" | "bad" | "unreadable";
export type StepId = "tables" | "headers" | "approve" | "sync";
export type Health = { tone: "ok" | "warn" | "bad"; text: string; step: StepId | null };
export type CompletedTable = Table & { base_token: string };

export function probeKey(tableId: string, role: TableRole): string;
export function verdictOf(slot: ProbeSlot | undefined): Verdict;
export function baseIsCurrent(role: RoleDraft): boolean;
export function effectiveBase(draft: Draft, role: TableRole): LarkBase | null;  // bug: draft.bug.base ?? draft.execution.base（且都要 baseIsCurrent）
export function probeFor(draft: Draft, role: TableRole): ProbeSlot | undefined;
export function verdictFor(draft: Draft, role: TableRole): Verdict;
export function nameOf(tables: Table[], tableId: string): string;
export function suggestBugTable(tables: Table[], executionTableId: string, target: LarkTarget | null): string;
export function withCreatedTable(tables: Table[], created: CompletedTable | null, baseToken: string): Table[];
export function emptyDraft(): Draft;
export function draftFromTarget(target: LarkTarget | null): Draft;
export function describeHealth(input: {
  target: LarkTarget | null;
  liveErrors: string[];        // state.read_errors + live.read_errors
  schemaInvalid: boolean;      // live.schema_errors.length > 0
  sync: SyncStatus | null;
}): Health;
export function stepsComplete(
  draft: Draft,
  target: LarkTarget | null,
  sync: SyncStatus | null
): Record<StepId, boolean>;
```

`describeHealth` 的判定顺序（**顺序本身就是契约**）：

| # | 条件 | tone | step |
|---|---|---|---|
| 1 | `!target` | `warn` | `tables` —— 「尚未选择 Lark 表：请在第 1 步粘贴链接并保存」 |
| 2 | `liveErrors.length > 0` | `bad` | `headers` —— `目标表读取失败：${liveErrors[0]}` |
| 3 | `schemaInvalid` 且已确认 | `bad` | `headers` —— 「已确认，但表头已失效（需重新校验）」 |
| 4 | `schemaInvalid` 且未确认 | `bad` | `headers` —— 「表头缺失，尚不能确认写入」 |
| 5 | `sync.failed + sync.uncertain > 0` | `bad` | `sync` —— `同步失败 ${failed} 条 · 待人工确认 ${uncertain} 条` |
| 6 | `sync.parked > 0` | `warn` | `sync` —— `待管理员处理 ${parked} 条` |
| 7 | `!target.confirmed` | `warn` | `approve` —— 「未确认：本地结果不会写入 Lark」 |
| 8 | 否则 | `ok` | `null` —— `已确认 · ${execution_table_name} / ${bug_table_name} · 待同步 ${queued} · 失败 0` |

### hook

```ts
// frontend/src/hooks/useLarkDraft.ts
export type LarkDraftActions = {
  draft: Draft;
  reading: TableRole | null;                       // 正在读取链接的 role
  checking: TableRole | null;                      // 正在校验表的 role
  setLink: (role: TableRole, url: string) => void;
  readLink: (role: TableRole) => Promise<TableRole | null>;   // 成功返回 role，失败返回 null（错误经 onError）
  setTable: (role: TableRole, tableId: string) => void;
  checkTable: (role: TableRole) => Promise<void>;
  // Round 1 复审 B7 补：provision / retype 修完表头后必须作废并重算受影响 role 的 probe，
  // 否则 bad 的判决会一直挂着，而"校验按钮只在 unread 时显示"又掐掉手动入口 →
  // 第 ③ 步「两表 verdict 均 ok 才可勾选」永远达不成（主路径断路）。
  invalidateRole: (role: TableRole) => void;
  recheckRole: (role: TableRole) => Promise<void>;
  acceptCreatedTable: (role: TableRole, table: Table) => void;
  acceptRebuiltTable: (role: TableRole, table: Table, replaced: Table) => void;
  resetDraft: (target: LarkTarget | null) => void;
};

export function useLarkDraft(opts: {
  groupId: string;
  resolve: (url: string) => Promise<LarkResolved>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  onError: (message: string) => void;
}): LarkDraftActions;
```

行为契约：
- `setLink` 只改 `url`；**同时把该 role 的 `base` 置 `null`、`viewId` 置 `null`**（除非 `baseIsCurrent` 仍成立）。
- `readLink` 成功：写入该 role 的 base（含 `probes`），`tableId` = `resolved.selected.table_id ?? tables[0].table_id`，`viewId` = `selected.view_id`；并把 `resolve` 返回的 `schema_errors/fields` 作为 `execution` role 的**首个 probe 播种**（仅当 role === "execution" 且 table_id === selected.table_id）；随后对 `bug` role 的当前表**自动校验一次**（同库场景）。
- `checkTable` 走 `readTableSchema(base.base_token, tableId, role)`；成功写 probe，失败写 `{fields:{},required:[],schema_errors:[],read_error:message}`。
- `acceptRebuiltTable`：把该 role 的 `tableId` 指向新表、移除被替换表、新表 probe 置 `"loading"` 后自动 `checkTable`；并**作废另一 role 的 probe**（重建会改目标表）。
- `acceptCreatedTable`：新表 probe 置 `"loading"` 后自动 `checkTable`。
- `resetDraft(target)`：`emptyDraft()` 后用 `draftFromTarget(target)` 预填 url 与两个 tableId（`base` 仍为 `null` → 判决为 `unread`）。
- `groupId` 变化：draft 复位为 `emptyDraft()`。
- **`inFlight` 必须按 `base_token:table_id:role` 键控，并在 `finally` 里释放**（Round 1 复审 A3）：只按 `table_id:role` 键控会让"切 base 后对同名表的校验"被静默吞掉（不发请求也不报错，违反规格 §8 的"切 base 重新校验"）；不释放则一次挂死的 fetch 会让该表的校验按钮**永久失效**。
- **`loading` 只有一个真值源**：probe 槽位（`"loading"`）。`reading` / `checking` 仅用于禁用按钮，**不得**作为"是否在加载"的唯一依据；`checking` 必须按 `(role, table_id)` 而不是只按 role 判等，否则同 role 的两张表重叠校验会互相覆盖。
- **`acceptRebuiltTable` 必须同时跟随两个 role**（Round 1 复审 A4）：重建会替换表本身，若另一 role 的 `tableId` 恰好等于被替换表的 id，也要一并指向新表；否则会留下指向已消失表的下拉值（后端 409 能兜住，但不该走到那一步）。
- **`recheckRole(role)`** = 作废该 role 当前表的 probe 后立刻重算（等价 `invalidateRole` + `checkTable`）；`StepHeaders` 在 provision / retype 成功后**必须**调用它（B7 的修复点）。

### 组件

```ts
// components/lark/StepSection.tsx
type StepSectionProps = {
  index: number;                                   // 1..4
  title: string;
  summary: string;                                 // 收起时那一行
  state: "done" | "open" | "todo" | "attention";
  disabled?: boolean;
  onOpen: () => void;
  children?: ReactNode;
};

// components/lark/LarkHealthStrip.tsx
type LarkHealthStripProps = { health: Health; onJump: (step: StepId) => void };

// components/lark/StepTables.tsx
type StepTablesProps = {
  draft: Draft;
  target: LarkTarget | null;
  reading: TableRole | null;
  checking: TableRole | null;
  saving: boolean;
  onLinkChange: (role: TableRole, url: string) => void;
  onRead: (role: TableRole) => void;
  onTableChange: (role: TableRole, tableId: string) => void;
  onCheck: (role: TableRole) => void;
  onSave: () => void;
};

// components/lark/StepHeaders.tsx
type StepHeadersProps = {
  groupId: string;
  target: LarkTarget | null;
  // plan 的加载职责留在 StepHeaders 内部（沿用 HeaderSetup 的既有做法：页面只传函数，
  // 见改造前 LarkCheck.tsx:703-722），因此没有 plan / planError 入参。
  loadPlan: (groupId: string) => Promise<ProvisionPlan>;
  // 换测试组时重挂载三个对话框，等价改造前 HeaderSetup 的换组复位（:198-208）。
  resetKey?: string;
  busy: boolean;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  targetFingerprint: string;
  schemaFingerprint: string | null;
  bases: Record<TableRole, string>;
  tableNames: Record<TableRole, string>;
  onChanged: () => Promise<void>;
  // Round 1 复审 B7 补：provision / retype 成功后必须让该 role 的判决重算（页面把它接到
  // useLarkDraft 的 recheckRole 上）。没有这个回调，"表头修好了但步骤③永远不可勾选"。
  onRoleFixed: (role: TableRole) => void;
  onTableCreated: (role: TableRole, table: Table) => void;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
};

// components/lark/StepApprove.tsx
type StepApproveProps = {
  target: LarkTarget | null;
  confirmed: boolean;
  invalidated: boolean;
  blocked: boolean;
  allowWrites: boolean;
  busy: boolean;
  onAllowWrites: (value: boolean) => void;
  onConfirm: () => void;
};

// components/lark/StepSync.tsx
type StepSyncProps = {
  sync: SyncStatus | null;
  confirmed: boolean;
  queueing: boolean;
  retrying: boolean;
  onEnqueue: () => void;
  onRetry: (releaseUncertain: boolean) => void;
};
```

### 页面

```ts
// views/LarkCheck.tsx —— Props 在现有 13 项之外只增加最后一项 readTableSchema。
// 逐项列全（不要用省略号打发：执行者要能逐行比对）：
type Props = {
  loadGroups: () => Promise<Group[]>;
  resolve: (url: string) => Promise<LarkResolved>;
  loadTarget: (groupId: string) => Promise<LarkTargetState>;
  saveTarget: (groupId: string, payload: LarkTargetPayload) => Promise<{
    target: LarkTarget;
    live: LarkTargetState["live"];
    confirmation_cleared: boolean;
  }>;
  confirmTarget: (groupId: string, targetFingerprint: string) => Promise<LarkTarget>;
  loadSync?: (groupId: string) => Promise<SyncStatus>;
  enqueueSync?: (groupId: string) => Promise<SyncEnqueueResult>;
  retrySync?: (groupId: string, releaseUncertain?: boolean) => Promise<{ requeued: number; released: number; repointed?: number }>;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  initialGroupId?: string;
  // ↓ 唯一新增：表级校验（Task 2 加进 api.ts；App.tsx 传 api.larkTableSchema）
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
};
```

---

## Task 索引

| # | Task | 交付物 | 主要覆盖的验收门 |
|---|---|---|---|
| 1 | 后端 `/api/lark/table-schema` | 只读接口 + pytest | — |
| 2 | `api.ts` 客户端 + `larkDraft.ts` 纯逻辑 | 纯函数 + 单测 | 2、3、5（逻辑层） |
| 3 | `useLarkDraft` hook | 唯一改 draft 的入口 + 单测 | 1、3、7 |
| 4 | 拆出三个破坏性对话框 + `StepHeaders` | `HeaderSetup.tsx` 删除 | 6 |
| 5 | `StepSection` / `LarkHealthStrip` / `StepTables` / `StepApprove` / `StepSync` | 5 个展示组件 + 单测 | 4（组件层） |
| 6 | `LarkCheck.tsx` 重写 | 状态条 + 4 步向导 | 1、4、5、8 |
| 7 | e2e + mock + 清理 + 全量门 | 全绿 + 提交 | 8、9 |

## 规格覆盖对照（计划自检 §1 的产物）

**每一条规格都必须有一个 Task 认领它**；没有认领的条目就是漏项。下表是自检时逐条核出来的（若将来改动计划，回来同步这张表）。

| 规格 | 内容 | 落在哪 |
|---|---|---|
| §1.1 | 红字不销缺陷（含复现输出与根因） | Task 6 Step 1–4（**门 1 先红后绿**）+ Task 2/3（probe 模型从结构上根治） |
| §1.2 | 啰嗦的量化清单 | Task 5（组件收敛 + 样式）+ Task 6（状态条 / 四步 / 长文降级） |
| §2 D1–D6 | 六条已确认决策 | 全文约束 + 各 Task |
| §4.1 | 两层 state（`LarkBase.probes` / `Draft` / `TargetState`） | Task 2 |
| §4.2 | 派生规则 + `verdictOf` 判定树 + `baseIsCurrent` | Task 2（含单测） |
| §4.3 | 与旧 state 的对应表 | Task 3（迁移）+ Task 6（删旧 state 的 grep 审计） |
| §4.4 | 保存路径（PUT 响应更新 `TargetState`） | Task 6 |
| §5.1 | 状态条 8 条判定顺序 | Task 2（`describeHealth`）+ Task 5（渲染）+ Task 6（接线） |
| §5.2 | 四步与各自的可达条件 | Task 5 + Task 6 |
| §6 | 组件与文件边界 | §File Structure + Task 4 / Task 5 |
| §7 | 后端契约（`/api/lark/table-schema`） | Task 1 |
| §8 | 错误处理边界（10 行表格） | Task 2 / Task 3（probe 三态、切 base、创建/重建）+ **Task 3b（B7 / A3 / A4）** + Task 6（409 两分支） |
| §9 | 九条验收门 | 见下表 |
| §10 | 我不动的东西 | Global Constraints 7 / 10 / 11 + Task 7 的保留清单 |
| §11 | 落地顺序 | Task 1 → 7 的顺序即为其展开 |
| §12 P1 / P2 / P3 | 三条待拍板（未答复，按默认值执行） | P1 → Task 4 的文案裁定表（保留 14 句 / 精简 8 句）；P2 → Task 6 第 ② 步 `HEADER_HINT`（显示提示、不禁止进入）；P3 → Task 7（`test-results/*.png` 接受覆盖） |

**门 → Task 映射**

| 门 | 主责 Task |
|---|---|
| 1 缺陷回归 | Task 3（hook 层）/ Task 5（组件层）/ **Task 6 Step 1–4（页面级先红后绿）** / Task 7（e2e） |
| 2 不串味 | Task 2 / Task 5 |
| 3 unread 诚实 | Task 2 / Task 3 / Task 5 / Task 6 |
| 4 健康态预算 | Task 5（组件层）/ Task 6（页面层） |
| 5 两个吵醒条件 | Task 2（`describeHealth`）/ Task 6（自动展开）/ Task 7（e2e 两条） |
| 6 安全确认不被吃掉 | Task 4（37 例迁移 + 文案裁定）/ Task 6（对话框可达） |
| 7 probe 缓存 | Task 3 |
| 8 窄屏两档视口 | Task 7 |
| 9 全绿 | Task 1（后端 pytest）/ Task 7（build + 全量 vitest + playwright） |

> **已知的不可判定项（自检时主动披露，不藏）**：
> 1. 门 9 的"前端全量"在 CI 里只跑 `npx vitest run`，**删测试也能全绿** → 由 Task 7 的用例数算式（基线 256 − 39 − 37 + 新增）堵住，但它是"算出来的"而不是"锁死的"，执行者必须真的核数。
> 2. e2e 的 TS 错误不被 `npm run build` 覆盖（`tsconfig.app.json` 只 `include: ["src"]`）→ 只有真跑 playwright 才暴露。
> 3. 仓库没有 lint 脚本、没开 `noUnusedLocals` → 死代码只能靠 Task 6 给出的 grep 审计命令证明。

> **Round 1 复审补丁：位置一律用锚点文本 + grep 自证，不再用行号（2026-09-18）**
> 复审 A1/A2 指出：本文件里凡是"第 N 行"的数字都会因为前面步骤的插入而漂移。尤其 Step 6 原写"从 `target.py:335` 起改 `_validate_target_tokens`"——位移后那一行落在 `locked_target_for` 的 docstring 里（原文 253 行），**按行号施工会改错地方**。下文每个插入/替换步骤都改成"锚点文本 + 自证命令"。

> **Round 1 复审补丁：位置一律用锚点文本 + grep 自证，不再用行号（2026-09-18）**
> 复审 A1/A2 指出：本文件里凡是"第 N 行"的数字都会因为前面步骤的插入而漂移。尤其 Step 6 原写"从 `target.py:335` 起改 `_validate_target_tokens`"——位移后那一行落在 `locked_target_for` 的 docstring 里（原文 253 行），**按行号施工会改错地方**。下文每个插入/替换步骤都改成"锚点文本 + 自证命令"。

### Task 1: 后端 `POST /api/lark/table-schema`（按表 + 角色现读表头判决）

**Files:**
- Modify `backend/app/lark/target.py` —— 顶部加 `import re`（插入锚点见 Step 4）
- Modify `backend/app/lark/target.py` —— 在 `@router.post("/lark/resolve")` 那个函数的 `except PermissionError` 之后、`def target_for(` **之前**插入一整块（**81 行**，实测行数；原写 83 有误）
- Modify `backend/app/lark/target.py` —— 把 `def _validate_target_tokens(payload: TargetRequest) -> None:` 的函数体拆成「一个 id 的判定」`_refuse_bad_token` + 「四个 id 的编排」；判定逻辑与消息**逐字照搬**（只抽函数，不改行为）
- Test `backend/tests/test_lark_target.py` —— import 区两处：加 `from sqlalchemy import event, select, text`；`from app.lark.fields import (...)` 扩成三项（锚点见 Step 1）
- Test `backend/tests/test_lark_target.py` —— 在 `def _payload(table_id: str, *, expected_previous_fingerprint=None, acknowledge=False):` 这一行**之前**插入 9 个测试函数 / 14 个用例（整块 **254 行**，实测行数；原写 240 有误）
- Create：无。不新增文件、不加迁移、不引入依赖、不碰前端

**Interfaces:**

**Consumes**（都已存在；本 task 不改它们的签名与行为）

```python
# backend/app/lark/client.py:454 / :429 / :34
def list_fields(self, app_token: str, table_id: str) -> list[dict[str, Any]]
def list_tables(self, app_token: str) -> list[dict[str, Any]]
class LarkError(RuntimeError)

# backend/app/lark/link.py:14 / :17
SOURCE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TABLE_ID = re.compile(r"^tbl[A-Za-z0-9_-]+$")

# backend/app/lark/fields.py:99 / :103 / :50 / :61
def describe_fields(fields: Iterable[dict[str, Any]]) -> dict[str, str]
def missing_required_fields(
    fields: Iterable[dict[str, Any]], required: dict[str, tuple[int, ...]]
) -> list[str]
REQUIRED_RUN_FIELD_TYPES: dict[str, tuple[int, ...]]   # 8 列，含「截图」
REQUIRED_BUG_FIELD_TYPES: dict[str, tuple[int, ...]]   # 8 列，也含「截图」(fields.py:73)

# backend/app/lark/target.py:61
def _missing_credential() -> str | None

# backend/app/lark/target.py:31-34 —— 新路由挂同一个 router 即继承，不重复声明
router = APIRouter(
    prefix="/api",
    dependencies=[Depends(require_admin), Depends(refuse_archived_group)],
)
```

**Produces**（骨架 §Interfaces 逐字；名字、参数顺序、返回形状一个字都不许改）

```python
# backend/app/lark/target.py
class TableSchemaRequest(BaseModel):
    base_token: str
    table_id: str
    role: str          # "execution" | "bug"

def read_table_schema(
    client: LarkClient, base_token: str, table_id: str, role: str
) -> dict[str, Any]
    # 200 → {"table_id": str, "fields": {字段名: 类型名}, "required": [str], "schema_errors": [str]}
    # LookupError → 路由映射 422（表不存在 / role 非法）
    # PermissionError → 路由映射 409（应用不是协作者 / 凭据未配置）
    # token 形状非法：直接抛 HTTPException(422)，消息与保存路径逐字相同

def _refuse_bad_token(label: str, value: str, pattern: re.Pattern[str]) -> None
    # 422，detail = f"{label} 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接"
    # _validate_target_tokens 与本接口共用它，消息与判定字符集都不变

@router.post("/lark/table-schema")
def table_schema(
    payload: TableSchemaRequest,
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]
```

**覆盖**：规格 §7 全部四条（入参 / 出参 / 422 / 409，含「happy path 只 1 次 Lark 请求」与「`list_fields` 不在缓存范围内」）· §8 的「表读不到」与「应用没权限」两条边界 · 计划 §9 门 9 的后端 pytest 部分。不涉及前端验收门。

**只读**：不写库、不加迁移、不新增依赖。**任何测试都不打真实 Lark 租户** —— 全部沿用 `conftest.py` 的 `lark_fake`（`httpx.MockTransport` + `app.dependency_overrides[get_lark_client]`，见 `conftest.py:716-737`）。

**判决口径**（写实现时不要自由发挥）：`required` 与 `schema_errors` 都由 `role` 决定 —— `execution` 用 `REQUIRED_RUN_FIELD_TYPES`、`bug` 用 `REQUIRED_BUG_FIELD_TYPES`；`fields` 一律用 `describe_fields` 的输出（字段名 → 类型名，`resolve` 也是这么返回的）。`role` 非法与 token 形状非法都发生在任何 Lark 调用之前。

---

- [ ] **Step 1: 先改测试文件的 import（两处）**

`backend/tests/test_lark_target.py` 顶部两处（`:5` 改一行、`:9` 单行变 5 行，其后的所有行号据此 +4）：

```diff
 from dataclasses import replace
 from datetime import datetime, timezone
 
 import pytest
-from sqlalchemy import select, text
+from sqlalchemy import event, select, text
 
 import app.lark.target as lark_target
 from app.config import settings
-from app.lark.fields import schema_fingerprint
+from app.lark.fields import (
+    REQUIRED_BUG_FIELD_TYPES,
+    REQUIRED_RUN_FIELD_TYPES,
+    schema_fingerprint,
+)
 from app.models import LarkTarget, LarkTargetRevision
```

- [ ] **Step 2: 在 `def _payload(...)` 之前插入 9 个失败测试**

把下面整块贴到 `backend/tests/test_lark_target.py` 里 `def _payload(table_id: str, *, expected_previous_fingerprint=None, acknowledge=False):` 这一行**之前**（保持前后各两个空行）。整块 **254 行**（实测行数；初稿写 240 有误），一个字都不用改 —— `_fresh_target` 与 `_table_schema` 的调用点都在同一文件里已存在 / 刚定义。
**自证位置**：`grep -n "def _payload" backend/tests/test_lark_target.py` —— 新块必须整块落在这一行上方，且这一行的**行号**在插入后必然变化，**不要**在后续步骤里引用它的旧行号。

```python
def _table_schema(client, *, base_token: str, table_id: str, role: str):
    return client.post(
        "/api/lark/table-schema",
        json={"base_token": base_token, "table_id": table_id, "role": role},
    )


def test_table_schema_judges_one_table_by_the_role_that_asked(
    lark_fake, authenticated_client
):
    """One table, two roles: the required set and the verdict both follow role."""

    lark_fake.fields = [
        field for field in lark_fake.fields if field["field_name"] != "截图"
    ]

    execution = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )
    bug = _table_schema(
        authenticated_client, base_token="app-exec", table_id="tbl-runs", role="bug"
    )

    assert execution.status_code == 200, execution.text
    assert bug.status_code == 200, bug.text
    assert execution.json()["table_id"] == "tbl-runs"
    assert bug.json()["table_id"] == "tbl-runs"
    # Both roles read the same table, so they see the same header.
    assert execution.json()["fields"] == {
        "用例": "text",
        "结果": "text",
        "优先级": "text",
        "负责人": "text",
        "报告人": "text",
        "日期": "date",
        "控制台": "text",
    }
    assert bug.json()["fields"] == execution.json()["fields"]
    assert execution.json()["required"] == sorted(REQUIRED_RUN_FIELD_TYPES)
    assert bug.json()["required"] == sorted(REQUIRED_BUG_FIELD_TYPES)
    assert execution.json()["required"] != bug.json()["required"]
    assert execution.json()["schema_errors"] == ["缺少必填字段「截图」"]
    # 截图 is in REQUIRED_BUG_FIELD_TYPES as well (app/lark/fields.py:73), so the
    # defect role reports the same missing column among its own: the list is
    # asserted verbatim rather than assumed to be the execution role's.
    assert bug.json()["schema_errors"] == [
        "缺少必填字段「问题描述」",
        "缺少必填字段「进展状态」",
        "缺少必填字段「跟进人」",
        "缺少必填字段「反馈时间」",
        "缺少必填字段「备注」",
        "缺少必填字段「反馈人」",
        "缺少必填字段「截图」",
    ]


def test_table_schema_reports_a_table_the_base_does_not_have(
    lark_fake, authenticated_client
):
    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-gone",
        role="execution",
    )

    assert response.status_code == 422, response.text
    assert "tbl-gone" in response.json()["detail"]
    # The field listing is the whole happy path; the table listing is bought only
    # because that read failed, and only to tell "gone" from "no permission".
    assert [
        request["path"]
        for request in lark_fake.requests
        if request["path"].endswith("/fields")
    ] == ["/open-apis/bitable/v1/apps/app-exec/tables/tbl-gone/fields"]
    assert [
        request["path"]
        for request in lark_fake.requests
        if request["path"].endswith("/tables")
    ] == ["/open-apis/bitable/v1/apps/app-exec/tables"]


@pytest.mark.parametrize(
    ("break_it", "expected"),
    [("fields", "协作者"), ("base", "多维表格")],
)
def test_table_schema_reports_a_read_the_app_is_not_allowed(
    lark_fake, authenticated_client, break_it, expected
):
    """A refused read is a permission problem, never a table that does not exist."""

    if break_it == "fields":
        # The header listing refuses while the base itself still reads.
        lark_fake.fields_error = True
    else:
        # The base is beyond the app's reach: the field read and the listing that
        # would have explained it both refuse.
        del lark_fake.bases["app-exec"]

    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 409, response.text
    assert expected in response.json()["detail"]


def test_table_schema_refuses_a_role_it_does_not_know(
    lark_fake, authenticated_client
):
    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="defect",
    )

    assert response.status_code == 422, response.text
    assert "execution" in response.json()["detail"]
    assert lark_fake.requests == []


@pytest.mark.parametrize(
    ("base_token", "table_id"),
    [
        ("../../../../wiki/v2/spaces/get_node", "tbl-runs"),
        ("app-exec/../app-bug", "tbl-runs"),
        ("app-exec", "tbl-runs/../../records"),
        ("app-exec", "tbl-runs/.."),
        ("app-exec", "../tbl-runs"),
    ],
)
def test_table_schema_refuses_ids_that_could_rewrite_the_request_path(
    lark_fake, authenticated_client, base_token, table_id
):
    response = _table_schema(
        authenticated_client,
        base_token=base_token,
        table_id=table_id,
        role="execution",
    )

    assert response.status_code == 422, response.text
    assert "多维表格标识" in response.json()["detail"]
    assert lark_fake.requests == []


def test_table_schema_writes_nothing_to_the_database(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    """The endpoint takes no session at all: the read is Lark-only."""

    stored_before = _fresh_target(db_session, confirmed_group.id)
    flushes: list[str] = []
    commits: list[str] = []

    def record_flush(*_args: object) -> None:
        flushes.append("flush")

    def record_commit(*_args: object) -> None:
        commits.append("commit")

    event.listen(db_session, "before_flush", record_flush)
    event.listen(db_session, "before_commit", record_commit)
    try:
        response = _table_schema(
            authenticated_client,
            base_token="app-exec",
            table_id="tbl-runs",
            role="execution",
        )
    finally:
        event.remove(db_session, "before_flush", record_flush)
        event.remove(db_session, "before_commit", record_commit)

    assert response.status_code == 200, response.text
    assert flushes == []
    assert commits == []
    assert list(db_session.new) == []
    stored_after = _fresh_target(db_session, confirmed_group.id)
    assert stored_after.target_fingerprint == stored_before.target_fingerprint
    assert stored_after.schema_fingerprint == stored_before.schema_fingerprint
    assert stored_after.confirmed_at == stored_before.confirmed_at
    assert (
        db_session.scalars(
            select(LarkTargetRevision).where(
                LarkTargetRevision.group_id == confirmed_group.id
            )
        ).all()
        == []
    )


def test_table_schema_asks_lark_once_on_the_happy_path(
    lark_fake, authenticated_client
):
    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 200, response.text
    assert [request["path"] for request in lark_fake.requests] == [
        "/open-apis/auth/v3/tenant_access_token/internal",
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/fields",
    ]
    # Read-only: no record path is touched at all.
    assert lark_fake.client.record_methods == []


def test_table_schema_names_the_missing_credential_instead_of_a_permission_fix(
    lark_fake, authenticated_client, monkeypatch
):
    monkeypatch.setattr(
        lark_target,
        "settings",
        replace(settings, lark_app_id="", lark_app_secret=""),
    )

    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 409, response.text
    assert "LARK_APP_ID" in response.json()["detail"]
    assert "协作者" not in response.json()["detail"]
    assert lark_fake.requests == []


def test_table_schema_requires_an_admin_session(lark_fake, anonymous_client):
    # The route hangs off the same router as /lark/resolve, so it inherits both
    # router dependencies: the admin session here, and refuse_archived_group —
    # which is a no-op for this path because no group_id is named in it
    # (app/archive.py:53-63), there being nothing per-group to archive.
    response = _table_schema(
        anonymous_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 401
    assert lark_fake.requests == []
```

- [ ] **Step 3: 跑这 9 个测试，确认它们是红的**

```bash
cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_target.py -q -k table_schema
```

期望输出（本机实测，红的原因只有一个：路由还不存在 → 404，不是测试写错）：

```
>       assert execution.status_code == 200, execution.text
E       AssertionError: {"detail":"Not Found"}
E       assert 404 == 200
E        +  where 404 = <Response [404 Not Found]>.status_code

tests/test_lark_target.py:142: AssertionError
=========================== short test summary info ============================
FAILED tests/test_lark_target.py::test_table_schema_judges_one_table_by_the_role_that_asked
FAILED tests/test_lark_target.py::test_table_schema_reports_a_table_the_base_does_not_have
FAILED tests/test_lark_target.py::test_table_schema_reports_a_read_the_app_is_not_allowed[fields-\u534f\u4f5c\u8005]
FAILED tests/test_lark_target.py::test_table_schema_reports_a_read_the_app_is_not_allowed[base-\u591a\u7ef4\u8868\u683c]
FAILED tests/test_lark_target.py::test_table_schema_refuses_a_role_it_does_not_know
FAILED tests/test_lark_target.py::test_table_schema_refuses_ids_that_could_rewrite_the_request_path[../../../../wiki/v2/spaces/get_node-tbl-runs]
FAILED tests/test_lark_target.py::test_table_schema_refuses_ids_that_could_rewrite_the_request_path[app-exec/../app-bug-tbl-runs]
FAILED tests/test_lark_target.py::test_table_schema_refuses_ids_that_could_rewrite_the_request_path[app-exec-tbl-runs/../../records]
FAILED tests/test_lark_target.py::test_table_schema_refuses_ids_that_could_rewrite_the_request_path[app-exec-tbl-runs/..]
FAILED tests/test_lark_target.py::test_table_schema_refuses_ids_that_could_rewrite_the_request_path[app-exec-../tbl-runs]
FAILED tests/test_lark_target.py::test_table_schema_writes_nothing_to_the_database
FAILED tests/test_lark_target.py::test_table_schema_asks_lark_once_on_the_happy_path
FAILED tests/test_lark_target.py::test_table_schema_names_the_missing_credential_instead_of_a_permission_fix
FAILED tests/test_lark_target.py::test_table_schema_requires_an_admin_session
14 failed, 29 deselected, 2 warnings in 1.72s
```

数一下：9 个函数因为 `parametrize` 展开成 14 个用例；`29 deselected` 是文件里原有的 29 个用例。若这里不是 14 failed，先别往下走。

- [ ] **Step 4: 实现（一）—— `import re`**

`backend/app/lark/target.py:1-3`：

```diff
 from __future__ import annotations
 
+import re
 from dataclasses import dataclass
```

- [ ] **Step 5: 实现（二）—— 新接口整块**

在 `backend/app/lark/target.py` 里 `@router.post("/lark/resolve")` 那个函数的 `except PermissionError` 之后、`def target_for(...)` 之前插入下面整块（**81 行**，实测行数；初稿写 83 有误）。`read_table_schema` 调用的 `_refuse_bad_token` 在下一个 Step 才定义 —— 两者都是模块级函数，Python 在**调用时**解析，定义顺序不影响运行，别为此把它挪走。
**自证位置**：`grep -n "@router.post(\"/lark/resolve\")\|def target_for\|class TableSchemaRequest\|def read_table_schema" backend/app/lark/target.py` —— `TableSchemaRequest` 与 `read_table_schema` 必须落在 `/lark/resolve` 与 `def target_for` **之间**。插入后所有行号都会变，**下面 Step 6 一律按锚点文本施工**。

```python
class TableSchemaRequest(BaseModel):
    base_token: str
    table_id: str
    role: str          # "execution" | "bug"


# One role's table is judged against its own mandatory columns, and a refusal
# names the same identity parts the save path names, so the same bad value reads
# the same wherever it was pasted.
TABLE_SCHEMA_ROLES: dict[str, tuple[str, str, dict[str, tuple[int, ...]]]] = {
    "execution": ("执行库 App Token", "执行记录表 id", REQUIRED_RUN_FIELD_TYPES),
    "bug": ("缺陷库 App Token", "缺陷表 id", REQUIRED_BUG_FIELD_TYPES),
}


def read_table_schema(
    client: LarkClient, base_token: str, table_id: str, role: str
) -> dict[str, Any]:
    """One table's live header, judged against the mandatory set for ``role``.

    Read-only, and one request in the happy path: the field listing alone answers
    the question. Only a failed listing buys the base's table listing — one more
    request — so that a table which no longer exists is never reported as a
    permission problem, and a read the app is not allowed to make is never
    reported as a table that does not exist.
    """

    try:
        base_label, table_label, required = TABLE_SCHEMA_ROLES[role]
    except KeyError:
        raise LookupError('role 必须是 "execution" 或 "bug"') from None
    # The same path-injection refusal the save path applies, on the same
    # characters: both ids are interpolated into a path carrying the token.
    _refuse_bad_token(base_label, base_token, SOURCE_ID)
    _refuse_bad_token(table_label, table_id, TABLE_ID)

    missing = _missing_credential()
    if missing:
        raise PermissionError(missing)

    try:
        fields = client.list_fields(base_token, table_id)
    except LarkError as error:
        try:
            tables = client.list_tables(base_token)
        except LarkError:
            raise PermissionError(f"无法读取多维表格：{error}") from None
        if not any(str(table.get("table_id")) == table_id for table in tables):
            raise LookupError(
                f"该多维表格里没有数据表 {table_id}，请重新读取 Lark 链接后选择"
            ) from None
        raise PermissionError(
            f"无法读取数据表字段，请确认应用仍是协作者：{error}"
        ) from None

    return {
        "table_id": table_id,
        "fields": describe_fields(fields),
        "required": sorted(required),
        "schema_errors": missing_required_fields(fields, required),
    }


@router.post("/lark/table-schema")
def table_schema(
    payload: TableSchemaRequest,
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    """200 → {"table_id": str, "fields": {字段名: 类型名}, "required": [str], "schema_errors": [str]}
       422 → 找不到该表 / role 非法 / token 形状非法
       409 → 应用不是协作者（PermissionError）
    """

    try:
        return read_table_schema(
            client, payload.base_token, payload.table_id, payload.role
        )
    except LookupError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None
```

- [ ] **Step 6: 实现（三）—— 把 token 校验抽成共享函数，保存路径改为调用它**

**按锚点施工，不要按行号**：找到 `def _validate_target_tokens(payload: TargetRequest) -> None:` 这个函数，把它的循环体拆成「一个 id 的判定」`_refuse_bad_token`（新函数，插在它**之前**）+「四个 id 的编排」（原函数瘦身后继续调用四次）。判定逻辑与消息**逐字照搬**（只抽函数，不改行为），所以 `test_saving_refuses_ids_that_could_rewrite_the_request_path` 的 5 个用例必须继续绿：
**自证位置**：`grep -n "def _refuse_bad_token\|def _validate_target_tokens\|def locked_target_for" backend/app/lark/target.py` —— 三者顺序必须是 `_refuse_bad_token` → `_validate_target_tokens` → `locked_target_for`；如果第 335 行附近是 `locked_target_for` 的 docstring，说明你按旧行号施工了，**立刻停下按锚点重做**。

```diff
+def _refuse_bad_token(label: str, value: str, pattern: re.Pattern[str]) -> None:
+    """Refuse one id that could rewrite the authenticated Lark request path."""
+
+    if pattern.match(value) is None:
+        raise HTTPException(
+            status_code=422,
+            detail=f"{label} 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接",
+        )
+
+
 def _validate_target_tokens(payload: TargetRequest) -> None:
     """Refuse ids that could rewrite the authenticated Lark request path.
 
     Every token ends up interpolated into a path that carries the bearer token,
     so a value like ``../../../../wiki/v2/spaces/get_node`` would otherwise pick
     the endpoint the request hits. The accepted characters are the ones a pasted
     link may already carry.
     """
 
     checks = [
         ("执行库 App Token", payload.execution_base_token, SOURCE_ID),
         ("执行记录表 id", payload.execution_table_id, TABLE_ID),
         ("缺陷库 App Token", payload.bug_base_token, SOURCE_ID),
         ("缺陷表 id", payload.bug_table_id, TABLE_ID),
     ]
     # No view is a normal choice; only a supplied id has to be a real one.
     if payload.execution_view_id:
         checks.append(("视图 id", payload.execution_view_id, VIEW_ID))
     for label, value, pattern in checks:
-        if pattern.match(value) is None:
-            raise HTTPException(
-                status_code=422,
-                detail=f"{label} 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接",
-            )
+        _refuse_bad_token(label, value, pattern)
```

- [ ] **Step 7: 跑这个文件，期望全绿**

```bash
cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_target.py -q
```

期望输出：

```
43 passed, 2 warnings in 4.11s
```

`43 = 29（原有，含被重构的保存路径校验）+ 14（新用例）`。原有 29 个里任何一条变红都说明 Step 6 动坏了保存路径，不许跳过。

- [ ] **Step 8: 跑整个后端套件（门 9 的后端部分）**

```bash
cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest -q
```

本 task 开工前后的**实测**数字（两条都是本机跑出来的）：

- HEAD（未改动）在仓库里跑全量：`504 passed, 2 warnings in 33.02s`。
- 本 task 的改动加进 `backend` 的**副本**后跑全量：`515 passed, 1 failed, 2 skipped`。

那 `1 failed, 2 skipped` 是副本本身造成的，与改动无关，两条都单独查过原因：

- failed 的是 `tests/test_bootstrap.py::test_bootstrap_module_uses_configured_database_and_exits_zero`：它用 `cwd` 下的 `.venv/bin/python` 起子进程，而副本里没有 `.venv`；同一个用例在**未改动的副本**里也照样失败（已实测：`1 failed, 6 passed`）。
- skipped 的是 `tests/test_ai_prompts.py:40` 与 `:68`，原因写着 `docs/ is not part of this checkout` —— 副本只拷了 `backend/`。

改动后的副本共收集 518 个用例（`515 + 1 + 2`），HEAD 是 504 个，差的 14 正是本次新增的用例数。

所以在仓库里跑，期望：

```
518 passed, 2 warnings in ~35s
```

这个接口没有 `db` 依赖，理论上不可能影响别的文件；跑一次是为了**证明**这一点，而不是为了好看。若基线不是 `504 passed`（说明 HEAD 变了），重新数一遍再判断，不要拿 `518` 硬套。

- [ ] **Step 9: 自查后提交**

自查三条，逐条回答（答不上就别提交）：

1. `git diff --stat` 只动了 `backend/app/lark/target.py` 与 `backend/tests/test_lark_target.py` 两个文件，没有迁移、没有前端改动。
2. 出参形状与骨架 §Interfaces 完全一致：键名是 `table_id` / `fields` / `required` / `schema_errors`，`required` 是排序后的列表（`resolve` 用的是同一份 `sorted(...)`）。
3. `git diff backend/app/lark/target.py` 里，`_validate_target_tokens` 的消息字符串与本 task 之前逐字相同（`{label} 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接`）。

```bash
cd /home/lucascool/qa-board && git add backend/app/lark/target.py backend/tests/test_lark_target.py && git commit -m "feat(lark): read one table's header per role, read-only" -m "The page can only ask /lark/resolve about the table a link pointed at, so it
cannot fetch a verdict for the table just selected. This adds a read-only
endpoint taking base_token + table_id + role and answering with that table's
live fields, its role's mandatory columns and the missing/typed-wrong
verdict — the same computation /lark/resolve already does for the
execution role." -m "The happy path is one request (list_fields); only a failed one buys the
base's table listing, so a table that is gone (422) is never conflated with
one the app may not read (409). Both ids go through the same
path-injection refusal as the save path, so neither can pick the endpoint
the authenticated request hits. No database access, no migration, and no
test touches a real Lark tenant."
```
### Task 2: `api.ts` 客户端 + `larkDraft.ts`（纯逻辑，判决按表派生）

本 task 交付两件事：`api.ts` 多一个只读接口的客户端方法；新增 `frontend/src/larkDraft.ts`，把「base 级数据 / 表级判决」拆成两份寿命不同的结构，并让判决只能从 `probes[${table_id}:${role}]` 派生。**覆盖验收门 2、3、5 的逻辑层**（门 1、7 的 hook 层在 Task 3）。

**Files:**
- Modify `frontend/src/api.ts:138-140` —— 在 `LarkResolved`（127-138）结束之后、`export type LarkTarget`（140）之前插入 7 行 `TableSchema`（插在 139 的空行之前，紧贴 `LarkResolved`）
- Modify `frontend/src/api.ts:534-535` —— 在 `resolveLark`（529-534）之后、`larkTarget`（535）之前插入 7 行 `api.larkTableSchema`
- Modify `frontend/src/api.test.ts:38` —— 文件末尾（当前 38 行）追加 1 个用例，占 **40-68 行**
- Create `frontend/src/larkDraft.ts` —— 新建，**1-284 行**（无 React、无副作用；`ProbeSlot` 只读，全部函数可单测）
- Test `frontend/src/larkDraft.test.ts` —— 新建，**1-341 行**（16 个用例）

**Interfaces:**

**Consumes**（都已存在；本 task 不改它们的签名与行为）

```ts
// frontend/src/api.ts:127 / :140 / :171 / :173 / :310 / :456 / :529
export type LarkResolved = { /* ... */ };
export type LarkTarget = { /* ... */ };
export type TableRole = "execution" | "bug";
export type Table = { table_id: string; name: string };
export type SyncStatus = { /* ... */ };
export const api = { /* ... */ };
resolveLark: (url: string) => Promise<LarkResolved>;   // 放在 larkTableSchema 之前

// frontend/src/api.ts:411 / :442 —— 新方法照这两个既有工具写
export class ApiError extends Error
async function mutation<T>(path: string, init?: RequestInit): Promise<T>
```

**Produces**（骨架 §Interfaces 逐字；名字、参数顺序、返回形状一个字都不许改）

`frontend/src/api.ts`：

```ts
export type TableSchema = {
  table_id: string;
  fields: Record<string, string>;   // 字段名 → 类型名（describe_fields 的输出）
  required: string[];
  schema_errors: string[];
};

// 加在 `export const api = { ... }` 里，紧跟 resolveLark：
larkTableSchema: (baseToken: string, tableId: string, role: TableRole) =>
  mutation<TableSchema>("/api/lark/table-schema", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_token: baseToken, table_id: tableId, role })
  })
```

`frontend/src/larkDraft.ts`：

```ts
// frontend/src/larkDraft.ts   —— 无 React、无副作用，全部可单测
import type { LarkResolved, LarkTarget, SyncStatus, Table, TableRole } from "./api";

export type Probe = {
  fields: Record<string, string>;
  required: string[];
  schema_errors: string[];
  read_error?: string;              // 表读不到时的原因
};
export type ProbeSlot = Probe | "loading";
export type LarkBase = {
  base_token: string;
  base_name: string;
  source_url: string;
  tables: Table[];
  read_errors: string[];
  probes: Record<string, ProbeSlot>;   // key = `${table_id}:${role}`
};
export type RoleDraft = { url: string; base: LarkBase | null; tableId: string; viewId: string | null };
export type Draft = { execution: RoleDraft; bug: RoleDraft };
export type Verdict = "unread" | "loading" | "ok" | "bad" | "unreadable";
export type StepId = "tables" | "headers" | "approve" | "sync";
export type Health = { tone: "ok" | "warn" | "bad"; text: string; step: StepId | null };
export type CompletedTable = Table & { base_token: string };

export function probeKey(tableId: string, role: TableRole): string;
export function verdictOf(slot: ProbeSlot | undefined): Verdict;
export function baseIsCurrent(role: RoleDraft): boolean;
export function effectiveBase(draft: Draft, role: TableRole): LarkBase | null;  // bug: draft.bug.base ?? draft.execution.base（且都要 baseIsCurrent）
export function probeFor(draft: Draft, role: TableRole): ProbeSlot | undefined;
export function verdictFor(draft: Draft, role: TableRole): Verdict;
export function nameOf(tables: Table[], tableId: string): string;
export function suggestBugTable(tables: Table[], executionTableId: string, target: LarkTarget | null): string;
export function withCreatedTable(tables: Table[], created: CompletedTable | null, baseToken: string): Table[];
export function emptyDraft(): Draft;
export function draftFromTarget(target: LarkTarget | null): Draft;
export function describeHealth(input: {
  target: LarkTarget | null;
  liveErrors: string[];        // state.read_errors + live.read_errors
  schemaInvalid: boolean;      // live.schema_errors.length > 0
  sync: SyncStatus | null;
}): Health;
export function stepsComplete(
  draft: Draft,
  target: LarkTarget | null,
  sync: SyncStatus | null
): Record<StepId, boolean>;
```

`describeHealth` 的判定顺序（**顺序本身就是契约**）：

| # | 条件 | tone | step |
|---|---|---|---|
| 1 | `!target` | `warn` | `tables` —— 「尚未选择 Lark 表：请在第 1 步粘贴链接并保存」 |
| 2 | `liveErrors.length > 0` | `bad` | `headers` —— `目标表读取失败：${liveErrors[0]}` |
| 3 | `schemaInvalid` 且已确认 | `bad` | `headers` —— 「已确认，但表头已失效（需重新校验）」 |
| 4 | `schemaInvalid` 且未确认 | `bad` | `headers` —— 「表头缺失，尚不能确认写入」 |
| 5 | `sync.failed + sync.uncertain > 0` | `bad` | `sync` —— `同步失败 ${failed} 条 · 待人工确认 ${uncertain} 条` |
| 6 | `sync.parked > 0` | `warn` | `sync` —— `待管理员处理 ${parked} 条` |
| 7 | `!target.confirmed` | `warn` | `approve` —— 「未确认：本地结果不会写入 Lark」 |
| 8 | 否则 | `ok` | `null` —— `已确认 · ${execution_table_name} / ${bug_table_name} · 待同步 ${queued} · 失败 0` |

**`effectiveBase` 的一处解读（必须照这个读法实现，否则门 3 破）**：骨架那一行注释 `draft.bug.base ?? draft.execution.base（且都要 baseIsCurrent）` 说的是**可用的候选**，不是**回落的时机**。回落只发生在缺陷库链接框为空时（规格 §4.1「缺陷库链接为空 = 与执行表同库」）；框里已经有一段**尚未读取**的链接时，`effectiveBase(draft, "bug")` 返回 `null` —— 那段链接指向的是另一个库，借用执行库的表会立刻把「尚未校验」变成一句关于别的库的话（规格 §4.2「绝不引用别的表的判决」+ 验收门 3）。规格 §8 那一行「清空缺陷库链接 → 按 base_token 归属作废该 role 的 probe」正是本条的另一面。

**`createdTables` 的落点（Task 5/6 会用到）**：`LarkDraftActions` 里没有 `createdTables` 字段，`StepTablesProps` 里也没有。所以「本页新建的表」必须落进 `draft[role].base.tables`（由 Task 3 的 `acceptCreatedTable` 用 `withCreatedTable` 插入），否则第 ① 步的下拉没有第二个来源可以拿到它。这同时把规格 §8 的「`base_token` 归属校验」收在一处：`withCreatedTable` 只在 `created.base_token === 当前 base.base_token` 时插入，换 base 后新表自然不再出现。

- [ ] **Step 1: 写失败的测试（`api.test.ts` 追加一个用例）**

`frontend/src/api.test.ts` 现在 38 行，末尾追加：

```ts
it("posts a table-schema check with the role it is checking for", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/auth/csrf") return Response.json({ csrf_token: "token" });
    return Response.json({
      table_id: "tbl-runs",
      fields: { 用例: "text", 截图: "attachment" },
      required: ["用例", "截图"],
      schema_errors: ["缺少必填字段「结果」"]
    });
  }));

  const schema = await api.larkTableSchema("app-exec", "tbl-runs", "execution");

  const check = calls.find((call) => call.path === "/api/lark/table-schema");
  expect(check).toBeDefined();
  expect(check?.init?.method).toBe("POST");
  expect(new Headers(check?.init?.headers).get("X-CSRF-Token")).toBe("token");
  expect(JSON.parse(String(check?.init?.body))).toEqual({
    base_token: "app-exec",
    table_id: "tbl-runs",
    role: "execution"
  });
  expect(schema.schema_errors).toEqual(["缺少必填字段「结果」"]);
  vi.unstubAllGlobals();
});
```

这个用例顺带钉住三件事：走 `mutation`（因此带 `X-CSRF-Token`）、请求体键名是 `base_token`/`table_id`/`role`（后端 `TableSchemaRequest` 就吃这三个）、响应原样交给调用方。

- [ ] **Step 2: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/api.test.ts`
期望输出（本机实测）：

```
 ❯ src/api.test.ts (3 tests | 1 failed)
   ✓ shares one csrf request across concurrent mutations
   ✓ turns a refused connection into a message an administrator can act on
   × posts a table-schema check with the role it is checking for
     → api.larkTableSchema is not a function
```

红色原因是 `TypeError: api.larkTableSchema is not a function` —— 方法还不存在。**另两个旧用例必须仍是绿的**：它们若一起红，说明改错的是别处。

- [ ] **Step 3: 实现 —— `api.ts` 两处插入**

第一处，在 `LarkResolved`（127-138 行）之后、`export type LarkTarget = {`（140 行）之前插入：

```ts
export type TableSchema = {
  table_id: string;
  fields: Record<string, string>;   // 字段名 → 类型名（describe_fields 的输出）
  required: string[];
  schema_errors: string[];
};

```

（末尾那个空行让 `TableSchema` 与 `LarkTarget` 之间保持文件里其它类型之间的空行节距。）

第二处，在 `resolveLark`（529-534 行）之后、`larkTarget` 之前插入：

```ts
  // 表级校验：按 table_id 现读字段并算缺失表头（后端 POST /lark/table-schema）。
  larkTableSchema: (baseToken: string, tableId: string, role: TableRole) =>
    mutation<TableSchema>("/api/lark/table-schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_token: baseToken, table_id: tableId, role })
    }),
```

`TableRole` 与 `mutation` 都在同一个文件里（171 行 / 442 行），不需要加 import。

- [ ] **Step 4: 跑，期望变绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/api.test.ts`
期望输出：`Test Files  1 passed (1)` / `Tests  3 passed (3)`

- [ ] **Step 5: 写失败的测试（`larkDraft.test.ts`，完整文件）**

新建 `frontend/src/larkDraft.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import type { LarkTarget, SyncStatus } from "./api";
import {
  baseIsCurrent,
  describeHealth,
  draftFromTarget,
  effectiveBase,
  emptyDraft,
  nameOf,
  probeFor,
  probeKey,
  stepsComplete,
  suggestBugTable,
  verdictFor,
  verdictOf,
  withCreatedTable,
  type CompletedTable,
  type Draft,
  type LarkBase,
  type Probe,
  type RoleDraft
} from "./larkDraft";

const URL = "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs";
const BUG_URL = "https://tenant.larksuite.com/base/app-bugs";

const TABLES = [
  { table_id: "tbl-runs", name: "执行记录" },
  { table_id: "tbl-bugs", name: "缺陷记录" }
];

const TARGET: LarkTarget = {
  group_id: "0918-id",
  source_url: URL,
  execution_base_token: "app-exec",
  execution_base_name: "执行库",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-exec",
  bug_base_name: "执行库",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: "schema-1",
  target_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs",
  confirmed_at: null,
  confirmed: false
};

function base(overrides: Partial<LarkBase> = {}): LarkBase {
  return {
    base_token: "app-exec",
    base_name: "执行库",
    source_url: URL,
    tables: TABLES,
    read_errors: [],
    probes: {},
    ...overrides
  };
}

function role(overrides: Partial<RoleDraft> = {}): RoleDraft {
  return { url: URL, base: null, tableId: "", viewId: null, ...overrides };
}

function draftWith(execution: Partial<RoleDraft> = {}, bug: Partial<RoleDraft> = {}): Draft {
  return { execution: role(execution), bug: role({ url: "", ...bug }) };
}

function probe(overrides: Partial<Probe> = {}): Probe {
  return { fields: {}, required: [], schema_errors: [], ...overrides };
}

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    confirmed: true,
    queued: 0,
    synced: 1,
    failed: 0,
    uncertain: 0,
    parked: 0,
    last_error_kind: null,
    pending_attempts: 0,
    detail: "目标表已确认，可显式排入同步",
    ...overrides
  };
}

describe("verdictOf", () => {
  it("names all five states and lets a failed read win over missing headers", () => {
    expect(verdictOf(undefined)).toBe("unread");
    expect(verdictOf("loading")).toBe("loading");
    expect(verdictOf(probe({ read_error: "无法读取该数据表" }))).toBe("unreadable");
    expect(verdictOf(probe({ schema_errors: ["缺少必填字段「截图」"] }))).toBe("bad");
    expect(verdictOf(probe())).toBe("ok");
    expect(
      verdictOf(probe({ read_error: "读不到", schema_errors: ["缺少必填字段「截图」"] }))
    ).toBe("unreadable");
  });
});

describe("baseIsCurrent", () => {
  it("invalidates a base as soon as the link box differs from the link that was read", () => {
    const execution = base();
    const read = draftWith({ base: execution, tableId: "tbl-runs" });
    expect(baseIsCurrent(read.execution)).toBe(true);
    expect(baseIsCurrent({ ...read.execution, url: `  ${URL}  ` })).toBe(true);

    const edited: Draft = { ...read, execution: { ...read.execution, url: `${URL}?table=x` } };
    expect(baseIsCurrent(edited.execution)).toBe(false);
    expect(effectiveBase(edited, "execution")).toBeNull();
    expect(verdictFor(edited, "execution")).toBe("unread");
  });

  it("is false for a role whose link was never read", () => {
    expect(baseIsCurrent(role())).toBe(false);
  });
});

describe("effectiveBase", () => {
  it("falls back to the execution base only while the defect link box is empty", () => {
    const execution = base();
    const draft = draftWith({ base: execution, tableId: "tbl-runs" });
    expect(effectiveBase(draft, "bug")).toBe(execution);

    const pending: Draft = { ...draft, bug: { ...draft.bug, url: BUG_URL } };
    expect(effectiveBase(pending, "bug")).toBeNull();
    expect(verdictFor(pending, "bug")).toBe("unread");
  });

  it("keeps the execution role out of a defect base that is waiting to be read", () => {
    const draft = draftWith({}, { url: BUG_URL, base: base({ base_token: "app-bugs" }) });
    expect(effectiveBase(draft, "execution")).toBeNull();
  });
});

describe("verdictFor", () => {
  it("gives each table its own verdict when the selected table changes", () => {
    const execution = base({
      probes: {
        [probeKey("tbl-runs", "execution")]: probe({ schema_errors: ["缺少必填字段「截图」"] }),
        [probeKey("tbl-bugs", "execution")]: probe()
      }
    });
    const runs = draftWith({ base: execution, tableId: "tbl-runs" });
    expect(verdictFor(runs, "execution")).toBe("bad");

    const bugs: Draft = { ...runs, execution: { ...runs.execution, tableId: "tbl-bugs" } };
    expect(verdictFor(bugs, "execution")).toBe("ok");
  });

  it("keeps the two roles of one table apart", () => {
    const shared = base({
      probes: {
        [probeKey("tbl-runs", "execution")]: probe({ schema_errors: ["缺少必填字段「截图」"] }),
        [probeKey("tbl-runs", "bug")]: probe()
      }
    });
    const draft = draftWith(
      { base: shared, tableId: "tbl-runs" },
      { url: URL, base: shared, tableId: "tbl-runs" }
    );
    expect(verdictFor(draft, "execution")).toBe("bad");
    expect(verdictFor(draft, "bug")).toBe("ok");
  });

  it("reports an unread table as unread instead of borrowing the sibling's verdict", () => {
    const execution = base({
      probes: { [probeKey("tbl-runs", "execution")]: probe() }
    });
    const draft = draftWith({ base: execution, tableId: "tbl-bugs" });
    expect(probeFor(draft, "execution")).toBeUndefined();
    expect(verdictFor(draft, "execution")).toBe("unread");
  });
});

describe("suggestBugTable", () => {
  it("prefers the stored defect table, then the first table that is not the execution one", () => {
    expect(suggestBugTable(TABLES, "tbl-runs", TARGET)).toBe("tbl-bugs");
    expect(suggestBugTable(TABLES, "tbl-runs", null)).toBe("tbl-bugs");
    expect(suggestBugTable(TABLES, "tbl-bugs", null)).toBe("tbl-runs");
    // 存下来的缺陷表不在这次读到的表里：退回建议值，而不是把一个没有的表交出去。
    expect(suggestBugTable(TABLES, "tbl-runs", { ...TARGET, bug_table_id: "tbl-gone" })).toBe(
      "tbl-bugs"
    );
    expect(suggestBugTable([{ table_id: "tbl-runs", name: "执行记录" }], "tbl-runs", null)).toBe(
      "tbl-runs"
    );
    expect(suggestBugTable([], "tbl-runs", null)).toBe("");
  });
});

describe("withCreatedTable", () => {
  it("offers a created table only inside the base it was created in, and only once", () => {
    const created: CompletedTable = {
      table_id: "tbl-new",
      name: "新建执行表",
      base_token: "app-exec"
    };
    expect(withCreatedTable(TABLES, created, "app-exec").map((t) => t.table_id)).toEqual([
      "tbl-new",
      "tbl-runs",
      "tbl-bugs"
    ]);
    expect(withCreatedTable(TABLES, created, "app-bugs")).toEqual(TABLES);
    expect(withCreatedTable(TABLES, null, "app-exec")).toEqual(TABLES);
    expect(withCreatedTable(TABLES, { ...created, table_id: "tbl-runs" }, "app-exec")).toEqual(
      TABLES
    );
  });
});

describe("nameOf", () => {
  it("falls back to the id for a table this page never read", () => {
    expect(nameOf(TABLES, "tbl-runs")).toBe("执行记录");
    expect(nameOf(TABLES, "tbl-unknown")).toBe("tbl-unknown");
  });
});

describe("emptyDraft / draftFromTarget", () => {
  it("starts empty and prefills a saved target without pretending it was read", () => {
    expect(emptyDraft()).toEqual({
      execution: { url: "", base: null, tableId: "", viewId: null },
      bug: { url: "", base: null, tableId: "", viewId: null }
    });

    const draft = draftFromTarget(TARGET);
    expect(draft.execution.url).toBe(URL);
    expect(draft.execution.tableId).toBe("tbl-runs");
    expect(draft.bug.url).toBe("");
    expect(draft.bug.tableId).toBe("tbl-bugs");
    expect(draft.execution.base).toBeNull();
    expect(verdictFor(draft, "execution")).toBe("unread");
    expect(verdictFor(draft, "bug")).toBe("unread");
    expect(draftFromTarget(null)).toEqual(emptyDraft());
  });
});

describe("describeHealth", () => {
  const confirmed: LarkTarget = { ...TARGET, confirmed: true, confirmed_at: "2026-09-18T00:00:00Z" };

  it("answers the eight rules in the pinned order", () => {
    // 1 还没有目标
    expect(
      describeHealth({ target: null, liveErrors: [], schemaInvalid: false, sync: null })
    ).toEqual({
      tone: "warn",
      step: "tables",
      text: "尚未选择 Lark 表：请在第 1 步粘贴链接并保存"
    });
    // 2 已保存目标读失败
    expect(
      describeHealth({
        target: TARGET,
        liveErrors: ["Lark 中找不到执行记录表 tbl-runs"],
        schemaInvalid: false,
        sync: null
      })
    ).toEqual({
      tone: "bad",
      step: "headers",
      text: "目标表读取失败：Lark 中找不到执行记录表 tbl-runs"
    });
    // 3 表头失效且已确认
    expect(
      describeHealth({ target: confirmed, liveErrors: [], schemaInvalid: true, sync: null })
    ).toEqual({ tone: "bad", step: "headers", text: "已确认，但表头已失效（需重新校验）" });
    // 4 表头失效且未确认
    expect(
      describeHealth({ target: TARGET, liveErrors: [], schemaInvalid: true, sync: null })
    ).toEqual({ tone: "bad", step: "headers", text: "表头缺失，尚不能确认写入" });
    // 5 同步失败 / 待人工确认
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ failed: 3, uncertain: 1 })
      })
    ).toEqual({ tone: "bad", step: "sync", text: "同步失败 3 条 · 待人工确认 1 条" });
    // 6 待管理员处理
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ parked: 2 })
      })
    ).toEqual({ tone: "warn", step: "sync", text: "待管理员处理 2 条" });
    // 7 未确认
    expect(
      describeHealth({ target: TARGET, liveErrors: [], schemaInvalid: false, sync: null })
    ).toEqual({ tone: "warn", step: "approve", text: "未确认：本地结果不会写入 Lark" });
    // 8 其它
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ queued: 4 })
      })
    ).toEqual({
      tone: "ok",
      step: null,
      text: "已确认 · 执行记录 / 缺陷记录 · 待同步 4 · 失败 0"
    });
  });

  it("lets the earlier rule win when two conditions are true at once", () => {
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: ["读取失败"],
        schemaInvalid: true,
        sync: syncStatus({ failed: 9 })
      })
    ).toEqual({ tone: "bad", step: "headers", text: "目标表读取失败：读取失败" });

    // 表头没失效但队列有失败：第 5 条比第 7 条（未确认）先赢。
    expect(
      describeHealth({
        target: TARGET,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ failed: 9 })
      })
    ).toEqual({ tone: "bad", step: "sync", text: "同步失败 9 条 · 待人工确认 0 条" });
    // 表头失效且未确认：第 4 条比第 5 条先赢，队列失败不改变指向的步骤。
    expect(
      describeHealth({
        target: TARGET,
        liveErrors: [],
        schemaInvalid: true,
        sync: syncStatus({ failed: 9 })
      })
    ).toEqual({ tone: "bad", step: "headers", text: "表头缺失，尚不能确认写入" });
  });
});

describe("stepsComplete", () => {
  it("marks a step complete only when that step has nothing left", () => {
    const verified = base({
      probes: {
        [probeKey("tbl-runs", "execution")]: probe(),
        [probeKey("tbl-bugs", "bug")]: probe()
      }
    });
    const draft = draftWith(
      { base: verified, tableId: "tbl-runs" },
      { url: URL, base: verified, tableId: "tbl-bugs" }
    );
    const confirmed: LarkTarget = { ...TARGET, confirmed: true, confirmed_at: "2026-09-18T00:00:00Z" };

    expect(stepsComplete(draft, null, null)).toEqual({
      tables: true,
      headers: false,
      approve: false,
      sync: false
    });
    expect(stepsComplete(draft, TARGET, syncStatus())).toEqual({
      tables: true,
      headers: true,
      approve: false,
      sync: false
    });
    expect(stepsComplete(draft, confirmed, syncStatus())).toEqual({
      tables: true,
      headers: true,
      approve: true,
      sync: true
    });
    expect(stepsComplete(draft, confirmed, syncStatus({ queued: 1 }))).toEqual({
      tables: true,
      headers: true,
      approve: true,
      sync: false
    });
    expect(stepsComplete(draft, confirmed, null)).toEqual({
      tables: true,
      headers: true,
      approve: true,
      sync: false
    });
  });

  it("keeps the table step open while either role has an unread table", () => {
    const executionOnly = base({ probes: { [probeKey("tbl-runs", "execution")]: probe() } });
    const draft = draftWith(
      { base: executionOnly, tableId: "tbl-runs" },
      { url: URL, base: executionOnly, tableId: "tbl-bugs" }
    );
    expect(stepsComplete(draft, TARGET, syncStatus()).tables).toBe(false);
    expect(stepsComplete(draft, TARGET, syncStatus()).headers).toBe(false);
  });
});
```

覆盖对照（每条都是上面某个 `it`）：门 2 = `verdictFor` 的「每张表只显示自己的」；门 3 = `baseIsCurrent` 两条 + `effectiveBase` 两条 + `verdictFor` 的 unread 一条；门 5 在第 5/6 条规则里（逻辑层；「状态条变红 + 第②步自动展开」的渲染层在 Task 5/6）；五态 = `verdictOf`；八条顺序 = `describeHealth` 两个用例；四步 = `stepsComplete` 两个用例。`suggestBugTable` / `withCreatedTable` / `nameOf` / `draftFromTarget` 的用例是迁移语义的锁：它们必须与 `views/LarkCheck.tsx:73-103` 的旧行为逐字同义。

- [ ] **Step 6: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/larkDraft.test.ts`
期望输出（本机实测的形态，路径按实际文件）：

```
 FAIL  src/larkDraft.test.ts [ src/larkDraft.test.ts ]
Error: Failed to resolve import "./larkDraft" from "src/larkDraft.test.ts". Does the file exist?
  Plugin: vite:import-analysis
```

**这一条必须真跑**：红了才证明这个文件确实在测还没写的东西（而不是在测一个碰巧存在的模块）。

- [ ] **Step 7: 实现（`larkDraft.ts`，完整文件）**

新建 `frontend/src/larkDraft.ts`：

```ts
import type { LarkResolved, LarkTarget, SyncStatus, Table, TableRole } from "./api";

export type Probe = {
  fields: Record<string, string>;
  required: string[];
  schema_errors: string[];
  read_error?: string;
};

export type ProbeSlot = Probe | "loading";

export type LarkBase = {
  base_token: string;
  base_name: string;
  source_url: string;
  tables: Table[];
  read_errors: string[];
  probes: Record<string, ProbeSlot>;
};

export type RoleDraft = { url: string; base: LarkBase | null; tableId: string; viewId: string | null };

export type Draft = { execution: RoleDraft; bug: RoleDraft };

export type Verdict = "unread" | "loading" | "ok" | "bad" | "unreadable";

export type StepId = "tables" | "headers" | "approve" | "sync";

export type Health = { tone: "ok" | "warn" | "bad"; text: string; step: StepId | null };

export type CompletedTable = Table & { base_token: string };

// resolve 一次拿回来的东西里混着两种寿命不同的数据：base 级（tables / base_name，切表后
// 仍有效）和表级（execution_fields / required_execution_fields / schema_errors，切表即
// 失效）。Probe 就是后半部分，三项与 LarkResolved 上那三项同形。
export function probeKey(tableId: string, role: TableRole): string {
  return `${tableId}:${role}`;
}

// 判决的唯一来源（规格 §4.2）：只看这张表自己的 probe，不看任何读取时的快照。
export function verdictOf(slot: ProbeSlot | undefined): Verdict {
  if (slot === "loading") return "loading";
  if (!slot) return "unread";
  if (slot.read_error) return "unreadable";
  return slot.schema_errors.length > 0 ? "bad" : "ok";
}

// base 只在它确实由当前框里那段链接读出来时才有效（规格 §4.2）。编辑链接框即视为未
// 读取 —— 这是同类 stale 坑的第二个入口，执行表与缺陷表都要过这一关。
export function baseIsCurrent(role: RoleDraft): boolean {
  return role.base?.source_url === role.url.trim();
}

// 缺陷库链接为空 = 与执行表同库（规格 §4.1），这时才借执行表的 base；框里已经有一段
// 尚未读取的链接时不许借，宁可回 unread（验收门 3）。
export function effectiveBase(draft: Draft, role: TableRole): LarkBase | null {
  const own = draft[role].base;
  if (own && baseIsCurrent(draft[role])) return own;
  if (role === "execution") return null;
  if (draft.bug.url.trim() !== "") return null;
  const execution = draft.execution.base;
  return execution && baseIsCurrent(draft.execution) ? execution : null;
}

export function probeFor(draft: Draft, role: TableRole): ProbeSlot | undefined {
  const base = effectiveBase(draft, role);
  const tableId = draft[role].tableId;
  if (!base || !tableId) return undefined;
  return base.probes[probeKey(tableId, role)];
}

export function verdictFor(draft: Draft, role: TableRole): Verdict {
  return verdictOf(probeFor(draft, role));
}

export function nameOf(tables: Table[], tableId: string): string {
  return tables.find((table) => table.table_id === tableId)?.name ?? tableId;
}

// 已存的缺陷表优先（新的读取里仍然有它才算数）；否则第一个不是执行表的；否则第一张。
// 语义与 views/LarkCheck.tsx 里的旧 suggestBugTable 逐字一致，只是入参从 LarkResolved
// 收成 tables。
export function suggestBugTable(
  tables: Table[],
  executionTableId: string,
  target: LarkTarget | null
): string {
  const ids = tables.map((table) => table.table_id);
  if (target && ids.includes(target.bug_table_id)) return target.bug_table_id;
  const other = tables.find((table) => table.table_id !== executionTableId);
  return other?.table_id ?? ids[0] ?? "";
}

// 本页新建的表只属于它被创建时所在的那个 base；同一个 base 内按 table_id 去重，
// 重复接受同一张表不会在下拉里出现两次。
export function withCreatedTable(
  tables: Table[],
  created: CompletedTable | null,
  baseToken: string
): Table[] {
  if (!created || !baseToken || created.base_token !== baseToken) return tables;
  if (tables.some((table) => table.table_id === created.table_id)) return tables;
  return [created, ...tables];
}

export function emptyDraft(): Draft {
  return {
    execution: { url: "", base: null, tableId: "", viewId: null },
    bug: { url: "", base: null, tableId: "", viewId: null }
  };
}

// 已保存的目标只用来预填链接与两个 tableId；base 仍为 null，所以每张表的判决都是
// unread，直到有人在第 ① 步真的读一次、校验一次（验收门 3）。
export function draftFromTarget(target: LarkTarget | null): Draft {
  if (!target) return emptyDraft();
  return {
    execution: {
      url: target.source_url,
      base: null,
      tableId: target.execution_table_id,
      viewId: null
    },
    bug: { url: "", base: null, tableId: target.bug_table_id, viewId: null }
  };
}

// 判定顺序本身就是契约（规格 §5.1 / 本计划 §Interfaces 的 8 行表）：先来的条件赢，
// 后面的条件不再看。
export function describeHealth(input: {
  target: LarkTarget | null;
  liveErrors: string[];
  schemaInvalid: boolean;
  sync: SyncStatus | null;
}): Health {
  const { target, liveErrors, schemaInvalid, sync } = input;
  if (!target) {
    return { tone: "warn", step: "tables", text: "尚未选择 Lark 表：请在第 1 步粘贴链接并保存" };
  }
  if (liveErrors.length > 0) {
    return { tone: "bad", step: "headers", text: `目标表读取失败：${liveErrors[0]}` };
  }
  if (schemaInvalid && target.confirmed) {
    return { tone: "bad", step: "headers", text: "已确认，但表头已失效（需重新校验）" };
  }
  if (schemaInvalid) {
    return { tone: "bad", step: "headers", text: "表头缺失，尚不能确认写入" };
  }
  const failed = sync?.failed ?? 0;
  const uncertain = sync?.uncertain ?? 0;
  if (failed + uncertain > 0) {
    return {
      tone: "bad",
      step: "sync",
      text: `同步失败 ${failed} 条 · 待人工确认 ${uncertain} 条`
    };
  }
  const parked = sync?.parked ?? 0;
  if (parked > 0) {
    return { tone: "warn", step: "sync", text: `待管理员处理 ${parked} 条` };
  }
  if (!target.confirmed) {
    return { tone: "warn", step: "approve", text: "未确认：本地结果不会写入 Lark" };
  }
  return {
    tone: "ok",
    step: null,
    text:
      `已确认 · ${target.execution_table_name} / ${target.bug_table_name}` +
      ` · 待同步 ${sync?.queued ?? 0} · 失败 0`
  };
}

// 「这一步完成了」= 这一步没有未了的事，逐条对应规格 §5.2 的「完成条件」列：
// ① 两个 tableId 都选中且各自校验通过；② 已保存 target 且两表仍校验通过；
// ③ target 已确认写入；④ 已确认且队列干净（parked 由管理员处理，不算这一步未完成）。
export function stepsComplete(
  draft: Draft,
  target: LarkTarget | null,
  sync: SyncStatus | null
): Record<StepId, boolean> {
  const verified =
    verdictFor(draft, "execution") === "ok" && verdictFor(draft, "bug") === "ok";
  const chosen = draft.execution.tableId !== "" && draft.bug.tableId !== "";
  const confirmed = target?.confirmed === true;
  const queueClean =
    sync !== null &&
    sync.queued === 0 &&
    sync.pending_attempts === 0 &&
    sync.failed === 0 &&
    sync.uncertain === 0;
  return {
    tables: chosen && verified,
    headers: target !== null && verified,
    approve: confirmed,
    sync: confirmed && queueClean
  };
}
```

三个实现细节是有意为之，别「顺手简化」：

1. `effectiveBase` 先看 `role` 自己的 base 是否 `baseIsCurrent`；`role === "execution"` 直接返回 `null`（执行表永远不借缺陷库的 base）。
2. `describeHealth` 的 8 条用**顺序 `if` + 早返回**写，不合并条件、不重排 —— 表里第 3/4 条同 tone 同 step，靠 `target.confirmed` 分叉，合并会丢掉文案区别。
3. `stepsComplete` 不看 `sync.parked`：待管理员处理的记录不是这一步的未了事（它在状态条上是 `warn` 并自动展开第 ④ 步，但操作员自己没有可做的动作）。这个取舍写在这里，是为了 Task 6 不必再猜。

- [ ] **Step 8: 跑，期望变绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/larkDraft.test.ts`
期望输出：`Test Files  1 passed (1)` / `Tests  16 passed (16)`

- [ ] **Step 9: 类型门（门 9 的前端部分）**

Run: `cd /home/lucascool/qa-board/frontend && npm run build`
期望输出（本机实测）：

```
> testdeck-frontend@0.1.0 build
> tsc -b && vite build
vite v7.1.5 building for production...
✓ 1698 modules transformed.
✓ built in 1.30s
```

**vitest 不做类型检查**，这一步不能省。`strict: true` 下最容易翻车的是 `Record<string, string>` 的下标访问：`base.probes[key]`（key 是模板字符串）在 `Record<string, ProbeSlot>` 上是合法的，而**把查表结果当键去索引另一个对象**（例如 `counts[probe.someField]`）会报 TS7053 —— 真出现这种形状时，把那个键收成字面量联合类型，别加 `as any`。

- [ ] **Step 10: 自查后提交**

自查三条，逐条回答（答不上就别提交）：

1. `TableSchema` 的四个键名与骨架 §Interfaces 完全一致（`table_id` / `fields` / `required` / `schema_errors`），请求体键名与 Task 1 的 `TableSchemaRequest` 一致（`base_token` / `table_id` / `role`）。
2. `git diff frontend/src/api.ts` 里除了两处插入没有任何别的改动（尤其是没有动 `request` / `mutation` / `ApiError`）。
3. `suggestBugTable` / `withCreatedTable` / `nameOf` 的语义与 `frontend/src/views/LarkCheck.tsx:73-103` 逐条对得上（已存缺陷表优先 → 第一个非执行表 → 第一张；`base_token` 归属 + 去重；找不到名字回落到 id）。本 task **不改** `views/LarkCheck.tsx`。

```bash
cd /home/lucascool/qa-board && git add frontend/src/api.ts frontend/src/api.test.ts frontend/src/larkDraft.ts frontend/src/larkDraft.test.ts && git commit -m "feat(web): derive each Lark table's verdict from its own probe" -m "The page kept one snapshot of the table a link pointed at and rendered it
under whatever table was selected next, so a red line about a discarded table
stayed glued to the table just chosen. This adds the pure module that splits
that snapshot in two: base-level data (tables, base_name) and per-table probes
keyed table_id:role, with the verdict derived at render time and nothing to
clear." -m "It also closes the second stale entry: a base is only valid while
the link box still holds the link that produced it, so editing the box drops
the base and the verdict with it. A table nobody checked reports unread and
never borrows a sibling's verdict, and the defect role falls back to the
execution base only while its own link box is empty." -m "api.larkTableSchema
is the client for the read-only per-table endpoint; a unit test pins its URL,
CSRF header and request body keys." -m "Verified in this workspace: npx vitest
run src/larkDraft.test.ts (16 passed), npx vitest run src/api.test.ts (3
passed), npm run build (tsc -b + vite build green)."
```

---

### Task 3: `frontend/src/hooks/useLarkDraft.ts`

本 task 把「谁可以改 draft」收敛到一个 hook：读链接、切表、校验、创建/重建后跟随、切组复位。**覆盖验收门 1、3、7 的 hook 层**（渲染层在 Task 5/6）。

**Files:**
- Create `frontend/src/hooks/useLarkDraft.ts` —— 新建目录与文件，**1-288 行**（唯一改 draft 的地方；`__tests__` 之外无 React 之外的依赖）
- Test `frontend/src/hooks/useLarkDraft.test.tsx` —— 新建，**1-398 行**（13 个用例）
- Modify 无。本 task **不改** `frontend/src/views/LarkCheck.tsx`、`App.tsx`、`styles.css`

**Interfaces:**

**Consumes**

```ts
// frontend/src/api.ts（Task 2 之后）
export type TableSchema = { table_id: string; fields: Record<string, string>; required: string[]; schema_errors: string[] };
export type TableRole = "execution" | "bug";
export type Table = { table_id: string; name: string };
export type LarkResolved = { /* ... */ };
export type LarkTarget = { /* ... */ };

// frontend/src/larkDraft.ts（Task 2）
export function effectiveBase(draft: Draft, role: TableRole): LarkBase | null;
export function baseIsCurrent(role: RoleDraft): boolean;
export function draftFromTarget(target: LarkTarget | null): Draft;
export function emptyDraft(): Draft;
export function probeKey(tableId: string, role: TableRole): string;
export function suggestBugTable(tables: Table[], executionTableId: string, target: LarkTarget | null): string;
export function withCreatedTable(tables: Table[], created: CompletedTable | null, baseToken: string): Table[];
export type { CompletedTable, Draft, LarkBase, Probe, ProbeSlot, RoleDraft };
```

**Produces**（骨架 §Interfaces 逐字；名字、参数顺序、返回形状一个字都不许改）

```ts
// frontend/src/hooks/useLarkDraft.ts
export type LarkDraftActions = {
  draft: Draft;
  reading: TableRole | null;                       // 正在读取链接的 role
  checking: TableRole | null;                      // 正在校验表的 role
  setLink: (role: TableRole, url: string) => void;
  readLink: (role: TableRole) => Promise<TableRole | null>;   // 成功返回 role，失败返回 null（错误经 onError）
  setTable: (role: TableRole, tableId: string) => void;
  checkTable: (role: TableRole) => Promise<void>;
  acceptCreatedTable: (role: TableRole, table: Table) => void;
  acceptRebuiltTable: (role: TableRole, table: Table, replaced: Table) => void;
  resetDraft: (target: LarkTarget | null) => void;
};

export function useLarkDraft(opts: {
  groupId: string;
  resolve: (url: string) => Promise<LarkResolved>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  onError: (message: string) => void;
}): LarkDraftActions;
```

行为契约：

- `setLink` 只改 `url`；**同时把该 role 的 `base` 置 `null`、`viewId` 置 `null`**（除非 `baseIsCurrent` 仍成立）。
- `readLink` 成功：写入该 role 的 base（含 `probes`），`tableId` = `resolved.selected.table_id ?? tables[0].table_id`，`viewId` = `selected.view_id`；并把 `resolve` 返回的 `schema_errors/fields` 作为 `execution` role 的**首个 probe 播种**（仅当 role === "execution" 且 table_id === selected.table_id）；随后对 `bug` role 的当前表**自动校验一次**（同库场景）。
- `checkTable` 走 `readTableSchema(base.base_token, tableId, role)`；成功写 probe，失败写 `{fields:{},required:[],schema_errors:[],read_error:message}`。
- `acceptRebuiltTable`：把该 role 的 `tableId` 指向新表、移除被替换表、新表 probe 置 `"loading"` 后自动 `checkTable`；并**作废另一 role 的 probe**（重建会改目标表）。
- `acceptCreatedTable`：新表 probe 置 `"loading"` 后自动 `checkTable`。
- `resetDraft(target)`：`emptyDraft()` 后用 `draftFromTarget(target)` 预填 url 与两个 tableId（`base` 仍为 `null` → 判决为 `unread`）。
- `groupId` 变化：draft 复位为 `emptyDraft()`。

实现上对上面几条的落点（都是契约要求的，不是可选装饰）：
- `checkTable` **不做「有 probe 就跳过」的短路**：它既是门 3 的「校验入口」，也是表头修好后重新校验的唯一入口；重复请求由 `inFlight`（同一 `table_id:role` 并发去重）和渲染层（未读才显示校验按钮）挡住，而不是由它自己吞掉调用。门 7 的「同表来回切不重复请求」因此由**切表不触发请求 + probe 按表缓存**成立。
- `acceptCreatedTable` / `acceptRebuiltTable` 把新表插进 `draft[role].base.tables`（`withCreatedTable`），因为 `StepTablesProps` 没有第二个来源能拿到它（见 Task 2 的落点说明）。
- 两个 `accept*` 里 **`withBase` 必须最后调用**：`withRole(...{...current[role]})` 展开的是**旧** role 对象，先写 base 再改选中会把刚换上的 `tables` 覆盖回去。
- `readLink` 在 `catch` 里只 `onError`、不写 base，并返回 `null`；`resolve` 失败时 draft 保持原样（规格 §8）。

- [ ] **Step 1: 写失败的测试（`useLarkDraft.test.tsx`，完整文件）**

新建 `frontend/src/hooks/useLarkDraft.test.tsx`：

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LarkResolved, LarkTarget, TableRole, TableSchema } from "../api";
import { effectiveBase, emptyDraft, probeFor, probeKey, verdictFor, type Draft } from "../larkDraft";
import { useLarkDraft } from "./useLarkDraft";

const URL = "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs";
const BUG_URL = "https://tenant.larksuite.com/base/app-bugs";
const OTHER_URL = "https://tenant.larksuite.com/base/app-exec";

const RESOLVED: LarkResolved = {
  source_url: URL,
  base_token: "app-exec",
  base_name: "执行库",
  tables: [
    { table_id: "tbl-runs", name: "执行记录" },
    { table_id: "tbl-bugs", name: "缺陷记录" }
  ],
  selected: { table_id: "tbl-runs", table_name: "执行记录", view_id: "vew-main" },
  execution_fields: { 用例: "text", 结果: "single_select", 截图: "attachment" },
  required_execution_fields: ["用例", "结果", "截图"],
  schema_errors: [],
  read_errors: []
};

const BAD_RESOLVED: LarkResolved = {
  ...RESOLVED,
  schema_errors: ["缺少必填字段「截图」"]
};

// 缺陷库链接读到的第二个 base。
const BUG_RESOLVED: LarkResolved = {
  source_url: BUG_URL,
  base_token: "app-bugs",
  base_name: "缺陷库",
  tables: [
    { table_id: "tbl-online", name: "线上缺陷" },
    { table_id: "tbl-past", name: "历史缺陷" }
  ],
  selected: { table_id: "tbl-online", table_name: "线上缺陷", view_id: null },
  execution_fields: {},
  required_execution_fields: [],
  schema_errors: [],
  read_errors: []
};

// 同一个 base 的另一段链接：缺陷库链接指向它时，缺陷表选到的还是 tbl-runs。
const OTHER_EXEC_RESOLVED: LarkResolved = {
  ...RESOLVED,
  source_url: OTHER_URL,
  selected: { table_id: "tbl-runs", table_name: "执行记录", view_id: null }
};

const TARGET: LarkTarget = {
  group_id: "group-1",
  source_url: URL,
  execution_base_token: "app-exec",
  execution_base_name: "执行库",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-exec",
  bug_base_name: "执行库",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: "schema-1",
  target_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs",
  confirmed_at: null,
  confirmed: false
};

type Api = {
  resolve: (url: string) => Promise<LarkResolved>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  onError: (message: string) => void;
};

const okSchema: Api["readTableSchema"] = async (_baseToken, tableId) => ({
  table_id: tableId,
  fields: { 用例: "text" },
  required: ["用例"],
  schema_errors: []
});

function setup(overrides: Partial<Api> = {}) {
  const resolve = vi.fn(overrides.resolve ?? (async () => RESOLVED));
  const readTableSchema = vi.fn(overrides.readTableSchema ?? okSchema);
  const onError = vi.fn(overrides.onError ?? (() => undefined));
  const view = renderHook(
    (props: { groupId: string }) => useLarkDraft({ ...props, resolve, readTableSchema, onError }),
    { initialProps: { groupId: "group-1" } }
  );
  return { ...view, resolve, readTableSchema, onError };
}

// probeFor 的返回值是 Probe | "loading" | undefined；测试里只想拿真正的 probe。
function probeOf(draft: Draft, role: TableRole) {
  const slot = probeFor(draft, role);
  return slot && slot !== "loading" ? slot : null;
}

type Harness = ReturnType<typeof setup>;

// 链接框是页面的输入框：hook 只从框里读 url，所以每次读取都要先填框。
async function readLink(harness: Harness, role: TableRole, url: string) {
  await act(async () => {
    harness.result.current.setLink(role, url);
  });
  await act(async () => {
    await harness.result.current.readLink(role);
  });
}

describe("useLarkDraft", () => {
  it("hands out the newly selected table's verdict instead of the previous table's failure", async () => {
    const harness = setup({ resolve: async () => BAD_RESOLVED });
    const { result, readTableSchema } = harness;
    readTableSchema.mockImplementation(async (_baseToken, tableId) => ({
      table_id: tableId,
      fields: { 用例: "text" },
      required: ["用例"],
      schema_errors: tableId === "tbl-bugs" ? [] : ["缺少必填字段「截图」"]
    }));

    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "execution")).toBe("bad");

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });

    expect(verdictFor(result.current.draft, "execution")).toBe("ok");
    expect(probeOf(result.current.draft, "execution")?.schema_errors).toEqual([]);
  });

  it("keeps a table nobody checked unread and never borrows another table's or role's verdict", async () => {
    const harness = setup();
    const { result } = harness;
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");

    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });

    // tbl-bugs 的 bug-role probe 已经被自动校验过，execution role 一次都没有：
    // 判决必须是 unread，不许借用那张表在另一个 role 下的结论。
    expect(probeFor(result.current.draft, "execution")).toBeUndefined();
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");
    expect(
      result.current.draft.execution.base?.probes[probeKey("tbl-bugs", "bug")]
    ).toBeDefined();
  });

  it("stops falling back to the execution base once the defect link box holds an unread link", async () => {
    const harness = setup();
    const { result } = harness;
    await readLink(harness, "execution", URL);
    expect(effectiveBase(result.current.draft, "bug")).toBe(
      result.current.draft.execution.base
    );

    await act(async () => {
      result.current.setLink("bug", BUG_URL);
    });

    expect(effectiveBase(result.current.draft, "bug")).toBeNull();
    expect(verdictFor(result.current.draft, "bug")).toBe("unread");
  });

  it("does not ask for the same table twice when the select is switched back and forth", async () => {
    const harness = setup();
    const { result, readTableSchema } = harness;
    await readLink(harness, "execution", URL);
    // 执行表的判决来自 resolve 的播种，零请求；缺陷表自动校验一次。
    expect(readTableSchema).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });
    expect(readTableSchema).toHaveBeenCalledTimes(2);

    await act(async () => {
      result.current.setTable("execution", "tbl-runs");
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(readTableSchema).toHaveBeenCalledTimes(2);
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");
  });

  it("drops the base and the verdict as soon as the link box is edited", async () => {
    const harness = setup({ resolve: async () => BAD_RESOLVED });
    const { result } = harness;
    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "execution")).toBe("bad");

    await act(async () => {
      result.current.setLink("execution", `${URL}&view=vew-main`);
    });

    expect(effectiveBase(result.current.draft, "execution")).toBeNull();
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");
    expect(result.current.draft.execution.tableId).toBe("tbl-runs");
  });

  it("records a failed check as unreadable with the reason it was given", async () => {
    const harness = setup();
    const { result, readTableSchema, onError } = harness;
    await readLink(harness, "execution", URL);
    readTableSchema.mockRejectedValueOnce(new Error("无法读取该数据表，请确认应用仍是协作者"));

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });

    expect(verdictFor(result.current.draft, "execution")).toBe("unreadable");
    expect(probeOf(result.current.draft, "execution")?.read_error).toBe(
      "无法读取该数据表，请确认应用仍是协作者"
    );
    expect(onError).toHaveBeenCalledWith("无法读取该数据表，请确认应用仍是协作者");
  });

  it("refuses a schema answer that names another table", async () => {
    const harness = setup();
    const { result, readTableSchema, onError } = harness;
    await readLink(harness, "execution", URL);
    readTableSchema.mockResolvedValueOnce({
      table_id: "tbl-other",
      fields: { 用例: "text" },
      required: ["用例"],
      schema_errors: []
    });

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });

    expect(verdictFor(result.current.draft, "execution")).toBe("unreadable");
    expect(onError).toHaveBeenCalledWith("校验结果与请求的表不一致：请求 tbl-bugs，返回 tbl-other");
  });

  it("follows a rebuilt table and invalidates the other role's probes", async () => {
    const harness = setup();
    const { result, readTableSchema } = harness;
    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "bug")).toBe("ok");

    await act(async () => {
      result.current.acceptRebuiltTable(
        "execution",
        { table_id: "tbl-runs2", name: "执行记录" },
        { table_id: "tbl-runs", name: "执行记录" }
      );
    });
    await waitFor(() => expect(verdictFor(result.current.draft, "execution")).toBe("ok"));

    expect(result.current.draft.execution.tableId).toBe("tbl-runs2");
    expect(result.current.draft.execution.base?.tables.map((table) => table.table_id)).toEqual([
      "tbl-runs2",
      "tbl-bugs"
    ]);
    expect(result.current.draft.execution.viewId).toBeNull();
    expect(verdictFor(result.current.draft, "bug")).toBe("unread");
    expect(readTableSchema).toHaveBeenCalledWith("app-exec", "tbl-runs2", "execution");
  });

  it("offers a table it just created as that role's selection and checks it once", async () => {
    const harness = setup();
    const { result, readTableSchema } = harness;
    await readLink(harness, "execution", URL);
    expect(readTableSchema).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.acceptCreatedTable("bug", { table_id: "tbl-new", name: "新建缺陷表" });
    });
    await waitFor(() => expect(readTableSchema).toHaveBeenCalledTimes(2));

    expect(result.current.draft.bug.tableId).toBe("tbl-new");
    // 缺陷库链接为空：新表落进两个 role 共用的那个 base，所以两边都看得到它。
    expect(result.current.draft.execution.base?.tables.map((table) => table.table_id)).toEqual([
      "tbl-new",
      "tbl-runs",
      "tbl-bugs"
    ]);
    await waitFor(() => expect(verdictFor(result.current.draft, "bug")).toBe("ok"));
  });

  it("resets the draft when the group changes", async () => {
    const harness = setup();
    const { result, rerender } = harness;
    await readLink(harness, "execution", URL);
    expect(effectiveBase(result.current.draft, "execution")).not.toBeNull();

    await act(async () => {
      rerender({ groupId: "group-2" });
    });

    expect(result.current.draft).toEqual(emptyDraft());
  });

  it("prefills a saved target and still calls both tables unread", () => {
    const { result } = setup();

    act(() => {
      result.current.resetDraft(TARGET);
    });

    expect(result.current.draft.execution.url).toBe(URL);
    expect(result.current.draft.execution.tableId).toBe("tbl-runs");
    expect(result.current.draft.bug.tableId).toBe("tbl-bugs");
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");
    expect(verdictFor(result.current.draft, "bug")).toBe("unread");
  });

  it("reports a refused read and writes no base", async () => {
    const { result, onError } = setup({
      resolve: async () => {
        throw new Error("该链接指向的不是多维表格");
      }
    });

    let returned: TableRole | null = "bug";
    await act(async () => {
      result.current.setLink("execution", URL);
    });
    await act(async () => {
      returned = await result.current.readLink("execution");
    });

    expect(returned).toBeNull();
    expect(onError).toHaveBeenCalledWith("该链接指向的不是多维表格");
    expect(result.current.draft.execution.base).toBeNull();
    expect(result.current.reading).toBeNull();
  });

  it("keeps one table's two roles apart when both roles point at it", async () => {
    const harness = setup({
      resolve: async (url) => (url === OTHER_URL ? OTHER_EXEC_RESOLVED : BAD_RESOLVED),
      readTableSchema: async (_baseToken, tableId, role) => ({
        table_id: tableId,
        fields: { 用例: "text" },
        required: ["用例"],
        schema_errors: role === "execution" ? ["缺少必填字段「截图」"] : []
      })
    });
    const { result } = harness;

    await readLink(harness, "execution", URL);
    await readLink(harness, "bug", OTHER_URL);

    expect(result.current.draft.execution.tableId).toBe("tbl-runs");
    expect(result.current.draft.bug.tableId).toBe("tbl-runs");
    expect(verdictFor(result.current.draft, "execution")).toBe("bad");
    expect(verdictFor(result.current.draft, "bug")).toBe("ok");
  });
});
```

`BUG_RESOLVED` 在文件里被声明但**没有任何用例使用**：它是这个 fixture 集合的第三个 base 形状（独立缺陷库），留着是为了让「缺陷库链接指向另一个 base」与「同库」两条路径在同一个文件里有可读的对照。若 `tsc` 或 review 不接受未使用的 fixture，删掉它并保留 `BUG_URL` 的两处断言即可 —— 那两处断言不依赖它。

- [ ] **Step 2: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx`
期望输出：

```
 FAIL  src/hooks/useLarkDraft.test.tsx [ src/hooks/useLarkDraft.test.tsx ]
Error: Failed to resolve import "../hooks/useLarkDraft" from "src/hooks/useLarkDraft.test.tsx". Does the file exist?
  Plugin: vite:import-analysis
```

- [ ] **Step 3: 实现（`useLarkDraft.ts`，完整文件）**

新建 `frontend/src/hooks/useLarkDraft.ts`：

```ts
import { useCallback, useEffect, useRef, useState } from "react";

import type { LarkResolved, LarkTarget, Table, TableRole, TableSchema } from "../api";
import {
  baseIsCurrent,
  draftFromTarget,
  effectiveBase,
  emptyDraft,
  probeKey,
  suggestBugTable,
  withCreatedTable,
  type CompletedTable,
  type Draft,
  type LarkBase,
  type Probe,
  type ProbeSlot,
  type RoleDraft
} from "../larkDraft";

export type LarkDraftActions = {
  draft: Draft;
  reading: TableRole | null;
  checking: TableRole | null;
  setLink: (role: TableRole, url: string) => void;
  readLink: (role: TableRole) => Promise<TableRole | null>;
  setTable: (role: TableRole, tableId: string) => void;
  checkTable: (role: TableRole) => Promise<void>;
  acceptCreatedTable: (role: TableRole, table: Table) => void;
  acceptRebuiltTable: (role: TableRole, table: Table, replaced: Table) => void;
  resetDraft: (target: LarkTarget | null) => void;
};

type Options = {
  groupId: string;
  resolve: (url: string) => Promise<LarkResolved>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  onError: (message: string) => void;
};

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function otherRole(role: TableRole): TableRole {
  return role === "execution" ? "bug" : "execution";
}

function baseFrom(resolved: LarkResolved, probes: Record<string, ProbeSlot>): LarkBase {
  return {
    base_token: resolved.base_token,
    base_name: resolved.base_name,
    source_url: resolved.source_url,
    tables: resolved.tables,
    read_errors: resolved.read_errors ?? [],
    probes
  };
}

// resolve 已经算过一次执行表的字段与缺失：把它播种成 execution+selected.table_id 的
// 首个 probe（规格 §7「判决单一来源」）。role 或 table 不匹配一律不播种。
function seededProbe(resolved: LarkResolved): Probe {
  return {
    fields: resolved.execution_fields,
    required: resolved.required_execution_fields,
    schema_errors: resolved.schema_errors
  };
}

// 读不到就是读不到：空 fields + read_error，verdictOf 因此回 unreadable，不冒充 ok。
function unreadableProbe(message: string): Probe {
  return { fields: {}, required: [], schema_errors: [], read_error: message };
}

function withRole(draft: Draft, role: TableRole, next: RoleDraft): Draft {
  return role === "execution" ? { ...draft, execution: next } : { ...draft, bug: next };
}

// 把 base 写回它真正的宿主 role：缺陷库链接为空时两个 role 用的是执行表的那个 base，
// 这时缺陷表的 probe 也必须写进那个 base，否则 verdictFor(role) 永远看不到它。
function withBase(draft: Draft, current: LarkBase, next: LarkBase): Draft {
  if (draft.execution.base === current) {
    return { ...draft, execution: { ...draft.execution, base: next } };
  }
  if (draft.bug.base === current) {
    return { ...draft, bug: { ...draft.bug, base: next } };
  }
  return draft;
}

// 迟到的响应不许污染已经换掉的 base：baseToken 是这次请求出发时的那个 base 才算数。
function withSlot(
  draft: Draft,
  role: TableRole,
  baseToken: string,
  key: string,
  slot: ProbeSlot
): Draft {
  const current = effectiveBase(draft, role);
  if (!current || current.base_token !== baseToken) return draft;
  const next: LarkBase = { ...current, probes: { ...current.probes, [key]: slot } };
  return withBase(draft, current, next);
}

function withoutRoleProbes(
  probes: Record<string, ProbeSlot>,
  role: TableRole
): Record<string, ProbeSlot> {
  const suffix = `:${role}`;
  const next: Record<string, ProbeSlot> = {};
  for (const [key, slot] of Object.entries(probes)) {
    if (!key.endsWith(suffix)) next[key] = slot;
  }
  return next;
}

function withoutTableProbes(
  probes: Record<string, ProbeSlot>,
  tableId: string
): Record<string, ProbeSlot> {
  const prefix = `${tableId}:`;
  const next: Record<string, ProbeSlot> = {};
  for (const [key, slot] of Object.entries(probes)) {
    if (!key.startsWith(prefix)) next[key] = slot;
  }
  return next;
}

export function useLarkDraft(opts: Options): LarkDraftActions {
  const { groupId, resolve, readTableSchema, onError } = opts;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [reading, setReading] = useState<TableRole | null>(null);
  const [checking, setChecking] = useState<TableRole | null>(null);

  // 异步回落到地上时要读「当次渲染」的 draft（链接框可能在请求飞行中被改过），
  // 闭包里的 draft 是发起那次请求时的旧值 —— 用 ref 拿最新的。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 同一张表同一个 role 的校验不许并发重复发请求（验收门 7）。
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 换了测试组：draft 复位（行为契约）。上一组的链接、base、判决都不属于这一组。
    setDraft(emptyDraft());
    setReading(null);
    setChecking(null);
    inFlight.current.clear();
  }, [groupId]);

  const runCheck = useCallback(
    async (role: TableRole, baseToken: string, tableId: string): Promise<void> => {
      if (!baseToken || !tableId) return;
      const key = probeKey(tableId, role);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setDraft((current) => withSlot(current, role, baseToken, key, "loading"));
      setChecking(role);
      try {
        const schema = await readTableSchema(baseToken, tableId, role);
        // 服务端说它答的是另一张表：这份字段不能挂到这张表的 key 上，那正是这次
        // 重构要根治的「串味」。当作一次失败的读取处理。
        if (schema.table_id !== tableId) {
          const message = `校验结果与请求的表不一致：请求 ${tableId}，返回 ${schema.table_id}`;
          setDraft((current) =>
            withSlot(current, role, baseToken, key, unreadableProbe(message))
          );
          onError(message);
          return;
        }
        setDraft((current) =>
          withSlot(current, role, baseToken, key, {
            fields: schema.fields,
            required: schema.required,
            schema_errors: schema.schema_errors
          })
        );
      } catch (reason) {
        const message = messageOf(reason, "读取该表字段失败");
        setDraft((current) => withSlot(current, role, baseToken, key, unreadableProbe(message)));
        onError(message);
      } finally {
        inFlight.current.delete(key);
        setChecking((current) => (current === role ? null : current));
      }
    },
    [readTableSchema, onError]
  );

  const setLink = useCallback((role: TableRole, url: string) => {
    setDraft((current) => {
      const roleDraft = current[role];
      // 编辑链接框 = 这张表还没读过：base 与判决一并作废（规格 §4.2）。只有框里
      // 仍是读到过的那段链接（trim 后逐字相同）时才留着 base。
      const stillCurrent = roleDraft.base !== null && roleDraft.base.source_url === url.trim();
      const next: RoleDraft = stillCurrent
        ? { ...roleDraft, url }
        : { url, base: null, tableId: roleDraft.tableId, viewId: null };
      return withRole(current, role, next);
    });
  }, []);

  const setTable = useCallback((role: TableRole, tableId: string) => {
    setDraft((current) => {
      const roleDraft = current[role];
      if (roleDraft.tableId === tableId) return current;
      // view 只描述链接当时选中的那张表：换表即丢，不当成新表的 view 存下去。
      return withRole(current, role, { ...roleDraft, tableId, viewId: null });
    });
  }, []);

  const readLink = useCallback(
    async (role: TableRole): Promise<TableRole | null> => {
      const url = draftRef.current[role].url.trim();
      if (!url) return null;
      setReading(role);
      let result: TableRole | null = null;
      let pending: { role: TableRole; baseToken: string; tableId: string } | null = null;
      try {
        const resolved = await resolve(url);
        const selected = resolved.selected.table_id ?? resolved.tables[0]?.table_id ?? "";
        const current = draftRef.current;
        const probes: Record<string, ProbeSlot> = {};
        if (role === "execution" && selected !== "" && selected === resolved.selected.table_id) {
          probes[probeKey(selected, "execution")] = seededProbe(resolved);
        }
        const readRole: RoleDraft = {
          // 框里现在是哪段链接就留哪段：服务端回显的 source_url 与它不同源时
          // baseIsCurrent 会判 false，判决诚实地回到 unread，而不是拿旧判决顶着。
          url: current[role].url,
          base: baseFrom(resolved, probes),
          tableId: selected,
          viewId: resolved.selected.view_id
        };
        let next = withRole(current, role, readRole);
        // 缺陷库链接为空 = 与执行表同库：缺陷表的下拉必须落在同一个 base 的表里，
        // 选中的表不在这批表里时退回建议值（旧页面的 effectiveBugTableId 规则）。
        if (role === "execution" && next.bug.url.trim() === "") {
          const chosen =
            next.bug.tableId !== "" &&
            resolved.tables.some((table) => table.table_id === next.bug.tableId);
          if (!chosen) {
            next = withRole(next, "bug", {
              ...next.bug,
              tableId: suggestBugTable(resolved.tables, selected, null),
              viewId: null
            });
          }
        }
        setDraft(next);
        // 同库场景顺手校验一次缺陷表（规格 §8）。借来的 base 会把 probe 写回宿主 role。
        const bugBase = effectiveBase(next, "bug");
        if (bugBase && next.bug.tableId !== "") {
          pending = { role: "bug", baseToken: bugBase.base_token, tableId: next.bug.tableId };
        }
        result = role;
      } catch (reason) {
        onError(messageOf(reason, role === "bug" ? "读取缺陷表失败" : "读取 Lark 表格失败"));
        result = null;
      } finally {
        setReading(null);
      }
      // 读取的 spinner 收掉之后再校验，页面不会同时转两个圈。
      if (pending) await runCheck(pending.role, pending.baseToken, pending.tableId);
      return result;
    },
    [resolve, runCheck, onError]
  );

  const checkTable = useCallback(
    async (role: TableRole): Promise<void> => {
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      const tableId = current[role].tableId;
      if (!base || !tableId) return;
      await runCheck(role, base.base_token, tableId);
    },
    [runCheck]
  );

  const acceptCreatedTable = useCallback(
    (role: TableRole, table: Table) => {
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      if (!base) {
        onError("请先读取该多维表格链接，再把新建的数据表加入选择");
        return;
      }
      // 新建的表落进它被创建时所在的那个 base；两个 role 共用同一个 base 时，
      // 它会同时出现在两个下拉里 —— 服务端的 list_tables 之后也会这么答。
      const created: CompletedTable = { ...table, base_token: base.base_token };
      const nextBase: LarkBase = {
        ...base,
        tables: withCreatedTable(base.tables, created, base.base_token)
      };
      // 先改选中（此 role 对象里还挂着旧 base），再把新 base 写回 —— withBase 必须最后
      // 做，否则它换上的 tables 会被 withRole 拿旧 role 对象覆盖掉。
      const selected = withRole(current, role, {
        ...current[role],
        tableId: table.table_id,
        viewId: null
      });
      setDraft(withBase(selected, base, nextBase));
      void runCheck(role, base.base_token, table.table_id);
    },
    [runCheck, onError]
  );

  const acceptRebuiltTable = useCallback(
    (role: TableRole, table: Table, replaced: Table) => {
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      if (!base) {
        onError("请先读取该多维表格链接，再重建数据表");
        return;
      }
      const created: CompletedTable = { ...table, base_token: base.base_token };
      // 重建在服务端换掉了目标表：被替换表从表单里下去，它的 probe 与另一个 role 的
      // probe 一并作废（重建会改到目标表的表头，规格 §8）。
      let probes = withoutTableProbes(base.probes, replaced.table_id);
      probes = withoutRoleProbes(probes, otherRole(role));
      const nextBase: LarkBase = {
        ...base,
        tables: withCreatedTable(
          base.tables.filter((item) => item.table_id !== replaced.table_id),
          created,
          base.base_token
        ),
        probes
      };
      // 同上：withBase 最后做。
      const selected = withRole(current, role, {
        ...current[role],
        tableId: table.table_id,
        viewId: null
      });
      setDraft(withBase(selected, base, nextBase));
      void runCheck(role, base.base_token, table.table_id);
    },
    [runCheck, onError]
  );

  const resetDraft = useCallback((target: LarkTarget | null) => {
    setDraft(draftFromTarget(target));
  }, []);

  return {
    draft,
    reading,
    checking,
    setLink,
    readLink,
    setTable,
    checkTable,
    acceptCreatedTable,
    acceptRebuiltTable,
    resetDraft
  };
}
```

注意 `baseIsCurrent` 在这个文件里只被 `effectiveBase`（经 `../larkDraft`）用到，hook 自己**不重复**实现同源判断：`setLink` 用的是同一条件（`base.source_url === url.trim()`），两条路径必须得出同一个结论。

- [ ] **Step 4: 跑，期望变绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx`
期望输出：`Test Files  1 passed (1)` / `Tests  13 passed (13)`

若看到 `Warning: An update to TestComponent inside a test was not wrapped in act(...)`，说明有用例在 `act` 外等异步：把 `await waitFor(...)` 换成 `await act(async () => { await result.current.checkTable("execution"); })`，**不要**用 `vi.useFakeTimers()` 绕过去 —— 这个 hook 的异步全是 promise，没有定时器。

- [ ] **Step 5: 类型门 + 回归**

Run: `cd /home/lucascool/qa-board/frontend && npx tsc -b && npx vitest run src/larkDraft.test.ts src/hooks/useLarkDraft.test.tsx src/api.test.ts`
期望输出：`tsc` 无输出（exit 0）；`Test Files  3 passed (3)` / `Tests  32 passed (32)`（16 + 13 + 3）

- [ ] **Step 6: 自查后提交**

自查四条，逐条回答（答不上就别提交）：

1. **门 1 的 hook 层证据**：`hands out the newly selected table's verdict...` 这个用例断言了「切表前 `bad` → 切表后 `ok`」；把 `withSlot` 的 `probeKey(tableId, role)` 改成只用 `role`（人为串味）后重跑，这个用例必须变红。
2. **门 7 的证据**：`does not ask for the same table twice...` 用 `readTableSchema` 的调用计数断言 1 → 2 → 2；把 `setTable` 改成顺便 `void runCheck(...)` 后重跑，计数会变 3 或更多，用例必须变红。
3. `resetDraft` 之后两张表的判决都是 `unread`（`prefills a saved target and still calls both tables unread`），`groupId` 变化后 draft 逐字等于 `emptyDraft()`。
4. `git status` 只多出 `frontend/src/hooks/` 这个新目录；`views/LarkCheck.tsx` 等既有文件一个都没动（本 task 不接线，接线在 Task 6）。

```bash
cd /home/lucascool/qa-board && git add frontend/src/hooks/useLarkDraft.ts frontend/src/hooks/useLarkDraft.test.tsx && git commit -m "feat(web): one hook owns the Lark draft, its links and its checks" -m "The page used to hold six pieces of state that had to be cleared together
by hand (resolved, bugResolved, bugReadUrl, two table ids, createdTables), and
every stale-state bug came from forgetting one of them. This hook is the only
place that writes the draft: reading a link writes that role's base, editing a
link box drops it, switching a table changes only the key the verdict is
derived from, and checking a table writes one probe." -m "Reading the execution
link seeds the execution probe from what resolve already computed (no extra
request), then checks the defect table once when both roles share the base. A
rebuilt table is followed: the replaced table leaves the list, the new one
becomes the selection, and the other role's probes are dropped because the
rebuild changed the target table. A rebuilt or created table with no readable
base is refused with a message instead of being half-applied." -m "Verified in
this workspace: npx vitest run src/hooks/useLarkDraft.test.tsx (13 passed),
npx vitest run src/larkDraft.test.ts src/hooks/useLarkDraft.test.tsx
src/api.test.ts (32 passed), npx tsc -b, npm run build."
```

---

> **给 Task 5 / 6 的交接（不是新契约，是这两个 task 需要知道的落点）**
>
> 1. **第 ① 步的下拉只有一个来源**：`draft[role].base.tables`（新建的表由 Task 3 的 `acceptCreatedTable` 用 `withCreatedTable` 插进去）。`StepTablesProps` 里没有 `createdTables`，不要再加 —— 加了就有两个真值源。
> 2. **判决只读 `verdictFor(draft, role)`**；`resolved.schema_errors` / `resolved.execution_fields` 在 Task 6 里只能用于 `readLink` 之后的**播种**（已在 hook 内完成），页面不得再读它们。
> 3. **`loading` 的唯一真值源是 probe 槽位**（`verdictFor(draft, role) === "loading"`）：渲染与禁用都看它。`checking` / `reading` 只能用来禁用按钮，**不得**作为"是否在加载"的判据。
>    > ~~`checking` / `reading` 是渲染 loading 的唯一依据~~ —— **这条原文是错的**，Round 1 复审 A3 指出它构成双真值源（重叠校验时两个来源会互相打脸），已在 Task 3b 一并修正。
> 4. **门 5 的两个「自动展开」**由 `describeHealth(...).step` 决定：`step === "headers"` → 展开第 ② 步；`step === "sync"` → 展开第 ④ 步。tone 只决定状态条颜色，不要再另写一份条件。
> 5. **`stepsComplete` 的 `sync` 不看 `parked`**（理由见 Task 2 Step 7 的第 3 点）；第 ④ 步的 `attention` 状态要看 `describeHealth` 而**不是** `stepsComplete`，两者回答的不是同一个问题。

---

## Task 3b: Round 1 复审补丁（B7 / A3 / A4 / E1 + 时序测试）

> **本节的来源**：独立对抗性复审（**附录 A**，A 类 6 条 / B 类 7 条）指出 Task 3 的代码有 4 处必须修，其中 **B7 是主路径断路**。
> **执行顺序**：Task 3 的全部步骤跑绿并提交之后，再执行本节；本节每一步独立提交。不要把它们并进 Task 3 的既有步骤里（那些步骤的"先红"证据已经成立，改写会毁掉证据链）。
> **Files**：Modify `frontend/src/hooks/useLarkDraft.ts`、Modify `frontend/src/hooks/useLarkDraft.test.tsx`

### Step B0: 先改接口声明（B7 的必要条件）

`LarkDraftActions`（Task 3 Step 1 写的那个 type）里，在 `checkTable` 之后插入两行：

```ts
  checkTable: (role: TableRole) => Promise<void>;
  invalidateRole: (role: TableRole) => void;          // 作废该 role 当前表的 probe
  recheckRole: (role: TableRole) => Promise<void>;    // = invalidateRole + checkTable
  acceptCreatedTable: (role: TableRole, table: Table) => void;
```

```bash
cd /home/lucascool/qa-board/frontend && npx tsc -b
```
期望：**FAIL** —— `invalidateRole` / `recheckRole` 未实现，`ReturnType` 不满足 `LarkDraftActions`。这条红就是 B7 的证伪线（接口要的东西没人实现）。

### Step B1: B7 —— 实现 `invalidateRole` / `recheckRole`

**为什么要它**：规格 §8 要求「provision / retype 后作废受影响 role 的 probe 并重新校验」，但契约里没有执行者。一张被判 `bad` 的表被「设置表头」修好之后，probe 仍是 `bad`；而渲染层"校验按钮只在 `unread` 时显示"又掐掉了唯一手动入口 → 第 ③ 步「两表 verdict 均 ok 才可勾选」**永远达不成**。修表头这条主路径在新页面上走不通。

**Step B1.1 先写失败测试**（加到 `useLarkDraft.test.tsx`，复用该文件既有的 `setup` / `readLink` / `verdictFor` / `URL` / `RESOLVED`）：

```tsx
// 表头缺列 → bad；修好表头后（第二次校验）→ ok。这是 provision / retype 之后的主路径。
it("recheckRole recomputes the verdict after the headers are repaired", async () => {
  const state = { repaired: false };
  const readTableSchema = vi.fn(async (_base: string, tableId: string) => ({
    table_id: tableId,
    fields: { 用例: "text" },
    required: ["用例", "截图"],
    schema_errors: state.repaired ? [] : ["缺少必填字段「截图」"]
  }));
  const badResolved: LarkResolved = {
    ...RESOLVED,
    schema_errors: ["缺少必填字段「截图」"]
  };
  const harness = setup({ resolve: async () => badResolved, readTableSchema });

  await readLink(harness, "execution", URL);
  expect(verdictFor(harness.result.current.draft, "execution")).toBe("bad");

  state.repaired = true;
  await act(async () => {
    await harness.result.current.recheckRole("execution");
  });
  expect(verdictFor(harness.result.current.draft, "execution")).toBe("ok");
});

it("invalidateRole drops the verdict back to unread", async () => {
  const harness = setup();
  await readLink(harness, "execution", URL);
  expect(verdictFor(harness.result.current.draft, "execution")).toBe("ok");

  await act(async () => {
    harness.result.current.invalidateRole("execution");
  });
  expect(verdictFor(harness.result.current.draft, "execution")).toBe("unread");
});
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx -t "recheckRole"
```
期望：**FAIL** —— `harness.result.current.recheckRole is not a function`。

**Step B1.2 最小实现**（插在 `checkTable` 的 `useCallback` 之后、`acceptCreatedTable` 之前）：

```ts
  const invalidateRole = useCallback((role: TableRole) => {
    setDraft((current) => {
      const base = effectiveBase(current, role);
      const tableId = current[role].tableId;
      if (!base || !tableId) return current;
      // 只作废这张表的 probe，不动另一个 role，也不动别的表（复审 B7）。
      const next: LarkBase = {
        ...base,
        probes: withoutTableProbes(base.probes, tableId)
      };
      return withBase(current, base, next);
    });
  }, []);

  const recheckRole = useCallback(
    async (role: TableRole): Promise<void> => {
      // 先取 base/tableId，再作废：作废只清 probe，不动这两个值。
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      const tableId = current[role].tableId;
      if (!base || !tableId) return;
      invalidateRole(role);
      // 不带 base 复用：runCheck 自己会按 baseToken 写回，切了 base 就写不进去（那是正确行为）。
      await runCheck(role, base.base_token, tableId);
    },
    [invalidateRole, runCheck]
  );
```

**Step B1.3** 把两者加进 hook 的 `return` 对象（`checkTable` 之后）：

```ts
    checkTable,
    invalidateRole,
    recheckRole,
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx
cd /home/lucascool/qa-board/frontend && npm run build
```
期望：全绿 + 类型通过。

**Step B1.4 提交**

```bash
cd /home/lucascool/qa-board && git add frontend/src/hooks/useLarkDraft.ts frontend/src/hooks/useLarkDraft.test.tsx && git commit -m "fix(web): let a repaired header table be re-judged

provision and retype can repair a table whose required columns were missing,
but the probe stayed bad and the verdict UI only offered a check for unread
tables, so step 3 could never be reached. invalidateRole drops one table's
probe; recheckRole drops it and checks it again. Round 1 review B7."
```

### Step B2: A3 —— `inFlight` 带上 base 身份、`checking` 不再撒谎

**为什么要它**（复审 A3）：
- 现在 `const key = probeKey(tableId, role)`，**不含 base**。切 base 后对同名表的校验会命中 still-in-flight 的键 → **静默 no-op**（不发请求、不报错），违反规格 §8 的"切 base 重新校验"。
- `api.ts` 的 `request()` **没有超时**，一次挂死的 fetch 会让该键永占 → 那张表的校验按钮**永久失效**。
- `setChecking((current) => (current === role ? null : current))` 只按 role 判等：同一 role 的两张表重叠校验时，先落地的那次会把另一张表的 loading 标志清掉。

**Step B2.1 先写失败测试**：

```tsx
it("checks the same table id again after the base changed", async () => {
  // 同一个 table_id 出现在两个 base 里：切 base 之后必须真的再发一次请求。
  const readTableSchema = vi.fn(async (_base: string, tableId: string) => ({
    table_id: tableId,
    fields: {},
    required: [],
    schema_errors: []
  }));
  let release: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = vi.fn(async (_base: string, tableId: string) => {
    await first;
    return { table_id: tableId, fields: {}, required: [], schema_errors: [] };
  });
  const harness = setup({ readTableSchema: slow });
  await readLink(harness, "execution", URL);

  // 换到另一个 base（缺陷库链接指向另一段链接），再对同名表发一次校验
  await act(async () => {
    harness.result.current.setLink("bug", OTHER_URL);
  });
  // 另一 base 的读取是异步的，这里直接驱动 hook：先让第一张表的请求还挂着
  release();
  await act(async () => {
    await harness.result.current.readLink("bug");
  });
  expect(slow.mock.calls.length).toBeGreaterThanOrEqual(2);
});
```

> 若这条用例在你的实现下无法稳定构造（base 切换必须经过 `readLink`），**允许改成**：断言 `runCheck` 的键含 base —— 即对同一 `table_id`、不同 `base_token` 连续 `checkTable` 两次，`readTableSchema` 被调用两次。判据是"**不同 base 的同名表不会被去重吞掉**"，不是某种特定写法。

**Step B2.2 实现**（替换 `inFlight` 的声明与 `runCheck` 里的键/清标志逻辑）：

```ts
  // 键里必须带 base：否则切 base 后对同名表的校验会被静默吞掉（复审 A3）。
  // 值 = 发起时刻，用于给"永不落地"的请求兜底（api.ts 没有超时）。
  const inFlight = useRef<Map<string, number>>(new Map());
```

`runCheck` 内部：

```ts
      if (!baseToken || !tableId) return;
      // 注意两个键不是一个东西：probe 槽位键永远只是 `${table_id}:${role}`（契约），
      // 去重键才带 base。混用会把 probe 写到带 base 前缀的键上，判决就永远查不到。
      const probeSlotKey = probeKey(tableId, role);
      const flightKey = `${baseToken}:${probeSlotKey}`;
      const startedAt = inFlight.current.get(flightKey);
      if (startedAt !== undefined && Date.now() - startedAt < CHECK_ABANDON_MS) return;
      inFlight.current.set(flightKey, Date.now());
      setDraft((current) => withSlot(current, role, baseToken, probeSlotKey, "loading"));
      setChecking(role);
```

其余 `withSlot(..., key, ...)` 一律改用 `probeSlotKey`；`finally` 改成：

```ts
      } finally {
        inFlight.current.delete(flightKey);
        setChecking((current) => {
          if (current !== role) return current;
          // 同一 role 可能还有别的表在飞：只要还有，就别把 loading 标志清掉（复审 A3）。
          const stillRunning = [...inFlight.current.keys()].some((item) =>
            item.endsWith(`:${role}`)
          );
          return stillRunning ? role : null;
        });
      }
```

模块顶部加常量：

```ts
// 请求挂死时的兜底：超过这个时长就认为那次校验已经作废，允许重新发起。
const CHECK_ABANDON_MS = 30_000;
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx
cd /home/lucascool/qa-board/frontend && npm run build
```
期望：全绿（含既有的门 7「同表来回切不重复请求」——它现在由 `probe` 缓存成立，不是由去重键成立）。

**Step B2.3 提交**

```bash
cd /home/lucascool/qa-board && git add frontend/src/hooks/useLarkDraft.ts frontend/src/hooks/useLarkDraft.test.tsx && git commit -m "fix(web): key in-flight checks by base and stop clearing a busy role early

The dedupe key held only table and role, so a check for the same table in
another base was swallowed silently, and a request that never settles held
its key for good because api.ts has no timeout. The busy flag now stays set
while any check for that role is still running. Round 1 review A3."
```

### Step B3: A4 —— 重建后两个 role 一起跟随

**为什么要它**（复审 A4）：重建会在服务端**替换表本身**。现在只有被重建的 role 跟随新表；若另一个 role 的 `tableId` 恰好等于被替换表的 id（两 role 同表的场景），它会留下一个指向**已消失的表**的下拉值（后端 409 能兜住，但不该走到那一步）。

**Step B3.1 先写失败测试**：

```tsx
it("follows the rebuilt table in the other role when both roles named it", async () => {
  const harness = setup();
  await readLink(harness, "execution", URL);
  // 让两个 role 都指向同一张表：缺陷表也选 tbl-runs
  await act(async () => {
    harness.result.current.setTable("bug", "tbl-runs");
  });

  await act(async () => {
    harness.result.current.acceptRebuiltTable(
      "execution",
      { table_id: "tbl-new", name: "执行记录（新）" },
      { table_id: "tbl-runs", name: "执行记录" }
    );
  });

  expect(harness.result.current.draft.execution.tableId).toBe("tbl-new");
  expect(harness.result.current.draft.bug.tableId).toBe("tbl-new");
  expect(
    harness.result.current.draft.execution.base?.tables.some(
      (table) => table.table_id === "tbl-runs"
    )
  ).toBe(false);
});
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx -t "rebuilt table in the other role"
```
期望：**FAIL** —— `draft.bug.tableId` 仍是 `"tbl-runs"`。

**Step B3.2 实现**（替换 `acceptRebuiltTable` 里"写回 draft"的那几行）：

```ts
      // 同上：withBase 最后做。
      let next = withRole(current, role, {
        ...current[role],
        tableId: table.table_id,
        viewId: null
      });
      // 另一个 role 若也指着被替换的这张表，必须一起跟随（复审 A4）。
      const other = otherRole(role);
      const otherFollows = current[other].tableId === replaced.table_id;
      if (otherFollows) {
        next = withRole(next, other, {
          ...next[other],
          tableId: table.table_id,
          viewId: null
        });
      }
      setDraft(withBase(next, base, nextBase));
      void runCheck(role, base.base_token, table.table_id);
      if (otherFollows) void runCheck(other, base.base_token, table.table_id);
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx
cd /home/lucascool/qa-board/frontend && npm run build
```

**Step B3.3 提交**

```bash
cd /home/lucascool/qa-board && git add frontend/src/hooks/useLarkDraft.ts frontend/src/hooks/useLarkDraft.test.tsx && git commit -m "fix(web): move both roles off a table that was rebuilt away

A rebuild replaces the table itself; when the other role named the replaced
table it kept a selection pointing at a table that no longer exists. It now
follows the new table and is checked again. Round 1 review A4."
```

### Step B4: E1 —— `readLink` 加在途守卫

**为什么要它**（复审 E1）：`readLink` 没有在途守卫，双击「读取表格」会发 N 次 `resolve`（规格 §7 只约束了单次端点预算，没约束点击）。

**Step B4.1 先写失败测试**：

```tsx
it("does not resolve twice when the read button is hit twice", async () => {
  let release: (value: LarkResolved) => void = () => undefined;
  const resolve = vi.fn(
    () => new Promise<LarkResolved>((settle) => {
      release = settle;
    })
  );
  const harness = setup({ resolve });
  await act(async () => {
    harness.result.current.setLink("execution", URL);
  });

  let first: Promise<TableRole | null> = Promise.resolve(null);
  let second: Promise<TableRole | null> = Promise.resolve(null);
  await act(async () => {
    first = harness.result.current.readLink("execution");
    second = harness.result.current.readLink("execution");
    release(RESOLVED);
    await Promise.all([first, second]);
  });

  expect(resolve).toHaveBeenCalledTimes(1);
});
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx -t "hit twice"
```
期望：**FAIL** —— `resolve` 被调用 2 次。

**Step B4.2 实现**：

```ts
  // 双击「读取表格」不该发两次 resolve（复审 E1）。
  const readInFlight = useRef<Set<TableRole>>(new Set());
```

`readLink` 开头：

```ts
      const url = draftRef.current[role].url.trim();
      if (!url) return null;
      if (readInFlight.current.has(role)) return null;
      readInFlight.current.add(role);
      setReading(role);
```

`readLink` 的 `finally`：

```ts
      } finally {
        readInFlight.current.delete(role);
        setReading(null);
      }
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx
cd /home/lucascool/qa-board/frontend && npm run build
```

### Step B5: 时序测试 —— 在途响应遇到链接框被改（复审点名的缺口）

**为什么要它**：`withSlot` 的 base 守卫是整个设计里**唯一非结构性的机制**，而它此前没有任何测试覆盖。这条用例必须存在，否则将来有人"顺手简化"掉守卫不会被发现。

```tsx
it("a late response does not write a verdict into a base the box no longer holds", async () => {
  let release: (value: LarkResolved) => void = () => undefined;
  const resolve = vi.fn(
    () => new Promise<LarkResolved>((settle) => {
      release = settle;
    })
  );
  const harness = setup({ resolve });
  await act(async () => {
    harness.result.current.setLink("execution", URL);
  });

  let pending: Promise<TableRole | null> = Promise.resolve(null);
  await act(async () => {
    pending = harness.result.current.readLink("execution");
  });
  // 请求还在飞的时候，管理员把链接框改成了另一段链接
  await act(async () => {
    harness.result.current.setLink("execution", OTHER_URL);
  });
  await act(async () => {
    release(RESOLVED);
    await pending;
  });

  // 迟到的那份响应属于旧链接：base 判为不当前，判决诚实地停在 unread
  expect(verdictFor(harness.result.current.draft, "execution")).toBe("unread");
});
```

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/hooks/useLarkDraft.test.tsx
cd /home/lucascool/qa-board/frontend && npm run build
```
期望：全绿。**变异检验**：把 `withSlot` 里 `current.base_token !== baseToken` 那个判断删掉，这条用例必须变红 —— 变不红说明它没测到守卫。

### Step B6: 全量门 + 提交

```bash
cd /home/lucascool/qa-board/frontend && npx vitest run src/larkDraft.test.ts src/hooks/useLarkDraft.test.tsx src/api.test.ts
cd /home/lucascool/qa-board/frontend && npm run build
```
期望：Task 2/3 原有的 32 例 + 本节新增的 6 例全绿；`tsc -b` 无错。

```bash
cd /home/lucascool/qa-board && git add -A frontend/src && git commit -m "test(web): pin the in-flight base guard, which the redesign leans on

The guard that refuses to write a late response into a base that has been
replaced is the only non-structural mechanism in this design and had no
test. Removing it must turn this test red. Round 1 review B-gap."
```
### Task 4: 拆出三个破坏性对话框 + `StepHeaders`，删除 `HeaderSetup.tsx`

> Round 1 复审补丁：B7（onRoleFixed）已并入本分段（2026-09-18）
> 契约收口：StepHeaders 只有 loadPlan 一条路（plan/planError props 已删），Round 1 复审 + Task 6 交叉核对（2026-09-18）

本 task 把 `frontend/src/components/HeaderSetup.tsx`（946 行）按**动作**拆成三个对话框组件 + 一个第 ② 步外壳，然后删掉原文件与它的测试。**覆盖验收门 6**（安全确认不被吃掉）。

**这不是重写，是搬家。** 三个弹窗的 `acknowledge` 语义、半应用失败（`ProvisionFailureDetail`）、失败后不关弹窗、确认前先读 plan、焦点陷阱、`Escape` 取消——逐字保留。`HeaderSetup.test.tsx` 的 **37 个 `it` 一条都不许丢**：迁移去向见「用例迁移对照表」。

**本分段同时补上规格 §8 缺的那个执行者**：`onRoleFixed(role)` —— provision / retype 成功后作废该 role 的 probe 并重新校验（Round 1 复审 B7）。没有它，「修好表头」这条主路径在第 ③ 步永远勾不上（见 §Interfaces 的说明与 Step 17、Step 18）。

**Files:**

- Create `frontend/src/components/lark/ProvisionDialog.tsx` —— 1-236 行（设置表头）
- Create `frontend/src/components/lark/RetypeDialog.tsx` —— 1-232 行（修正表头类型）
- Create `frontend/src/components/lark/RebuildDialog.tsx` —— 1-303 行（重建数据表）
- Create `frontend/src/components/lark/StepHeaders.tsx` —— 1-238 行（第 ② 步外壳：plan 读取 + 状态行 + 三个动作入口 + 建表入口）
- Test `frontend/src/components/lark/ProvisionDialog.test.tsx` —— 1-204 行（13 个迁移用例 ＋ 1 条 B7 用例，来自旧 `HeaderSetup.test.tsx:36-380`）
- Test `frontend/src/components/lark/RetypeDialog.test.tsx` —— 1-135 行（5 个迁移用例 ＋ 2 条 B7 用例，来自旧 `:400-496`）
- Test `frontend/src/components/lark/RebuildDialog.test.tsx` —— 1-219 行（13 个迁移用例，来自旧 `:498-738`）
- Test `frontend/src/components/lark/StepHeaders.test.tsx` —— 1-232 行（6 个迁移用例 ＋ 3 条 B7 用例：`:53-57`、`:191-229`、`:231-266`、`:344-366`）
- Modify `frontend/src/views/LarkCheck.tsx:30`（import 行）与 `:703-722`（内嵌组件调用）—— **只有这两处**，页面其余部分一个字不动
- Delete `frontend/src/components/HeaderSetup.tsx`（946 行）
- Delete `frontend/src/components/HeaderSetup.test.tsx`（738 行）

**Interfaces:**

**Consumes**（都已存在；本 task 不改它们的签名）

```ts
// frontend/src/api.ts:171 / :173 / :175 / :188 / :201 / :211 / :218 / :224 / :230 / :239 / :245 / :252 / :257 / :264 / :408
export type TableRole = "execution" | "bug";
export type Table = { table_id: string; name: string };
export type ProvisionField = { name: string; type: number; type_name: string; properties: Record<string, unknown> };
export type ProvisionView = { name: string; exists: boolean; view_id: string | null };
export type ProvisionPlan = {
  roles: { execution: ProvisionField[]; bug: ProvisionField[] };
  retype?: { execution: RetypeField[]; bug: RetypeField[] };
  views?: { execution: ProvisionView; bug: ProvisionView };
  rebuild?: Record<TableRole, number>;
};
export type RetypeField = { name: string; type: number; type_name: string; field_id: string | null; current_type: number; current_type_name: string; properties: Record<string, unknown> };
export type ProvisionFieldsPayload = { role: TableRole; field_names: string[]; create_view: boolean; acknowledge: boolean };
export type RetypeFieldsPayload = { role: TableRole; field_names: string[]; acknowledge: boolean };
export type RetypeFieldsResult = { retyped_fields: string[]; schema_errors: string[]; target: LarkTarget };
export type ProvisionFieldsResult = { created_fields: string[]; view?: ProvisionView & { created: boolean }; schema_errors: string[]; target: LarkTarget };
export type ProvisionFailureDetail = { reason: "provision_failed"; message: string; created_fields: string[] };
export type CreateTablePayload = { role: TableRole; base_token: string; table_name: string; acknowledge: boolean };
export type CreateTableResult = { table: Table; role: TableRole };
export type RebuildTablePayload = { role: TableRole; acknowledge: boolean; force?: boolean };
export type RebuildTableResult = { role: TableRole; table: Table; replaced: Table; requeued: number; schema_errors: string[]; target: LarkTarget };
export class ApiError extends Error { constructor(public status: number, public detail: unknown) }
export type LarkTarget = { /* ...现有字段；本 task 只读 execution_table_name / bug_table_name */ };
```

**Produces**（骨架 `## Interfaces` › `components/lark/StepHeaders.tsx` 逐字，**外加两个可选 prop**，理由见下）

```ts
// frontend/src/components/lark/StepHeaders.tsx
export const ROLE_LABELS: Record<TableRole, string>;          // { execution: "执行记录表", bug: "缺陷记录表" }
export const DEFAULT_TABLE_NAME: Record<TableRole, string>;   // { execution: "执行记录", bug: "缺陷记录" }
export function messageOf(reason: unknown, fallback: string): string;
export function rebuiltNameOf(name: string): string;          // `${name || "数据表"}（表头修正）`

type StepHeadersProps = {
  groupId: string;
  target: LarkTarget | null;
  busy: boolean;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  targetFingerprint: string;
  schemaFingerprint: string | null;
  bases: Record<TableRole, string>;
  tableNames: Record<TableRole, string>;
  onChanged: () => Promise<void>;
  // 表头在 Lark 里被真的改了（provision / retype 成功）：该 role 的 probe 已作废，
  // 页面必须把它重新校验一次，否则「两表 verdict 均 ok」永远达不成（规格 §8）。
  onRoleFixed: (role: TableRole) => void;
  onTableCreated: (role: TableRole, table: Table) => void;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
  // plan 的唯一来源：本组件自己读，读到的停在内部 state 里（不再是 props）。
  loadPlan: (groupId: string) => Promise<ProvisionPlan>;
  resetKey?: string;                                        // 唯一的追加项
};
```

**`onRoleFixed` 是补断路用的，不是可选装饰（Round 1 复审 B7）**：规格 §8「provision / retype 之后：作废受影响 role 的 probe 并重新校验」。渲染层里手动「校验」按钮只在 verdict 为 `unread` 时出现，所以一张被判 `bad` 的表被修好之后，**没有第二个入口能把它从 `bad` 推到 `ok`**——而第 ③ 步要求「两表 verdict 均 ok 才可勾选」。因此 `StepHeaders` 必须在 provision 成功与 retype 成功之后调用它，`role` 就是这次操作的那个 role；页面的实现（Task 3 的 hook）负责把该 role 的 probe 作废并重跑 `checkTable`。**失败时不调用**（表没变，probe 不该被作废）。

**`loadPlan` 是**必填**，`plan` / `planError` 不再是 props（契约收口）**

旧 `HeaderSetup` 自己读 plan（`HeaderSetup.tsx:210-241`），而那次读取依赖 `groupId` / `targetFingerprint` / `schemaFingerprint`——这三样只有 `StepHeaders` 拿得到。骨架原稿把 `plan` / `planError` 写成 props，等于把「谁去读」留空；Task 6 按更正后的契约**不传** `plan`，于是任何形如 `if (!loadPlan || plan !== null) return` 的守卫在 `plan === undefined` 时**恒真**，组件永远不自读 → 第 ② 步永远显示「正在读取表头…」→ 三个破坏性入口一个都不出现（门 6 与 e2e 全红）。所以：**plan 只有一条路**，就是本组件用 `loadPlan` 自己读，结果停在内部 `plan` / `planError` state 里；`loadPlan` 因此是必填。`plan` / `planError` 现在只是内部实现细节，任何父层都不许也不需要通过 props 注入。

- **`resetKey`**（唯一追加项）：旧代码用 `useEffect([groupId])` 在换组时关掉弹窗、清掉消息（`HeaderSetup.tsx:198-208`）。新结构里对话框是三个独立组件，把「换组复位」做成 `key={resetKey}` 的**重挂载**比再引入一个跨组件的复位 effect 更简单，也不会漏掉某个 state。Task 6 传 `\`${groupId}|${target?.target_fingerprint ?? ""}\``。

除此之外：`provision` / `retype` / `createTable` / `rebuild` 四个回调的**可选性**按骨架保留——`retype` 缺席时修正入口不出现（可断言），`rebuild` 缺席时重建入口不出现（可断言）。

```ts
// frontend/src/components/lark/ProvisionDialog.tsx
type ProvisionDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;                       // 由 StepHeaders 持有
  onClose: () => void;
  onOpenRequest: () => void;           // 入口按钮被按下：把 open 置真
  onFinished: (notice: string) => void; // 成功后的结果通知，显示在页面上（旧 :433-437）
  onChanged: () => Promise<void>;
  onRoleFixed: (role: TableRole) => void; // 每个成功改过表头的 role 各调一次（B7）
  provision: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  reloadPlan: () => void;              // 运行结束后重读 plan（旧 :425 的等价物）
};

// frontend/src/components/lark/RetypeDialog.tsx
type RetypeDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  onRoleFixed: (role: TableRole) => void; // 成功改过类型的 role 各调一次（B7）
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  reloadPlan: () => void;
};

// frontend/src/components/lark/RebuildDialog.tsx
type RebuildDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  tableNames: Record<TableRole, string>;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
  reloadPlan: () => void;
  targetFingerprint: string;
  schemaFingerprint: string | null;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
};
```

**`reloadPlan` 的语义**：`StepHeaders` 传进来的回调把它的 `generation` 计数加一，`generation` 在 `loadPlan` 的 effect 依赖里，于是 plan 被重读一次。三个对话框各自在提交结束后调用它（旧代码里是 `HeaderSetup.tsx:425` / `:480` / `:567` 那三次 `loadPlan(...)`）。`ProvisionDialog` 与 `RetypeDialog` 都不需要自己读 plan（它们只读别人给的那一份），`RebuildDialog` 额外多一条「打开时重读」（旧 `:228-241`），所以它另收 `loadPlan` / `targetFingerprint` / `schemaFingerprint`。

**`onChanged` / `onRoleFixed` / `reloadPlan` 三者各管一件事，别混**

| 回调 | 管什么 | 何时调 | 谁实现 |
|---|---|---|---|
| `reloadPlan` | **plan 内容**（缺哪些列、错哪些类型、重建成本） | 每次提交结束后**无条件**调（成功、拒绝、半应用都调，旧 `:425` 的注释「refusals included」就是这个意思） | `StepHeaders` 自己（`generation++`） |
| `onChanged` | **服务端事实**（`target`、`live`、写入确认是否被清） | 只在**真的改了表**时调（旧 `:416` / `:473` / `:559` 的 `if (created > 0 \|\| viewCreated)` / `if (retyped > 0)` / `if (moved.length > 0)`） | 页面（Task 4 里是 `LarkCheck.reloadAfterProvision`） |
| `onRoleFixed` | **该 role 的表级判决**（probe） | 只在 provision / retype **成功且真的改了**时调，`role` = 本次操作的 role | 页面（Task 3 起是 `useLarkDraft` 的作废 + 重校验） |

三者缺一会各自产生一类不一致：缺 `reloadPlan` → 「表头已修好，第②步还提示缺列」；缺 `onChanged` → 「服务端已清确认，页面还显示已确认」；缺 `onRoleFixed` → 「表已修好，probe 仍 `bad`，第③步永远勾不上」。**`onRoleFixed` 与 `reloadPlan` 调用时机不同，不许合并成一件事**：`reloadPlan` 是读事实、`onRoleFixed` 是作废判决，先作废判决再读事实（顺序见下面的实现：`onRoleFixed` 紧跟 provider 调用之后，`reloadPlan` 在方法末尾）。

**三个对话框都不接收 `onError` / `onBusy` 回调**：每个对话框自己持有 `error` / `busy`（旧代码里这三个动作共用一份 `error`，但同一时刻只可能有一个弹窗的提交在跑，拆开后各自闭环更简单），失败时把错误渲染在**自己的弹窗里**——这正是旧代码的位置（`HeaderSetup.tsx:742-746` / `:815-819` / `:902-906`），也是「失败后弹窗不关，管理员必须看见拒绝原因」那条断言的落点。

---

## 门 6 文案裁定：逐字保留 vs 精简

门 6：「**安全相关文案逐字不改**（非安全说明句可精简）」。下面是**逐条裁定**，行号指 `HeaderSetup.tsx`（本 task 之后即删除，行号只作溯源）。执行方式：安全句**原样出现在新文件源码里**；精简句**不在任何新文件里出现**。

### 保留原文的句子（安全语义：不可逆 / 影响范围 / 不会发生的事）

| # | 原行号 | 逐字原文 | 去处 |
|---|---|---|---|
| S1 | `:699` | `只会创建下面勾选的表头；表中已有的字段不会被修改。` | `ProvisionDialog.tsx` 弹窗首段 |
| S2 | `:731` | `同时创建 TestDeck 视图` | `ProvisionDialog.tsx` 勾选框文案 |
| S3 | `:734` | `TestDeck 视图已存在，不会被重复创建。` | `ProvisionDialog.tsx` |
| S4 | `:783` | `只会把下面勾选的表头改成正确的类型；表头里已有的数据不会被删除。` | `RetypeDialog.tsx` 弹窗首段 |
| S5 | `:856-861` | `新建一张表头顺序和类型都正确的新表（执行记录表为 用例 / 结果 / 优先级 / 负责人 / 截图 / 控制台 / 报告人 / 日期，缺陷记录表为 问题描述 / 优先级 / 进展状态 / 反馈时间 / 反馈人 / 跟进人 / 备注 / 截图），并把本组指向它。结果、优先级、进展状态是下拉框，截图和人员是对应类型的字段。` | `RebuildDialog.tsx` 第 1 段（**整段一字不改**：它声明管理员将拿到什么表） |
| S6 | `:862-864` | `` `表头顺序和主列无法在 Lark 里改，只能换一张表。旧表不会被删除${rebuildCostNote}；重建后需要重新确认写入。` `` | `RebuildDialog.tsx` 第 2 段（「旧表不会被删除」「重建后需要重新确认写入」两个后果句逐字保留，模板字符串形状也保留） |
| S7 | `:916-917` | `强制重建` ＋ `（表头已经正确时也重建：会再建一张新表，并把上面列出的记录重新写入）` | `RebuildDialog.tsx`（**连 `<strong>` 拆词结构一起保留**） |
| S8 | `:615-617` | `` plan?.rebuild ? "，本组按当前规则重新写入的行数见下（从表里采纳的记录不会重写，本组目标确认前写入的记录也不会）" : "" `` | `RebuildDialog.tsx` 的 `rebuildCostNote`（**挂载条件 `plan?.rebuild` 一并保留**） |
| S9 | `:885-889` | `` `，将重新写入 ${plan.rebuild[role]} 条记录` `` / `"，这一类没有会被重写的记录"` | `RebuildDialog.tsx` 每行成本文案 |
| S10 | `:576-578` | `` `旧表「${item.replaced.name}」不会自动删除，请确认后手动删除` `` | `RebuildDialog.tsx` 与 `StepHeaders.tsx` 的结果通知（`"；"` 分隔符与拼接顺序保留） |
| S11 | `:430` / `:484` / `:518` / `:581` | `，请重新确认写入`（三种结果通知与半应用失败行内通知共用的尾句） | 三个对话框 + `StepHeaders.tsx`（逐字） |
| S12 | `:518` | `` `已新建数据表「${created.name}」，请把它保存为本组的${ROLE_LABELS[role]}` `` | `StepHeaders.tsx`（「请把它保存为」是「新表只是草稿」的提示，保留） |
| S13 | `:638-641` | `重建数据表（表头修正）`（含 `（表头修正）` 后缀） | `StepHeaders.tsx` 入口按钮文案 |
| S14 | `:677-686` / `:737-746` | `notice` 用 `role="status"`、`error` 用 `role="alert"` 的分工 | 三个对话框（弹窗内）＋ `StepHeaders.tsx`（弹窗未开时把残留 `error` 显示在页面上） |

### 精简 / 删除的句子（非安全说明）

| # | 原行号 | 原文 | 处理 | 理由 |
|---|---|---|---|---|
| T1 | `:26-27` | `// Converts a header that already exists with a type the writer cannot fill. / // Absent means the page cannot repair a table, so the offer stays hidden.` | 删除 | 注释；约束改由 `RetypeDialog` 的 `retype?` 可选参数表达（缺席即不渲染入口，测试断言） |
| T2 | `:30-31` | `// The table the plan describes. Re-pointing the group…has to be read again.` | 删除 | 注释；约束由 `targetFingerprint` 触发重读的 effect 承担 |
| T3 | `:34-35` | `// A new table is only offered when the page can also name the base…` | 删除 | 注释；约束由 `baseOf(role)` 非空才启用按钮承担（测试断言） |
| T4 | `:38-39` / `:43-44` / `:58-60` / `:74-76` | 四段设计注释 | 删除 | 注释；对应字面值（`REBUILD_SUFFIX`、`TABLE_NAME_LABELS`）逐字保留 |
| T5 | `:112-114` / `:139-140` / `:222-227` / `:243` / `:253-255` / `:259-260` / `:278-279` / `:283-284` / `:399` / `:414-415` / `:423-424` / `:471-472` / `:560-561` | 各处实现注释 | 删除 | 纯注释；`trapFocus` 的两段注释原样搬进三个对话框各自的那份 `trapFocus`，其余行为逐字保留 |
| T6 | `:516` | `const created = { table_id: table.table_id, name: table.name \|\| tableName };` | 保留（回退 `table.name \|\| tableName` 仍在） | 见 `StepHeaders.createRoleTable()`，`name` 为空时用输入框里的名字，与旧行为等价 |
| T7 | `:591-617` 的 `statusParts` | `缺少 N 个表头：执行记录表 2 · …` | **保留** | 它是第 ② 步唯一的 plan 摘要、门 5「表头失效 → 第②步」的入口，不属于可精简的解释性长文 |
| T8 | `:818-820`（78 字）、`:824-827`（194 字） | 同步队列的常驻长说明 | **本 task 不动** | 属 `LarkCheck.tsx` 第 ④ 步范围，Task 6 处理 |

**净结果**：安全句 **0 处改动、0 处删除**；删除的全是注释，加上一处等价回退（T6 实际是保留）。`HeaderSetup.tsx` 里唯一没有搬走的**可见文案**是 `:640` 与 `:855` 两处重复出现的 `（表头修正）`——`StepHeaders` 与 `RebuildDialog` 各保留一份，页面不再有第三次。

### 一处需要 review 点名的渲染位置调整

旧代码里 `error` **两处都渲染**：弹窗内（`:742-746` / `:815-819` / `:902-906`）与外壳里（`:682-686`，仅当三个弹窗都关着）。新结构里弹窗内的 `error` 由对话组件自己渲染（**与旧位置相同**）；外壳里那一处**删掉了**，因为拆开后外壳不再拥有弹窗的 `open` 状态，无法表达「三个都关着」这个条件。可观察差异只有一条：三个弹窗都关着且上一次动作失败时，页面上不再残留那条红字——而这正是门 4「健康态页面无 `role="alert"`」要的方向。**所有既有断言不受影响**（失败路径的断言都在弹窗开着时做，且 `screen` 包含 `dialog`）。

---

## 用例迁移对照表（旧 `HeaderSetup.test.tsx` → 4 个新文件，**37 条全在**）

| 旧行号 | 用例名（首句） | 新文件 | 备注 |
|---|---|---|---|
| `:36-51` | lists exactly what will be created before creating it | `ProvisionDialog.test.tsx` | 加一条 `expect(dialog).toHaveTextContent("只会创建下面勾选的表头…")`（把 S1 钉进门 6） |
| `:53-57` | stays hidden when the table already has every header | `StepHeaders.test.tsx` | 「隐藏」是外壳的状态行 + 入口显隐条件 |
| `:59-71` | sends only the headers the administrator left ticked | `ProvisionDialog.test.tsx` | 原样 |
| `:73-86` | keeps the primary command disabled until a header is ticked | `ProvisionDialog.test.tsx` | 原样 |
| `:88-99` | asks for the TestDeck view only when the administrator ticked it | `ProvisionDialog.test.tsx` | 原样 |
| `:101-112` | reports how many headers were created and asks the page to re-read the target | `ProvisionDialog.test.tsx` | 原样（`onChanged` 计数不变）＋加一条 `expect(onRoleFixed).toHaveBeenCalledWith("execution")` 与 `toHaveBeenCalledTimes(1)`（B7：成功才作废判决） |
| `:114-126` | reports a refused creation instead of claiming success | `ProvisionDialog.test.tsx` | 原样（错误仍在弹窗内） |
| `:128-142` | leaves the approval alone when Lark already had every header | `ProvisionDialog.test.tsx` | 原样（`loadPlan` 第二读由外壳转交） |
| `:144-154` | takes focus on open and lets Escape cancel without creating anything | `ProvisionDialog.test.tsx` | 原样 |
| `:156-189` | keeps Tab, checkboxes included, inside the dialog instead of the page behind | `ProvisionDialog.test.tsx` | 原样（`trapFocus` 一字不改） |
| `:191-215` | creates a role's table with its default name and hands the new table back | `StepHeaders.test.tsx` | 原样 |
| `:217-229` | only offers a new table once that role's base is known | `StepHeaders.test.tsx` | 原样（含 `maxlength=100`） |
| `:231-245` | closes the dialog when the group changes | `StepHeaders.test.tsx` | 拆成两条：新名 `reads the new group's list when the group changes`（`loadPlan` 用新 group 重读，原样断言）；「弹窗关闭」由 `resetKey` 重挂载承担，断言落在新名 `stays hidden when the table already has every header` 与各对话框的 `key` 上 |
| `:247-266` | re-reads the header list when the target it describes changes | `StepHeaders.test.tsx` | 原样（`loadPlan` 调用计数 2） |
| `:268-280` | re-reads the header list after a refusal | `ProvisionDialog.test.tsx` | 原样 |
| `:282-300` | shows a half-applied refusal's created count inside the dialog | `ProvisionDialog.test.tsx` | 原样（`ApiError(409, object)` 的 `created_fields` 仍被累加） |
| `:302-320` | does not offer a TestDeck view the table already carries | `ProvisionDialog.test.tsx` | 原样 |
| `:322-342` | only asks for the view in the role that is missing it | `ProvisionDialog.test.tsx` | 原样（两次 `provision` 调用） |
| `:344-366` | clears the new-table message once that role's base moves | `StepHeaders.test.tsx` | 原样 |
| `:368-380` | resets the view choice when the dialog is closed and opened again | `ProvisionDialog.test.tsx` | 原样 |
| `:400-425` | offers to convert a header that already exists with the wrong type | `RetypeDialog.test.tsx` | 加一条 `expect(dialog).toHaveTextContent("只会把下面勾选的表头改成正确的类型…")`（钉 S4） |
| `:427-458` | sends only the headers the administrator left ticked for repair | `RetypeDialog.test.tsx` | 原样 |
| `:460-470` | keeps the approval when nothing actually needed repair | `RetypeDialog.test.tsx` | 原样 |
| `:472-488` | reports a refused repair with the headers it did convert | `RetypeDialog.test.tsx` | 原样；另加一条独立用例 `does not retire a role's verdict when the repair is refused`（断言 `onRoleFixed` 未被调用，B7） |
| `:490-496` | hides the repair command when the page cannot repair a table | `RetypeDialog.test.tsx` | 原样：`retype` 缺席时页面上查不到「修正表头类型」按钮（`StepHeaders` 收到 `retype={undefined}`） |
| `:529-562` | rebuilds the ticked role's table and names the one it replaces | `RebuildDialog.test.tsx` | 原样（含 `onTableRebuilt` 三参、`onChanged` 计数 1、两条通知） |
| `:564-579` | keeps the rebuild command disabled until a role is ticked | `RebuildDialog.test.tsx` | 原样 |
| `:581-602` | says how many rows a rebuild would rewrite and can force one | `RebuildDialog.test.tsx` | 原样（`force: true`） |
| `:604-616` | does not force a rebuild unless the box is ticked | `RebuildDialog.test.tsx` | 原样（`force: false`） |
| `:618-633` | names a role with nothing to rewrite instead of showing a bare zero | `RebuildDialog.test.tsx` | 原样（含 S8 那句挂在计数上） |
| `:635-649` | reads the count again when the dialog opens, not only when the page loaded | `RebuildDialog.test.tsx` | 原样（「打开时重读」= `RebuildDialog` 自己的 effect，`loadPlan` 计数 2） |
| `:651-660` | does not promise a count the plan does not carry yet | `RebuildDialog.test.tsx` | 原样（`plan.rebuild` 缺失时 S8 不出现） |
| `:662-679` | rebuilds every ticked role, one table after the other | `RebuildDialog.test.tsx` | 原样（`mock.calls` 逐条比对，顺序 execution→bug） |
| `:681-695` | reports a refused rebuild and keeps the dialog open | `RebuildDialog.test.tsx` | 原样（`onChanged` 未被调用） |
| `:697-716` | keeps the page on the table that did move when the second rebuild is refused | `RebuildDialog.test.tsx` | 原样（第一条已重建的通知 + `onTableRebuilt` 计数 1） |
| `:718-729` | closes the rebuild dialog on Escape without replacing anything | `RebuildDialog.test.tsx` | 原样（焦点在 dialog 上，因为主按钮 disabled） |
| `:731-738` | hides the rebuild command when the page cannot rebuild a table | `RebuildDialog.test.tsx` | 原样 |

合计：`ProvisionDialog` 13 ＋ `RetypeDialog` 5 ＋ `RebuildDialog` 13 ＋ `StepHeaders` 6 = **37**（迁移用例，一条不丢）。
**Round 1 复审 B7 另加 6 条**（都是「加」不是「改」，迁移用例本身不被削弱）：`ProvisionDialog` ＋1、`RetypeDialog` ＋2、`StepHeaders` ＋3 → **交付文件里共 43 条**。

**上面这些数字是 grep 出来的，不是跑出来的**：计划里所有 `Test Files N passed` / `Tests N passed` 计数一律**不是判据**，只作形状参考——改动前 `frontend/src` 下共 21 个 `*.test.ts(x)`、256 个 `it(`（本机 grep 实测）；本 task 删 1 个文件（37 个 `it`）、加 4 个文件（37 个 `it`），所以终态应落在 **24 个文件**附近。真判据只有一条：**`0 failed`**。

---

- [ ] **Step 1: 写 `ProvisionDialog.test.tsx`（完整内容，先红）**

`frontend/src/components/lark/ProvisionDialog.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import {
  ApiError,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type Table
} from "../../api";
import { ProvisionDialog } from "./ProvisionDialog";
import { StepHeaders } from "./StepHeaders";

const PLAN: ProvisionPlan = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  }
};

const COMPLETE: ProvisionPlan = { roles: { execution: [], bug: [] } };

type HarnessProps = {
  // What this shell's own plan read returns. There is no `plan` prop to hand
  // in — `StepHeaders` reads the plan itself, which is the only path the page
  // uses (see the契约收口 note at the top of this part).
  plan?: ProvisionPlan | null;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  onChanged?: () => Promise<void>;
  onRoleFixed?: (role: "execution" | "bug") => void;
  onTableCreated?: (role: "execution" | "bug", table: Table) => void;
};

// The shell reads the plan itself; the dialog is rendered as a sibling of the
// shell, handed the plan the shell last loaded and `open` driven from here —
// the dialog's own button is hidden while `open` is true, and its visibility
// when closed is StepHeaders' concern (asserted in StepHeaders.test.tsx).
function Harness({
  plan = COMPLETE,
  loadPlan,
  provision,
  onChanged,
  onRoleFixed,
  onTableCreated
}: HarnessProps) {
  const planOf = loadPlan ?? vi.fn().mockResolvedValue(plan);
  const [open, setOpen] = useState(true);
  const [current, setCurrent] = useState<ProvisionPlan | null>(null);
  // Every read is wrapped, so the dialog sees the plan the shell would hand
  // down on each generation — the same wiring the page has.
  const read = () =>
    planOf("g1").then((loaded) => {
      setCurrent(loaded);
      return loaded;
    });
  const close = () => setOpen(false);
  return (
    <>
      <StepHeaders
        groupId="g1"
        target={null}
        busy={false}
        provision={provision ?? vi.fn()}
        loadPlan={read}
        targetFingerprint="app-exec|tbl-runs|app-exec|tbl-bugs"
        schemaFingerprint={null}
        bases={{ execution: "app-exec", bug: "app-bugs" }}
        tableNames={{ execution: "执行记录", bug: "缺陷记录" }}
        onChanged={onChanged ?? vi.fn().mockResolvedValue(undefined)}
        onRoleFixed={onRoleFixed ?? vi.fn()}
        onTableCreated={onTableCreated ?? vi.fn()}
        onTableRebuilt={vi.fn()}
      />
      <ProvisionDialog
        groupId="g1"
        plan={current}
        open={open}
        onClose={close}
        onChanged={onChanged ?? vi.fn().mockResolvedValue(undefined)}
        provision={provision ?? vi.fn()}
        reloadPlan={() => {
          void read();
        }}
        onOpenRequest={() => setOpen(true)}
        onFinished={vi.fn()}
        onRoleFixed={onRoleFixed ?? vi.fn()}
      />
    </>
  );
}

function renderDialog(props: HarnessProps = {}) {
  render(<Harness {...props} />);
}

// Waits for the shell's first plan read to land, then hands back the dialog.
async function openProvision() {
  await screen.findByText(/缺少 2 个表头|表头完整|正在读取表头|读取缺失表头失败/);
  return screen.findByRole("dialog");
}

it("lists exactly what will be created before creating it", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [] });
  renderDialog({ plan: PLAN, provision });

  const dialog = await openProvision();
  expect(dialog).toHaveTextContent("结果");
  expect(dialog).toHaveTextContent("日期");
  expect(dialog).toHaveTextContent("只会创建下面勾选的表头；表中已有的字段不会被修改。");
  expect(provision).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));
  expect(provision).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ role: "execution", field_names: ["结果", "日期"], acknowledge: true })
  );
});

it("sends only the headers the administrator left ticked", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [] });
  renderDialog({ plan: PLAN, provision });

  await openProvision();
  await userEvent.click(screen.getByRole("checkbox", { name: "创建表头「日期」" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(provision).toHaveBeenCalledTimes(1);
  expect(provision).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ role: "execution", field_names: ["结果"], create_view: false, acknowledge: true })
  );
});

it("keeps the primary command disabled until a header is ticked", async () => {
  const provision = vi.fn();
  renderDialog({ plan: PLAN, provision });

  await openProvision();
  const create = screen.getByRole("button", { name: "创建这些表头" });
  expect(create).toBeEnabled();

  await userEvent.click(screen.getByRole("checkbox", { name: "创建表头「结果」" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "创建表头「日期」" }));

  // Nothing is ticked, so nothing may be created.
  expect(create).toBeDisabled();
  expect(provision).not.toHaveBeenCalled();
});

it("asks for the TestDeck view only when the administrator ticked it", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [] });
  renderDialog({ plan: PLAN, provision });

  await openProvision();
  await userEvent.click(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(provision).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ create_view: true, acknowledge: true })
  );
});

it("reports how many headers were created and asks the page to re-read the target", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [] });
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const onRoleFixed = vi.fn();
  renderDialog({ plan: PLAN, provision, onChanged, onRoleFixed });

  await openProvision();
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText("已创建 1 个表头，请重新确认写入")).toBeVisible();
  // The server clears the write approval with the schema change.
  expect(onChanged).toHaveBeenCalledTimes(1);
  // The role's schema verdict was describing the table before this run.
  expect(onRoleFixed).toHaveBeenCalledWith("execution");
  expect(onRoleFixed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("reports a refused creation instead of claiming success", async () => {
  const provision = vi.fn().mockRejectedValue(new Error("创建表头失败：没有权限"));
  const onChanged = vi.fn().mockResolvedValue(undefined);
  renderDialog({ plan: PLAN, provision, onChanged });

  await openProvision();
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText("创建表头失败：没有权限")).toBeVisible();
  expect(screen.queryByText(/已创建/)).not.toBeInTheDocument();
  expect(onChanged).not.toHaveBeenCalled();
  // The dialog stays up: the administrator has to see the refusal.
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("leaves the approval alone when Lark already had every header", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [] });
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const loadPlan = vi.fn().mockResolvedValueOnce(PLAN).mockResolvedValue(COMPLETE);
  renderDialog({ plan: COMPLETE, provision, onChanged, loadPlan });

  await openProvision();
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // Nothing was created, so the approval still stands: neither the notice nor
  // the page may claim it has to be confirmed again.
  expect(await screen.findByText("没有缺少的表头，写入确认保持不变")).toBeVisible();
  expect(onChanged).not.toHaveBeenCalled();
  // The list is still re-read, so the panel stops offering what is there.
  expect(await screen.findByText("表头完整")).toBeVisible();
});

it("takes focus on open and lets Escape cancel without creating anything", async () => {
  const provision = vi.fn();
  renderDialog({ plan: PLAN, provision });

  await openProvision();
  expect(screen.getByRole("button", { name: "创建这些表头" })).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(provision).not.toHaveBeenCalled();
});

it("keeps Tab, checkboxes included, inside the dialog instead of the page behind", async () => {
  renderDialog({ plan: PLAN });

  await openProvision();
  const dialog = screen.getByRole("dialog");
  const outside = screen.getByRole("button", { name: "新建执行记录数据表" });
  const create = screen.getByRole("button", { name: "创建这些表头" });
  const firstHeader = screen.getByRole("checkbox", { name: "创建表头「结果」" });

  expect(create).toHaveFocus();
  await userEvent.tab();
  // Forward Tab wraps onto the first header checkbox, so the rows stay reachable.
  expect(firstHeader).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(create).toHaveFocus();

  // Shift+Tab from the first control stays inside, and no step of the cycle
  // ever lands on the page behind the overlay.
  for (let step = 0; step < 8; step += 1) {
    await userEvent.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(outside).not.toHaveFocus();
  }
});

it("re-reads the header list after a refusal", async () => {
  const loadPlan = vi.fn().mockResolvedValueOnce(PLAN).mockResolvedValue(COMPLETE);
  const provision = vi.fn().mockRejectedValue(new Error("创建表头失败：没有权限"));
  renderDialog({ plan: PLAN, loadPlan, provision });

  await openProvision();
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText("创建表头失败：没有权限")).toBeVisible();
  // A run can create fields before it stops, so the list is read again.
  expect(loadPlan).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("shows a half-applied refusal's created count inside the dialog", async () => {
  const detail = {
    reason: "provision_failed",
    message: "创建视图失败：没有权限",
    created_fields: ["结果", "日期"]
  };
  const provision = vi.fn().mockRejectedValue(new ApiError(409, detail));
  const onChanged = vi.fn().mockResolvedValue(undefined);
  renderDialog({ plan: PLAN, provision, onChanged });

  await openProvision();
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // The refusal is an object, not a plain string: its readable message is what
  // the administrator needs, and the fields it did create were really created.
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("创建视图失败：没有权限");
  expect(dialog).toHaveTextContent("已创建 2 个表头，请重新确认写入");
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("does not offer a TestDeck view the table already carries", async () => {
  const plan: ProvisionPlan = {
    ...PLAN,
    views: {
      execution: { name: "TestDeck", exists: true, view_id: "vew-1" },
      bug: { name: "TestDeck", exists: false, view_id: null }
    }
  };
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [] });
  renderDialog({ plan, provision });

  await openProvision();

  expect(screen.queryByRole("checkbox", { name: "同时创建 TestDeck 视图" })).not.toBeInTheDocument();
  expect(screen.getByText(/TestDeck 视图已存在/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));
  expect(provision).toHaveBeenCalledWith("g1", expect.objectContaining({ create_view: false }));
});

it("only asks for the view in the role that is missing it", async () => {
  const plan: ProvisionPlan = {
    roles: {
      execution: PLAN.roles.execution,
      bug: [{ name: "问题描述", type: 1, type_name: "text", properties: {} }]
    },
    views: {
      execution: { name: "TestDeck", exists: true, view_id: "vew-1" },
      bug: { name: "TestDeck", exists: false, view_id: null }
    }
  };
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [] });
  renderDialog({ plan, provision });

  await openProvision();
  await userEvent.click(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(provision).toHaveBeenCalledWith("g1", expect.objectContaining({ role: "execution", create_view: false }));
  expect(provision).toHaveBeenCalledWith("g1", expect.objectContaining({ role: "bug", create_view: true }));
});

it("resets the view choice when the dialog is closed and opened again", async () => {
  renderDialog({ plan: PLAN });

  await openProvision();
  await userEvent.click(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" }));
  expect(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" })).toBeChecked();

  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));

  // The rows are reseeded on every open, and the view choice goes with them.
  expect(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" })).not.toBeChecked();
});
```

- [ ] **Step 2: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/ProvisionDialog.test.tsx`

期望输出（本机基线口径）：

```
 ❯ src/components/lark/ProvisionDialog.test.tsx (0 test)
Error: Failed to resolve import "./ProvisionDialog" from "src/components/lark/ProvisionDialog.test.tsx". Does the file exist?
```

红色原因是两个文件还不存在。**一次只做一个文件**，每个文件写完立刻跑。

- [ ] **Step 3: 写 `ProvisionDialog.tsx`（完整内容）**

`frontend/src/components/lark/ProvisionDialog.tsx`：

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ListPlus, LoaderCircle } from "lucide-react";

import {
  ApiError,
  type ProvisionFailureDetail,
  type ProvisionField,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type TableRole
} from "../../api";
import { ROLE_LABELS, messageOf } from "./StepHeaders";

type ProvisionDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  // 表头真的建出来了：该 role 的 probe 已作废，页面要重新校验它（B7）。
  onRoleFixed: (role: TableRole) => void;
  provision: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  reloadPlan: () => void;
};

const ROLES: TableRole[] = ["execution", "bug"];

// A refused run is the one 409 whose detail is an object; every other refusal
// is a plain string the Error already carries.
function refusalOf(
  reason: unknown,
  fallback: string
): { message: string; createdFields: string[] } {
  if (reason instanceof ApiError && typeof reason.detail === "object" && reason.detail !== null) {
    const detail = reason.detail as Partial<ProvisionFailureDetail>;
    if (detail.reason === "provision_failed") {
      return {
        message: typeof detail.message === "string" && detail.message ? detail.message : fallback,
        createdFields: Array.isArray(detail.created_fields) ? detail.created_fields : []
      };
    }
  }
  return { message: messageOf(reason, fallback), createdFields: [] };
}

function createdCopy(created: number, viewCreated: boolean): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`已创建 ${created} 个表头`);
  if (viewCreated) parts.push("已创建 TestDeck 视图");
  return parts.join("，");
}

// One dialog's focus trap. Every focusable control counts: trapping only the
// buttons left the header checkboxes unreachable and let Shift+Tab out to the
// page behind.
function trapFocus(event: KeyboardEvent<HTMLDivElement>, container: HTMLDivElement | null) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    container?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  );
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = container?.contains(active) ?? false;
  if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  }
}

export function ProvisionDialog({
  groupId,
  plan,
  open,
  onClose,
  onOpenRequest,
  onFinished,
  onChanged,
  onRoleFixed,
  provision,
  reloadPlan
}: ProvisionDialogProps) {
  const [ticked, setTicked] = useState<Record<TableRole, string[]>>({ execution: [], bug: [] });
  const [createView, setCreateView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runNotice, setRunNotice] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const missing: Record<TableRole, ProvisionField[]> = {
    execution: plan?.roles?.execution ?? [],
    bug: plan?.roles?.bug ?? []
  };
  const missingTotal = missing.execution.length + missing.bug.length;
  const viewExists = (role: TableRole) => plan?.views?.[role]?.exists === true;
  const provisionedRoles = ROLES.filter((role) => missing[role].length > 0);
  const viewMissing = provisionedRoles.some((role) => !viewExists(role));
  // Only a header the administrator can still see may be sent: a reload can
  // drop a ticked name from the plan, and a hidden tick must not create it.
  const tickedNames = (role: TableRole) =>
    missing[role].filter((field) => ticked[role].includes(field.name)).map((field) => field.name);
  const tickedTotal = ROLES.reduce((total, role) => total + tickedNames(role).length, 0);

  // The overlay is mounted only while the confirmation is pending; the
  // overlay claims modality, so focus has to move in.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  function openDialog() {
    setTicked({
      execution: missing.execution.map((field) => field.name),
      bug: missing.bug.map((field) => field.name)
    });
    setRunNotice("");
    setCreateView(false);
    setError("");
    onOpenRequest();
  }

  function closeDialog() {
    setRunNotice("");
    setCreateView(false);
    onClose();
  }

  function toggle(role: TableRole, name: string) {
    setTicked((current) => ({
      ...current,
      [role]: current[role].includes(name)
        ? current[role].filter((item) => item !== name)
        : [...current[role], name]
    }));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) closeDialog();
      return;
    }
    trapFocus(event, dialogRef.current);
  }

  async function createTicked() {
    const roles = ROLES.filter((role) => tickedNames(role).length > 0);
    if (roles.length === 0) return;
    setBusy(true);
    setError("");
    setRunNotice("");
    let created = 0;
    let viewCreated = false;
    let failure = "";
    // The roles this run really changed. Their probes are stale from that
    // moment on, and only a re-check can lift a `bad` verdict — the page's own
    // "校验" button is offered for `unread` alone (B7).
    const changedRoles: TableRole[] = [];
    try {
      for (const role of roles) {
        try {
          const result = await provision(groupId, {
            role,
            field_names: tickedNames(role),
            // Never ask for a view the table already carries.
            create_view: createView && !viewExists(role),
            acknowledge: true
          });
          const changed = (result.created_fields?.length ?? 0) > 0 || result.view?.created === true;
          created += result.created_fields?.length ?? 0;
          if (result.view?.created) viewCreated = true;
          if (changed) changedRoles.push(role);
        } catch (reason) {
          const refusal = refusalOf(reason, "创建表头失败");
          failure = refusal.message;
          // The backend creates the fields before the view, so a refusal can
          // still have changed the table it refuses to finish. The count is
          // this run's own, not the running total: an earlier role's fields
          // must not make this role look edited.
          created += refusal.createdFields.length;
          if (refusal.createdFields.length > 0) changedRoles.push(role);
          break;
        }
      }
      // The verdict is retired before the page re-reads the target: the probe
      // belongs to the table this run just edited, not to the one on screen.
      for (const role of changedRoles) onRoleFixed(role);
      // Only a run that really changed the table clears the write approval, so
      // the page is only asked to re-read it then.
      if (created > 0 || viewCreated) {
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the write still happened.
        }
      }
      // The plan is re-read after every attempt, refusals included: a run can
      // have created fields while the panel still lists them as missing.
      reloadPlan();
      if (failure) {
        setError(failure);
        // The count stays inside the dialog, next to the refusal it belongs to.
        if (created > 0) setRunNotice(`${createdCopy(created, viewCreated)}，请重新确认写入`);
      } else {
        closeDialog();
        onFinished(
          created > 0 || viewCreated
            ? `${createdCopy(created, viewCreated)}，请重新确认写入`
            : "没有缺少的表头，写入确认保持不变"
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return missingTotal > 0 ? (
      <button type="button" className="primary" onClick={openDialog}>
        <ListPlus size={16} />
        设置表头
      </button>
    ) : null;
  }

  return (
    <div className="header-setup-overlay" onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        className="header-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-setup-title"
      >
        <h3 id="header-setup-title">设置表头</h3>
        <p className="inline-status">
          只会创建下面勾选的表头；表中已有的字段不会被修改。
        </p>

        <ul className="header-setup-roles">
          {ROLES.filter((role) => missing[role].length > 0).map((role) => (
            <li className="header-setup-role" key={role}>
              <h4>{ROLE_LABELS[role]}</h4>
              <ul className="header-setup-fields">
                {missing[role].map((field) => (
                  <li className="header-setup-row" key={field.name}>
                    <input
                      type="checkbox"
                      checked={ticked[role].includes(field.name)}
                      aria-label={`创建表头「${field.name}」`}
                      onChange={() => toggle(role, field.name)}
                    />
                    <span className="header-setup-name">{field.name}</span>
                    <span className="header-setup-type">{field.type_name}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {viewMissing ? (
          <label className="header-setup-view">
            <input
              type="checkbox"
              checked={createView}
              onChange={(event) => setCreateView(event.target.checked)}
            />
            同时创建 TestDeck 视图
          </label>
        ) : (
          <p className="inline-status">TestDeck 视图已存在，不会被重复创建。</p>
        )}

        {runNotice ? (
          <p className="inline-status saved" role="status">
            {runNotice}
          </p>
        ) : null}
        {error ? (
          <p className="inline-status error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="header-setup-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={closeDialog}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="primary"
            disabled={busy || tickedTotal === 0}
            onClick={() => void createTicked()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <ListPlus size={16} />}
            创建这些表头
          </button>
        </div>
      </div>
    </div>
  );
}
```

**两处必须按下面写法收口，否则类型门不过**：`onOpenRequest` 与 `onFinished` 是 `StepHeaders` 传下来的两个额外回调，加进 `ProvisionDialogProps`：

```ts
  onOpenRequest: () => void;            // 由 StepHeaders 打开本弹窗
  onFinished: (notice: string) => void; // 成功后的结果通知，显示在页面上（旧 :433-437）
```

它们与 `open` 一起构成「外壳持有 open、对话框持有内部状态」的分工：**打开**由外壳的 `open` 控制，**按钮点击**通过 `onOpenRequest` 上报。`busy` 与 `error` 留在对话框内部，所以失败时错误就渲染在弹窗里（与旧的 `:742-746` 同位置）。

- [ ] **Step 4: 跑，确认全绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/ProvisionDialog.test.tsx`

期望输出：

```
 ✓ src/components/lark/ProvisionDialog.test.tsx (13 tests)

 Test Files  1 passed (1)
      Tests  13 passed (13)
```

- [ ] **Step 5: 写 `StepHeaders.tsx`（完整内容）**

`frontend/src/components/lark/StepHeaders.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Table2 } from "lucide-react";

import {
  type CreateTablePayload,
  type CreateTableResult,
  type LarkTarget,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type RetypeFieldsPayload,
  type RetypeFieldsResult,
  type Table,
  type TableRole
} from "../../api";
import { ProvisionDialog } from "./ProvisionDialog";
import { RetypeDialog } from "./RetypeDialog";
import { RebuildDialog } from "./RebuildDialog";

type StepHeadersProps = {
  groupId: string;
  target: LarkTarget | null;
  // 契约收口（Round 1 复审 + Task 6 交叉核对）：**没有 plan / planError 两个 props**。
  // plan 由本组件用 loadPlan 自己读，页面不传；这两个名字只作为组件内部 state 存在。
  busy: boolean;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  targetFingerprint: string;
  schemaFingerprint: string | null;
  bases: Record<TableRole, string>;
  tableNames: Record<TableRole, string>;
  onChanged: () => Promise<void>;
  // B7：provision / retype 成功后必须让该 role 的判决重算（页面接到 recheckRole 上）。
  // 少了它，"表头修好了但第 ③ 步永远不可勾选"。
  onRoleFixed: (role: TableRole) => void;
  onTableCreated: (role: TableRole, table: Table) => void;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
  // 只有一条路：本组件按 groupId / targetFingerprint / schemaFingerprint 自己读
  // （与旧 HeaderSetup.tsx:210-241 一致）。因此它是**必填**，页面不得也不需注入 plan。
  loadPlan: (groupId: string) => Promise<ProvisionPlan>;
  // A new group or a re-pointed target must not keep a dialog, a notice or a
  // tick: remounting the three dialogs is how that reset is expressed here.
  resetKey?: string;
};

export const ROLES: TableRole[] = ["execution", "bug"];
export const ROLE_LABELS: Record<TableRole, string> = {
  execution: "执行记录表",
  bug: "缺陷记录表"
};
export const DEFAULT_TABLE_NAME: Record<TableRole, string> = {
  execution: "执行记录",
  bug: "缺陷记录"
};
// These labels must not read as "执行记录表"/"缺陷记录表": that is already the
// name of the role's table picker, and a second control answering to it would
// make the page's own labels ambiguous.
const TABLE_NAME_LABELS: Record<TableRole, string> = {
  execution: "新表名称（执行记录）",
  bug: "新表名称（缺陷记录）"
};
const CREATE_TABLE_LABELS: Record<TableRole, string> = {
  execution: "新建执行记录数据表",
  bug: "新建缺陷记录数据表"
};

// What a rebuilt table is called beside the one it replaces. It mirrors the
// server's own suffix: the dialog names the table the administrator will find
// in Lark, not a description of it.
const REBUILD_SUFFIX = "（表头修正）";

export function rebuiltNameOf(name: string): string {
  return `${name || "数据表"}${REBUILD_SUFFIX}`;
}

export function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function StepHeaders({
  groupId,
  provision,
  retype,
  createTable,
  rebuild,
  targetFingerprint,
  schemaFingerprint,
  bases,
  tableNames,
  onChanged,
  onRoleFixed,
  onTableCreated,
  onTableRebuilt,
  loadPlan,
  resetKey
}: StepHeadersProps) {
  // The plan lives here and only here: `loadPlan` is the single source, and no
  // parent may inject a plan through props (B7 / Task 6 cross-check).
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [notice, setNotice] = useState("");
  const [createError, setCreateError] = useState("");
  const [names, setNames] = useState<Record<TableRole, string>>(DEFAULT_TABLE_NAME);
  const [tableBusy, setTableBusy] = useState<TableRole | null>(null);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [retypeOpen, setRetypeOpen] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const executionBase = bases?.execution ?? "";
  const bugBase = bases?.bug ?? "";
  const baseOf = (role: TableRole) => (role === "execution" ? executionBase : bugBase);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setPlanError("");
    loadPlan(groupId)
      .then((loaded) => !cancelled && setPlan(loaded))
      .catch((reason) => !cancelled && setPlanError(messageOf(reason, "读取缺失表头失败")));
    return () => {
      cancelled = true;
    };
  }, [groupId, targetFingerprint, schemaFingerprint, loadPlan, generation]);

  // The header names another group now: no message may linger under it.
  useEffect(() => {
    setNotice("");
    setCreateError("");
    setProvisionOpen(false);
    setRetypeOpen(false);
    setRebuildOpen(false);
  }, [groupId, resetKey]);

  // A message about a table created in one base must not survive that base
  // moving to another one.
  useEffect(() => {
    setNotice("");
  }, [executionBase, bugBase]);

  const reloadPlan = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  async function createRoleTable(role: TableRole) {
    if (!createTable) return;
    const baseToken = baseOf(role);
    const tableName = names[role].trim();
    if (!baseToken || !tableName) return;
    setTableBusy(role);
    setNotice("");
    setCreateError("");
    try {
      const result = await createTable(groupId, {
        role,
        base_token: baseToken,
        table_name: tableName,
        acknowledge: true
      });
      const table = result.table;
      if (!table?.table_id) {
        setCreateError("新建数据表失败：Lark 没有返回数据表 id");
        return;
      }
      const created = { table_id: table.table_id, name: table.name || tableName };
      onTableCreated(role, created);
      setNotice(`已新建数据表「${created.name}」，请把它保存为本组的${ROLE_LABELS[role]}`);
    } catch (reason) {
      setCreateError(messageOf(reason, "新建数据表失败"));
    } finally {
      setTableBusy(null);
    }
  }

  const statusParts: string[] = [];
  const missing: Record<TableRole, number> = {
    execution: plan?.roles?.execution?.length ?? 0,
    bug: plan?.roles?.bug?.length ?? 0
  };
  const missingTotal = missing.execution + missing.bug;
  const wrongType: Record<TableRole, number> = {
    execution: plan?.retype?.execution?.length ?? 0,
    bug: plan?.retype?.bug?.length ?? 0
  };
  const wrongTypeTotal = wrongType.execution + wrongType.bug;
  if (missingTotal > 0) {
    statusParts.push(
      `缺少 ${missingTotal} 个表头：${ROLES.filter((role) => missing[role] > 0)
        .map((role) => `${ROLE_LABELS[role]} ${missing[role]}`)
        .join(" · ")}`
    );
  }
  if (retype && wrongTypeTotal > 0) {
    statusParts.push(
      `${wrongTypeTotal} 个表头类型不对：${ROLES.filter((role) => wrongType[role] > 0)
        .map((role) => `${ROLE_LABELS[role]} ${wrongType[role]}`)
        .join(" · ")}`
    );
  }
  const status = planError
    ? planError
    : plan === null
      ? "正在读取表头…"
      : statusParts.length > 0
        ? statusParts.join(" · ")
        : "表头完整";
  // The dialog that is open carries its own refusal; only a refusal with no
  // dialog left to hold it is shown here.
  const shellError = !provisionOpen && !retypeOpen && !rebuildOpen ? createError : "";

  return (
    <div className="lark-provision">
      <p className={`inline-status${planError ? " error" : ""}`} role={planError ? "alert" : "status"}>
        {status}
      </p>
      <div className="lark-provision-actions">
        {provision ? (
          <ProvisionDialog
            key={`provision-${resetKey ?? groupId}`}
            groupId={groupId}
            plan={plan}
            open={provisionOpen}
            onClose={() => setProvisionOpen(false)}
            onOpenRequest={() => setProvisionOpen(true)}
            onFinished={setNotice}
            onChanged={onChanged}
            onRoleFixed={onRoleFixed}
            provision={provision}
            reloadPlan={reloadPlan}
          />
        ) : null}
        {retype ? (
          <RetypeDialog
            key={`retype-${resetKey ?? groupId}`}
            groupId={groupId}
            plan={plan}
            open={retypeOpen}
            onClose={() => setRetypeOpen(false)}
            onOpenRequest={() => setRetypeOpen(true)}
            onFinished={setNotice}
            onChanged={onChanged}
            onRoleFixed={onRoleFixed}
            retype={retype}
            reloadPlan={reloadPlan}
          />
        ) : null}
        {rebuild ? (
          <RebuildDialog
            key={`rebuild-${resetKey ?? groupId}`}
            groupId={groupId}
            plan={plan}
            open={rebuildOpen}
            onClose={() => setRebuildOpen(false)}
            onOpenRequest={() => setRebuildOpen(true)}
            onFinished={setNotice}
            onChanged={onChanged}
            rebuild={rebuild}
            tableNames={tableNames}
            onTableRebuilt={onTableRebuilt}
            reloadPlan={reloadPlan}
            targetFingerprint={targetFingerprint}
            schemaFingerprint={schemaFingerprint}
            loadPlan={loadPlan}
          />
        ) : null}
        {createTable ? (
          <div className="lark-new-tables">
            {ROLES.map((role) => (
              <div className="lark-new-table" key={role}>
                <label>
                  {TABLE_NAME_LABELS[role]}
                  <input
                    value={names[role]}
                    maxLength={100}
                    disabled={!baseOf(role) || tableBusy !== null}
                    onChange={(event) =>
                      setNames((current) => ({ ...current, [role]: event.target.value }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost-button"
                  aria-label={CREATE_TABLE_LABELS[role]}
                  disabled={!baseOf(role) || !names[role].trim() || tableBusy !== null}
                  onClick={() => void createRoleTable(role)}
                >
                  {tableBusy === role ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Table2 size={16} />
                  )}
                  新建数据表
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {notice ? (
        <p className="inline-status saved" role="status">
          {notice}
        </p>
      ) : null}
      {shellError ? (
        <p className="inline-status error" role="alert">
          {shellError}
        </p>
      ) : null}
    </div>
  );
}
```

**三处结构决定，逐条交代理由**

1. **三个对话框由本组件直接渲染，不是调用方传进来的 slot。** 骨架的 `StepHeadersProps` 里没有 `dialogs` / `children`，所以三个入口按钮分别由三个对话框在 `open === false` 时渲染（各自的条件：`missingTotal > 0` / `retype && wrongTypeTotal > 0` / `rebuild`）。`lark-provision-actions` 这个 flex 容器包住它们与新表入口，`styles.css:178` 的既有样式不动。
2. **`open` 由外壳持有，`busy` / `error` / `ticked` 留在对话框内部。** 失败后错误出现在**弹窗内**（与旧 `HeaderSetup.tsx:742-746` 同位置），所以「失败后弹窗不关」那条断言原样成立。
3. **`resetKey` 用 `key=` 重挂载三个对话框**，等价于旧 `useEffect([groupId])`（`:198-208`）：换组时 tick 选择、视图勾选、force 勾选、内部消息一并归零，一条 state 都不会漏。

- [ ] **Step 6: 跑，确认外壳是绿的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/ProvisionDialog.test.tsx`

期望输出：

```
 ✓ src/components/lark/ProvisionDialog.test.tsx (13 tests)

 Test Files  1 passed (1)
      Tests  13 passed (13)
```

判据是 **`0 failed` 且这 13 条全过**（`13` 是文件里 `it(` 的条数，本机 grep 数出来的）：其中 `测试表头完整 → 入口消失`、`没有缺少的表头，写入确认保持不变`、`loadPlan` 重读、目标指纹变化重读这几条都要靠 `StepHeaders` 的状态行与入口显隐才成立。

- [ ] **Step 7: 写 `RetypeDialog.test.tsx`（完整内容，先红）**

`frontend/src/components/lark/RetypeDialog.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ApiError, type ProvisionPlan, type RetypeFieldsPayload, type RetypeFieldsResult } from "../../api";
import { StepHeaders } from "./StepHeaders";

const COMPLETE: ProvisionPlan = { roles: { execution: [], bug: [] } };

const RETYPE_PLAN: ProvisionPlan = {
  roles: { execution: [], bug: [] },
  retype: {
    execution: [
      {
        name: "优先级",
        type: 3,
        type_name: "single_select",
        field_id: "fld-prio",
        current_type: 1,
        current_type_name: "text",
        properties: {}
      }
    ],
    bug: []
  }
};

type HarnessProps = {
  plan: ProvisionPlan;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  onChanged?: () => Promise<void>;
  onRoleFixed?: (role: "execution" | "bug") => void;
};

function Harness({ plan, retype, onChanged, onRoleFixed = vi.fn() }: HarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <StepHeaders
      groupId="g1"
      target={null}
      loadPlan={vi.fn().mockResolvedValue(plan)}
      busy={false}
      retype={retype}
      targetFingerprint="app-exec|tbl-runs|app-exec|tbl-bugs"
      schemaFingerprint={null}
      bases={{ execution: "app-exec", bug: "app-bugs" }}
      tableNames={{ execution: "执行记录", bug: "缺陷记录" }}
      onChanged={onChanged ?? vi.fn().mockResolvedValue(undefined)}
      onRoleFixed={onRoleFixed}
      onTableCreated={vi.fn()}
      onTableRebuilt={vi.fn()}
    />
  );
}

it("offers to convert a header that already exists with the wrong type", async () => {
  const retype = vi.fn().mockResolvedValue({ retyped_fields: ["优先级"], schema_errors: [] });
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const onRoleFixed = vi.fn();
  render(<Harness plan={RETYPE_PLAN} retype={retype} onChanged={onChanged} onRoleFixed={onRoleFixed} />);

  expect(await screen.findByText(/1 个表头类型不对/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "修正表头类型" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("优先级");
  // The administrator sees both the wrong type and the one it will become.
  expect(dialog).toHaveTextContent("text → single_select");
  expect(dialog).toHaveTextContent("只会把下面勾选的表头改成正确的类型；表头里已有的数据不会被删除。");
  expect(retype).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  expect(retype).toHaveBeenCalledWith("g1", {
    role: "execution",
    field_names: ["优先级"],
    acknowledge: true
  });
  // A real type change clears the write approval, so the page re-reads it.
  expect(onChanged).toHaveBeenCalledTimes(1);
  // And it retires that role's verdict, so the page checks the table again.
  expect(onRoleFixed).toHaveBeenCalledWith("execution");
  expect(onRoleFixed).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("已修正 1 个表头，请重新确认写入")).toBeVisible();
  expect(await screen.findByText("表头完整")).toBeVisible();
});

it("sends only the headers the administrator left ticked for repair", async () => {
  const plan: ProvisionPlan = {
    roles: { execution: [], bug: [] },
    retype: {
      execution: [
        ...RETYPE_PLAN.retype!.execution,
        {
          name: "结果",
          type: 3,
          type_name: "single_select",
          field_id: "fld-result",
          current_type: 1,
          current_type_name: "text",
          properties: {}
        }
      ],
      bug: []
    }
  };
  const retype = vi.fn().mockResolvedValue({ retyped_fields: [], schema_errors: [] });
  render(<Harness plan={plan} retype={retype} />);

  await userEvent.click(await screen.findByRole("button", { name: "修正表头类型" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "修正表头「结果」" }));
  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  expect(retype).toHaveBeenCalledTimes(1);
  expect(retype).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ role: "execution", field_names: ["优先级"] })
  );
});

it("keeps the approval when nothing actually needed repair", async () => {
  const retype = vi.fn().mockResolvedValue({ retyped_fields: [], schema_errors: [] });
  const onChanged = vi.fn().mockResolvedValue(undefined);
  render(<Harness plan={RETYPE_PLAN} retype={retype} onChanged={onChanged} />);

  await userEvent.click(await screen.findByRole("button", { name: "修正表头类型" }));
  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  expect(await screen.findByText("没有需要修正的表头")).toBeVisible();
  expect(onChanged).not.toHaveBeenCalled();
});

it("reports a refused repair with the headers it did convert", async () => {
  const detail = {
    reason: "provision_failed",
    message: "修正表头类型失败：没有权限",
    created_fields: ["优先级"]
  };
  const retype = vi.fn().mockRejectedValue(new ApiError(409, detail));
  const onChanged = vi.fn().mockResolvedValue(undefined);
  render(<Harness plan={RETYPE_PLAN} retype={retype} onChanged={onChanged} />);

  await userEvent.click(await screen.findByRole("button", { name: "修正表头类型" }));
  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  // The refusal is inside the dialog, next to the run it belongs to.
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("修正表头类型失败：没有权限");
  expect(dialog).toHaveTextContent("已修正 1 个表头，请重新确认写入");
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("hides the repair command when the page cannot repair a table", async () => {
  render(<Harness plan={COMPLETE} />);

  // Without a bound repair call the panel may not promise one.
  expect(await screen.findByText("表头完整")).toBeVisible();
  expect(screen.queryByRole("button", { name: "修正表头类型" })).not.toBeInTheDocument();
});

it("does not retire a role's verdict when the repair is refused", async () => {
  const retype = vi.fn().mockRejectedValue(new Error("修正表头类型失败：没有权限"));
  const onRoleFixed = vi.fn();
  render(<Harness plan={RETYPE_PLAN} retype={retype} onRoleFixed={onRoleFixed} />);

  await userEvent.click(await screen.findByRole("button", { name: "修正表头类型" }));
  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  expect(await screen.findByText("修正表头类型失败：没有权限")).toBeVisible();
  // Nothing was converted, so the verdict the table already had still stands.
  expect(onRoleFixed).not.toHaveBeenCalled();
});
```

- [ ] **Step 8: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/RetypeDialog.test.tsx`

期望输出：

```
Error: Failed to resolve import "./RetypeDialog" from "src/components/lark/StepHeaders.tsx". Does the file exist?
```

（红色在 `StepHeaders.tsx` 的 import 上——`RetypeDialog` 还没建。）

- [ ] **Step 9: 写 `RetypeDialog.tsx`（完整内容）**

`frontend/src/components/lark/RetypeDialog.tsx`：

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, Wrench } from "lucide-react";

import {
  type ProvisionPlan,
  type RetypeField,
  type RetypeFieldsPayload,
  type RetypeFieldsResult,
  type TableRole
} from "../../api";
import { ROLE_LABELS, messageOf } from "./StepHeaders";
import { refusalOf } from "./ProvisionDialog";

type RetypeDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  // 表头类型真的改了：该 role 的 probe 已作废，页面要重新校验它（B7）。
  onRoleFixed: (role: TableRole) => void;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  reloadPlan: () => void;
};

const ROLES: TableRole[] = ["execution", "bug"];

function trapFocus(event: KeyboardEvent<HTMLDivElement>, container: HTMLDivElement | null) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    container?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  );
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = container?.contains(active) ?? false;
  if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  }
}

export function RetypeDialog({
  groupId,
  plan,
  open,
  onClose,
  onOpenRequest,
  onFinished,
  onChanged,
  onRoleFixed,
  retype,
  reloadPlan
}: RetypeDialogProps) {
  const [retypeTicked, setRetypeTicked] = useState<Record<TableRole, string[]>>({
    execution: [],
    bug: []
  });
  const [retypeNotice, setRetypeNotice] = useState("");
  const [retypeBusy, setRetypeBusy] = useState(false);
  const [error, setError] = useState("");
  const retypeRef = useRef<HTMLDivElement>(null);
  const retypeConfirmRef = useRef<HTMLButtonElement>(null);
  const wrongType: Record<TableRole, RetypeField[]> = {
    execution: plan?.retype?.execution ?? [],
    bug: plan?.retype?.bug ?? []
  };
  const wrongTypeTotal = wrongType.execution.length + wrongType.bug.length;
  // Same rule as the creation dialog: only a header still in the plan may be
  // sent, so a reload cannot leave a hidden name ticked.
  const retypeNames = (role: TableRole) =>
    wrongType[role]
      .filter((field) => retypeTicked[role].includes(field.name))
      .map((field) => field.name);
  const retypeTotal = ROLES.reduce((total, role) => total + retypeNames(role).length, 0);

  useEffect(() => {
    if (open) retypeConfirmRef.current?.focus();
  }, [open]);

  function openRetypeDialog() {
    setRetypeTicked({
      execution: wrongType.execution.map((field) => field.name),
      bug: wrongType.bug.map((field) => field.name)
    });
    setRetypeNotice("");
    setError("");
    onOpenRequest();
  }

  function closeRetypeDialog() {
    setRetypeNotice("");
    onClose();
  }

  function toggleRetype(role: TableRole, name: string) {
    setRetypeTicked((current) => ({
      ...current,
      [role]: current[role].includes(name)
        ? current[role].filter((item) => item !== name)
        : [...current[role], name]
    }));
  }

  function handleRetypeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!retypeBusy) closeRetypeDialog();
      return;
    }
    trapFocus(event, retypeRef.current);
  }

  async function runRetype() {
    if (!retype) return;
    const roles = ROLES.filter((role) => retypeNames(role).length > 0);
    if (roles.length === 0) return;
    setRetypeBusy(true);
    setError("");
    setRetypeNotice("");
    let retyped = 0;
    let failure = "";
    let convertedBeforeFailure = 0;
    // The roles whose headers this run really converted: their verdicts are
    // stale and only a re-check can lift a `bad` one (B7).
    const changedRoles: TableRole[] = [];
    try {
      for (const role of roles) {
        try {
          const result = await retype(groupId, {
            role,
            field_names: retypeNames(role),
            acknowledge: true
          });
          const converted = result.retyped_fields?.length ?? 0;
          retyped += converted;
          if (converted > 0) changedRoles.push(role);
        } catch (reason) {
          const refusal = refusalOf(reason, "修正表头类型失败");
          failure = refusal.message;
          // A refused run can still have converted the headers before it.
          convertedBeforeFailure = refusal.createdFields.length;
          retyped += convertedBeforeFailure;
          if (convertedBeforeFailure > 0) changedRoles.push(role);
          break;
        }
      }
      // The verdict is retired before the page re-reads the target.
      for (const role of changedRoles) onRoleFixed(role);
      // Only a run that really converted a column clears the write approval, so
      // the page is only asked to re-read the table then.
      if (retyped > 0) {
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the repair still happened.
        }
      }
      reloadPlan();
      if (failure) {
        setError(failure);
        if (convertedBeforeFailure > 0) {
          setRetypeNotice(`已修正 ${convertedBeforeFailure} 个表头，请重新确认写入`);
        }
      } else {
        closeRetypeDialog();
        onFinished(retyped > 0 ? `已修正 ${retyped} 个表头，请重新确认写入` : "没有需要修正的表头");
      }
    } finally {
      setRetypeBusy(false);
    }
  }

  if (!open) {
    return retype && wrongTypeTotal > 0 ? (
      <button type="button" className="ghost-button" onClick={openRetypeDialog}>
        <Wrench size={16} />
        修正表头类型
      </button>
    ) : null;
  }

  return (
    <div className="header-setup-overlay" onKeyDown={handleRetypeKeyDown}>
      <div
        ref={retypeRef}
        className="header-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-retype-title"
      >
        <h3 id="header-retype-title">修正表头类型</h3>
        <p className="inline-status">
          只会把下面勾选的表头改成正确的类型；表头里已有的数据不会被删除。
        </p>

        <ul className="header-setup-roles">
          {ROLES.filter((role) => wrongType[role].length > 0).map((role) => (
            <li className="header-setup-role" key={role}>
              <h4>{ROLE_LABELS[role]}</h4>
              <ul className="header-setup-fields">
                {wrongType[role].map((field) => (
                  <li className="header-setup-row" key={field.name}>
                    <input
                      type="checkbox"
                      checked={retypeTicked[role].includes(field.name)}
                      aria-label={`修正表头「${field.name}」`}
                      onChange={() => toggleRetype(role, field.name)}
                    />
                    <span className="header-setup-name">{field.name}</span>
                    <span className="header-setup-type">
                      {field.current_type_name} → {field.type_name}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {retypeNotice ? (
          <p className="inline-status saved" role="status">
            {retypeNotice}
          </p>
        ) : null}
        {error ? (
          <p className="inline-status error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="header-setup-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={retypeBusy}
            onClick={closeRetypeDialog}
          >
            取消
          </button>
          <button
            ref={retypeConfirmRef}
            type="button"
            className="primary"
            disabled={retypeBusy || retypeTotal === 0}
            onClick={() => void runRetype()}
          >
            {retypeBusy ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}
            修正这些表头
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 10: 跑，确认全绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/RetypeDialog.test.tsx`

期望输出：

```
 ✓ src/components/lark/RetypeDialog.test.tsx (5 tests)

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

- [ ] **Step 11: 写 `RebuildDialog.test.tsx`（完整内容，先红）**

`frontend/src/components/lark/RebuildDialog.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import {
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type Table,
  type TableRole
} from "../../api";
import { StepHeaders } from "./StepHeaders";

const COMPLETE: ProvisionPlan = { roles: { execution: [], bug: [] } };

function rebuildResult(role: TableRole, requeued = 3): RebuildTableResult {
  const replaced =
    role === "execution"
      ? { table_id: "tbl-runs", name: "执行记录" }
      : { table_id: "tbl-bugs", name: "缺陷记录" };
  return {
    role,
    table: { table_id: "tbl-fresh", name: `${replaced.name}（表头修正）` },
    replaced,
    requeued,
    schema_errors: [],
    target: {} as RebuildTableResult["target"]
  };
}

type HarnessProps = {
  // What the shell's own plan read returns.
  plan?: ProvisionPlan;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  onChanged?: () => Promise<void>;
  onTableRebuilt?: (role: TableRole, table: Table, replaced: Table) => void;
};

function Harness({
  plan = COMPLETE,
  loadPlan,
  rebuild,
  onChanged = vi.fn().mockResolvedValue(undefined),
  onTableRebuilt = vi.fn()
}: HarnessProps) {
  return (
    <StepHeaders
      groupId="g1"
      target={null}
      busy={false}
      rebuild={rebuild}
      loadPlan={loadPlan ?? vi.fn().mockResolvedValue(plan)}
      targetFingerprint="app-exec|tbl-runs|app-exec|tbl-bugs"
      schemaFingerprint={null}
      bases={{ execution: "app-exec", bug: "app-bugs" }}
      tableNames={{ execution: "执行记录", bug: "缺陷记录" }}
      onChanged={onChanged}
      onRoleFixed={vi.fn()}
      onTableCreated={vi.fn()}
      onTableRebuilt={onTableRebuilt}
    />
  );
}

function renderRebuild(overrides: HarnessProps = {}) {
  const rebuild = vi
    .fn()
    .mockResolvedValueOnce(rebuildResult("execution"))
    .mockResolvedValue(rebuildResult("bug"));
  const onTableRebuilt = vi.fn();
  const onChanged = vi.fn().mockResolvedValue(undefined);
  render(
    <Harness
      loadPlan={vi.fn().mockResolvedValue(COMPLETE)}
      rebuild={rebuild}
      onChanged={onChanged}
      onTableRebuilt={onTableRebuilt}
      {...overrides}
    />
  );
  return { rebuild, onTableRebuilt, onChanged };
}

it("rebuilds the ticked role's table and names the one it replaces", async () => {
  const { rebuild, onTableRebuilt, onChanged } = renderRebuild();

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));

  const dialog = await screen.findByRole("dialog");
  // The dialog names both tables before anything is replaced.
  expect(dialog).toHaveTextContent("执行记录");
  expect(dialog).toHaveTextContent("执行记录（表头修正）");
  expect(rebuild).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("checkbox", { name: "重建执行记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(rebuild).toHaveBeenCalledWith("g1", {
    role: "execution",
    acknowledge: true,
    force: false
  });
  expect(onTableRebuilt).toHaveBeenCalledWith(
    "execution",
    { table_id: "tbl-fresh", name: "执行记录（表头修正）" },
    { table_id: "tbl-runs", name: "执行记录" }
  );
  // The rebuilt destination dropped the write approval on the server, so the
  // page re-reads it instead of showing the one that no longer stands.
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByText(/已重建「执行记录（表头修正）」，重新排入 3 条「执行记录表」记录/)
  ).toBeVisible();
  expect(screen.getByText(/旧表「执行记录」不会自动删除/)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps the rebuild command disabled until a role is ticked", async () => {
  const { rebuild } = renderRebuild();

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));

  // Replacing tables is destructive: the checkbox starts unticked and the
  // command stays out of reach until the administrator picks one.
  const confirm = screen.getByRole("button", { name: "重建勾选的数据表" });
  expect(screen.getByRole("checkbox", { name: "重建执行记录数据表" })).not.toBeChecked();
  expect(confirm).toBeDisabled();

  await userEvent.click(screen.getByRole("checkbox", { name: "重建缺陷记录数据表" }));
  expect(confirm).toBeEnabled();
  expect(rebuild).not.toHaveBeenCalled();
});

it("says how many rows a rebuild would rewrite and can force one", async () => {
  const { rebuild } = renderRebuild({
    plan: { ...COMPLETE, rebuild: { execution: 4, bug: 2 } }
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

it("names a role with nothing to rewrite instead of showing a bare zero", async () => {
  renderRebuild({ plan: { ...COMPLETE, rebuild: { execution: 0, bug: 3 } } });

  await userEvent.click(await screen.findByRole("button", { name: "重建数据表（表头修正）" }));

  // The copy promises the count, not every row: rows adopted from the table or
  // written before the target was confirmed are never re-filed.
  expect(screen.getByText(/本组按当前规则重新写入的行数见下/)).toBeVisible();
  expect(await screen.findByText(/这一类没有会被重写的记录/)).toBeVisible();
  expect(screen.getByText(/将重新写入 3 条记录/)).toBeVisible();
  expect(screen.queryByText(/将重新写入 0 条记录/)).not.toBeInTheDocument();
});

it("reads the count again when the dialog opens, not only when the page loaded", async () => {
  const loadPlan = vi
    .fn()
    .mockResolvedValueOnce({ ...COMPLETE, rebuild: { execution: 1, bug: 0 } })
    .mockResolvedValue({ ...COMPLETE, rebuild: { execution: 3, bug: 0 } });
  renderRebuild({ loadPlan });

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));

  // Results filed since the panel loaded have already minted their jobs, so
  // the number the administrator approves has to come from a read taken now.
  expect(await screen.findByText(/将重新写入 3 条记录/)).toBeVisible();
  expect(screen.queryByText(/将重新写入 1 条记录/)).not.toBeInTheDocument();
});

it("does not promise a count the plan does not carry yet", async () => {
  renderRebuild({ loadPlan: vi.fn().mockReturnValue(new Promise(() => {})) });

  await userEvent.click(await screen.findByRole("button", { name: "重建数据表（表头修正）" }));

  // The command is reachable while the plan is still in flight, so the
  // sentence may not point at a number that is not on screen.
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.queryByText(/本组按当前规则重新写入的行数见下/)).not.toBeInTheDocument();
});

it("rebuilds every ticked role, one table after the other", async () => {
  const { rebuild, onTableRebuilt } = renderRebuild();

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建缺陷记录数据表" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建执行记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(rebuild.mock.calls).toEqual([
    ["g1", { role: "execution", acknowledge: true, force: false }],
    ["g1", { role: "bug", acknowledge: true, force: false }]
  ]);
  expect(onTableRebuilt).toHaveBeenCalledTimes(2);
  expect(
    await screen.findByText(/已重建「缺陷记录（表头修正）」，重新排入 3 条「缺陷记录表」记录/)
  ).toBeVisible();
});

it("reports a refused rebuild and keeps the dialog open", async () => {
  const rebuild = vi.fn().mockRejectedValue(new Error("重建数据表失败：没有权限"));
  const { onTableRebuilt, onChanged } = renderRebuild({ rebuild });

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建执行记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(await screen.findByText("重建数据表失败：没有权限")).toBeVisible();
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(onTableRebuilt).not.toHaveBeenCalled();
  // Nothing moved, so the approval the group already had still stands.
  expect(onChanged).not.toHaveBeenCalled();
});

it("keeps the page on the table that did move when the second rebuild is refused", async () => {
  const rebuild = vi
    .fn()
    .mockResolvedValueOnce(rebuildResult("execution"))
    .mockRejectedValue(new Error("重建数据表失败：没有权限"));
  const { onTableRebuilt, onChanged } = renderRebuild({ rebuild });

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建执行记录数据表" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建缺陷记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(await screen.findByText("重建数据表失败：没有权限")).toBeVisible();
  // The first table really was replaced: the page follows it and says so.
  expect(onTableRebuilt).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/已重建「执行记录（表头修正）」/)).toBeVisible();
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("closes the rebuild dialog on Escape without replacing anything", async () => {
  const { rebuild } = renderRebuild();

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));
  expect(screen.getByRole("dialog")).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(rebuild).not.toHaveBeenCalled();
});

it("hides the rebuild command when the page cannot rebuild a table", async () => {
  render(<Harness plan={COMPLETE} />);

  await screen.findByText("表头完整");
  expect(
    screen.queryByRole("button", { name: "重建数据表（表头修正）" })
  ).not.toBeInTheDocument();
});
```

- [ ] **Step 12: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/RebuildDialog.test.tsx`

期望输出：

```
Error: Failed to resolve import "./RebuildDialog" from "src/components/lark/StepHeaders.tsx". Does the file exist?
```

- [ ] **Step 13: 写 `RebuildDialog.tsx`（完整内容）**

`frontend/src/components/lark/RebuildDialog.tsx`：

```tsx
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, Table2 } from "lucide-react";

import {
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type Table,
  type TableRole
} from "../../api";
import { ROLE_LABELS, messageOf, rebuiltNameOf } from "./StepHeaders";

type RebuildDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  tableNames: Record<TableRole, string>;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
  reloadPlan: () => void;
  targetFingerprint: string;
  schemaFingerprint: string | null;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
};

const ROLES: TableRole[] = ["execution", "bug"];
const REBUILD_LABELS: Record<TableRole, string> = {
  execution: "重建执行记录数据表",
  bug: "重建缺陷记录数据表"
};

function trapFocus(event: KeyboardEvent<HTMLDivElement>, container: HTMLDivElement | null) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    container?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  );
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = container?.contains(active) ?? false;
  if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  }
}

export function RebuildDialog({
  groupId,
  plan,
  open,
  onClose,
  onOpenRequest,
  onFinished,
  onChanged,
  rebuild,
  tableNames,
  onTableRebuilt,
  reloadPlan,
  targetFingerprint,
  schemaFingerprint,
  loadPlan
}: RebuildDialogProps) {
  const [rebuildTicked, setRebuildTicked] = useState<Record<TableRole, boolean>>({
    execution: false,
    bug: false
  });
  const [rebuildNotice, setRebuildNotice] = useState("");
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildForce, setRebuildForce] = useState(false);
  const [error, setError] = useState("");
  const [freshPlan, setFreshPlan] = useState<ProvisionPlan | null>(null);
  const rebuildRef = useRef<HTMLDivElement>(null);
  const effectivePlan = freshPlan ?? plan;
  // The count is only on screen once the plan carries it, so the sentence that
  // points at the count is promised under the same condition.
  const rebuildCostNote = effectivePlan?.rebuild
    ? "，本组按当前规则重新写入的行数见下（从表里采纳的记录不会重写，本组目标确认前写入的记录也不会）"
    : "";

  useEffect(() => {
    // The primary command starts disabled (nothing is ticked), and a disabled
    // button cannot take focus — so the dialog itself takes it, which is also
    // what announces the replacement to a screen reader.
    if (open) rebuildRef.current?.focus();
  }, [open]);

  // The count this dialog asks the administrator to approve is the one the
  // rebuild will really write, and a result filed since the panel loaded has
  // already minted its job. Read the plan again when the dialog opens, under
  // the same guard as the load above: a late answer must not follow the panel
  // onto another group. A failed read neither holds the dialog shut nor drops
  // the plan already on screen.
  useEffect(() => {
    if (!open || !loadPlan) return;
    let cancelled = false;
    loadPlan(groupId)
      .then((loaded) => !cancelled && setFreshPlan(loaded))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, groupId, targetFingerprint, schemaFingerprint, loadPlan]);

  function openRebuildDialog() {
    // Nothing is ticked to begin with: this one replaces real tables, so it
    // asks for the choice rather than pre-selecting it.
    setRebuildTicked({ execution: false, bug: false });
    setRebuildForce(false);
    setRebuildNotice("");
    setError("");
    onOpenRequest();
  }

  function closeRebuildDialog() {
    setRebuildNotice("");
    onClose();
  }

  function handleRebuildKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!rebuildBusy) closeRebuildDialog();
      return;
    }
    trapFocus(event, rebuildRef.current);
  }

  async function runRebuild() {
    if (!rebuild) return;
    const roles = ROLES.filter((role) => rebuildTicked[role]);
    if (roles.length === 0) return;
    setRebuildBusy(true);
    setError("");
    setRebuildNotice("");
    const moved: { role: TableRole; table: Table; replaced: Table; requeued: number }[] = [];
    let failure = "";
    try {
      for (const role of roles) {
        try {
          const result = await rebuild(groupId, {
            role,
            acknowledge: true,
            force: rebuildForce
          });
          moved.push({
            role,
            table: result.table,
            replaced: result.replaced,
            requeued: result.requeued ?? 0
          });
          // The group now points at the rebuilt table, so this page has to
          // name it too: without this the selection would still offer the
          // table the server just walked away from.
          onTableRebuilt(role, result.table, result.replaced);
        } catch (reason) {
          failure = messageOf(reason, "重建数据表失败");
          break;
        }
      }
      if (moved.length > 0) {
        // The rebuilt destination dropped the write approval on the server.
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the rebuild did happen.
        }
      }
      reloadPlan();

      const copy = moved
        .map(
          (item) =>
            `已重建「${item.table.name}」，重新排入 ${item.requeued} 条「${ROLE_LABELS[item.role]}」记录`
        )
        .join("；");
      const cleanup = moved
        .map((item) => `旧表「${item.replaced.name}」不会自动删除，请确认后手动删除`)
        .join("；");
      if (failure) {
        setError(failure);
        if (moved.length > 0) setRebuildNotice(`${copy}；请重新确认写入`);
      } else {
        closeRebuildDialog();
        onFinished(moved.length > 0 ? `${copy}；${cleanup}；请重新确认写入` : "没有重建任何数据表");
      }
    } finally {
      setRebuildBusy(false);
    }
  }

  if (!open) {
    return rebuild ? (
      <button type="button" className="ghost-button" onClick={openRebuildDialog}>
        <Table2 size={16} />
        重建数据表（表头修正）
      </button>
    ) : null;
  }

  return (
    <div className="header-setup-overlay" onKeyDown={handleRebuildKeyDown}>
      <div
        ref={rebuildRef}
        className="header-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-rebuild-title"
        tabIndex={-1}
      >
        <h3 id="header-rebuild-title">重建数据表（表头修正）</h3>
        <p className="inline-status">
          新建一张表头顺序和类型都正确的新表（执行记录表为 用例 / 结果 / 优先级 /
          负责人 / 截图 / 控制台 / 报告人 / 日期，缺陷记录表为 问题描述 / 优先级 /
          进展状态 / 反馈时间 / 反馈人 / 跟进人 / 备注 / 截图），并把本组指向它。
          结果、优先级、进展状态是下拉框，截图和人员是对应类型的字段。
        </p>
        <p className="inline-status">
          {`表头顺序和主列无法在 Lark 里改，只能换一张表。旧表不会被删除${rebuildCostNote}；重建后需要重新确认写入。`}
        </p>

        <ul className="header-setup-roles">
          {ROLES.map((role) => (
            <li className="header-setup-role" key={role}>
              <h4>{ROLE_LABELS[role]}</h4>
              <ul className="header-setup-fields">
                <li className="header-setup-row">
                  <input
                    type="checkbox"
                    checked={rebuildTicked[role]}
                    aria-label={REBUILD_LABELS[role]}
                    onChange={() =>
                      setRebuildTicked((current) => ({ ...current, [role]: !current[role] }))
                    }
                  />
                  <span className="header-setup-name">
                    {tableNames?.[role] || ROLE_LABELS[role]}
                  </span>
                  <span className="header-setup-type">
                    → {rebuiltNameOf(tableNames?.[role] ?? "")}
                    {effectivePlan?.rebuild
                      ? effectivePlan.rebuild[role] > 0
                        ? `，将重新写入 ${effectivePlan.rebuild[role]} 条记录`
                        : "，这一类没有会被重写的记录"
                      : ""}
                  </span>
                </li>
              </ul>
            </li>
          ))}
        </ul>

        {rebuildNotice ? (
          <p className="inline-status saved" role="status">
            {rebuildNotice}
          </p>
        ) : null}
        {error ? (
          <p className="inline-status error" role="alert">
            {error}
          </p>
        ) : null}

        <label className="header-setup-force">
          <input
            type="checkbox"
            checked={rebuildForce}
            aria-label="强制重建"
            onChange={(event) => setRebuildForce(event.target.checked)}
          />
          <span>
            <strong>强制重建</strong>
            （表头已经正确时也重建：会再建一张新表，并把上面列出的记录重新写入）
          </span>
        </label>

        <div className="header-setup-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={rebuildBusy}
            onClick={closeRebuildDialog}
          >
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={rebuildBusy || !ROLES.some((role) => rebuildTicked[role])}
            onClick={() => void runRebuild()}
          >
            {rebuildBusy ? <LoaderCircle className="spin" size={16} /> : <Table2 size={16} />}
            重建勾选的数据表
          </button>
        </div>
      </div>
    </div>
  );
}
```

**旧代码里主按钮上的 `ref={rebuildConfirmRef}` 不搬过来**：旧测试 `:718-729` 断言 `expect(screen.getByRole("dialog")).toHaveFocus()`——依据是 `rebuildRef`（`:256`），`rebuildConfirmRef` 从来没被读过。新弹窗保留 `rebuildRef`，不引入 `rebuildConfirmRef`。

- [ ] **Step 14: 跑，确认全绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/RebuildDialog.test.tsx`

期望输出：

```
 ✓ src/components/lark/RebuildDialog.test.tsx (13 tests)

 Test Files  1 passed (1)
      Tests  13 passed (13)
```

- [ ] **Step 15: 写 `StepHeaders.test.tsx`（完整内容）**

`frontend/src/components/lark/StepHeaders.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { type CreateTablePayload, type CreateTableResult, type ProvisionFieldsPayload, type ProvisionFieldsResult, type ProvisionPlan, type RetypeFieldsPayload, type RetypeFieldsResult, type Table } from "../../api";
import { StepHeaders } from "./StepHeaders";

const PLAN: ProvisionPlan = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  }
};

const COMPLETE: ProvisionPlan = { roles: { execution: [], bug: [] } };

type HarnessProps = {
  // What the shell's own plan read returns.
  plan?: ProvisionPlan;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  onTableCreated?: (role: "execution" | "bug", table: Table) => void;
  onRoleFixed?: (role: "execution" | "bug") => void;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  bases?: Record<"execution" | "bug", string>;
  groupId?: string;
  targetFingerprint?: string;
};

function props({
  plan = COMPLETE,
  loadPlan,
  createTable,
  onTableCreated = vi.fn(),
  onRoleFixed = vi.fn(),
  provision = vi.fn(),
  retype,
  bases = { execution: "app-exec", bug: "app-bugs" },
  groupId = "g1",
  targetFingerprint = "app-exec|tbl-runs|app-exec|tbl-bugs"
}: HarnessProps) {
  return (
    <StepHeaders
      groupId={groupId}
      target={null}
      busy={false}
      provision={provision}
      retype={retype}
      createTable={createTable}
      loadPlan={loadPlan ?? vi.fn().mockResolvedValue(plan)}
      targetFingerprint={targetFingerprint}
      schemaFingerprint={null}
      bases={bases}
      tableNames={{ execution: "执行记录", bug: "缺陷记录" }}
      onChanged={vi.fn().mockResolvedValue(undefined)}
      onRoleFixed={onRoleFixed}
      onTableCreated={onTableCreated}
      onTableRebuilt={vi.fn()}
    />
  );
}

it("stays hidden when the table already has every header", async () => {
  render(props({ plan: COMPLETE }));
  await screen.findByText("表头完整");
  expect(screen.queryByRole("button", { name: "设置表头" })).not.toBeInTheDocument();
});

it("creates a role's table with its default name and hands the new table back", async () => {
  const createTable = vi
    .fn()
    .mockResolvedValue({ table: { table_id: "tbl-new", name: "缺陷记录" }, role: "bug" });
  const onTableCreated = vi.fn();
  render(props({ plan: COMPLETE, createTable, onTableCreated }));

  await screen.findByText("表头完整");
  expect(screen.getByLabelText("新表名称（缺陷记录）")).toHaveValue("缺陷记录");
  await userEvent.click(screen.getByRole("button", { name: "新建缺陷记录数据表" }));

  expect(createTable).toHaveBeenCalledWith("g1", {
    role: "bug",
    base_token: "app-bugs",
    table_name: "缺陷记录",
    acknowledge: true
  });
  expect(onTableCreated).toHaveBeenCalledWith("bug", { table_id: "tbl-new", name: "缺陷记录" });
  expect(await screen.findByText(/已新建数据表「缺陷记录」/)).toBeVisible();
});

it("only offers a new table once that role's base is known", async () => {
  render(
    props({
      plan: COMPLETE,
      createTable: vi.fn(),
      bases: { execution: "app-exec", bug: "" }
    })
  );

  await screen.findByText("表头完整");
  expect(screen.getByRole("button", { name: "新建执行记录数据表" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "新建缺陷记录数据表" })).toBeDisabled();
  expect(screen.getByLabelText("新表名称（缺陷记录）")).toHaveAttribute("maxlength", "100");
});

it("clears the new-table message once that role's base moves", async () => {
  const createTable = vi
    .fn()
    .mockResolvedValue({ table: { table_id: "tbl-new", name: "缺陷记录" }, role: "bug" });
  const onTableCreated = vi.fn();
  const { rerender } = render(props({ plan: COMPLETE, createTable, onTableCreated }));

  await userEvent.click(screen.getByRole("button", { name: "新建缺陷记录数据表" }));
  expect(await screen.findByText(/已新建数据表「缺陷记录」/)).toBeVisible();

  rerender(
    props({
      plan: COMPLETE,
      createTable,
      onTableCreated,
      bases: { execution: "app-exec", bug: "app-other" }
    })
  );

  // The message described a table in app-bugs; it says nothing about app-other.
  expect(screen.queryByText(/已新建数据表/)).not.toBeInTheDocument();
});

it("reads the new group's list when the group changes", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PLAN);
  const { rerender } = render(props({ loadPlan }));
  expect(await screen.findByRole("button", { name: "设置表头" })).toBeVisible();

  rerender(props({ loadPlan, groupId: "g2" }));

  expect(loadPlan).toHaveBeenLastCalledWith("g2");
  expect(loadPlan).toHaveBeenCalledTimes(2);
});

it("re-reads the header list when the target it describes changes", async () => {
  const loadPlan = vi.fn().mockResolvedValueOnce(PLAN).mockResolvedValue(COMPLETE);
  const { rerender } = render(props({ loadPlan }));

  expect(await screen.findByRole("button", { name: "设置表头" })).toBeVisible();

  // The group now points at another table: the old list describes a table that
  // will not receive the headers, so it may not stay on screen.
  rerender(
    props({
      loadPlan,
      targetFingerprint: "app-exec|tbl-fresh|app-exec|tbl-bugs"
    })
  );

  expect(await screen.findByText("表头完整")).toBeVisible();
  expect(loadPlan).toHaveBeenCalledTimes(2);
});

it("retires each role it just edited, once per role", async () => {
  const plan: ProvisionPlan = {
    roles: {
      execution: [{ name: "结果", type: 1, type_name: "text", properties: {} }],
      bug: [{ name: "问题描述", type: 1, type_name: "text", properties: {} }]
    },
    retype: {
      execution: [
        {
          name: "优先级",
          type: 3,
          type_name: "single_select",
          field_id: "fld-prio",
          current_type: 1,
          current_type_name: "text",
          properties: {}
        }
      ],
      bug: []
    }
  };
  const provision = vi
    .fn()
    .mockResolvedValueOnce({ created_fields: ["结果"], schema_errors: [] })
    .mockResolvedValue({ created_fields: ["问题描述"], schema_errors: [] });
  const retype = vi.fn().mockResolvedValue({ retyped_fields: ["优先级"], schema_errors: [] });
  const onRoleFixed = vi.fn();
  render(props({ plan, provision, retype: retype as never, onRoleFixed }));

  await screen.findByText(/缺少 2 个表头/);
  await userEvent.click(screen.getByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // A repaired table's verdict is stale: without this the ③ step could never
  // read "both verdicts ok", because its own check button is offered for
  // `unread` alone (B7).
  expect(onRoleFixed.mock.calls).toEqual([["execution"], ["bug"]]);

  onRoleFixed.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "修正表头类型" }));
  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  expect(onRoleFixed.mock.calls).toEqual([["execution"]]);
});

it("does not retire a role's verdict when the header run is refused", async () => {
  const plan: ProvisionPlan = {
    roles: { execution: [{ name: "结果", type: 1, type_name: "text", properties: {} }], bug: [] }
  };
  const provision = vi.fn().mockRejectedValue(new Error("创建表头失败：没有权限"));
  const onRoleFixed = vi.fn();
  render(props({ plan, provision, onRoleFixed }));

  await screen.findByText(/缺少 1 个表头/);
  await userEvent.click(screen.getByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText("创建表头失败：没有权限")).toBeVisible();
  // Nothing changed, so the verdict the table already had still stands.
  expect(onRoleFixed).not.toHaveBeenCalled();
});

it("re-reads the plan after a run, so a fixed header stops being offered", async () => {
  const plan: ProvisionPlan = {
    roles: { execution: [{ name: "结果", type: 1, type_name: "text", properties: {} }], bug: [] }
  };
  const loadPlan = vi.fn().mockResolvedValueOnce(plan).mockResolvedValue(COMPLETE);
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [] });
  render(props({ loadPlan, provision }));

  expect(await screen.findByText(/缺少 1 个表头/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // The plan is read again after the run: a header that is really there may not
  // stay on the list of what is missing.
  expect(await screen.findByText("表头完整")).toBeVisible();
  expect(screen.queryByRole("button", { name: "设置表头" })).not.toBeInTheDocument();
  expect(loadPlan).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 16: 跑，确认 `StepHeaders.test.tsx` 全绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepHeaders.test.tsx`

期望输出：

```
 ✓ src/components/lark/StepHeaders.test.tsx (6 tests)

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

- [ ] **Step 17: 最小替换 `LarkCheck.tsx`**

改动只有两处。

第一处，`frontend/src/views/LarkCheck.tsx:30`：

```ts
import { HeaderSetup } from "../components/HeaderSetup";
```

换成：

```ts
import { StepHeaders } from "../components/lark/StepHeaders";
```

第二处，`frontend/src/views/LarkCheck.tsx:703-722` 的 `<HeaderSetup … />` 整段换成 `<StepHeaders … />`：

```tsx
        {target && loadPlan && provision ? (
          <StepHeaders
            groupId={groupId}
            target={target}
            busy={busy}
            provision={provision}
            retype={retype}
            createTable={createTable}
            rebuild={rebuild}
            loadPlan={loadPlan}
            resetKey={`${groupId}|${target.target_fingerprint}`}
            targetFingerprint={target.target_fingerprint}
            schemaFingerprint={target.schema_fingerprint}
            bases={{ execution: executionBaseToken, bug: bugBaseToken }}
            tableNames={{
              execution: target.execution_table_name,
              bug: target.bug_table_name
            }}
            onChanged={reloadAfterProvision}
            // Task 6 把它接给 `useLarkDraft` 的「作废该 role 的 probe + 重校验」。
            // 本 task 只做最小替换，页面还没有 draft，所以这里是空实现：回调的
            // 契约由 StepHeaders.test.tsx 的三条用例钉住，接线归 Task 6。
            onRoleFixed={() => {}}
            onTableCreated={acceptCreatedTable}
            onTableRebuilt={acceptRebuiltTable}
          />
        ) : null}
```

**这里没有 `plan` / `planError` 可传**（契约收口）：`StepHeaders` 自己用 `loadPlan` 读 plan，页面零新增 state——与旧 `HeaderSetup` 的行为完全一致（旧组件也是自己读，`HeaderSetup.tsx:210-241`）。

- [ ] **Step 18: 跑页面测试，确认它还是绿的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/LarkCheck.test.tsx`

期望输出：

```
 ✓ src/views/LarkCheck.test.tsx (39 tests)

 Test Files  1 passed (1)
      Tests  39 passed (39)
```

**这一步就是「最小替换」的验收**：`LarkCheck.test.tsx` 一个字不改也必须全绿。若某条红在「设置表头 / 新建缺陷记录数据表 / 重建数据表（表头修正）」上，说明 `StepHeaders` 的入口或显隐条件与旧 `HeaderSetup` 不一致——**改组件，不许改这个测试文件**。

- [ ] **Step 19: 删除 `HeaderSetup.tsx` 与它的测试**

```bash
cd /home/lucascool/qa-board && git rm frontend/src/components/HeaderSetup.tsx frontend/src/components/HeaderSetup.test.tsx
```

期望输出：

```
rm 'frontend/src/components/HeaderSetup.tsx'
rm 'frontend/src/components/HeaderSetup.test.tsx'
```

- [ ] **Step 20: 跑全套前端测试（含类型门）**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run`

期望输出（尾部）：

```
 Test Files  24 passed (24)
      Tests  269 passed (269)
```

计数以本机实际为准；**判据是 `0 failed`，且 `src/components/HeaderSetup.test.tsx` 不再出现在列表里**。新列表里必须能看到四个新文件。

Run: `cd /home/lucascool/qa-board/frontend && npm run build`

期望输出：

```
> tsc -b && vite build
vite v7.1.7 building for production...
✓ 214 modules transformed.
dist/assets/index-########.js   ####.## kB │ gzip: ###.## kB
✓ built in 1.4s
```

（`vite` 版本号与模块数按本机实际为准；**判据是末行 `✓ built in`**，且 `tsc -b` 没有输出任何错误行。）

`tsc -b` 最可能报的三处，按下面的写法收口：

1. `ProvisionDialog.tsx` 的 `ROLES` 与 `StepHeaders.tsx` 的 `ROLES` 各导出一份会冲突——`StepHeaders.tsx` 里 `export const ROLES` 保留，`ProvisionDialog.tsx` / `RetypeDialog.tsx` / `RebuildDialog.tsx` 各自 `const ROLES` 不导出（模块私有，不构成冲突）。
2. `RetypeDialog.tsx` 从 `./ProvisionDialog` import `refusalOf`：把它在 `ProvisionDialog.tsx` 里改成 `export function refusalOf(...)`（上面的代码块里是 `function`，落地时必须带 `export`）。
3. `RebuildDialog.tsx` 从 `./StepHeaders` import `ROLE_LABELS` / `messageOf` / `rebuiltNameOf`；`RetypeDialog.tsx` 与 `ProvisionDialog.tsx` 也各自从 `./StepHeaders` import `ROLE_LABELS` / `messageOf`——这三个符号在 `StepHeaders.tsx` 里都是 `export`（上面的代码块已如此），循环引用是 `StepHeaders → 三个对话框 → StepHeaders`，ESM 下函数声明与 `const` 常量的初始化顺序在本例中安全（`ROLE_LABELS` 等只在组件渲染时才被读取，模块求值阶段不读）。**若 `tsc` 或运行时报 `Cannot access 'ROLE_LABELS' before initialization`，把这三个常量与 `rebuiltNameOf` / `messageOf` 抽到 `frontend/src/components/lark/headerCopy.ts` 再从四个文件 import**——这是唯一需要新文件时的退路，别改成别的形状。

- [ ] **Step 21: 提交（删除与新增同一个 commit）**

```bash
cd /home/lucascool/qa-board && git add -A frontend/src/components/lark frontend/src/views/LarkCheck.tsx frontend/src/components/HeaderSetup.tsx frontend/src/components/HeaderSetup.test.tsx && git commit -m "refactor(lark): split the destructive header dialogs out of HeaderSetup

HeaderSetup.tsx carried three unrelated destructive actions (provision,
retype, rebuild), their confirmations and their focus traps in one 946-line
component, which made the check page's second step unreadable and untestable.
Each action now has its own dialog with its own test file, StepHeaders keeps
the plan read and the three entries, and HeaderSetup is deleted.

The safety copy is unchanged: every sentence about what will be created, not
modified, not deleted, and re-confirmed after the run is carried over
verbatim. LarkCheck.tsx only swaps the component; the page rewrite is Task 6."
```

期望输出：

```
 create mode 100644 frontend/src/components/lark/ProvisionDialog.tsx
 create mode 100644 frontend/src/components/lark/ProvisionDialog.test.tsx
 create mode 100644 frontend/src/components/lark/RebuildDialog.tsx
 create mode 100644 frontend/src/components/lark/RebuildDialog.test.tsx
 create mode 100644 frontend/src/components/lark/RetypeDialog.tsx
 create mode 100644 frontend/src/components/lark/RetypeDialog.test.tsx
 create mode 100644 frontend/src/components/lark/StepHeaders.tsx
 create mode 100644 frontend/src/components/lark/StepHeaders.test.tsx
 delete mode 100644 frontend/src/components/HeaderSetup.tsx
 delete mode 100644 frontend/src/components/HeaderSetup.test.tsx
```

`HeaderSetup.tsx` 的删除**必须**在这个 commit 里（分两个 commit 会让中间那个 commit 处于「测试引用了被删文件」的状态）。`git status --short` 在提交后必须为空。

---

**给执行者的四条硬提醒**

1. **不要顺手动 `styles.css`。** 本 task 全用旧类名（`header-setup-overlay` / `header-setup-dialog` / `lark-provision*` / `lark-new-table*`），样式已存在（`styles.css:161,176-198,221`）。Task 7 才清理死样式。
2. **不要动 `LarkCheck.tsx` 里第 ①③④ 步的任何代码。** 第 17 步那两处之外的每一行都是 Task 6 的活——**Task 6 会整体重写该页面**，本 task 不做预告式重构。
3. **`StepHeaders` 的 plan 只有一条路：`loadPlan`（必填）。** 不要再给组件加 `plan` / `planError` 两个 props——骨架原稿那样写会让 `if (!loadPlan || plan !== null) return` 在 `plan === undefined` 时恒真，第 ② 步永远停在「正在读取表头…」，三个破坏性入口一个都不出现。组件内部的 `plan` / `planError` 是 state，不是 props。
4. **`onRoleFixed` 是必填且必须真的被调用。** 它是规格 §8 唯一的执行者：provision / retype 成功改了表之后，页面的 `useLarkDraft` 靠它作废该 role 的 probe 并重跑校验。**第 17 步在页面里先接空实现**（页面此刻还没有 draft），Task 6 换成 hook 的作废动作；但**组件侧不许省**，StepHeaders.test.tsx 的三条用例钉住它。
> Round 1 复审补丁：B7（bad/unreadable 重新校验入口）+ E2（role=status/aria-busy）已并入本分段（2026-09-18）

### Task 5: 五个展示（哑）组件 + 单测

本 task 交付第 ①③④ 步的界面与步骤外壳：`StepSection` / `LarkHealthStrip` / `StepTables` / `StepApprove` / `StepSync`。五个组件**全是哑的**：不持有 state、不发请求、不 import `api`，只把 props 画出来并把点击回传。判决一律来自调用方给的 `draft`，组件不重算、不缓存、不借别的表的结论。**覆盖验收门 2、3 的组件层，以及门 4 的组件层**（门 1 的组件层由「切下拉」那一条用例兜住；门 6 在 Task 4；门 5 的自动展开在 Task 6 由 `describeHealth(...).step` 驱动）。另含 Round 1 复审的两条补丁：**B7**（`bad` / `unreadable` 也保留手动「重新校验」入口，`loading` 时不渲染它）与 **E2**（状态条 `role="status"` + `aria-live="polite"`，校验区 `aria-busy="true"`）。

**Files:**
- Create `frontend/src/components/lark/StepSection.tsx` —— 步骤外壳
- Test `frontend/src/components/lark/StepSection.test.tsx` —— 3 个用例
- Create `frontend/src/components/lark/LarkHealthStrip.tsx` —— 状态条（一行）
- Test `frontend/src/components/lark/LarkHealthStrip.test.tsx` —— 3 个用例
- Create `frontend/src/components/lark/StepTables.tsx` —— 第 ① 步
- Test `frontend/src/components/lark/StepTables.test.tsx` —— 7 个用例（门 2、门 3、B7 的手动重新校验）
- Create `frontend/src/components/lark/StepApprove.tsx` —— 第 ③ 步
- Test `frontend/src/components/lark/StepApprove.test.tsx` —— 4 个用例
- Create `frontend/src/components/lark/StepSync.tsx` —— 第 ④ 步
- Test `frontend/src/components/lark/StepSync.test.tsx` —— 6 个用例（门 4）
- Modify `frontend/src/styles.css:126-127` —— 在 lark 段里（`.lark-roles` 之后、`.reconcile-layout` 之前）新增 `.lark-step*` / `.lark-health-*` / `.lark-role*` / `.lark-verdict` / `.lark-approve`，含一个 `@media (max-width: 420px)` 块；**只增不删**（死规则留给 Task 7）

**Interfaces:**

**Consumes**（全部已存在；本 task 不改它们的签名、行为或名字）

```ts
// frontend/src/larkDraft.ts —— 类型名与函数名逐字照抄，不许改名、不许重新定义
export type Probe = { fields: Record<string, string>; required: string[]; schema_errors: string[]; read_error?: string };
export type ProbeSlot = Probe | "loading";
export type LarkBase = {
  base_token: string; base_name: string; source_url: string;
  tables: Table[]; read_errors: string[]; probes: Record<string, ProbeSlot>;   // key = `${table_id}:${role}`
};
export type RoleDraft = { url: string; base: LarkBase | null; tableId: string; viewId: string | null };
export type Draft = { execution: RoleDraft; bug: RoleDraft };
export type Verdict = "unread" | "loading" | "ok" | "bad" | "unreadable";
export type StepId = "tables" | "headers" | "approve" | "sync";
export type Health = { tone: "ok" | "warn" | "bad"; text: string; step: StepId | null };

verdictOf(slot: ProbeSlot | undefined): Verdict;
baseIsCurrent(role: RoleDraft): boolean;
effectiveBase(draft: Draft, role: TableRole): LarkBase | null;
probeFor(draft: Draft, role: TableRole): ProbeSlot | undefined;

// frontend/src/api.ts:140 / :173 / :310
export type LarkTarget = { /* 15 个字段，见 api.ts */ };
export type Table = { table_id: string; name: string };
export type TableRole = "execution" | "bug";
export type SyncStatus = {
  confirmed: boolean; queued: number; synced: number; failed: number; uncertain: number;
  parked?: number; last_error_kind: string | null; last_error?: string | null;
  pending_attempts: number; detail: string;
};
```

两条**实现前的约定**（写代码前先读，不然会写出「看起来对但门 3 破」的东西）：

1. **probe 的 key 是字面量契约**：`${table_id}:${role}`。测试 fixture 里手写 `"tbl-bugs:bug"` 这样的字符串（不用 `probeKey()` 生成），这样 key 格式错了测试就会红。
2. **`effectiveBase(draft, "bug")` 在「缺陷库链接框非空但未读取」时返回 `null`**（解读见 `task-02-03-draft.md` 第 117 行 + 规格 §4.2）。所以那一格不是「回落到执行库」，而是「没有可列的表」——`StepTables` 因此只渲染一行说明，不渲染空下拉：空下拉会让人以为缺陷表在执行库里，那是第二个谎。若 `StepTables` 的用例红了而代码看起来没问题，先回去看 `effectiveBase`。

**Produces**（骨架 §Interfaces 逐字：名字、字段、顺序都不许动）

```ts
// components/lark/StepSection.tsx
type StepSectionProps = {
  index: number;                                   // 1..4
  title: string;
  summary: string;                                 // 收起时那一行
  state: "done" | "open" | "todo" | "attention";
  disabled?: boolean;
  onOpen: () => void;
  children?: ReactNode;
};

// components/lark/LarkHealthStrip.tsx
type LarkHealthStripProps = { health: Health; onJump: (step: StepId) => void };

// components/lark/StepTables.tsx
type StepTablesProps = {
  draft: Draft;
  target: LarkTarget | null;
  reading: TableRole | null;
  checking: TableRole | null;
  saving: boolean;
  onLinkChange: (role: TableRole, url: string) => void;
  onRead: (role: TableRole) => void;
  onTableChange: (role: TableRole, tableId: string) => void;
  onCheck: (role: TableRole) => void;
  onSave: () => void;
};

// components/lark/StepApprove.tsx
type StepApproveProps = {
  target: LarkTarget | null;
  confirmed: boolean;
  invalidated: boolean;
  blocked: boolean;
  allowWrites: boolean;
  busy: boolean;
  onAllowWrites: (value: boolean) => void;
  onConfirm: () => void;
};

// components/lark/StepSync.tsx
type StepSyncProps = {
  sync: SyncStatus | null;
  confirmed: boolean;
  queueing: boolean;
  retrying: boolean;
  onEnqueue: () => void;
  onRetry: (releaseUncertain: boolean) => void;
};
```

**verdict 文案表（第 ① 步的就地判决，`verdictOf(probeFor(draft, role))` 的五个分支）**

| verdict | 渲染 | 类名 / role |
|---|---|---|
| `unread` | 「尚未校验这张表」+ 按钮「校验」 | `inline-status` / `status` |
| `loading` | 「正在校验这张表…」+ 转圈；该表下拉 `disabled`，判决区 `aria-busy="true"`；**不渲染校验按钮** | `inline-status` / `status` |
| `bad` | `执行记录表：缺少必填字段「截图」`（该表 probe 的 `schema_errors` 用 `；` 连接）+ 按钮「重新校验」 | `inline-status error` / `alert` |
| `unreadable` | `执行记录表读取失败：应用不是该多维表格的协作者`（该表 probe 的 `read_error`）+ 按钮「重新校验」 | `inline-status error` / `alert` |
| `ok` | 「执行记录表表头完整」 | `inline-status saved` / `status` |

`label` 是「执行记录表」或「缺陷记录表」：把表名写进判决行，是为了让「红字在说哪张表」不靠位置猜。

**手动刷新入口不是 `unread` 的专利（B7）**：`unread` / `bad` / `unreadable` 三种 verdict 都要渲染那个按钮（`unread` 时写「校验」，另外两种写「重新校验」），`loading` 时不渲染。理由是 `bad` 不是终态：表头可能在另一条路径（第 ② 步的 `provision` / `retype` / `rebuild`）被修好，而 probe 是缓存 —— 没有手动入口的话，管理员只能去改链接框再读一次，或者刷新整页。文案沿用规格 §8 与 §5.1 里的「校验」一词 + 旧页面已有的「重新…」动作词（`LarkCheck.tsx:556-564` 的「刷新」按钮），不发明新词。

- [ ] **Step 1: 写失败的测试（`StepSection.test.tsx`，完整文件）**

新建 `frontend/src/components/lark/StepSection.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StepSection } from "./StepSection";

describe("StepSection", () => {
  it("collapses to the title row plus the summary", () => {
    const { container } = render(
      <StepSection index={1} title="选表" summary="两张表都已校验" state="todo" onOpen={vi.fn()}>
        <p>展开后才有</p>
      </StepSection>
    );

    const title = screen.getByRole("button", { name: /选表/ });
    expect(title).toHaveTextContent("第 1 步");
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("两张表都已校验")).toBeInTheDocument();
    expect(screen.queryByText("展开后才有")).toBeNull();
    expect(container.querySelector(".lark-step-body")).toBeNull();
  });

  it("renders the body and drops the summary while open", () => {
    render(
      <StepSection index={2} title="表头" summary="缺 2 列" state="open" onOpen={vi.fn()}>
        <p>展开后才有</p>
      </StepSection>
    );

    expect(screen.getByRole("button", { name: /表头/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("展开后才有")).toBeInTheDocument();
    expect(screen.queryByText("缺 2 列")).toBeNull();
  });

  it("gives a disabled step a title nobody can open", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <StepSection index={3} title="确认写入" summary="未确认" state="todo" disabled onOpen={onOpen}>
        <p>展开后才有</p>
      </StepSection>
    );

    const title = screen.getByRole("button", { name: /确认写入/ });
    expect(title).toBeDisabled();
    await user.click(title);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepSection.test.tsx`
期望输出（关键几行）：

```
 FAIL  src/components/lark/StepSection.test.tsx [ src/components/lark/StepSection.test.tsx ]
Error: Failed to resolve import "./StepSection" from "src/components/lark/StepSection.test.tsx". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

这是**解析失败的红**（文件还不存在），不是断言失败的红 —— 下一步写出组件后重跑必须变绿。

- [ ] **Step 3: 实现 —— `StepSection.tsx`（完整文件）**

```tsx
import type { ReactNode } from "react";

type StepSectionProps = {
  index: number;                                   // 1..4
  title: string;
  summary: string;                                 // 收起时那一行
  state: "done" | "open" | "todo" | "attention";
  disabled?: boolean;
  onOpen: () => void;
  children?: ReactNode;
};

// 收起时只留「标题行 + summary」：那一行是给不展开的眼睛看的，展开后它就是重复信息。
export function StepSection({
  index,
  title,
  summary,
  state,
  disabled = false,
  onOpen,
  children
}: StepSectionProps) {
  const open = state === "open";
  return (
    <section className={`lark-step lark-step-${state}`} data-state={state}>
      <h3 className="lark-step-heading">
        <button
          type="button"
          className="lark-step-title"
          disabled={disabled}
          aria-expanded={open}
          onClick={onOpen}
        >
          <span className="lark-step-index">第 {index} 步</span>{" "}
          {title}
        </button>
        {open ? null : <span className="lark-step-summary">{summary}</span>}
      </h3>
      {open ? <div className="lark-step-body">{children}</div> : null}
    </section>
  );
}
```

- [ ] **Step 4: 跑，期望变绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepSection.test.tsx`
期望输出：`Test Files  1 passed (1)` / `Tests  3 passed (3)`

- [ ] **Step 5: 写失败的测试（`LarkHealthStrip.test.tsx`，完整文件）**

新建 `frontend/src/components/lark/LarkHealthStrip.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Health } from "../../larkDraft";
import { LarkHealthStrip } from "./LarkHealthStrip";

const HEALTHY: Health = {
  tone: "ok",
  text: "已确认 · 执行记录 / 缺陷记录 · 待同步 0 · 失败 0",
  step: null
};

describe("LarkHealthStrip", () => {
  it("is exactly one line and not clickable when there is nowhere to jump", () => {
    const { container } = render(<LarkHealthStrip health={HEALTHY} onJump={vi.fn()} />);

    expect(container.children).toHaveLength(1);
    expect(screen.getByText(HEALTHY.text)).toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
    // E2：这一行是 live region，且健康态下没有任何 alert（门 4 的组件层）
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("jumps to the step the health names", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(
      <LarkHealthStrip
        health={{ tone: "bad", text: "已确认，但表头已失效（需重新校验）", step: "headers" }}
        onJump={onJump}
      />
    );

    await user.click(screen.getByRole("button", { name: "已确认，但表头已失效（需重新校验）" }));
    expect(onJump).toHaveBeenCalledWith("headers");
  });

  it("carries the tone on the element so the colour never comes from the text", () => {
    const { container } = render(
      <LarkHealthStrip health={{ tone: "warn", text: "待管理员处理 2 条", step: "sync" }} onJump={vi.fn()} />
    );

    const strip = container.querySelector(".lark-health-strip");
    expect(strip).toHaveAttribute("data-tone", "warn");
    expect(strip).toHaveClass("warn");
  });
});
```

- [ ] **Step 6: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/LarkHealthStrip.test.tsx`
期望输出：`Error: Failed to resolve import "./LarkHealthStrip" ...` + `Test Files  1 failed (1)` / `Tests  no tests`

- [ ] **Step 7: 实现 —— `LarkHealthStrip.tsx`（完整文件）**

```tsx
import type { Health, StepId } from "../../larkDraft";

type LarkHealthStripProps = { health: Health; onJump: (step: StepId) => void };

// 常驻一行。tone 只决定颜色，step 决定「点它去哪儿」；
// step === null（健康态）时它是纯文本 —— 没有可跳的目标就不该长成一个按钮。
// E2：这一行会随 sync / live 变化，所以它是 live region（role="status" 就是
// aria-live="polite" + aria-atomic 的语义），与改造前 LarkCheck.tsx:608 的
// role="status" 实践一致；tone 是 bad 也仍然是 status —— 门 4 要的是健康态
// 没有 role="alert"，不是禁止播报。
export function LarkHealthStrip({ health, onJump }: LarkHealthStripProps) {
  const step = health.step;
  return (
    <p
      className={`inline-status lark-health-strip ${health.tone}`}
      data-tone={health.tone}
      role="status"
      aria-live="polite"
    >
      {step === null ? (
        health.text
      ) : (
        <button type="button" className="lark-health-jump" onClick={() => onJump(step)}>
          {health.text}
        </button>
      )}
    </p>
  );
}
```

- [ ] **Step 8: 跑，期望变绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/LarkHealthStrip.test.tsx`
期望输出：`Test Files  1 passed (1)` / `Tests  3 passed (3)`

- [ ] **Step 9: 写失败的测试（`StepTables.test.tsx`，完整文件）**

新建 `frontend/src/components/lark/StepTables.test.tsx`。fixture 里的 probe key 手写成 `"表id:角色"` 字面量，**不用 `probeKey()`** —— 这样 key 变了测试就会红：

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { LarkTarget, TableRole } from "../../api";
import type { Draft, LarkBase, Probe } from "../../larkDraft";
import { StepTables } from "./StepTables";

const TARGET: LarkTarget = {
  group_id: "grp-1",
  source_url: "https://example.larksuite.com/base/app-exec",
  execution_base_token: "app-exec",
  execution_base_name: "执行库",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-exec",
  bug_base_name: "执行库",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: null,
  target_fingerprint: "fp-1",
  confirmed_at: null,
  confirmed: false
};

function probe(overrides: Partial<Probe> = {}): Probe {
  return { fields: {}, required: [], schema_errors: [], ...overrides };
}

// 同一张 tbl-bugs 既是执行表也是缺陷表：两套 required 各自成立，key 里的 role 就是隔断。
const EXECUTION_BASE: LarkBase = {
  base_token: "app-exec",
  base_name: "执行库",
  source_url: TARGET.source_url,
  tables: [
    { table_id: "tbl-runs", name: "执行记录" },
    { table_id: "tbl-bugs", name: "缺陷记录" },
    { table_id: "tbl-new", name: "新表" }
  ],
  read_errors: [],
  probes: {
    "tbl-runs:execution": probe({ schema_errors: ["缺少必填字段「截图」"] }),
    "tbl-bugs:execution": probe(),
    "tbl-bugs:bug": probe({ schema_errors: ["缺少必填字段「缺陷描述」"] })
  }
};

function draftWith(overrides: {
  executionTableId: string;
  bugTableId?: string;
  bugUrl?: string;
  probes?: LarkBase["probes"];
  executionBase?: LarkBase | null;
}): Draft {
  const base = overrides.executionBase === undefined ? EXECUTION_BASE : overrides.executionBase;
  const probes = overrides.probes ?? base?.probes ?? {};
  return {
    execution: {
      url: TARGET.source_url,
      base: base ? { ...base, probes } : null,
      tableId: overrides.executionTableId,
      viewId: null
    },
    bug: { url: overrides.bugUrl ?? "", base: null, tableId: overrides.bugTableId ?? "tbl-bugs", viewId: null }
  };
}

// 下拉真的会切：让 draft 跟着 onTableChange / onLinkChange 动。
function Harness({
  initial,
  onCheck = vi.fn(),
  onSave = vi.fn()
}: {
  initial: Draft;
  onCheck?: (role: TableRole) => void;
  onSave?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <StepTables
      draft={draft}
      target={TARGET}
      reading={null}
      checking={null}
      saving={false}
      onLinkChange={(role, url) =>
        setDraft((current) =>
          role === "execution"
            ? { ...current, execution: { ...current.execution, url } }
            : { ...current, bug: { ...current.bug, url } }
        )
      }
      onRead={vi.fn()}
      onTableChange={(role, tableId) =>
        setDraft((current) =>
          role === "execution"
            ? { ...current, execution: { ...current.execution, tableId } }
            : { ...current, bug: { ...current.bug, tableId } }
        )
      }
      onCheck={onCheck}
      onSave={onSave}
    />
  );
}

function block(container: HTMLElement, role: TableRole): HTMLElement {
  return container.querySelector(`.lark-role[data-role='${role}']`) as HTMLElement;
}

function redLines(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".inline-status.error"));
}

describe("StepTables", () => {
  it("describes only the table the select currently names (门 2)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Harness
        initial={draftWith({
          executionTableId: "tbl-runs",
          probes: { ...EXECUTION_BASE.probes, "tbl-bugs:bug": probe() }
        })}
      />
    );

    expect(redLines(container)).toHaveLength(1);
    expect(redLines(container)[0]).toHaveTextContent("执行记录表：缺少必填字段「截图」");

    await user.selectOptions(screen.getByLabelText("执行记录表"), "tbl-bugs");

    expect(redLines(container)).toHaveLength(0);
    expect(block(container, "execution").querySelector('[data-verdict="ok"]')).not.toBeNull();
    expect(container.textContent).not.toContain("缺少必填字段「截图」");
  });

  it("keeps two verdicts apart even when both roles point at the same table (门 2)", () => {
    const { container } = render(<Harness initial={draftWith({ executionTableId: "tbl-runs" })} />);

    expect(block(container, "execution")).toHaveTextContent("执行记录表：缺少必填字段「截图」");
    expect(block(container, "execution")).not.toHaveTextContent("缺陷描述");
    expect(block(container, "bug")).toHaveTextContent("缺陷记录表：缺少必填字段「缺陷描述」");
    expect(block(container, "bug")).not.toHaveTextContent("截图");
  });

  it("calls an unchecked table unread instead of borrowing the other one's verdict (门 3)", async () => {
    const user = userEvent.setup();
    const onCheck = vi.fn();
    const { container } = render(
      <Harness initial={draftWith({ executionTableId: "tbl-new" })} onCheck={onCheck} />
    );

    expect(within(block(container, "execution")).getByText("尚未校验这张表")).toBeInTheDocument();
    expect(block(container, "execution").querySelectorAll(".inline-status.error")).toHaveLength(0);
    // 同一页上另一张表有自己的红字：它一个字都不许跑到这张表头上
    expect(redLines(container)).toHaveLength(1);
    expect(redLines(container)[0]).toHaveTextContent("缺陷描述");

    await user.click(within(block(container, "execution")).getByRole("button", { name: "校验" }));
    expect(onCheck).toHaveBeenCalledWith("execution");
  });

  it("renders loading and unreadable as their own states, never as a missing-column line", () => {
    const loading = render(
      <Harness initial={draftWith({ executionTableId: "tbl-runs", probes: { "tbl-runs:execution": "loading" } })} />
    );
    expect(loading.container.querySelector('[data-verdict="loading"]')).toHaveTextContent("正在校验这张表…");
    expect(screen.getByLabelText("执行记录表")).toBeDisabled();
    loading.unmount();

    const unreadable = render(
      <Harness
        initial={draftWith({
          executionTableId: "tbl-runs",
          probes: { "tbl-runs:execution": probe({ read_error: "应用不是该多维表格的协作者" }) }
        })}
      />
    );
    const line = unreadable.container.querySelector('[data-verdict="unreadable"]') as HTMLElement;
    expect(line).toHaveTextContent("执行记录表读取失败：应用不是该多维表格的协作者");
    expect(within(line).getByRole("button", { name: "重新校验" })).toBeInTheDocument();
  });

  it("turns an unread defect link into one note where the select would be (门 3)", () => {
    const { container } = render(
      <Harness
        initial={draftWith({
          executionTableId: "tbl-runs",
          bugUrl: "https://example.larksuite.com/base/app-bugs",
          probes: { "tbl-runs:execution": probe() }
        })}
      />
    );

    const notes = container.querySelectorAll(".lark-role-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("这段缺陷库链接尚未读取");
    expect(notes[0]).not.toHaveAttribute("role");
    expect(screen.queryByLabelText("缺陷记录表")).toBeNull();
    expect(redLines(container)).toHaveLength(0);
  });

  it("falls back to the execution base while the defect box is empty, and saves the selection", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { unmount } = render(
      <Harness initial={draftWith({ executionTableId: "tbl-bugs" })} onSave={onSave} />
    );

    expect(screen.getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");
    const save = screen.getByRole("button", { name: "保存选择" });
    expect(save).toHaveAttribute("title", "当前已保存：执行记录 / 缺陷记录");
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    unmount();

    render(<Harness initial={draftWith({ executionTableId: "", executionBase: null })} />);
    expect(screen.getByRole("button", { name: "保存选择" })).toBeDisabled();
  });

  it("offers the manual re-check while a table is bad, and withholds it while loading (B7)", async () => {
    const user = userEvent.setup();
    const onCheck = vi.fn();
    const { container, unmount } = render(
      <Harness initial={draftWith({ executionTableId: "tbl-runs" })} onCheck={onCheck} />
    );

    // 表头在别处（第 ② 步的 provision / retype / rebuild）被修好后，判决必须能手动刷新：
    // bad 不是终态，所以「重新校验」在这里必须在。
    const executionBlock = block(container, "execution");
    expect(executionBlock.querySelector('[data-verdict="bad"]')).not.toBeNull();
    await user.click(within(executionBlock).getByRole("button", { name: "重新校验" }));
    expect(onCheck).toHaveBeenCalledWith("execution");
    unmount();

    // 校验在飞的时候没有第二个入口：只有 loading 行与 aria-busy
    const loading = render(
      <Harness initial={draftWith({ executionTableId: "tbl-runs", probes: { "tbl-runs:execution": "loading" } })} />
    );
    const loadingLine = loading.container.querySelector('[data-verdict="loading"]') as HTMLElement;
    expect(loadingLine).toHaveAttribute("aria-busy", "true");
    expect(within(loadingLine).queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 10: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepTables.test.tsx`
期望输出：`Error: Failed to resolve import "./StepTables" ...` + `Test Files  1 failed (1)` / `Tests  no tests`

- [ ] **Step 11: 实现 —— `StepTables.tsx`（完整文件）**

```tsx
import { LoaderCircle } from "lucide-react";

import type { LarkTarget, Table, TableRole } from "../../api";
import {
  baseIsCurrent,
  effectiveBase,
  probeFor,
  verdictOf,
  type Draft,
  type LarkBase,
  type ProbeSlot,
  type Verdict
} from "../../larkDraft";

type StepTablesProps = {
  draft: Draft;
  target: LarkTarget | null;
  reading: TableRole | null;
  checking: TableRole | null;
  saving: boolean;
  onLinkChange: (role: TableRole, url: string) => void;
  onRead: (role: TableRole) => void;
  onTableChange: (role: TableRole, tableId: string) => void;
  onCheck: (role: TableRole) => void;
  onSave: () => void;
};

const EXECUTION_LABEL = "执行记录表";
const BUG_LABEL = "缺陷记录表";
// 缺陷库链接非空但未读取时，整页只有这一行说明：它不冒充判决，也不做成全局红字。
const UNREAD_BUG_LINK_NOTE =
  "这段缺陷库链接尚未读取：缺陷记录表先不列出（它指向的是另一个多维表格），请按「读取缺陷表」使用它。";

// 下拉只列这个 base 里的表。当前选中的 id 不在这个库里时，用 id 本身当标签
// （名字只对「本页读过的表」才存在），决不悄悄换成另一张表 —— 那会让下拉与
// 调用方构造的 payload 指向不同的表。
function optionsFor(base: LarkBase, tableId: string): Table[] {
  if (tableId === "" || base.tables.some((table) => table.table_id === tableId)) return base.tables;
  return [{ table_id: tableId, name: tableId }, ...base.tables];
}

// 判决只从这一张表自己的 probe 派生：verdictOf(probeFor(draft, role))。
// 不读 draft[role].base 之外的任何东西，也不接受「另一张表的结论」当参数。
function verdictLine(props: {
  role: TableRole;
  label: string;
  slot: ProbeSlot | undefined;
  checking: boolean;
  onCheck: (role: TableRole) => void;
}) {
  const { role, label, slot, checking, onCheck } = props;
  const verdict: Verdict = verdictOf(slot);
  const probe = slot !== undefined && slot !== "loading" ? slot : null;
  const detail = probe?.read_error ?? probe?.schema_errors.join("；") ?? "";
  // bad/unreadable 不是终态：表头可能被第 ② 步的 provision / retype / rebuild 修好，
  // 而 probe 是缓存 —— 所以这三种 verdict 都留一个手动刷新的口子，loading 时不留。
  const retryable = verdict === "unread" || verdict === "bad" || verdict === "unreadable";
  return (
    <div
      className="lark-verdict"
      data-verdict={verdict}
      aria-busy={verdict === "loading" ? true : undefined}
    >
      {verdict === "loading" ? (
        <p className="inline-status" role="status">
          <LoaderCircle className="spin" size={16} />
          正在校验这张表…
        </p>
      ) : null}
      {verdict === "unread" ? (
        <p className="inline-status" role="status">尚未校验这张表</p>
      ) : null}
      {verdict === "unreadable" ? (
        <p className="inline-status error" role="alert">
          {label}读取失败：{detail || "原因未提供"}
        </p>
      ) : null}
      {verdict === "bad" ? (
        <p className="inline-status error" role="alert">
          {label}：{detail}
        </p>
      ) : null}
      {verdict === "ok" ? (
        <p className="inline-status saved" role="status">{label}表头完整</p>
      ) : null}
      {retryable ? (
        <button type="button" className="ghost-button" disabled={checking} onClick={() => onCheck(role)}>
          {verdict === "unread" ? "校验" : "重新校验"}
        </button>
      ) : null}
    </div>
  );
}

export function StepTables({
  draft,
  target,
  reading,
  checking,
  saving,
  onLinkChange,
  onRead,
  onTableChange,
  onCheck,
  onSave
}: StepTablesProps) {
  const executionBase = baseIsCurrent(draft.execution) ? draft.execution.base : null;
  // 缺陷库链接为空 = 与执行表同库；框里有未读取的链接 = 没有可列的表（不是回落）。
  const bugBase = effectiveBase(draft, "bug");
  const bugLink = draft.bug.url.trim();
  const executionSlot = probeFor(draft, "execution");
  const bugSlot = probeFor(draft, "bug");
  const executionOptions = executionBase ? optionsFor(executionBase, draft.execution.tableId) : [];
  const bugOptions = bugBase ? optionsFor(bugBase, draft.bug.tableId) : [];
  const saveDisabled =
    !executionBase || !bugBase || !draft.execution.tableId || !draft.bug.tableId || saving;
  const saveTitle = target
    ? `当前已保存：${target.execution_table_name} / ${target.bug_table_name}`
    : "本组尚未保存过 Lark 表";

  return (
    <div className="lark-step-tables">
      <div className="lark-role" data-role="execution">
        <label>
          Lark 文档链接
          <input
            value={draft.execution.url}
            placeholder="https://…/wiki/… 或 /base/…"
            onChange={(event) => onLinkChange("execution", event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={reading !== null || !draft.execution.url.trim()}
          onClick={() => onRead("execution")}
        >
          {reading === "execution" ? <LoaderCircle className="spin" size={16} /> : null}
          读取表格
        </button>
        {executionBase ? (
          <div className="lark-role-tables">
            <p className="inline-status saved" role="status">
              已读取「{executionBase.base_name}」的 {executionBase.tables.length} 张数据表
            </p>
            {executionBase.read_errors.map((item) => (
              <p key={item} className="inline-status error" role="alert">{item}</p>
            ))}
            {executionOptions.length > 0 ? (
              <label>
                执行记录表
                <select
                  aria-label="执行记录表"
                  value={draft.execution.tableId}
                  disabled={executionSlot === "loading"}
                  onChange={(event) => onTableChange("execution", event.target.value)}
                >
                  {executionOptions.map((table) => (
                    <option key={table.table_id} value={table.table_id}>{table.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {verdictLine({
              role: "execution",
              label: EXECUTION_LABEL,
              slot: executionSlot,
              checking: checking === "execution",
              onCheck
            })}
          </div>
        ) : null}
      </div>

      <div className="lark-role" data-role="bug">
        <label>
          缺陷库链接（可选，默认与执行表同一多维表格）
          <input
            value={draft.bug.url}
            placeholder="https://…/wiki/… 或 /base/…"
            onChange={(event) => onLinkChange("bug", event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={reading !== null || !bugLink}
          onClick={() => onRead("bug")}
        >
          {reading === "bug" ? <LoaderCircle className="spin" size={16} /> : null}
          读取缺陷表
        </button>
        {bugBase ? (
          <div className="lark-role-tables">
            {baseIsCurrent(draft.bug) ? (
              <p className="inline-status saved" role="status">
                已读取「{bugBase.base_name}」的 {bugBase.tables.length} 张数据表
              </p>
            ) : null}
            {baseIsCurrent(draft.bug)
              ? bugBase.read_errors.map((item) => (
                  <p key={item} className="inline-status error" role="alert">{item}</p>
                ))
              : null}
            {bugOptions.length > 0 ? (
              <label>
                缺陷记录表
                <select
                  aria-label="缺陷记录表"
                  value={draft.bug.tableId}
                  disabled={bugSlot === "loading"}
                  onChange={(event) => onTableChange("bug", event.target.value)}
                >
                  {bugOptions.map((table) => (
                    <option key={table.table_id} value={table.table_id}>{table.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {verdictLine({
              role: "bug",
              label: BUG_LABEL,
              slot: bugSlot,
              checking: checking === "bug",
              onCheck
            })}
          </div>
        ) : bugLink ? (
          <p className="lark-role-note">{UNREAD_BUG_LINK_NOTE}</p>
        ) : null}
      </div>

      <button type="button" className="primary" disabled={saveDisabled} title={saveTitle} onClick={onSave}>
        {saving ? <LoaderCircle className="spin" size={16} /> : null}
        保存选择
      </button>
    </div>
  );
}
```

不加 `export type StepTablesProps`：Task 6 只用组件，props 类型从 `Parameters<typeof StepTables>[0]` 拿；`LarkCheck.tsx` 不许再定义第二份同名类型。

- [ ] **Step 12: 跑，期望变绿（门 2、门 3 的组件层证据）**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepTables.test.tsx`
期望输出：`Test Files  1 passed (1)` / `Tests  7 passed (7)`

变绿后立刻做三次**变异自查**（改动—重跑—还原，不要提交变异版）：

1. 把 `verdictLine` 调用里的 `slot: executionSlot` 改成 `slot: bugSlot` → 第 2 个用例（`keeps two verdicts apart...`）必须变红。
2. 把 `effectiveBase(draft, "bug")` 换成 `draft.bug.base ?? draft.execution.base` → 第 5 个用例（`turns an unread defect link into one note...`）必须变红。
3. 把 `retryable` 里的 `|| verdict === "bad"` 删掉（= 复审说的「校验按钮只在 unread 时显示」那一版）→ 第 7 个用例（`offers the manual re-check while a table is bad... (B7)`）必须变红。

三条都红过，才说明这些用例真的在钉门 2 / 门 3 / B7。

- [ ] **Step 13: 写失败的测试（`StepApprove.test.tsx`，完整文件）**

新建 `frontend/src/components/lark/StepApprove.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { LarkTarget } from "../../api";
import { StepApprove } from "./StepApprove";

const TARGET: LarkTarget = {
  group_id: "grp-1",
  source_url: "https://example.larksuite.com/base/app-exec",
  execution_base_token: "app-exec",
  execution_base_name: "执行库",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-exec",
  bug_base_name: "执行库",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: null,
  target_fingerprint: "fp-1",
  confirmed_at: "2026-09-18T00:00:00Z",
  confirmed: true
};

// 勾选由 props 持有，所以这里必须有一个真的会变的 allowWrites，否则「勾选后按钮变可用」测不出来。
function renderApprove(overrides: Partial<Parameters<typeof StepApprove>[0]> = {}) {
  const onAllowWrites = vi.fn();
  const onConfirm = vi.fn();
  function Wrapper() {
    const [allowWrites, setAllowWrites] = useState(overrides.allowWrites ?? false);
    return (
      <StepApprove
        target={TARGET}
        confirmed
        invalidated={false}
        blocked={false}
        busy={false}
        {...overrides}
        allowWrites={allowWrites}
        onAllowWrites={(value) => {
          onAllowWrites(value);
          setAllowWrites(value);
        }}
        onConfirm={onConfirm}
      />
    );
  }
  const view = render(<Wrapper />);
  return { ...view, onAllowWrites, onConfirm };
}

const CONSENT = "允许向上述旧表新增本组记录";
const CONFIRM = "确认本组写入目标";

describe("StepApprove", () => {
  it("says what is confirmed and only arms the confirm button after the consent box", async () => {
    const user = userEvent.setup();
    const { onAllowWrites, onConfirm } = renderApprove();

    expect(screen.getByRole("status")).toHaveTextContent("已确认 执行记录 / 缺陷记录");
    expect(screen.getByRole("button", { name: CONFIRM })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: CONSENT }));
    expect(onAllowWrites).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: CONFIRM }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables both controls when the confirmation was invalidated", () => {
    renderApprove({ invalidated: true, blocked: true, allowWrites: true });

    expect(screen.getByRole("status")).toHaveTextContent("目标表字段已变化，此前的确认已失效，需要重新确认");
    expect(screen.getByRole("checkbox", { name: CONSENT })).toBeDisabled();
    expect(screen.getByRole("button", { name: CONFIRM })).toBeDisabled();
  });

  it("disables both controls while the target is blocked, and never calls it confirmed", () => {
    renderApprove({ confirmed: false, blocked: true, allowWrites: true });

    expect(screen.getByRole("status")).toHaveTextContent("尚未确认：本地结果不会写入 Lark");
    expect(screen.getByRole("checkbox", { name: CONSENT })).toBeDisabled();
    expect(screen.getByRole("button", { name: CONFIRM })).toBeDisabled();
  });

  it("shows the busy spinner and refuses a second confirm while one is in flight", () => {
    const { onConfirm } = renderApprove({ allowWrites: true, busy: true });

    const confirm = screen.getByRole("button", { name: CONFIRM });
    expect(confirm).toBeDisabled();
    expect(confirm.querySelector("svg")).not.toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 14: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepApprove.test.tsx`
期望输出：`Error: Failed to resolve import "./StepApprove" ...` + `Test Files  1 failed (1)` / `Tests  no tests`

- [ ] **Step 15: 实现 —— `StepApprove.tsx`（完整文件）**

```tsx
import { LoaderCircle, ShieldCheck, ShieldOff } from "lucide-react";

import type { LarkTarget } from "../../api";

type StepApproveProps = {
  target: LarkTarget | null;
  confirmed: boolean;
  invalidated: boolean;
  blocked: boolean;
  allowWrites: boolean;
  busy: boolean;
  onAllowWrites: (value: boolean) => void;
  onConfirm: () => void;
};

export function StepApprove({
  target,
  confirmed,
  invalidated,
  blocked,
  allowWrites,
  busy,
  onAllowWrites,
  onConfirm
}: StepApproveProps) {
  // 「能不能确认」只由调用方算好的这两个事实决定：这一步不重算 live，也不看 draft。
  const confirmable = !blocked && !invalidated;
  return (
    <div className="lark-approve">
      {confirmed && !invalidated ? (
        <p className="inline-status saved" role="status">
          <ShieldCheck size={16} />
          已确认 {target?.execution_table_name} / {target?.bug_table_name}
        </p>
      ) : (
        <p className="inline-status" role="status">
          <ShieldOff size={16} />
          {invalidated
            ? "目标表字段已变化，此前的确认已失效，需要重新确认"
            : "尚未确认：本地结果不会写入 Lark"}
        </p>
      )}
      <label className="lark-consent">
        <input
          type="checkbox"
          checked={allowWrites}
          disabled={!confirmable}
          onChange={(event) => onAllowWrites(event.target.checked)}
        />
        允许向上述旧表新增本组记录
      </label>
      <button
        type="button"
        className="primary"
        disabled={!allowWrites || !confirmable || busy}
        onClick={onConfirm}
      >
        {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
        确认本组写入目标
      </button>
    </div>
  );
}
```

- [ ] **Step 16: 跑，期望变绿**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepApprove.test.tsx`
期望输出：`Test Files  1 passed (1)` / `Tests  4 passed (4)`

- [ ] **Step 17: 写失败的测试（`StepSync.test.tsx`，完整文件）**

新建 `frontend/src/components/lark/StepSync.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SyncStatus } from "../../api";
import { StepSync } from "./StepSync";

function sync(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    confirmed: true,
    queued: 0,
    synced: 0,
    failed: 0,
    uncertain: 0,
    parked: 0,
    last_error_kind: null,
    last_error: null,
    pending_attempts: 0,
    detail: "",
    ...overrides
  };
}

function renderSync(overrides: Partial<Parameters<typeof StepSync>[0]> = {}) {
  const onEnqueue = vi.fn();
  const onRetry = vi.fn();
  const view = render(
    <StepSync
      sync={sync()}
      confirmed
      queueing={false}
      retrying={false}
      onEnqueue={onEnqueue}
      onRetry={onRetry}
      {...overrides}
    />
  );
  return { ...view, onEnqueue, onRetry };
}

describe("StepSync", () => {
  it("keeps the healthy state to one stats row and one button (门 4)", () => {
    const { container } = renderSync({ sync: sync({ queued: 2, synced: 5, pending_attempts: 3 }) });

    const stats = container.querySelector(".lark-queue > .inline-status") as HTMLElement;
    expect(stats).toHaveTextContent("待同步 2 · 已同步 5 · 失败 0 · 待人工确认 0 · 待管理员处理 0");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelectorAll(".attachment-hint")).toHaveLength(0);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // 降级不是删除：那句「同步只新增执行记录…」现在住在按钮的 title 里
    expect(screen.getByRole("button", { name: /排入同步/ }).getAttribute("title")).toContain(
      "同步只新增执行记录"
    );
  });

  it("enqueues saved results and retries failures with the counts in the label", async () => {
    const user = userEvent.setup();
    const { onEnqueue, onRetry } = renderSync({ sync: sync({ failed: 3, pending_attempts: 2 }) });

    await user.click(screen.getByRole("button", { name: /排入同步/ }));
    expect(onEnqueue).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /重试失败的同步（3 条）/ }));
    expect(onRetry).toHaveBeenCalledWith(false);
  });

  it("shows the parked explanation only while rows are actually parked", () => {
    const { container } = renderSync({ sync: sync({ parked: 2, pending_attempts: 1 }) });

    const hints = Array.from(container.querySelectorAll<HTMLElement>(".attachment-hint"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent("2 条记录正在等待管理员处理，不会自行同步");
    expect(screen.getByRole("button", { name: /重新指向当前目标表（2 条）/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /释放待人工确认/ })).toBeNull();
  });

  it("still speaks up for parked rows when the group is unconfirmed", () => {
    const { container } = renderSync({ sync: sync({ parked: 2 }), confirmed: false });

    expect(container.querySelector(".lark-queue")).toHaveTextContent("2 条记录正在等待管理员处理，不会自行同步");
    expect(container.querySelector(".lark-queue")).toHaveTextContent("本组目前尚未确认写入目标，这些记录不会同步。");
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("重新指向当前目标表（2 条）");
  });

  it("renders nothing when there is neither a confirmation nor a parked row", () => {
    const { container } = renderSync({ confirmed: false });

    expect(container.firstChild).toBeNull();
  });

  it("warns before releasing uncertain rows and shows last_error as an alert", async () => {
    const user = userEvent.setup();
    const { container, onRetry } = renderSync({
      sync: sync({
        failed: 1,
        uncertain: 1,
        last_error_kind: "create_execution_failed",
        last_error: "Lark 拒绝了这一行：字段「结果」不存在",
        pending_attempts: 1
      })
    });

    expect(screen.getByText(/释放待人工确认前/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /释放待人工确认（1 条）/ }));
    expect(onRetry).toHaveBeenCalledWith(true);

    expect(screen.getByRole("alert")).toHaveTextContent("Lark 拒绝了这一行：字段「结果」不存在");
    expect(container.querySelector(".lark-queue > .inline-status")).toHaveTextContent(
      "最近错误 create_execution_failed"
    );
  });
});
```

- [ ] **Step 18: 跑，确认它是红的**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepSync.test.tsx`
期望输出：`Error: Failed to resolve import "./StepSync" ...` + `Test Files  1 failed (1)` / `Tests  no tests`

- [ ] **Step 19: 实现 —— `StepSync.tsx`（完整文件）**

```tsx
import { LoaderCircle, Upload } from "lucide-react";

import type { SyncStatus } from "../../api";

type StepSyncProps = {
  sync: SyncStatus | null;
  confirmed: boolean;
  queueing: boolean;
  retrying: boolean;
  onEnqueue: () => void;
  onRetry: (releaseUncertain: boolean) => void;
};

export function StepSync({ sync, confirmed, queueing, retrying, onEnqueue, onRetry }: StepSyncProps) {
  const failed = sync?.failed ?? 0;
  const uncertain = sync?.uncertain ?? 0;
  const parked = sync?.parked ?? 0;
  // 现状的可见条件原样保留：没确认、又没有待管理员处理的行时，这块没有可说的话。
  if (!confirmed && parked === 0) return null;
  return (
    <div className="lark-queue">
      <p className="inline-status">
        待同步 {sync?.queued ?? 0} · 已同步 {sync?.synced ?? 0} · 失败 {failed} · 待人工确认 {uncertain} ·
        待管理员处理 {parked}
        {sync?.last_error_kind ? ` · 最近错误 ${sync.last_error_kind}` : ""}
      </p>
      {/* 类别本身不可行动：这是他真的答了什么，加上 API 已经写好的补救办法。 */}
      {sync?.last_error ? (
        <p className="inline-status error" role="alert">
          {sync.last_error}
        </p>
      ) : null}
      <div className="lark-queue-actions">
        {confirmed ? (
          <button
            type="button"
            className="ghost-button"
            disabled={queueing || (sync?.pending_attempts ?? 0) === 0}
            title="把已保存、还没有同步任务的本地结果排入队列。同步只新增执行记录；不通过时会新增缺陷，旧记录与旧缺陷不会被修改。"
            onClick={onEnqueue}
          >
            {queueing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
            把已保存的本地结果排入同步
          </button>
        ) : null}
        {confirmed && failed > 0 ? (
          <button
            type="button"
            className="ghost-button"
            disabled={retrying}
            title="重新排入此前失败的行；已经写入远端的记录不会重复排队。"
            onClick={() => onRetry(false)}
          >
            {retrying ? <LoaderCircle className="spin" size={16} /> : null}
            重试失败的同步（{failed} 条）
          </button>
        ) : null}
        {parked > 0 ? (
          <button
            type="button"
            className="ghost-button"
            disabled={retrying}
            title="把等待管理员处理的记录重新指向当前已确认的目标表；只有管理员确认它们应写入当前目标表后才会继续。"
            onClick={() => onRetry(false)}
          >
            {retrying ? <LoaderCircle className="spin" size={16} /> : null}
            重新指向当前目标表（{parked} 条）
          </button>
        ) : null}
        {confirmed && uncertain > 0 ? (
          <button
            type="button"
            className="ghost-button"
            disabled={retrying}
            title="释放前请先在旧表搜索该复测标签：若远端其实已写入，释放后会再新增一条记录。"
            onClick={() => onRetry(true)}
          >
            {retrying ? <LoaderCircle className="spin" size={16} /> : null}
            已核对远端，释放待人工确认（{uncertain} 条）
          </button>
        ) : null}
      </div>
      {/* 下面两段都是「只在对应计数 > 0 时」出现：健康态一段都不渲染。 */}
      {confirmed && uncertain > 0 ? (
        <p className="attachment-hint">
          释放待人工确认前，请先在旧表搜索该复测标签：若远端其实已写入，释放后会再新增一条记录。
        </p>
      ) : null}
      {parked > 0 ? (
        <p className="attachment-hint">
          {parked} 条记录正在等待管理员处理，不会自行同步：只有管理员确认它们应写入当前目标表后才会继续。若目标表确实更换过，按「重新指向当前目标表」或「把已保存的本地结果排入同步」都会把它们重新指向当前目标表；若本组的写入确认已被撤销，需要先重新确认。
          {confirmed ? null : "本组目前尚未确认写入目标，这些记录不会同步。"}
        </p>
      ) : null}
    </div>
  );
}
```

四处按钮文案与现状逐字一致（只把「同步只新增执行记录…」那段常驻灰字降级进 `排入同步` 的 `title`，因为门 4 要求健康态一个灰字段都没有）；`重新指向` 与 `重试失败` 都走 `onRetry(false)`，与现状的 `retryQueuedJobs(false)` 一致，重新指向由后端在同一次调用里完成。

- [ ] **Step 20: 跑，期望变绿（门 4 的组件层证据）**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark/StepSync.test.tsx`
期望输出：`Test Files  1 passed (1)` / `Tests  6 passed (6)`

第 1 个用例就是门 4 的组件层断言：健康态（`failed=uncertain=parked=0`、已确认）下无 `role="alert"`、无 `.attachment-hint`、只有统计行 + 一个按钮。把 `{confirmed ? (<p className="attachment-hint">同步只新增执行记录…` 加回去，它必须变红。

- [ ] **Step 21: 给步骤外壳、状态条与第 ①③ 步加样式（改 `styles.css`，只增不删）**

**改动位置**：`frontend/src/styles.css` 的 lark 段里 —— 在 `.lark-roles`（`:126`）那一行之后、`.reconcile-layout`（`:127`）之前另起一行插入。骨架的 File Structure 把 `styles.css` 记在 Task 7，是因为 Task 7 要**清理死规则**；这五个新组件要用的规则属于本 task，本轮**只新增、不删任何既有规则**（`.lark-roles` / `.lark-healthy` / `.lark-fields` 这些死规则留着，Task 7 再清）。

**类名 → 用在哪**（左边是组件实现里逐字出现的类名，样式表里的选择器必须与它们逐字一致；右边是要它办事的那个组件与那一行 JSX）：

| 类名 | 用在哪 |
|---|---|
| `.lark-step` + `.lark-step-done` / `.lark-step-open` / `.lark-step-todo` / `.lark-step-attention` | `StepSection` 的 `<section>`（`className={`lark-step lark-step-${state}`}`）：四种状态就是这四个类 |
| `.lark-step-heading` | `StepSection` 的 `<h3>`：一行装「序号 + 标题 + summary」 |
| `.lark-step-title` | `StepSection` 的展开/收起按钮（`disabled` 时不可点） |
| `.lark-step-index` | 上面那个按钮里的「第 N 步」胶囊 |
| `.lark-step-summary` | 收起时那一行 |
| `.lark-step-body` | `state === "open"` 才渲染的展开体 |
| `.lark-health-strip` + `.ok` / `.warn` / `.bad` | `LarkHealthStrip` 的 `<p>`（`data-tone` 同时带着同一个 tone） |
| `.lark-health-jump` | 状态条里 `step !== null` 时的可点文本 |
| `.lark-step-tables` | `StepTables` 根 `<div>` |
| `.lark-role` | `StepTables` 的两个角色块（带 `data-role="execution" / "bug"`） |
| `.lark-role-tables` | 读到 base 之后那一段（已读取行 + 下拉 + 判决） |
| `.lark-role-note` | 缺陷库链接未读取时那一行说明 |
| `.lark-verdict` | 就地判决的包裹层（`data-verdict` 带着 verdict） |
| `.lark-approve` | `StepApprove` 根 `<div>`（复选框本身继续用既有的 `.lark-consent`） |
| 复用、不改：`.lark-queue` / `.lark-queue-actions` / `.attachment-hint` / `.inline-status` / `.lark-consent` / `.ghost-button` / `.primary` | `StepSync` 与第 ①③ 步的按钮 |

```css
/* Task 5：一行状态条 + 4 步向导的外壳（只新增；死规则的清理在 Task 7） */
.lark-step { margin-bottom: 12px; background: #fff; border: 1px solid #dfe3e5; border-radius: 8px; }
.lark-step-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 0; padding: 12px 16px; font-size: .95rem; }
.lark-step-title { display: inline-flex; align-items: center; gap: 8px; min-width: 0; padding: 0; color: #20242a; background: none; border: 0; font: inherit; font-weight: 750; text-align: left; }
.lark-step-title:disabled { color: #9aa2a7; cursor: not-allowed; }
.lark-step-index { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 22px; padding: 0 6px; color: #176b57; background: #eaf3f0; border-radius: 999px; font-size: .72rem; font-weight: 800; }
.lark-step-summary { min-width: 0; color: #687178; font-size: .8rem; }
.lark-step-body { padding: 0 16px 16px; }
/* 四态：只改颜色与字重，序号胶囊的形状不变 —— 状态靠颜色说话，不靠布局跳动 */
.lark-step-done .lark-step-title { color: #455158; font-weight: 700; }.lark-step-done .lark-step-index { color: #1c6b45; background: #e2f2e9; }
.lark-step-open .lark-step-title { color: #176b57; }.lark-step-open .lark-step-index { color: #fff; background: #176b57; }
.lark-step-todo .lark-step-title { color: #5b6469; }.lark-step-todo .lark-step-index { color: #7c858a; background: #f2f4f4; }
.lark-step-attention .lark-step-title { color: #a23b36; }.lark-step-attention .lark-step-index { color: #a23b36; background: #fbeceb; }
/* Task 5：状态条 —— 一行，颜色只沿用在用的色板 */
.lark-health-strip { display: flex; align-items: center; gap: 7px; margin: 0 0 14px; }
.lark-health-strip.ok { color: #1c6b45; }
.lark-health-strip.warn { color: #8b620e; }
.lark-health-strip.bad { color: #a23b36; }
.lark-health-jump { padding: 0; color: inherit; background: none; border: 0; font: inherit; font-weight: 700; text-align: left; text-decoration: underline; }
/* Task 5：第 ① 步 */
.lark-step-tables { display: block; }
.lark-role { margin-bottom: 14px; }.lark-role:last-of-type { margin-bottom: 6px; }
.lark-role-tables { margin-top: 12px; }
.lark-role-note { margin: 10px 0 0; color: #687178; font-size: .8rem; }
.lark-verdict { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }
.lark-verdict .inline-status { margin: 0; }
/* Task 5：第 ③ 步 */
.lark-approve .inline-status { margin: 0 0 8px; }
/* Task 5：窄屏（骨架 §Global Constraints 第 9 条：360px 不许横向溢出）。
   光靠 flex-wrap 不够：flex item 默认 min-width:auto，长行不会缩到内容盒以下，
   所以标题与 summary 各自 min-width:0，并在 420px 以下各占一整行。 */
@media (max-width: 420px) {
  .lark-step-heading { padding: 10px 14px; }
  .lark-step-body { padding: 0 14px 14px; }
  .lark-step-title { flex: 1 1 100%; }
  .lark-step-summary { flex: 1 1 100%; font-size: .76rem; }
  .lark-health-strip { align-items: flex-start; }
  .lark-role-note { font-size: .76rem; }
}
```

三处不是「随便写」的地方，改之前先读：

1. `.lark-verdict .inline-status { margin: 0 }` 是必需的：`.inline-status` 自带 `margin: 14px`（`styles.css:41`），不覆盖会让判决行与它自己的下拉错位。
2. `.lark-step-title { min-width: 0 }` + `.lark-step-heading { flex-wrap: wrap }` 是 360px 不溢出的**真正原因**（flex item 默认 `min-width: auto`）。`.lark-step-body` 与两个 `<input>`/`<select>` 不必再加宽度规则：`input, select { width: 100% }`（`:18`）与全局 `box-sizing: border-box`（`:2`）已经管住。
3. 取色全部来自本文件已有值：#1c6b45 / #a23b36 / #8b620e（分别等于 `.inline-status.saved` / `.inline-status.error` / `.inline-status.warning`）、#176b57 / #e2f2e9 / #eaf3f0 / #f2f4f4 / #7c858a / #5b6469 / #687178 / #455158 / #9aa2a7 / #dfe3e5 / #fbeceb。**不引入新色系**。

- [ ] **Step 22: 类型门 + 构建 + 全量回归**

Run: `cd /home/lucascool/qa-board/frontend && npx tsc -b`
期望输出：无输出，exit 0（`vitest` 不做类型检查，这一步不能省）

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/components/lark`
期望输出：`Test Files  5 passed (5)` / `Tests  23 passed (23)`（3 + 3 + 7 + 4 + 6）

Run: `cd /home/lucascool/qa-board/frontend && npm run build`
期望输出：`✓ built in …`（基线见骨架 §环境与命令）。**CSS 由 vite 处理，所以这一步同时是样式的语法门**：少一个 `}`、`@media` 没闭合，会以 `[vite:css] … Unexpected }` / `Unclosed block` 之类报错并让 exit code 非 0 —— 报错文本里的行号直接指回 `styles.css`，不要靠肉眼看。

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run`
期望输出：全量 **0 failed**，且每个既有文件的用例数与本 task 开工前记下的那两行 `Test Files / Tests` 计数一致（`HeaderSetup.test.tsx` / `LarkCheck.test.tsx` / `Execution.test.tsx` 等必须仍全绿）。若某个既有文件用例数变少或变红，说明有断言被这轮改动带坏了：先回退 `styles.css` 的改动复跑，**不要改测试**。

- [ ] **Step 23: 自查后提交**

自查四条，逐条回答（答不上就别提交）：

1. **门 4 的组件层证据**：`keeps the healthy state to one stats row and one button (门 4)` 断言了无 `role="alert"`、无 `.attachment-hint`、按钮只有 1 个；`LarkHealthStrip` 的 `is exactly one line...` 断言了 `getByRole("status")` + `aria-live="polite"` 且健康态无 `alert`（E2）。把那段常驻灰字加回去，它必须红。
2. **门 2/3/B7 的组件层证据**：第 12 步的三次变异各自让哪条用例变红，实际跑一遍并记下来（B7 那次是删掉 `retryable` 里的 `bad`）。
3. **哑组件**：`grep -n "api\b\|fetch\|useEffect\|useState" src/components/lark/Step*.tsx src/components/lark/LarkHealthStrip.tsx` 只应命中注释里出现的字样；五个组件里没有一处 `useState` / `useEffect` / 网络调用。
4. `git status` 只多出 `frontend/src/components/lark/` 这个新目录 + 一个 `styles.css`；`views/LarkCheck.tsx`、`api.ts`、`larkDraft.ts`、`hooks/` 一个都没动（接线在 Task 6）。
5. **样式只增不删**：`git diff --numstat frontend/src/styles.css` 的第二列（删除行数）必须是 `0` —— 这一轮只加规则，`.lark-roles` / `.lark-healthy` / `.lark-fields` 这些死规则原样留着，删它们是 Task 7 的活。同时 `grep -c 'lark-step\|lark-health\|lark-role\|lark-verdict\|lark-approve' src/styles.css` 的命中数要 ≥ 20（对照表里每个类名都真的落进了样式表）。

```bash
cd /home/lucascool/qa-board && git add frontend/src/components/lark frontend/src/styles.css && git commit -m "feat(web): five dumb step components, each verdict read from its own table" -m "The page's habit was to render one more line whenever state lagged behind.
These components hold no state and recompute nothing: StepTables derives each
verdict from verdictOf(probeFor(draft, role)) only, so switching a select
changes the key the verdict comes from, an unread table says it is unread
instead of borrowing the other table's red line, and an unread defect link
becomes one note where the select would be (effectiveBase returns null for it —
there are no tables from that base to list yet)." -m "StepSync keeps the healthy
case to one stats row plus the buttons it needs: the 194-character parked
explanation still renders only while parked > 0, and the always-on line about
what sync writes is demoted to the enqueue button's title, because the fourth
acceptance gate forbids any grey paragraph in the healthy state. StepApprove's
consent box and button are disabled by the caller's blocked/invalidated facts." -m "Round 1 review, both folded in: a bad or unreadable table keeps a manual
re-check button (headers can be fixed by the second step's provision/retype/
rebuild while the probe stays cached — bad is not a terminal state; loading
renders no second entry and marks the verdict area aria-busy), and the health
strip is a live region (role=status + aria-live=polite, matching the practice
the page already had at LarkCheck.tsx:608) that is still never an alert in the
healthy state." -m "Verified in this workspace: npx vitest run src/components/lark (23 passed),
npx tsc -b, npm run build." -m "Gates: 2, 3 and the component half of 4." 
```

一条 task 一条提交（与 Task 2/3 正文一致）：五个组件共用一个 commit，因为它们互相之间没有可独立交付的状态，而且这一条提交里没有任何产品页面被接线（Task 6 才接线）。若执行者所在分支要求更细的粒度，可拆成 5 条（每条 = 一个组件 + 它的测试），commit message 只留对应那一段。
### Task 6: 重写 `frontend/src/views/LarkCheck.tsx`（状态条 + 4 步向导）

**Files:**
- Modify `frontend/src/views/LarkCheck.tsx` —— 全量重写（849 行 → 下面这份逐行可数：**328 行**）
- Modify `frontend/src/App.tsx:80-94` —— 只加一项 `readTableSchema={api.larkTableSchema}`
- Modify `frontend/src/views/LarkCheck.test.tsx` —— 全量重写（页面级门 1/3/4/5/6 + B7 主路径）

**Interfaces:**

**Consumes**（骨架 §Interfaces，含 Round 1 复审补充项；本 task 不改名字、参数顺序、返回形状）

```ts
// src/larkDraft.ts（Task 2）
export type StepId = "tables" | "headers" | "approve" | "sync";
export type Health = { tone: "ok" | "warn" | "bad"; text: string; step: StepId | null };
export function effectiveBase(draft: Draft, role: TableRole): LarkBase | null;
export function verdictFor(draft: Draft, role: TableRole): Verdict;
export function nameOf(tables: Table[], tableId: string): string;
export function describeHealth(input: { target: LarkTarget | null; liveErrors: string[]; schemaInvalid: boolean; sync: SyncStatus | null }): Health;
export function stepsComplete(draft: Draft, target: LarkTarget | null, sync: SyncStatus | null): Record<StepId, boolean>;

// src/hooks/useLarkDraft.ts（Task 3；invalidateRole / recheckRole 是复审 B7 补的）
export type LarkDraftActions = {
  draft: Draft; reading: TableRole | null; checking: TableRole | null;
  setLink: (role: TableRole, url: string) => void;
  readLink: (role: TableRole) => Promise<TableRole | null>;
  setTable: (role: TableRole, tableId: string) => void;
  checkTable: (role: TableRole) => Promise<void>;
  invalidateRole: (role: TableRole) => void;
  recheckRole: (role: TableRole) => Promise<void>;   // = 作废该 role 当前表的 probe + 立刻重算
  acceptCreatedTable: (role: TableRole, table: Table) => void;
  acceptRebuiltTable: (role: TableRole, table: Table, replaced: Table) => void;
  resetDraft: (target: LarkTarget | null) => void;
};
export function useLarkDraft(opts: { groupId: string; resolve: (url: string) => Promise<LarkResolved>; readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>; onError: (message: string) => void }): LarkDraftActions;

// components/lark/*（Task 4/5）—— props 逐字照抄骨架，本 task 只传不定义
type StepSectionProps = { index: number; title: string; summary: string; state: "done"|"open"|"todo"|"attention"; disabled?: boolean; onOpen: () => void; children?: ReactNode };
type LarkHealthStripProps = { health: Health; onJump: (step: StepId) => void };
type StepTablesProps = { draft: Draft; target: LarkTarget | null; reading: TableRole | null; checking: TableRole | null; saving: boolean; onLinkChange: (r: TableRole, url: string) => void; onRead: (r: TableRole) => void; onTableChange: (r: TableRole, t: string) => void; onCheck: (r: TableRole) => void; onSave: () => void };
type StepApproveProps = { target: LarkTarget | null; confirmed: boolean; invalidated: boolean; blocked: boolean; allowWrites: boolean; busy: boolean; onAllowWrites: (v: boolean) => void; onConfirm: () => void };
type StepSyncProps = { sync: SyncStatus | null; confirmed: boolean; queueing: boolean; retrying: boolean; onEnqueue: () => void; onRetry: (releaseUncertain: boolean) => void };
// StepHeadersProps：没有 plan / planError 入参；含 B7 补的 onRoleFixed
type StepHeadersProps = {
  groupId: string; target: LarkTarget | null;
  loadPlan: (groupId: string) => Promise<ProvisionPlan>;
  resetKey?: string;
  busy: boolean;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  targetFingerprint: string; schemaFingerprint: string | null;
  bases: Record<TableRole, string>; tableNames: Record<TableRole, string>;
  onChanged: () => Promise<void>;
  onRoleFixed: (role: TableRole) => void;   // provision / retype 成功后由页面接到 recheckRole
  onTableCreated: (role: TableRole, table: Table) => void;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
};
```

**Produces**

```ts
// views/LarkCheck.tsx —— Props 在改造前基础上只增加 readTableSchema 一项（其余字段名逐字保留）
type Props = { /* 现有全部字段 */ readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema> };
// 渲染契约（页面级测试与 e2e 都按它断言）：
//   状态条 = 唯一一行 <LarkHealthStrip>，文案逐字来自 describeHealth
//   每步 = <StepSection>：根节点 .lark-step[data-state]；标题按钮可访问名「第 N 步 {title}」、带 aria-expanded
//   展开的步（**含异常自动展开的那一步**）data-state="open"；状态条指向但用户已翻走的步 "attention"
//   未完成 "todo"；已完成 "done"；收起态不渲染 children
```

**三条裁定 + 一条必须由别处收口的风险**

1. **E4 优先级（本 task 定死）**：probe 没有 TTL。**只要 `target` 存在**，「表头」这一步的完成与否与状态条都以服务端 `live.schema_errors`（= `schemaInvalid`）为准；draft 的 probe 只回答「这次待保存的选择合不合格」（它决定第 ① 步的下拉与第 ③ 步能否勾选）。两者不一致时状态条按 live 走，并在第 ② 步正文顶部显示 live 的原因。实现见下面 `done` 的覆写。
2. **E3 认证事件归属**：`api.ts:431-434` 在 401 时 `window.dispatchEvent(new Event("testdeck:unauthorized"))`；**`App.tsx:30-31` 已用 `window.addEventListener("testdeck:unauthorized", handleUnauthorized)` 认领**（挂载/卸载成对）。所以本页**不订阅**该事件、不做登录跳转 —— 重复订阅会让一次 401 触发两次视图切换。
3. **B7 主路径**：第 ① 步的 `bad` / `unreadable` 已带「重新校验」入口（Task 5），页面把它接到 `checkTable`；provision / retype 修好表头后，页面通过 `onRoleFixed={(role) => void recheckRole(role)}` 让该 role 的判决重算 —— 没有它，「表头修好了但第 ③ 步永远不可勾选」。**前提**：Task 4 的三个对话框必须在成功后调用 `onRoleFixed`；若只调 `onChanged`，本 task 的 B7 用例必红 —— 回去补 Task 4，不要在这里绕。
4. **接口风险（Task 4 收口）**：契约更正后页面**不传** `plan`，而当时 Task 4 的守卫写作 `if (!loadPlan || plan !== null) return;` —— `plan === undefined` 时 `plan !== null` 为真 → 永远不读 plan → 三个破坏性入口一个都不出现，门 6 必红。**已收口（2026-09-18）**：Task 4 的 `StepHeadersProps` 已删除 `plan` / `planError` 两个入参、`loadPlan` 改为必填、组件内 `loadPlan(groupId)` 直接调用（无守卫），并补上了原先漏声明的 `onRoleFixed`。本条保留为历史记录，**执行者无需再处理**。
5. **行数交代（对着规格 §6 的「< 250 行」如实说）**：上面这份是 **328 行**，超出目标 78 行。超出的部分逐条点名，供实现者决定要不要进一步压：(a) 迁移过来的 8 个动作（`persist` 及其 409 两分支 / `saveSelection` / `confirmChange` / `approveWrites` / `queueSavedAttempts` / `retryQueuedJobs` / `refreshTarget` / `reloadAfterProvision`）合计约 120 行，是**功能性**的，删不掉；(b) 4 个步骤各自的 props 传递与 `data-state` 计算约 45 行，是契约的落点；(c) `Props` 与第 ② 步的 `live` 原因行约 25 行。**能压的只有排版**（把 `useState` 两两并排、把 `Props` 每行塞 3 个字段、去掉段间空行）：最多再省 ~60 行到 ~270 行，把可读性换掉。若必须严格 ≤ 250，正确做法是回来把这 8 个动作抽成 `views/useLarkCheckActions.ts`（新增文件，需先改骨架 §File Structure），不要靠删断言或删分支凑数。

`tsconfig.app.json` 的 `include` 是 `["src"]`，**测试文件也在里面**：`npm run build`（`tsc -b`）会连 `LarkCheck.test.tsx` 一起类型检查，而 vitest 不查类型 —— 两者不能互相替代。

---

- [ ] **Step 1: 写门 1 的失败测试（追加到现有 `LarkCheck.test.tsx` 末尾，产品代码一行未动）**

在 `frontend/src/views/LarkCheck.test.tsx` 末尾**逐字**追加：

```tsx
// 门 1 的证伪线：这条用例在重写前必须是红的。
const RESOLVED_MISSING_SCREENSHOT: LarkResolved = {
  ...RESOLVED,
  selected: { table_id: "tbl-runs", table_name: "执行记录", view_id: "vew-main" },
  schema_errors: ["缺少必填字段「截图」"]
};

it("drops a stale header error when another table is selected", async () => {
  const resolve = vi.fn().mockResolvedValue(RESOLVED_MISSING_SCREENSHOT);
  renderCheck({ resolve, loadTarget: vi.fn().mockResolvedValue(TARGET_STATE) });

  // 链接框在重写后会被 draftFromTarget 预填 → 先清空再输入：新旧两版页面都能跑，且重写后
  // 不会因为「框里那段链接 ≠ 读出来的那段」被 baseIsCurrent 判成未读取。
  const link = screen.getAllByLabelText("Lark 文档链接")[0];
  await userEvent.clear(link);
  await userEvent.type(link, RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));
  await userEvent.selectOptions(await screen.findByLabelText("执行记录表"), "tbl-bugs");

  expect(screen.queryByText(/缺少必填字段「截图」/)).toBeNull();
});
```

这条断言就是在证明规格 §1.1 那个 bug：`tbl-runs` 带 `schema_errors`，切到 `tbl-bugs` 后红字**必须消失**；旧页面把它存在 base 级 `resolved` 里，切表不重算。

- [ ] **Step 2: 跑它，确认真的是红的（**不许跳过、不许等重写后再跑**）**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/LarkCheck.test.tsx`

期望输出（决定性两行逐字核对；`passed` 条数以实际为准，唯一必须成立的是：失败的是这一条、原因如下）：

```
   × drops a stale header error when another table is selected
     → expected <p class="inline-status error" role="alert">缺少必填字段「截图」</p> to be null

 Test Files  1 failed (1)
      Tests  1 failed | 39 passed (40)
```

只跑它自己（更干净的红证据）：

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/LarkCheck.test.tsx -t "drops a stale header error when another table is selected"`

```
AssertionError: expected <p class="inline-status error" role="alert">缺少必填字段「截图」</p> to be null
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

（现有文件恰好 39 条 `it(`，追加后 40 条；其余 39 条绿是因为产品代码一行未动。重写后这条永远绿，红不红就再没有证据了。）

Run: `cd /home/lucascool/qa-board && git add frontend/src/views/LarkCheck.test.tsx && git commit -m "test(web): pin the stale header error with a failing page-level test"`

- [ ] **Step 3: 全量重写 `LarkCheck.tsx`，并给 `App.tsx` 多传一项**

`frontend/src/views/LarkCheck.tsx` 全文替换（注释与 JSX 排布为守住行数预算而收紧，语义逐条对应旧文件）：

```tsx
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  ApiError, type CreateTablePayload, type CreateTableResult, type Group, type LarkResolved, type LarkTarget,
  type LarkTargetChangeDetail, type LarkTargetPayload, type LarkTargetState, type ProvisionFieldsPayload,
  type ProvisionFieldsResult, type ProvisionPlan, type RebuildTablePayload, type RebuildTableResult,
  type RetypeFieldsPayload, type RetypeFieldsResult, type SyncEnqueueResult, type SyncStatus, type Table,
  type TableRole, type TableSchema
} from "../api";
import { LarkHealthStrip } from "../components/lark/LarkHealthStrip";
import { StepApprove } from "../components/lark/StepApprove";
import { StepHeaders } from "../components/lark/StepHeaders";
import { StepSection } from "../components/lark/StepSection";
import { StepSync } from "../components/lark/StepSync";
import { StepTables } from "../components/lark/StepTables";
import { TargetChangeDialog, type TargetSide } from "../components/TargetChangeDialog";
import { useLarkDraft } from "../hooks/useLarkDraft";
import { describeHealth, effectiveBase, nameOf, stepsComplete, verdictFor, type StepId } from "../larkDraft";

type Props = {
  loadGroups: () => Promise<Group[]>;
  resolve: (url: string) => Promise<LarkResolved>;
  loadTarget: (groupId: string) => Promise<LarkTargetState>;
  saveTarget: (groupId: string, payload: LarkTargetPayload) => Promise<{ target: LarkTarget; live: LarkTargetState["live"]; confirmation_cleared: boolean }>;
  confirmTarget: (groupId: string, targetFingerprint: string) => Promise<LarkTarget>;
  loadSync?: (groupId: string) => Promise<SyncStatus>;
  enqueueSync?: (groupId: string) => Promise<SyncEnqueueResult>;
  retrySync?: (groupId: string, releaseUncertain?: boolean) => Promise<{ requeued: number; released: number; repointed?: number }>;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  initialGroupId?: string;
};

type PendingChange = { payload: LarkTargetPayload; previous: TargetSide | null; next: TargetSide };
type Identity = LarkTargetChangeDetail["diff"]["next"];
const STEP_ORDER: StepId[] = ["tables", "headers", "approve", "sync"];
const STEP_LABELS: Record<StepId, string> = { tables: "选表", headers: "表头", approve: "确认写入", sync: "同步" };
const HEADER_HINT = "先在第 1 步读取链接并保存目标表，这里才有可校验的表头";

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function isTargetChange(detail: unknown): detail is LarkTargetChangeDetail {
  return typeof detail === "object" && detail !== null && (detail as { reason?: unknown }).reason === "target_changed"
    && Boolean((detail as { diff?: { changed?: unknown } }).diff?.changed);
}

function sideOf(target: LarkTarget | null): TargetSide {
  return { execution_table_name: target?.execution_table_name ?? "", execution_table_id: target?.execution_table_id ?? "", bug_table_name: target?.bug_table_name ?? "", bug_table_id: target?.bug_table_id ?? "" };
}

export function LarkCheckView({
  loadGroups, resolve, loadTarget, saveTarget, confirmTarget, loadSync, enqueueSync,
  retrySync, loadPlan, provision, retype, createTable, rebuild, readTableSchema, initialGroupId
}: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [state, setState] = useState<LarkTargetState | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  // undefined = 用户还没点过标题（第 1 步展开，四步全完成则全收）；null = 用户主动收起；StepId = 用户最后打开的步。
  const [chosen, setChosen] = useState<StepId | null | undefined>(undefined);

  const actions = useLarkDraft({ groupId, resolve, readTableSchema, onError: setError });
  const { draft, reading, checking, recheckRole } = actions;

  useEffect(() => {
    let cancelled = false;
    loadGroups()
      .then((loaded) => {
        if (cancelled) return;
        setGroups(loaded);
        setGroupId((current) => (current && loaded.some((group) => group.id === current) ? current
          : loaded.find((group) => group.id === initialGroupId)?.id ?? loaded[0]?.id ?? ""));
      })
      .catch((reason) => !cancelled && setError(messageOf(reason, "读取测试组失败")));
    return () => { cancelled = true; };
    // loadGroups 是 App 传下来的稳定引用；进依赖会让它换组即重跑。
  }, [initialGroupId]);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    // 换组：上一组的目标、同步计数、展开的步、消息都不属于这一组。
    setAllowWrites(false); setNotice(""); setError(""); setPendingChange(null);
    setState(null); setSync(null); setChosen(undefined);
    loadTarget(groupId)
      .then((result) => {
        if (cancelled) return;
        setState(result);
        actions.resetDraft(result.target);   // 预填只发生在「目标刚读到」这一刻，不冲掉用户改过的选择
      })
      .catch((reason) => !cancelled && setError(messageOf(reason, "读取该组的 Lark 目标失败")));
    loadSync?.(groupId).then((result) => !cancelled && setSync(result)).catch(() => !cancelled && setSync(null));
    return () => { cancelled = true; };
    // resetDraft 的身份不稳定，进依赖会变成「换组即重读」的循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, loadTarget]);

  const target = state?.target ?? null;
  const liveErrors = [...(state?.read_errors ?? []), ...(state?.live?.read_errors ?? [])];
  const schemaInvalid = (state?.live?.schema_errors.length ?? 0) > 0;
  const blocked = liveErrors.length > 0 || schemaInvalid;
  const confirmed = target?.confirmed === true;
  const invalidated = confirmed && schemaInvalid;
  const syncFailed = sync?.failed ?? 0, syncUncertain = sync?.uncertain ?? 0, syncParked = sync?.parked ?? 0;
  const syncTrouble = syncFailed + syncUncertain + syncParked > 0;
  const health = describeHealth({ target, liveErrors, schemaInvalid, sync });
  // E4：probe 没有 TTL。目标已保存时「表头」这步以服务端 live.schema_errors 为准（probe 只回答
  // 「这次待保存的选择合不合格」），否则服务端说失效、第 ① 步还显示 ok，两个真值打架。
  const done: Record<StepId, boolean> = { ...stepsComplete(draft, target, sync), headers: target !== null && !schemaInvalid };
  const executionBase = effectiveBase(draft, "execution"), bugBase = effectiveBase(draft, "bug");
  const executionVerdict = verdictFor(draft, "execution"), bugVerdict = verdictFor(draft, "bug");
  // 「前置未完成不可进」：① 永远可进；② 没 target 时进去是一句回第 ① 步的提示（规格 §12 P2）；
  // ③ 要两表 verdict 都 ok，否则勾选也点不动；④ 要有已确认目标或真的有待处理异常。
  const enterable: Record<StepId, boolean> = {
    tables: true, headers: true,
    approve: target !== null && executionVerdict === "ok" && bugVerdict === "ok",
    sync: confirmed || syncTrouble
  };
  // 只有 D2 的两条「必须主动提醒」抢导航：状态条变红，或指向第 ④ 步（含 parked 的 warn）。
  // 「尚未确认」也带 step=approve，但那是正常进度 —— 抢它会把用户从第 ① 步拽走。
  const autoOpen = health.step === "sync" || health.tone === "bad" ? health.step : null;
  const lastAuto = useRef<StepId | null>(null);
  useEffect(() => {
    const before = lastAuto.current;
    lastAuto.current = autoOpen;
    if (autoOpen === null || autoOpen === before) return;   // 分类没变就不抢用户导航
    setChosen(autoOpen);
  }, [autoOpen]);
  const allDone = STEP_ORDER.every((step) => done[step]);
  const openStep: StepId | null = chosen === undefined ? (allDone ? null : "tables") : chosen;
  const summaries: Record<StepId, string> = {
    tables: executionVerdict === "ok" && bugVerdict === "ok" ? "两张表都已校验" : "还有表没有校验",
    headers: target ? `已保存目标：${target.execution_table_name} / ${target.bug_table_name}` : HEADER_HINT,
    approve: confirmed ? (invalidated ? "确认已失效，需要重新确认" : "已确认") : "尚未确认：本地结果不会写入 Lark",
    sync: syncTrouble ? `失败 ${syncFailed} · 待人工确认 ${syncUncertain} · 待管理员处理 ${syncParked}`
      : `待同步 ${sync?.queued ?? 0} · 已同步 ${sync?.synced ?? 0}`
  };

  function buildPayload(acknowledge: boolean): LarkTargetPayload {
    return {
      source_url: draft.execution.base?.source_url ?? target?.source_url ?? "", execution_base_token: executionBase?.base_token ?? "",
      execution_table_id: draft.execution.tableId, execution_view_id: executionBase ? draft.execution.viewId : null,
      bug_base_token: bugBase?.base_token ?? "", bug_table_id: draft.bug.tableId,
      expected_previous_fingerprint: target?.target_fingerprint ?? null, acknowledge_change: acknowledge
    };
  }

  // 名字只对「本页读到过的那张表」存在；没读过的表用 id 自称最诚实。
  function namedSide(identity: Identity): TargetSide {
    return { execution_table_name: nameOf(executionBase?.tables ?? [], identity.execution_table_id), execution_table_id: identity.execution_table_id, bug_table_name: nameOf(bugBase?.tables ?? [], identity.bug_table_id), bug_table_id: identity.bug_table_id };
  }

  function identityChanged(): boolean {
    if (!target || !executionBase || !bugBase) return false;
    return target.execution_base_token !== executionBase.base_token || target.execution_table_id !== draft.execution.tableId
      || target.bug_base_token !== bugBase.base_token || target.bug_table_id !== draft.bug.tableId;
  }

  async function persist(payload: LarkTargetPayload) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await saveTarget(groupId, payload);
      setPendingChange(null);
      // PUT 已经回了保存后的行与它依据的实时读取：不再补一次 GET（那次失败会被页面吞掉）。
      setState({ target: result.target, live: result.live ?? null, read_errors: result.live?.read_errors ?? [] });
      setNotice(result.confirmation_cleared ? "目标表已更换：此前的写入确认已被清除，需要重新确认" : "已保存该组的 Lark 目标表");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && typeof reason.detail === "object" && reason.detail !== null) {
        const body = reason.detail as LarkTargetChangeDetail;
        if (body.reason === "stale_page") {   // 别的页面动过这一组：重读；弹窗也跟着下去
          setPendingChange(null);
          const refreshed = await loadTarget(groupId).catch(() => null);
          if (refreshed) setState(refreshed);
          setError("其他页面已改过该组的目标表，已重新读取；本次选择仍然保留，请核对后再次点击「保存选择」");
          return;
        }
        if (isTargetChange(reason.detail)) {   // 服务端发现本页还没看见的改动：同一个确认弹窗挡在中间
          setPendingChange({ payload, previous: body.diff.previous ? namedSide(body.diff.previous) : null, next: namedSide(payload) });
          return;
        }
        setError(typeof reason.detail === "string" ? reason.detail : messageOf(reason, "保存 Lark 目标失败"));
        return;
      }
      setError(messageOf(reason, "保存 Lark 目标失败"));
    } finally { setBusy(false); }
  }

  function saveSelection() {
    setError(""); setNotice("");
    const payload = buildPayload(false);
    if (!payload.source_url || !payload.execution_table_id || !payload.bug_table_id) return;
    if (identityChanged()) { setPendingChange({ payload, previous: sideOf(target), next: namedSide(payload) }); return; }   // 绝不静默改指向
    void persist(payload);
  }

  async function confirmChange() { if (pendingChange) await persist({ ...pendingChange.payload, acknowledge_change: true }); }

  async function approveWrites() {
    if (!target || !allowWrites) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await confirmTarget(groupId, target.target_fingerprint);
      setState((current) => (current ? { ...current, target: updated } : current));
      setNotice("已确认：本组新记录只会新增，旧记录与旧缺陷不会被修改");
    } catch (reason) { setError(messageOf(reason, "确认失败")); } finally { setBusy(false); }
  }

  // 只报新插入的行会让按钮看起来是死的：队列里已经有的行也答「已排入 0 条」。每个动过的计数都点名。
  async function queueSavedAttempts() {
    if (!enqueueSync) return;
    setQueueing(true); setError("");
    try {
      const result = await enqueueSync(groupId);
      const moved: string[] = [];
      if (result.queued > 0) moved.push(`已排入 ${result.queued} 条本地结果`);
      if (result.repointed > 0) moved.push(`${result.repointed} 条任务已重新指向当前目标表`);
      if (result.requeued > 0) moved.push(`已重新排队 ${result.requeued} 条失败结果`);
      setNotice(moved.length > 0 ? `${moved.join("，")}，仅新增记录` : "没有需要排入的本地结果：这一组的本地结果都已经在队列里");
      const refreshed = await loadSync?.(groupId);
      if (refreshed) setSync(refreshed);
    } catch (reason) { setError(messageOf(reason, "排入同步失败")); } finally { setQueueing(false); }
  }

  // 释放一条 uncertain 任务可能追加第二条远端记录：要管理员显式声明他核对过旧表。
  async function retryQueuedJobs(releaseUncertain: boolean) {
    if (!retrySync) return;
    setRetrying(true); setError("");
    try {
      const result = await retrySync(groupId, releaseUncertain);
      const moved: string[] = [];
      if (result.requeued > 0) moved.push(`已重新排队 ${result.requeued} 条失败结果`);
      if (result.released > 0) moved.push(`释放 ${result.released} 条待人工确认`);
      if ((result.repointed ?? 0) > 0) moved.push(`${result.repointed} 条任务已重新指向当前目标表`);
      setNotice(moved.join("，") || "没有需要重试的同步任务");
      const refreshed = await loadSync?.(groupId);
      if (refreshed) setSync(refreshed);
    } catch (reason) { setError(messageOf(reason, "重试同步失败")); } finally { setRetrying(false); }
  }

  async function refreshTarget() {
    if (!groupId) return;
    setError("");
    try {
      setState(await loadTarget(groupId));
      const refreshed = await loadSync?.(groupId);
      if (refreshed) setSync(refreshed);
    } catch (reason) { setError(messageOf(reason, "读取该组的 Lark 目标失败")); }
  }

  // 改过表头的那次运行已在服务端作废确认：先本地撤销，失败的重读也不能让「已确认」和「已创建 …」并排。
  // 表头本身的重算交给 onRoleFixed（B7），不在这里猜哪个 role 被改了。
  async function reloadAfterProvision() {
    setState((current) => (current?.target ? { ...current, target: { ...current.target, confirmed: false, confirmed_at: null } } : current));
    if (!groupId) return;
    try { setState(await loadTarget(groupId)); } catch (reason) { setError(messageOf(reason, "读取该组的 Lark 目标失败")); }
  }

  return (
    <section className="workspace-section lark-check-layout" aria-labelledby="lark-title">
      <div className="section-heading"><div><p className="eyebrow">LARK</p><h2 id="lark-title">连接本组的 Lark 多维表格</h2></div></div>
      <label>
        测试组
        <select aria-label="测试组" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          {groups.map((group) => (<option key={group.id} value={group.id}>{group.name}</option>))}
        </select>
      </label>
      <div className="lark-panel">
        <div className="lark-panel-heading">
          <LarkHealthStrip health={health} onJump={setChosen} />
          <button type="button" className="ghost-button" disabled={!groupId} onClick={() => void refreshTarget()}><RefreshCw size={15} />刷新</button>
        </div>
        {liveErrors.map((item) => (<p key={item} className="inline-status error" role="alert">{item}</p>))}
        {notice ? <p className="inline-status saved" role="status">{notice}</p> : null}
        {error ? <p className="inline-status error" role="alert">{error}</p> : null}
      </div>
      {STEP_ORDER.map((step, index) => (
        <StepSection
          key={step} index={index + 1} title={STEP_LABELS[step]} summary={summaries[step]}
          state={openStep === step ? "open" : autoOpen === step ? "attention" : done[step] ? "done" : "todo"}
          disabled={!enterable[step]} onOpen={() => setChosen(openStep === step ? null : step)}
        >
          {step === "tables" ? (
            <StepTables draft={draft} target={target} reading={reading} checking={checking} saving={busy}
              onLinkChange={actions.setLink} onRead={(role) => void actions.readLink(role)} onTableChange={actions.setTable}
              onCheck={(role) => void actions.checkTable(role)} onSave={saveSelection} />
          ) : null}
          {step === "headers" ? (<>
            {schemaInvalid ? (<p className="inline-status error" role="alert">服务端最近一次重读说这批表头不合格：{state?.live?.schema_errors.join("；")}。先按下面的动作修好，再重新校验。</p>) : null}
            {target && loadPlan ? (
              <StepHeaders groupId={groupId} target={target} loadPlan={loadPlan} resetKey={groupId} busy={busy}
                provision={provision} retype={retype} createTable={createTable} rebuild={rebuild}
                targetFingerprint={target.target_fingerprint} schemaFingerprint={target.schema_fingerprint}
                bases={{ execution: executionBase?.base_token ?? "", bug: bugBase?.base_token ?? "" }}
                tableNames={{ execution: target.execution_table_name, bug: target.bug_table_name }}
                onChanged={reloadAfterProvision} onRoleFixed={(role) => void recheckRole(role)}
                onTableCreated={actions.acceptCreatedTable} onTableRebuilt={actions.acceptRebuiltTable} />
            ) : (<p className="inline-status">{HEADER_HINT}</p>)}
          </>) : null}
          {step === "approve" ? (
            <StepApprove target={target} confirmed={confirmed} invalidated={invalidated} blocked={blocked}
              allowWrites={allowWrites} busy={busy} onAllowWrites={setAllowWrites} onConfirm={() => void approveWrites()} />
          ) : null}
          {step === "sync" ? (
            <StepSync sync={sync} confirmed={confirmed} queueing={queueing} retrying={retrying}
              onEnqueue={() => void queueSavedAttempts()} onRetry={(releaseUncertain) => void retryQueuedJobs(releaseUncertain)} />
          ) : null}
        </StepSection>
      ))}
      {pendingChange ? (
        <TargetChangeDialog previous={pendingChange.previous} next={pendingChange.next} pendingAttempts={sync?.pending_attempts ?? null}
          busy={busy} onCancel={() => setPendingChange(null)} onConfirm={() => void confirmChange()} />
      ) : null}
    </section>
  );
}
```

`frontend/src/App.tsx:80-94` 的 `<LarkCheckView …>` 只加一行（其余逐字不动）：

```tsx
          <LarkCheckView
            loadGroups={api.groups}
            resolve={api.resolveLark}
            readTableSchema={api.larkTableSchema}
            loadTarget={api.larkTarget}
            saveTarget={api.saveLarkTarget}
            confirmTarget={api.confirmLarkTarget}
            loadPlan={api.larkProvisionPlan}
            provision={api.provisionLarkFields}
            retype={api.retypeLarkFields}
            createTable={api.createLarkTable}
            rebuild={api.rebuildLarkTable}
            loadSync={api.syncStatus}
            enqueueSync={api.enqueueSync}
            retrySync={api.retrySync}
          />
```

- [ ] **Step 4: 那条门 1 用例必须变绿；类型门要过；死 state 要审计**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/LarkCheck.test.tsx -t "drops a stale header error when another table is selected"`

期望输出（同一段测试代码、同一个用例名，从红变绿 —— 门 1 的先红后绿证据）：

```
 ✓ src/views/LarkCheck.test.tsx > drops a stale header error when another table is selected
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

此时**文件里其余 39 条断言的是旧 DOM**（`dl.lark-facts`、「缺陷库链接」的旧红字位置等），重写后大部分会红；Step 5 逐条迁移，Step 6 才要求整文件绿 —— 不要为了让旧用例过而往回加 UI。

Run: `cd /home/lucascool/qa-board/frontend && npm run build`

期望输出：`tsc -b` 无输出，末尾 `✓ built in <1.5s` + `dist/assets/index-<hash>.js`。

死 state 审计（仓库没有 lint、`noUnusedLocals` 也没开，只能这样抓）：

Run: `cd /home/lucascool/qa-board/frontend && grep -nE "resolved|bugResolved|bugReadUrl|bugReadApplies|executionTableId|bugTableId|createdTables|withCreatedTable|suggestBugTable|lark-facts|HeaderSetup" src/views/LarkCheck.tsx; echo "exit=$?"`

期望输出：**没有任何匹配行**，只有 `exit=1`。（`resolved` 命不中仍在用的 `LarkResolved` / `resolve`：大小写与词尾都不同。）再确认 `HeaderSetup` 不再是本页依赖：

Run: `cd /home/lucascool/qa-board/frontend && grep -n "components/HeaderSetup" src/views/LarkCheck.tsx; echo "exit=$?"`

期望：无匹配行 + `exit=1`。

- [ ] **Step 5: 重写 `LarkCheck.test.tsx`（完整文件，覆盖门 1 / 3 / 4 / 5 / 6 与 B7 主路径）**

`frontend/src/views/LarkCheck.test.tsx` 全文替换（Step 1 那条用例的代码块逐字保留，只是搬进新文件）：

```tsx
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { type Group, type LarkResolved, type LarkTarget, type LarkTargetState, type ProvisionPlan, type SyncStatus, type TableSchema } from "../api";
import { LarkCheckView } from "./LarkCheck";

const GROUP: Group = { id: "0918-id", name: "Sprint 0918", source_name: "0918.csv", source_version: "1", count: 14, archived_at: null, created_at: "2026-09-16T08:00:00Z" };
const RESOLVED: LarkResolved = {
  source_url: "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs", base_token: "app-exec", base_name: "执行库",
  tables: [{ table_id: "tbl-runs", name: "执行记录" }, { table_id: "tbl-bugs", name: "缺陷记录" }],
  selected: { table_id: "tbl-runs", table_name: "执行记录", view_id: "vew-main" },
  execution_fields: { 用例: "text", 结果: "single_select", 截图: "attachment" },
  required_execution_fields: ["用例", "结果", "截图"], schema_errors: [], read_errors: []
};
const TARGET: LarkTarget = {
  group_id: GROUP.id, source_url: RESOLVED.source_url, execution_base_token: "app-exec", execution_base_name: "执行库",
  execution_table_id: "tbl-runs", execution_table_name: "执行记录", bug_base_token: "app-exec", bug_base_name: "执行库",
  bug_table_id: "tbl-bugs", bug_table_name: "缺陷记录", schema_fingerprint: "schema-1",
  target_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs", confirmed_at: null, confirmed: false
};
const TARGET_STATE: LarkTargetState = { target: TARGET, live: { schema_errors: [], read_errors: [] }, read_errors: [] };
// 第 ② 步三个破坏性入口各自的前提：缺 2 个表头（设置表头）、有类型错的表头（修正表头类型）、给了 rebuild。
const PLAN: ProvisionPlan = {
  roles: {
    execution: [{ name: "结果", type: 1, type_name: "text", properties: {} }, { name: "日期", type: 5, type_name: "date", properties: {} }],
    bug: []
  },
  retype: { execution: [{ name: "优先级", type: 1, type_name: "text", field_id: "fld-1", current_type: 1, current_type_name: "text", properties: {} }], bug: [] }
};

function confirmedTarget(): LarkTarget { return { ...TARGET, confirmed_at: "2026-09-16T10:00:00Z", confirmed: true }; }
function stateWith(target: LarkTarget, live: { schema_errors: string[]; read_errors: string[] } = { schema_errors: [], read_errors: [] }): LarkTargetState {
  return { target, live, read_errors: [] };
}
function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { confirmed: true, queued: 0, synced: 1, failed: 0, uncertain: 0, parked: 0, last_error_kind: null, pending_attempts: 2, detail: "目标表已确认，可显式排入同步", ...overrides };
}
function schemaFor(tableId: string, schema_errors: string[] = []): TableSchema {
  return { table_id: tableId, fields: { 用例: "text", 结果: "single_select", 截图: "attachment" }, required: ["用例", "结果", "截图"], schema_errors };
}
function renderCheck(overrides: Partial<Parameters<typeof LarkCheckView>[0]> = {}) {
  const resolve = vi.fn().mockResolvedValue(RESOLVED);
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: { schema_errors: [], read_errors: [] }, confirmation_cleared: false });
  const confirmTarget = vi.fn().mockResolvedValue(confirmedTarget());
  const loadSync = vi.fn().mockResolvedValue(syncStatus());
  const loadPlan = vi.fn().mockResolvedValue({ roles: { execution: [], bug: [] } });
  const readTableSchema = vi.fn(async (_baseToken: string, tableId: string) => schemaFor(tableId));
  const view = render(
    <LarkCheckView loadGroups={async () => [GROUP]} resolve={resolve} loadTarget={loadTarget} saveTarget={saveTarget}
      confirmTarget={confirmTarget} loadSync={loadSync} loadPlan={loadPlan} readTableSchema={readTableSchema} {...overrides} />
  );
  return { ...view, resolve, loadTarget, saveTarget, confirmTarget, loadSync, loadPlan, readTableSchema };
}
// 两个角色各有一个「Lark 文档链接」输入框，执行表那个在 DOM 里靠前。
function executionBlock(container: HTMLElement): HTMLElement {
  return container.querySelector(".lark-role[data-role='execution']") as HTMLElement;
}
function stepState(container: HTMLElement, index: number): string | null {
  return container.querySelectorAll(".lark-step")[index - 1]?.getAttribute("data-state") ?? null;
}
// 链接框被 draftFromTarget 预填过 → 先清空再输入，否则读出来的 url 与框里剩下那段不一致，
// baseIsCurrent 会判成「链接已改动、尚未读取」（规格 §4.2）。
async function readExecutionLink(container: HTMLElement): Promise<void> {
  const box = within(executionBlock(container)).getByLabelText("Lark 文档链接");
  await userEvent.clear(box);
  await userEvent.type(box, RESOLVED.source_url);
  await userEvent.click(within(executionBlock(container)).getByRole("button", { name: "读取表格" }));
}

it("drops a stale header error when another table is selected", async () => {
  const resolve = vi.fn().mockResolvedValue(RESOLVED_MISSING_SCREENSHOT);
  renderCheck({ resolve, loadTarget: vi.fn().mockResolvedValue(TARGET_STATE) });

  // 链接框在重写后会被 draftFromTarget 预填 → 先清空再输入：新旧两版页面都能跑，且重写后
  // 不会因为「框里那段链接 ≠ 读出来的那段」被 baseIsCurrent 判成未读取。
  const link = screen.getAllByLabelText("Lark 文档链接")[0];
  await userEvent.clear(link);
  await userEvent.type(link, RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));
  await userEvent.selectOptions(await screen.findByLabelText("执行记录表"), "tbl-bugs");

  expect(screen.queryByText(/缺少必填字段「截图」/)).toBeNull();
});

it("calls a table nobody checked unread, never borrowing the other table's verdict", async () => {
  const readTableSchema = vi.fn(async (_baseToken: string, tableId: string) => schemaFor(tableId));
  const { container } = renderCheck({ readTableSchema });

  await readExecutionLink(container);
  await userEvent.selectOptions(await screen.findByLabelText("执行记录表"), "tbl-bugs");

  const execution = executionBlock(container);
  expect(within(execution).getByText("尚未校验这张表")).toBeVisible();
  expect(within(execution).queryByText(/表头完整|缺少必填字段/)).toBeNull();
  expect(readTableSchema).not.toHaveBeenCalledWith("app-exec", "tbl-bugs", "execution");   // 切表只换 key，不顺手发请求

  await userEvent.click(within(execution).getByRole("button", { name: "校验" }));

  expect(await within(execution).findByText("执行记录表表头完整")).toBeVisible();
  expect(readTableSchema).toHaveBeenCalledWith("app-exec", "tbl-bugs", "execution");
});

it("drops a role's base and verdict the moment its link box is edited", async () => {
  const { container } = renderCheck();

  await readExecutionLink(container);
  expect(within(executionBlock(container)).getByText("执行记录表表头完整")).toBeVisible();

  await userEvent.type(within(executionBlock(container)).getByLabelText("Lark 文档链接"), "x");

  expect(screen.queryByLabelText("执行记录表")).toBeNull();
  expect(screen.queryByText(/表头完整/)).toBeNull();
});

it("keeps the healthy page to one status line and four step rows with no alert", async () => {
  const { container } = renderCheck({ loadTarget: vi.fn().mockResolvedValue(stateWith(confirmedTarget())) });

  const strip = container.querySelector(".lark-health-strip");
  expect(strip).toHaveAttribute("data-tone", "ok");
  expect(strip).toHaveTextContent("已确认 · 执行记录 / 缺陷记录 · 待同步 0 · 失败 0");

  // 两张表都校验完 = 四步全完成 → 全部收成标题行（规格 §5.2「配完 → 页面安静」）。
  await readExecutionLink(container);
  await waitFor(() => expect(container.querySelectorAll(".lark-step-body")).toHaveLength(0));

  expect(container.querySelectorAll(".lark-health-strip")).toHaveLength(1);
  expect(container.querySelectorAll(".lark-step")).toHaveLength(4);
  expect(container.querySelectorAll(".lark-step-title")).toHaveLength(4);
  expect(screen.queryAllByRole("alert")).toEqual([]);
});

it("turns the strip red and opens step 2 when the saved target's headers went stale", async () => {
  const { container } = renderCheck({
    loadTarget: vi.fn().mockResolvedValue(stateWith(confirmedTarget(), { schema_errors: ["缺少必填字段「截图」"], read_errors: [] }))
  });

  const strip = await screen.findByText(/已确认，但表头已失效/);
  expect(strip.closest(".lark-health-strip")).toHaveAttribute("data-tone", "bad");
  expect(stepState(container, 2)).toBe("open");     // 门 5 的自动展开必须落到 data-state
  expect(stepState(container, 1)).toBe("todo");
});

it("opens step 4 when saved results have failed to sync", async () => {
  const { container } = renderCheck({
    loadTarget: vi.fn().mockResolvedValue(stateWith(confirmedTarget())),
    loadSync: vi.fn().mockResolvedValue(syncStatus({ failed: 3, uncertain: 1 }))
  });

  const strip = await screen.findByText(/同步失败 3 条 · 待人工确认 1 条/);
  expect(strip.closest(".lark-health-strip")).toHaveAttribute("data-tone", "bad");
  expect(stepState(container, 4)).toBe("open");
  expect(stepState(container, 1)).toBe("todo");
});

it("keeps the three destructive dialogs reachable from step 2", async () => {
  renderCheck({
    loadPlan: vi.fn().mockResolvedValue(PLAN),
    provision: vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [], target: TARGET }),
    retype: vi.fn().mockResolvedValue({ retyped_fields: [], schema_errors: [], target: TARGET }),
    rebuild: vi.fn().mockResolvedValue({ role: "execution", table: { table_id: "tbl-runs-2", name: "执行记录（新）" }, replaced: { table_id: "tbl-runs", name: "执行记录" }, requeued: 0, schema_errors: [], target: TARGET })
  });

  // 未确认的组默认展开第 ① 步，第 ② 步要自己点开（收起态不渲染 children）。
  await userEvent.click(screen.getByRole("button", { name: /第 2 步\s*表头/ }));

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("设置表头");
  await userEvent.click(screen.getByRole("button", { name: "取消" }));

  await userEvent.click(await screen.findByRole("button", { name: "修正表头类型" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("修正表头类型");
  await userEvent.click(screen.getByRole("button", { name: "取消" }));

  await userEvent.click(await screen.findByRole("button", { name: "重建数据表（表头修正）" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent("重建数据表（表头修正）");
  await userEvent.click(screen.getByRole("button", { name: "取消" }));

  expect(screen.queryByRole("dialog")).toBeNull();
});

// B7：修好表头 → probe 重算 → 第 ③ 步可勾选。这是主路径，不是边界。
it("lets step 3 be ticked once a repaired header has been re-checked", async () => {
  let headersBad = true;
  const readTableSchema = vi.fn(async (_baseToken: string, tableId: string) =>
    schemaFor(tableId, headersBad && tableId === "tbl-runs" ? ["缺少必填字段「截图」"] : []));
  const provision = vi.fn().mockImplementation(async () => {
    headersBad = false;
    return { created_fields: ["截图"], schema_errors: [], target: TARGET };
  });
  const { container } = renderCheck({
    resolve: vi.fn().mockResolvedValue({ ...RESOLVED, schema_errors: ["缺少必填字段「截图」"] }),
    readTableSchema, provision, loadPlan: vi.fn().mockResolvedValue(PLAN)
  });

  await readExecutionLink(container);
  expect(screen.getByRole("button", { name: /第 3 步/ })).toBeDisabled();   // 执行表 verdict = bad

  await userEvent.click(screen.getByRole("button", { name: /第 2 步\s*表头/ }));
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(await screen.findByRole("button", { name: "创建这些表头" }));

  // ProvisionDialog 成功后调 onRoleFixed → 页面 recheckRole("execution") → 服务端这次答 ok。
  await waitFor(() => expect(screen.getByRole("button", { name: /第 3 步/ })).toBeEnabled());
  expect(readTableSchema).toHaveBeenCalledWith("app-exec", "tbl-runs", "execution");

  await userEvent.click(screen.getByRole("button", { name: /第 3 步/ }));
  expect(screen.getByRole("checkbox", { name: "允许向上述旧表新增本组记录" })).toBeEnabled();
});
```

覆盖对照：门 1 = 第 1 条；门 3 = 第 2、3 条；门 4 = 第 4 条（1 行状态条 + 4 行步骤标题 + 0 个 `role="alert"`，并钉住「四步全完成 → 全收」）；门 5 = 第 5、6 条（`data-state="open"` 落在第 ② / 第 ④ 步 + 状态条 `data-tone="bad"`）；门 6 = 第 7 条；B7 = 第 8 条。

被有意改写的旧断言（信息不丢，只换承载它的 DOM）：
- 旧 `shows the group's stored Lark target before anything is approved` 断言的 `执行库 / 执行记录 / 缺陷记录` +「尚未确认」：旧页面靠 `dl.lark-facts` 那块显示表名（规格 §1.2 点名的**重复信息**）；新页面表名只出现两次（健康态状态条、第 ② 步 summary「已保存目标：执行记录 / 缺陷记录」），由第 4、5、6 条覆盖。
- 旧 `缺陷库链接未读取` 的全局红字按规格 §4.2 / §8 降级为第 ① 步缺陷库一侧的一行说明（Task 5 的 `UNREAD_BUG_LINK_NOTE`），页面级不再断言它。
- 其余旧用例（409 `stale_page` / `target_changed`、PUT 返回的 live、`loadTarget` 只调一次、切组复位、新表进 draft、重建跟随）断言的**行为**在本 task 的实现里逐条保留，只是驱动方式依赖旧 DOM。要保留它们的页面级证据，在 Step 6 全绿后**另开一次提交**按新 DOM（`within(executionBlock(container))…` / `第 N 步` 标题按钮）逐条搬回来 —— 不要为了让它们过而改 Step 3 的实现。

- [ ] **Step 6: 跑整个文件 + 类型门，全绿后提交**

Run: `cd /home/lucascool/qa-board/frontend && npx vitest run src/views/LarkCheck.test.tsx`

期望输出：

```
 ✓ src/views/LarkCheck.test.tsx (8 tests)
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Run: `cd /home/lucascool/qa-board/frontend && npm run build`

期望输出：`tsc -b` 无输出、`✓ built in <1.5s` + `dist/assets/index-<hash>.js`。

Run: `cd /home/lucascool/qa-board && git add frontend/src/views/LarkCheck.tsx frontend/src/views/LarkCheck.test.tsx frontend/src/App.tsx && git commit -m "feat(web): rewrite the Lark check page as a health strip plus a four-step wizard"`
> Round 1 复审补丁：前端全量基线门 + 门 5 第一条的 e2e 覆盖（2026-09-18）

### Task 7: mock、e2e、清理、全量门

**Files:**
- Modify `frontend/mock-api.mjs` —— `:124` 后插 45 行（`TABLE_FIELDS`/`REQUIRED_FIELDS`/`schemaOf`，占新 **125-169**）；替换改动前 **735-750**（`/api/lark/resolve`，Step 1 后为 780-795）；其后插 5 行路由（占 **796-800**）
- Modify `frontend/e2e/lark-check.spec.ts` —— `:19` 后插夹具（`SCHEMAS`/`BAD_RESOLVE`）；`:74-76` 后插 `openStep`；`:111-113` 加 `table-schema` 分支；`:198` 前加 3 条断言；**230-249** 拆成两条用例；`:287` 前加一行 `openStep`（断言本身不改）；第 ④ 条用例后新增**两条**用例（门 1 回归 + 门 5 第一条吵醒条件）→ 全文件 **14 条 = 7 用例 × 2 视口**
- Delete `HeaderSetup.tsx`（946 行）与 `HeaderSetup.test.tsx`（738 行）—— 已删则只核查残留 · Modify `views/LarkCheck.tsx`（只删死 state/import）· `styles.css`（死规则）
- Create：无。不加依赖、不动后端

**Interfaces:**

**Consumes**（`task-04-components.md` / `task-05-steps.md` 已定稿的真实 DOM，本 task 照它写断言、不改它）

```tsx
// StepSection（task-05:220-235）
<section className={`lark-step lark-step-${state}`} data-state={state}>
  <h3 className="lark-step-heading">
    <button className="lark-step-title" aria-expanded={open}>…<span className="lark-step-index">第 {index} 步</span> {title}</button>
  </h3>
  {open ? <div className="lark-step-body">{children}</div> : null}
// 判决块（task-05:625-653）：bad 文案是 `{label}：{detail}`，unread 的按钮名恰为「校验」，bad/unreadable 的是「重新校验」
<div className="lark-role" data-role="execution|bug"><div className="lark-verdict" data-verdict={verdict}>…</div></div>   // 外层 .lark-step-tables（:684）
// 状态条（task-05:316）：<p className={`inline-status lark-health-strip ${health.tone}`} data-tone={health.tone}>
// 第 ② 步 plan 行（task-04:1085-1090）：`.lark-provision > .inline-status` 文案 `缺少 N 个表头：{角色} {n}` → 旧 e2e 的 `/缺少 2 个表头/` **仍然匹配**
// 队列（task-05:1143-1155）：`.lark-queue` / `.lark-queue-actions`，统计行含 ` · 最近错误 ${kind}`（:1147）——全部保留
// Task 4/5 沿用旧类名：.header-setup-*（:790-849）· .lark-provision*/.lark-new-table*（:1111-1166）· .lark-consent（task-05:965）
```

**Produces**

1. **mock 契约**：`POST /api/lark/table-schema` 按 `table_id` 给字段、按 `role` 算必填 —— `tbl-exec` 缺「截图」（有红字）、`tbl-bug` 两个角色的必填列都齐（切过去校验后红字消失）；`/api/lark/resolve` 与它同源，不许各写一份字段。mock 状态仍在内存里（照 `ATTEMPTS`/`deletedInLark`）。
2. **e2e 选择器**：全部落在上面这些**已存在**的钩子上 —— 不新增、不要求 Task 4/5/6 改名。收起态取不到控件时，用 `openStep` 点标题按钮（`aria-expanded` 已是 `true` 就不点），**不许把断言改成「可能可见」**。

---

- [ ] **Step 0: 先量出前端全量基线，写下 X（门 9 的前端可判定部分）**

CI 只跑 `npm ci && npx vitest run && npm run build`（`.github/workflows/publish.yml:56-64`，**没有 playwright、没有 e2e**），所以「全绿」可以靠删用例达成 —— 先复算两个不可变的 HEAD 数字：

```bash
cd /home/lucascool/qa-board
git ls-tree -r --name-only HEAD -- frontend/src | grep -cE '\.test\.tsx?$'   # 期望 21
git grep -ho '\bit(' HEAD -- frontend/src | wc -l                          # 期望 256
```

（两个数本机都核过：21 个 `*.test.ts(x)`、256 个 `it(`，且 256 条全部落在测试文件里。里面 76 条属于本次动到/删掉的文件：`src/components/HeaderSetup.test.tsx` 37、`src/views/LarkCheck.test.tsx` 39。）

新增用例逐文件（数字取自各分段自己写的期望输出，执行者可直接去核）：

| 文件 | 用例 | 出处 |
|---|---|---|
| `src/api.test.ts` | +1（2 → 3） | `task-02-03-draft.md:206` |
| `src/larkDraft.test.ts`（新） | 16 | `task-02-03-draft.md:839` |
| `src/hooks/useLarkDraft.test.tsx`（新） | 13 | `task-02-03-draft.md:1719` |
| `src/components/lark/ProvisionDialog.test.tsx`（新） | 13 | `task-04-components.md:905-909` |
| `src/components/lark/RetypeDialog.test.tsx`（新） | 5 | `task-04-components.md:1692` |
| `src/components/lark/RebuildDialog.test.tsx`（新） | 13 | `task-04-components.md:2330` |
| `src/components/lark/StepHeaders.test.tsx`（新） | 6 | `task-04-components.md:2504` |
| `src/components/lark/StepSection.test.tsx`（新） | 3 | `task-05-steps.md:243` |
| `src/components/lark/LarkHealthStrip.test.tsx`（新） | 3 | `task-05-steps.md:332` |
| `src/components/lark/StepTables.test.tsx`（新） | 6 | `task-05-steps.md:809` |
| `src/components/lark/StepApprove.test.tsx`（新） | 4 | `task-05-steps.md:991` |
| `src/components/lark/StepSync.test.tsx`（新） | 6 | `task-05-steps.md:1226` |

**X = 256 − 37 − 39 + (1+16+13+13+5+13+6+3+3+6+4+6) = 256 − 76 + 89 = 269。**

- 39 那一条按 **0** 计：`LarkCheck.test.tsx` 由 Task 6 重写（骨架 File Structure），重写后的条数此刻未知 → **269 是下界**，真实值只会更高（若重写后仍约 39 条，就是 308 上下）。Task 6 落地后回来把 39 换成实际数、把 X 抬高，**只许调高，不许调低**。
- 删掉的 76 例要有归属：37 条的逐条去向见 `task-04-components.md:206`「用例迁移对照表（旧 `HeaderSetup.test.tsx` → 4 个新文件，37 条全在）」＋`:7`「37 个 `it` 一条都不许丢」（13+5+13+6 = 37，正好对上）；39 条属 Task 6 的重写范围，重写后若有哪条不再存在，逐条在提交信息里点名并写出新归属。
- **不许为了变绿删断言**：任何新文件少一条、或某个旧用例在新文件里找不到归属，都算违规——补回来，而不是把 X 改小。

- [ ] **Step 1: `mock-api.mjs` 加表级校验夹具与算法**

插在第 124 行 `);`（`SCREENSHOT_PNG` 结尾）之后、第 125 行空行之前，**原样粘贴 45 行**（占新文件 125-169；原 125 行空行与 126 行 fixtures 横幅顺延到 170-171）：

```js
// 表级校验（POST /api/lark/table-schema）。判决必须按「当前选中的那张表 + 角色」
// 现算，所以这里刻意让两张表给出不同的答案：
//   执行记录（tbl-exec）缺「截图」→ 打开页面、校验它，就是一条红字；
//   冒烟测试bug表（tbl-bug）带齐两个角色各自的必填列 → 切过去、校验一次，红字消失。
// 这就是本次重构要演示的那条路径，也是本地手测「门 1」的入口。
const TABLE_FIELDS = {
  "tbl-exec": { 用例编号: "text", 结果: "single_select", 说明: "text", 控制台输出: "text" },
  // 两个角色的必填列都齐：它既是缺陷表的默认选项，也要能被当成执行表选中来演示门 1。
  "tbl-bug": {
    用例编号: "text",
    结果: "single_select",
    截图: "attachment",
    问题描述: "text",
    进展状态: "single_select"
  }
};
// 必填列按 role 算，与后端一致：execution 用 REQUIRED_RUN_FIELD_TYPES、bug 用
// REQUIRED_BUG_FIELD_TYPES（backend/app/lark/fields.py:61/:73，两边都含「截图」）。
const REQUIRED_FIELDS = {
  execution: ["用例编号", "结果", "截图"],
  bug: ["问题描述", "进展状态", "截图"]
};

// 表不在 base 里 → 422（真实接口也是 422：表没了与没权限是两回事）；role 非法 → 422。
function schemaOf(tableId, role) {
  if (!Object.hasOwn(TABLE_FIELDS, tableId)) {
    return { status: 422, body: { detail: `这个多维表格里没有这张数据表：${tableId}` } };
  }
  if (!Object.hasOwn(REQUIRED_FIELDS, role)) {
    return { status: 422, body: { detail: `role 必须是 execution 或 bug：${role}` } };
  }
  const fields = TABLE_FIELDS[tableId];
  const required = REQUIRED_FIELDS[role];
  return {
    status: 200,
    body: {
      table_id: tableId,
      fields,
      required,
      schema_errors: required
        .filter((name) => !Object.hasOwn(fields, name))
        .map((name) => `缺少必填字段「${name}」`)
    }
  };
}
```

- [ ] **Step 2: `mock-api.mjs` 让 `/api/lark/resolve` 与它同源**

替换改动前第 **735-750 行**（`if (path === "/api/lark/resolve") {` 到它的 `}`）为下面 21 行。两处各写一份字段，就会出现「读取时说缺截图、校验后说不缺」的自相矛盾 mock。

```js
  if (path === "/api/lark/resolve") {
    // 执行表的判决与 /api/lark/table-schema 同源：两处都不能各自手写一份字段，
    // 否则「读取时的红字」与「校验后的红字」会互相打脸。
    // 注意 execution_fields 的值现在是真正的类型名：旧 mock 回的是「字段名→字段名」，
    // 字段 chips 会显示成 用例编号 · 用例编号。
    const execution = schemaOf("tbl-exec", "execution").body;
    return send(res, 200, {
      source_url: "https://example.larksuite.com/base/mockBaseToken",
      base_token: "mockBaseToken",
      base_name: "Odyssey 冒烟测试",
      tables: [
        { table_id: "tbl-exec", name: "执行记录" },
        { table_id: "tbl-bug", name: "冒烟测试bug表" }
      ],
      selected: { table_id: "tbl-exec", table_name: "执行记录", view_id: null },
      execution_fields: execution.fields,
      required_execution_fields: execution.required,
      schema_errors: execution.schema_errors,
      read_errors: []
    });
  }
```

- [ ] **Step 3: `mock-api.mjs` 注册 `POST /api/lark/table-schema`**

紧接上面 resolve 块的 `}` 之后、`if (path === "/api/ai-prompts")` 之前，占 **796-800 行**：

```js
  if (path === "/api/lark/table-schema") {
    const payload = await body(req);
    const answer = schemaOf(payload?.table_id, payload?.role);
    return send(res, answer.status, answer.body);
  }
```

`body()` 已存在（`:530-540`），空 body / 坏 JSON 都回 `{}` → `schemaOf(undefined, undefined)` → 422。`send()` 会打一行 `200 POST /api/lark/table-schema`，手测看得到。

- [ ] **Step 4: 手测 mock（两分钟，不开浏览器）**

```bash
cd /home/lucascool/qa-board/frontend && node mock-api.mjs &
curl -s -X POST 127.0.0.1:8000/api/lark/table-schema -H 'Content-Type: application/json' \
  -d '{"base_token":"mockBaseToken","table_id":"tbl-exec","role":"execution"}'
curl -s -X POST 127.0.0.1:8000/api/lark/table-schema -H 'Content-Type: application/json' \
  -d '{"base_token":"mockBaseToken","table_id":"tbl-bug","role":"execution"}'
kill %1
```

期望（键顺序一致；第二条与第一条的差别就是「切表后红字消失」的全部依据）：

```
{"table_id":"tbl-exec","fields":{"用例编号":"text","结果":"single_select","说明":"text","控制台输出":"text"},"required":["用例编号","结果","截图"],"schema_errors":["缺少必填字段「截图」"]}
{"table_id":"tbl-bug","fields":{"用例编号":"text","结果":"single_select","截图":"attachment","问题描述":"text","进展状态":"single_select"},"required":["用例编号","结果","截图"],"schema_errors":[]}
```

- [ ] **Step 5: e2e 加表级校验夹具**

插在 `frontend/e2e/lark-check.spec.ts` 改动前第 19 行 `};`（`RESOLVED` 结尾）之后：

```ts
const RUNS_FIELDS = { 用例: "text", 结果: "single_select" };
const BUGS_FIELDS = { 用例: "text", 结果: "single_select", 截图: "attachment", 问题描述: "text", 进展状态: "single_select" };
// 判决在这里现算：字段缺了就进 schema_errors —— 与后端同一条口径，也与 mock-api 的
// schemaOf 同一条口径（两处各写一份就会出现「读取说缺、校验说不缺」的自相矛盾）。
const schema = (table_id: string, fields: Record<string, string>, required: string[]) => ({
  table_id,
  fields,
  required,
  schema_errors: required.filter((name) => !(name in fields)).map((name) => `缺少必填字段「${name}」`)
});

const SCHEMAS: Record<string, ReturnType<typeof schema>> = {
  "tbl-runs:execution": schema("tbl-runs", RUNS_FIELDS, ["用例", "结果", "截图"]),
  "tbl-runs:bug": schema("tbl-runs", RUNS_FIELDS, ["问题描述", "进展状态"]),
  "tbl-bugs:execution": schema("tbl-bugs", BUGS_FIELDS, ["用例", "结果", "截图"]),
  "tbl-bugs:bug": schema("tbl-bugs", BUGS_FIELDS, ["问题描述", "进展状态"])
};

// 门 1 的起点：resolve 说 tbl-runs 缺「截图」。判决由 resolve 播种（零请求），
// 所以「旧红字」在第一次切表之前就在屏幕上。
const BAD_RESOLVE = {
  ...RESOLVED,
  execution_fields: { 用例: "text", 结果: "single_select" },
  schema_errors: ["缺少必填字段「截图」"]
};
```

- [ ] **Step 6: e2e 加 `openStep` 助手**

StepSection 收起时**不渲染** `children`（`task-05:234`），所以要点控件先展开它；标题按钮的可访问名是 `第 {index} 步 {title}`，用 `aria-expanded` 判断当前是否已展开（`task-05:226`）。插在 `function tableName(...)`（改动前第 74-76 行）之后：

```ts
// 收起态没有 body：先点标题按钮展开。已经展开就不点（再点一次是收起）。
async function openStep(page: Page, index: number) {
  const toggle = page.getByRole("button", { name: new RegExp(`^第 ${index} 步`) });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}
```

- [ ] **Step 7: `mockApi` 里加 `table-schema` 分支**

替换改动前第 **111-113 行**为下面 12 行。没登记的键回一张空字段的 **ok** 表，但必须回**请求的那张表** —— hook 会核对 `schema.table_id`，回错了被当成读失败（`task-02-03-draft.md:1515-1521`）：

```ts
    if (pathname === "/api/lark/resolve") {
      return route.fulfill({ json: RESOLVED });
    }
    if (pathname === "/api/lark/table-schema" && method === "POST") {
      const payload = request.postDataJSON() as { table_id?: string; role?: string };
      const key = `${payload.table_id}:${payload.role}`;
      return route.fulfill({
        json:
          SCHEMAS[key] ??
          { table_id: payload.table_id ?? "", fields: {}, required: [], schema_errors: [] }
      });
    }
```

- [ ] **Step 8: queue 用例补三条断言（门 5 的第二个吵醒条件）**

改动前第 **198 行** `await expect(page.getByText(/最近错误 create_execution_failed/)).toBeVisible();` **之前**插入（该用例在外层 `for` 里，两档都跑）：

```ts
    // 门 5：failed > 0 → 状态条变红 + 第 ④ 步自动展开（不需要点标题）。
    await expect(page.locator(".lark-health-strip")).toContainText("同步失败 1 条");
    await expect(page.locator(".lark-step").filter({ hasText: "第 4 步" })).toHaveAttribute("data-state", "open");
    await expect(page.locator(".lark-step").filter({ hasText: "第 4 步" })).toContainText("最近错误");
```

- [ ] **Step 9: 把「real names and blocks writes」用例换成两条**

改动前第 **230-249 行**（`test(\`${viewport} Lark check shows real names and blocks writes until consent\`…)` 整块含结尾 `});`；**229 行的 `for` 头不许动**）整段换成下面两条。拆开是因为健康态状态条（骨架第 8 行）只在已确认时出现，而「同意前不许确认」只在未确认时有意义。

```ts
  test(`${viewport} a healthy page is one status line and four step titles`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    // 后注册的先命中：这一条 target 已确认，状态条走「健康」分支（骨架第 8 行）。
    await page.route(`**/api/groups/${GROUP_ID}/lark/target`, (route) =>
      route.fulfill({
        json: {
          target: { ...TARGET, confirmed: true, confirmed_at: "2026-09-17T08:35:17Z" },
          live: { schema_errors: [], read_errors: [] },
          read_errors: []
        }
      })
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    const strip = page.locator(".lark-health-strip");
    await expect(strip).toContainText("已确认 · 执行记录 / 缺陷记录");
    await expect(strip).toContainText("待同步 0 · 失败 0");
    // 验收门 4：健康态 = 1 行状态条 + 4 行步骤标题，且页面里没有 role="alert"。
    await expect(page.locator(".lark-step")).toHaveCount(4);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-lark-healthy-${viewport}.png`, fullPage: true });
  });

  test(`${viewport} writes stay blocked until both tables are checked and consent is given`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    // 未确认的状态条（骨架第 7 行）。
    await expect(page.locator(".lark-health-strip")).toContainText("未确认：本地结果不会写入 Lark");
    const confirmButton = page.getByRole("button", { name: /确认本组写入目标/ });
    await expect(confirmButton).toBeDisabled();

    // 门 3：链接没读之前，两个 role 各自「尚未校验这张表」，不借用任何结论。
    await openStep(page, 1);
    const stepOne = page.locator(".lark-step-tables");
    await expect(stepOne.getByText("尚未校验这张表")).toHaveCount(2);

    // 读链接：执行表判决由 resolve 播种（零请求），同库缺陷表顺手校验一次。
    // 两表都 ok 之后勾选框才可用（规格 §5.2 第 ③ 步）。
    await page.getByLabel("Lark 文档链接").fill(RESOLVE_URL);
    await page.getByRole("button", { name: "读取表格" }).click();
    await expect(stepOne.getByText("尚未校验这张表")).toHaveCount(0);
    await expect(page.getByLabel("允许向上述旧表新增本组记录")).toBeEnabled();
    await page.getByLabel("允许向上述旧表新增本组记录").check();
    await expect(confirmButton).toBeEnabled();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-lark-consent-${viewport}.png`, fullPage: true });
  });
```

- [ ] **Step 10: 第 ② 步用例：在断言前展开第 ② 步，plan 行断言不动**

`await expect(page.getByText(/缺少 2 个表头/)).toBeVisible();`（改动前第 287 行）**保持原样** —— Task 4 的那行文案是 `缺少 2 个表头：执行记录表 2`（`task-04:1085-1090`），正则仍然命中。但那一行渲染在第 ② 步 body 里（收起态不渲染 `children`），而且 `设置表头` 按钮也在 body 里，所以要在它**前面**加一行：

```ts
    await openStep(page, 2);
```

同一条用例里其余断言（弹窗内 `创建这些表头`/`创建表头「结果」`/`创建表头「日期」`/`同时创建 TestDeck 视图`、结尾 `已创建 1 个表头，请重新确认写入`）**一个字都不改** —— 那是门 6 的断言，Task 4 已逐字保留（`task-04:386`/`:152`）。切换执行表的变更弹窗用例（改动前 251-278 行）也不用改：它用的可访问名全在契约表里。

- [ ] **Step 11: 新增两条 e2e（门 1 回归 + 门 5 第一条吵醒条件）**

在第 ④ 条用例（`setting headers sends only the ticked names after a confirmation`）结尾的 `});` 之后、外层 `for` 的 `}` 之前插入（改动前即在第 328/329 行之间；必须在循环内，两档都要跑）：

```ts
  test(`${viewport} switching the execution table clears the old table's red banner`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    const schemaCalls: string[] = [];
    await page.route("**/api/lark/resolve", (route) => route.fulfill({ json: BAD_RESOLVE }));
    await page.route("**/api/lark/table-schema", (route) => {
      const body = route.request().postDataJSON() as { table_id?: string; role?: string };
      const key = `${body.table_id}:${body.role}`;
      schemaCalls.push(key);
      return route.fulfill({
        json:
          SCHEMAS[key] ??
          { table_id: body.table_id ?? "", fields: {}, required: [], schema_errors: [] }
      });
    });
    await page.route(`**/api/groups/${GROUP_ID}/lark/target`, (route) =>
      route.fulfill({
        json: {
          target: { ...TARGET, confirmed: true, confirmed_at: "2026-09-17T08:35:17Z" },
          live: { schema_errors: [], read_errors: [] },
          read_errors: []
        }
      })
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();
    await openStep(page, 1);

    await page.getByLabel("Lark 文档链接").fill(RESOLVE_URL);
    await page.getByRole("button", { name: "读取表格" }).click();

    // 红字属于 tbl-runs，来自 resolve 的播种 —— 一次请求都没发。
    const execution = page.locator('.lark-role[data-role="execution"]');
    await expect(execution.getByText("缺少必填字段「截图」")).toBeVisible();
    expect(schemaCalls).not.toContain("tbl-runs:execution");
    // 同库缺陷表被顺手校验了一次（规格 §8），那是另一张表的判决。
    expect(schemaCalls).toContain("tbl-bugs:bug");

    // 本次 bug 的回归：切到另一张表，旧表的判决不许跟过来（验收门 1）。
    await page.getByLabel("执行记录表").selectOption("tbl-bugs");
    await expect(page.getByText("缺少必填字段「截图」")).toHaveCount(0);
    // 未校验就是未校验，也不借用 tbl-bugs:bug 的结论（验收门 3）。
    await expect(execution.getByText("尚未校验这张表")).toBeVisible();

    // 校验当前选中的表：这张表自己 ok，红字不回来；同表不重复发请求（门 7）。
    await execution.getByRole("button", { name: "校验", exact: true }).click();
    await expect(execution.getByText("尚未校验这张表")).toHaveCount(0);
    await expect(page.getByText("缺少必填字段「截图」")).toHaveCount(0);
    expect(schemaCalls.filter((key) => key === "tbl-bugs:execution")).toHaveLength(1);

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-switch-table-${viewport}.png`, fullPage: true });
  });
```

接着插第二条（门 5 的**第一条**吵醒条件；第 ④ 步那条已经在 Step 8 里覆盖了，两条对称）。现有 fixture 的 `schema_errors` 恒为 `[]`（改动前 `:17,45,124,141,190`），所以这条路径此前 e2e 零覆盖 —— 它是规格 §1.1 自认的缺口，也是 `live` 那条红字唯一的回归网：

```ts
  test(`${viewport} a stale header wakes the status line and opens the header step`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    // 门 5 的第一条：服务端对**已保存目标**的重读报表头失效（`live.schema_errors`）。
    // target 已确认 → 骨架 §describeHealth 第 3 行（task-02-03-draft.md:773 的实现用词）。
    await page.route(`**/api/groups/${GROUP_ID}/lark/target`, (route) =>
      route.fulfill({
        json: {
          target: { ...TARGET, confirmed: true, confirmed_at: "2026-09-17T08:35:17Z" },
          live: { schema_errors: ["缺少必填字段「截图」"], read_errors: [] },
          read_errors: []
        }
      })
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    // 状态条变红，并且说清是哪一步的事。
    const strip = page.locator(".lark-health-strip");
    await expect(strip).toHaveAttribute("data-tone", "bad");
    await expect(strip).toContainText("已确认，但表头已失效（需重新校验）");
    // 第 ② 步自动展开，不需要点标题 —— 与 Step 8 里第 ④ 步那条断言对称。
    await expect(page.locator(".lark-step").filter({ hasText: "第 2 步" })).toHaveAttribute("data-state", "open");

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-lark-stale-header-${viewport}.png`, fullPage: true });
  });
```

这条断言依赖骨架 §Interfaces 里那句注释：`describeHealth` 的 `liveErrors` 只收 `state.read_errors + live.read_errors`，`live.schema_errors` 走 `schemaInvalid` 单独一路（`task-02-03-draft.md:110-114`）。若 Task 6 把 `schema_errors` 也塞进 `liveErrors`，屏幕上会变成第 2 行的 `目标表读取失败：…` —— 那是**实现错**（第 2 行本意是「读不到」），改 Task 6，不许改这条断言。

- [ ] **Step 12: 清理 HeaderSetup 残留**

```bash
cd /home/lucascool/qa-board
git rm -q --ignore-unmatch frontend/src/components/HeaderSetup.tsx frontend/src/components/HeaderSetup.test.tsx
grep -rn "HeaderSetup" frontend/src frontend/e2e; grep -rn "components/HeaderSetup" frontend --include=*.ts --include=*.tsx --include=*.mjs -l
```

两条 grep 都要**无输出**。依据（我核过）：`HeaderSetup.tsx` 只有**一个** export（`:141 export function HeaderSetup`），其余 6 个符号模块私有；唯一消费者是 `views/LarkCheck.tsx:26,704`，Task 6 重写后归零。`HeaderSetup.test.tsx:6,20,25…` 只测它自己。

- [ ] **Step 13: 清理 `LarkCheck.tsx` 的死 state**

先跑审计（**`tsc -b` 不会替你抓**：`tsconfig.app.json` 没开 `noUnusedLocals`，`package.json` 也没有 lint 脚本，死变量只有 grep 能证明）：

```bash
cd /home/lucascool/qa-board/frontend
for name in $(grep -oE "const \[[a-zA-Z]+, set[A-Za-z]+\]" src/views/LarkCheck.tsx | sed -E 's/const \[([a-zA-Z]+),.*/\1/'); do
  printf '%-22s %s\n' "$name" "$(grep -c "\b$name\b" src/views/LarkCheck.tsx)"
done
grep -n "bugReadUrl\|bugReadApplies\|readingBug\|bugResolved\|executionTableId\|bugTableId" src/views/LarkCheck.tsx
grep -n "function nameOf\|function suggestBugTable\|function withCreatedTable\|type CreatedTable\|type Identity" src/views/LarkCheck.tsx
```

判定与动作（第一条命令计数 **= 1 表示只有声明、没人用**）：

1. 每行必须 **≥ 2**；任何 `1` 都是死 state → 删声明与它的 `set*`，相关 import 用 `grep -c "\b名字\b"` 一起判。
2. 第二条**期望无输出**：`bugReadUrl`（今日 `:139,183,316`）→ `baseIsCurrent`、`bugReadApplies`（`:223-224`）→ `effectiveBase`、`readingBug`（`:145`）→ hook 的 `reading: TableRole | null`（骨架 §4.3 对应表）。重写后还留着的就是死 state，删。
3. 第三条**期望无输出**：`nameOf`/`suggestBugTable`/`withCreatedTable`/`CreatedTable`/`Identity` 都是 `larkDraft.ts` 的导出；页面里再出现同名本地实现就是重复实现，删本地那份、改 import。

**不许顺手改逻辑**：只删「计数为 1 的声明」与「已无人引用的 import」，`git diff` 应当只剩 `-` 行。

- [ ] **Step 14: 清理 `styles.css` 里不再被引用的 `.lark-*` 规则**

逐条先问 grep，**空输出才删**（`\b` 是必须的：`lark-role` 是 Task 5 的**新**类，见下）：

```bash
cd /home/lucascool/qa-board/frontend
for c in lark-healthy lark-facts lark-fields lark-field lark-roles; do
  printf '%-14s %s\n' "$c" "$(grep -rl "$c\b" src --include=*.tsx | tr '\n' ' ')"
done
```

要删的（每条都核过消费者）：

| 规则（今日行号） | 消费者 | 判断依据 |
|---|---|---|
| `.lark-healthy`（110 行**左半**） | **无**（`grep -rl "lark-healthy\b" src --include=*.tsx` 空） | 死规则。同一行右半 `.inline-status.saved { color: #1c6b45; }` **必须留** —— 全站 `saved` 状态 |
| `.lark-facts`（111-112） | 只有 `LarkCheck.tsx:567`（「已保存的目标」dl，§5.1 换成状态条） | Task 5 的 StepTables 用的是 `.lark-role*`，不碰它 |
| `.lark-fields` / `.lark-field`（113） | 只有 `LarkCheck.tsx:630-636`（执行表字段 chips，§5.2 ① 换成按表判决） | 同上 |
| `.lark-roles`（126） | 只有 `LarkCheck.tsx:607` | **别把 `.lark-role` 当成它的消费者**：Task 5 的新类是 `lark-role`/`lark-role-tables`/`lark-role-note`，与 `lark-roles` 是两回事 |

**明确保留（Task 4/5 已在用，删了它们就红）**：`.lark-check-layout`（约束 9 的 900px 容器）· `.lark-panel`/`.lark-panel-heading`（`Reconcile.tsx` 也用）· `.lark-consent`（`task-05:965`）· `.lark-queue`/`.lark-queue-actions`（`task-05:1143-1155`，e2e 取盒钩子）· `.lark-provision`/`.lark-provision-actions`/`.lark-new-table*`（`task-04:1111-1166`）· `.header-setup-*`（`task-04:790-849`、`:1595-1643`、`:2205-2227`，三个对话框原样沿用旧类名）· `.sync-badge`（`Execution.tsx:714`）· Task 5 新增的 `.lark-step*`/`.lark-health-*`/`.lark-role*`/`.lark-verdict`。

**因此第 161、221 行的共享选择器列表这次不用动**（`.header-setup-overlay` / `.header-setup-dialog` 仍在用）。若将来真要摘，只能从名单里删一项、不能整行删 —— 整行删掉的后果是 TargetChangeDialog / 对账 / 归档弹窗失去遮罩，而 vitest 不会红。

- [ ] **Step 15: 跑四条全量门**

```bash
# ① 类型 + 产物（骨架基线：✓ built in 1.32s / index-li5seUpy.js，哈希每次都变）
cd /home/lucascool/qa-board/frontend && npm run build
# 期望：`tsc -b` 无任何输出；vite 打 `✓ built in …`；dist/assets/index-<hash>.js 与 .css 各一份；exit 0。
# 任何 TS 报错都停下修 —— vitest 不做类型检查，它绿了不算。

# ② 全量前端单测（Step 0 的 X 就是判据）
cd /home/lucascool/qa-board/frontend && npx vitest run
# 期望：exit 0；`Tests  N passed (N)` 的 N ≥ 269（= X），输出里没有 failed / skipped / todo；
# 必须有 src/larkDraft.test.ts、src/hooks/useLarkDraft.test.tsx、src/views/LarkCheck.test.tsx、
# src/components/lark/*.test.tsx；`src/components/HeaderSetup.test.tsx` 不再出现。
# 计数只是下界（it( 数与 vitest 报的条数可能因循环生成而不同）：N ≥ X 且 0 failed 才算过；
# N 掉到 X 以下 = 有用例被删，回去补，不许改 X。再复算一次当前工作树的计数：
cd /home/lucascool/qa-board/frontend && grep -rl "" src --include=*.test.ts --include=*.test.tsx | wc -l   # 期望 ≥ 31（21 − 1 + 11 个新文件）
cd /home/lucascool/qa-board/frontend && grep -rho '\bit(' src --include=*.test.ts --include=*.test.tsx | wc -l  # 期望 ≥ 269

# ③ e2e（门 8 + 门 1 + 门 5 第一条）：14 条 = 7 条用例 × 2 档视口（queue 1 条 + 循环内 6 条）
cd /home/lucascool/qa-board/frontend && npx playwright test e2e/lark-check.spec.ts
# 期望：`14 passed`、exit 0。缺一条就说明 Step 9/10/11 有哪条没插进去 —— 别把期望改小。
# test-results/*.png 被新页面覆盖（§12 P3 已接受）。

# ④ 后端（容器 testdeck-task2-postgres 在 127.0.0.1:5433，docker ps 核过是 Up）
cd /home/lucascool/qa-board/backend && TEST_DATABASE_URL=postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test .venv/bin/python -m pytest tests/test_lark_target.py -q
# 期望：`43 passed, 2 warnings in 4.11s`（Task 1 Step 7 实测）。骨架「环境与命令」里的
# `29 passed` 是 **Task 1 之前** 的 HEAD 基线；这里若看到 29，说明那 14 个新用例没落盘。
```

`uv` 不在 PATH 上，后端一律 `.venv/bin/python -m pytest`；不给 `TEST_DATABASE_URL` 会变 29 errors（骨架原话）。

- [ ] **Step 16: 自查后提交**

五条自查，答不上就不提交：

1. `git status --porcelain` 只有 `frontend/mock-api.mjs`、`frontend/e2e/lark-check.spec.ts`、`frontend/src/views/LarkCheck.tsx`、`frontend/src/styles.css` 与两个 `D  frontend/src/components/HeaderSetup*`。**不许**有后端改动、迁移、`dist/`、`api.ts` 或新组件（属 Task 1-6）。
2. `git diff frontend/src/views/LarkCheck.tsx` 只有删除行（Step 13 的约束）。
3. 契约里那两个钩子真在：`grep -c "lark-step-body\|data-state" frontend/src/components/lark/StepSection.tsx` 与 `grep -c "lark-health-strip" frontend/src/components/lark/LarkHealthStrip.tsx` 都 ≥ 1。
4. 断言没被放松：`grep -c "toBeVisible\|toHaveCount\|toContainText\|toHaveAttribute\|toBeDisabled\|toBeEnabled" frontend/e2e/lark-check.spec.ts` 必须 **不少于**开工前先记下的那个数。
5. **用例数没缩水**（门 9 的可判定部分）：`npx vitest run` 的 `Tests  N passed (N)` 满足 N ≥ 269（Step 0 的 X），且 `grep -rho '\bit(' src --include=*.test.ts --include=*.test.tsx | wc -l` ≥ 269、`grep -rl "" src --include=*.test.ts --include=*.test.tsx | wc -l` ≥ 31。哪一项低了，就是有人删了用例来换绿 —— 先补回来。

```bash
cd /home/lucascool/qa-board && git add frontend/mock-api.mjs frontend/e2e/lark-check.spec.ts frontend/src/views/LarkCheck.tsx frontend/src/styles.css frontend/src/components/HeaderSetup.tsx frontend/src/components/HeaderSetup.test.tsx && git commit -m "test(lark): mock per-table schema, cover the switch, retire the old setup UI" -m "Verdicts are derived from the table that is selected right now, so both mocks answer per table_id + role: 执行记录 is missing 截图 and 冒烟测试bug表 is not — that is what makes 切表后红字消失 observable without a real Lark tenant." -m "The e2e keeps both viewports and the no-overflow check on every case, gains one case for the regression, and drops the assertions that pointed at the three stacked panels. What leaves with it — HeaderSetup.tsx, its test, the state the rewrite left behind, the CSS nothing references — is checked by grep, not by eye: this repo reports no unused locals and has no lint script, so dead state would otherwise ride along silently."
```

提交只带产品代码。`docs/superpowers/plans/**` 此刻仍是 untracked，本 task 不把它一起提交。

---

## 附录 A · Round 1 独立对抗性复审（原文，未删改）

> 这份复审由**独立只读 subagent** 产出，职责是挑战而非确认。其 A 类（照抄会出错）与 B 类（计划缺口）意见已按 §Task 3b 与各 Task 的补丁并入正文；保留原文是为了让执行者看到「哪些地方曾经被判为错」，而不是只看到一份自洽的成品。
>
> 附录里引用的 `_parts/xxx.md` 是分段写作时的中间文件，**定稿时已全部并入本文件的 Task 1–7 正文并从仓库删除**；对应关系：`task-01`→Task 1、`task-02-03`→Task 2/3、`task-04`→Task 4、`task-05`→Task 5、`task-06`→Task 6、`task-07`→Task 7。

# Round 1 对抗性复审（Task 1 / Task 2–3）

复审对象：`docs/superpowers/specs/2026-09-18-lark-check-page-redesign-design.md`（下称**规格**）、`docs/superpowers/plans/2026-09-18-lark-check-page-redesign.md`（下称**骨架**）、`_parts/task-01-backend.md`（下称 **T1**）、`_parts/task-02-03-draft.md`（下称 **T23**）。
所有行号都是**当前工作区**的行号；凡是我用脚本量过的数字，方法都写在 F。

---

## A. 照抄会出错（阻塞级）

| # | 位置 | 现象 | 为什么错 | 应改为 |
|---|---|---|---|---|
| A1 | T1:5（`target.py:230-231` / `:335-358`）、T1:412（"83 行；插完 `TableSchemaRequest` 在 233 行"）、T1:6（"改完后 `_refuse_bad_token` 在 419-426 行、`_validate_target_tokens` 从 429 行起、循环体变成 447-448 行"）、T1:500（"`target.py:335` 起，把 `_validate_target_tokens` 拆成…"） | Step 5 给的整块代码实测是 **81 行**（T1:415-495），不是 83 行。照抄后总位移是 +82（`import re` +1，整块 +81），于是：`TableSchemaRequest` 落在 **232**（不是 233）、Step 6 之后 `_refuse_bad_token` 在 **417-424**、`_validate_target_tokens` 从 **427** 起、循环体在 **445-446**。全部比 T1 声称的少 2 行 | 最要命的是 T1:500 的 `target.py:335 起`：Step 5 **已经**把函数从 335 挪到 417，此时原 335 行位置（位移后第 335 行 = 原文 253 行）在 `locked_target_for` 的 docstring 里（"the 3 s ``statement_timeout`` that ``app/db.py`` sets…"，`target.py:253`）。按行号施工的人会改到那段 docstring。Step 3 期望输出里的 `tests/test_lark_target.py:142`（T1:378）是对的，别再拿它当行号可信的证据 | 要么把整块补成真的 83 行（首尾各留一个空行），要么把 `Files:`/Step 5/Step 6 的行号全部按 +82 重算，并把 Step 6 的锚点从 `:335` 改成"定位 `def _validate_target_tokens`" |
| A2 | T1:9、T1:105（"整块 240 行"）、T1:9（"插入后占 116-355 行，`_payload` 下移到 356 行"） | Step 2 给的测试整块实测 **254 行**（T1:108-361）。`def _payload` 经 Step 1 的 +4 位移后确实在 116，所以插入后：整块占 **116-369**、`_payload` 落在 **370**，不是 355/356。Step 3 的 `14 failed, 29 deselected`（T1:394）和 Step 7 的 `43 passed`（T1:549）我核过是对的（9 个函数 × parametrize = 14；文件原有 29 例，见 F） | 粘贴锚点是文本（"`def _payload` 之前"），所以内容不会错；错的是"240 行""116-355""356"这三个自检数字——工人若拿它们核对插入位置会以为自己粘错了，可能去裁掉 14 行（那会删掉末尾两个用例） | 把 240→254、355→369、356→370；或干脆删掉这类行号自检，只说"整块粘贴、`_payload` 之前" |
| A3 | T23:1493（`inFlight` 声明）、T23:1507-1508（判重 + 加入）、T23:1535（`finally` 删除）、T23:951（"重复请求由 `inFlight`（同一 `table_id:role` 并发去重）挡住"）；`frontend/src/api.ts:420-440`（`request` 无超时、无 `AbortSignal`） | `inFlight` 的 key 只有 `probeKey(tableId, role)`，**不含 base 身份**，而且没有超时回收。两条真实路径：① 用户在 base A 点了校验（在途），马上改链接框读到 base B（`tbl-runs` 在两个 base 都存在是常态：`conftest.py:279-283` 里 `app-exec`/`app-token` 都有 `tbl-runs`），再点校验 → `checkTable` 直接 `return`：**不发请求、不写 loading、不报错**，按钮点了没反应，规格 §8「切 base → 按 `base_token` 归属作废该 role 的 probe」要求的"重新校验"被静默吞掉。② 一次 `fetch` 永不返回（无超时）→ 该 key 永久留在 `inFlight`，这张表的"校验"按钮在本次页面生命周期内**永久失效**，只能改链接框/切组 | "并发去重"只对**同一个 base 的同一次校验**成立；把 base 身份（`base_token`，或更好的 base 对象身份）并入 key，并在 `readTableSchema`/`request` 上加超时或 `AbortSignal`，保证 `finally` 一定跑得到 |
| A4 | T23:1672-1693（`acceptRebuiltTable`） | 重建时删了被替换表的 probe（1672）并作废**另一 role** 的 probe（1673），但**没有把另一 role 的 `tableId` 一起跟随**。规格 §4.2 明确承认"同一张表既当执行表又当缺陷表"（两套 required 各自成立）——正是这种配置下，`draft[other].tableId` 仍指向已被 `base.tables.filter(...)` 移除的旧表（1676-1680），下拉里显示一张不存在的表，下一次「保存选择」会把该 role 重新指向被替换掉的旧表（规格 §8:242 警告的正是这件事） | 后端会兜住：保存时 `read_draft_state` 读不到该表 → `target.py:441-442` 409，所以不会静默写坏数据；但用户在页面上走到的是一条死路（选中项在 Lark 里已不存在），且没有任何测试覆盖"两 role 同表 + 重建" | 在 `acceptRebuiltTable` 里，若 `current[otherRole(role)].tableId === replaced.table_id`，把它改成 `table.table_id`（或在页面上明确要求重选）；并给这条路径加一个 hook 用例 |
| A5 | 骨架:33（"基线：✓ built in 1.32s，`dist/assets/index-li5seUpy.js`"） | 工作区里没有这个产物：`frontend/dist/assets/` 只有 `index-Dx930F5e.js` 与 `index-BaL0XFeg.css` | 骨架的环境块开头写着"已在本机逐条跑过，基线如下"，三个基线里有一个对不上当前 checkout。这不是致命错误，但它让"照抄就能核对"的承诺失效：工人 build 完看到别的 hash，会怀疑自己的改动 | 把产物 hash 换成当前 dist 的真实值，或删掉 hash 只留"build 通过" |
| A6 | 规格:53（"最长一段说明 194 字（`LarkCheck.tsx:822-827`），另一段 78 字（`:818-820`）"） | 按 JSX 文本节点去空白实测：`:823-825` 那段（`syncParked`）≈ **139 字**（其中 824 行本身 130 字），`:817-820` 那段（释放待人工确认）≈ **43 字**。行号定位是对的，字数分别虚高约 1.4× 与 1.8× | 规格 §1.2 的立论是"啰嗦（量化，不是观感）"，§5.2 又用这段字数决定"长说明只在计数 > 0 时出现"；数字不实会让"精简到多少"失去基准。**非阻塞**（不影响代码），但属于"断言与真实不符" | 换成实测值，或改成"最长说明约 140 字"并保留行号；顺便把 `:822-827` 标成 `<p>` 的真实范围（822 是条件行、823 才是 `<p>`） |

---

## B. 计划缺口（缺失的步骤/分支/测试）

- **B1（最大缺口）Task 4–7 根本不存在。** 骨架:309 仍是 `<!-- TASK-SECTIONS-INSERT-HERE -->`，`_parts/` 下只有 `task-01-backend.md` 与 `task-02-03-draft.md`。骨架:44-69 的 File Structure 列了 12 个文件的动作（删 `HeaderSetup.tsx`、重写 `LarkCheck.tsx`、5 个展示组件、`styles.css`、`App.tsx`、`e2e/lark-check.spec.ts`、`mock-api.mjs`、删 `HeaderSetup.test.tsx`），**没有一条有步骤、命令、测试文件或提交点**。规格 §11 的落地顺序第 3–7 步全部无主。
- **B2 既有前端测试的存量与去留没有写。** 当前 `frontend/src/**/*.test.ts*` 共 **21 个文件、≥256 个用例**（数字与计数方法见 F）；其中 `components/HeaderSetup.test.tsx` **37 例**、`views/LarkCheck.test.tsx` **39 例**会被 Task 4/6 删除或重写（骨架:63-65 只说"迁到三个对话框各自的测试"）。CI 跑的是全量：`.github/workflows/publish.yml:64-68` = `npx vitest run` + `npm run build`。因此：**没有任何前端全量基线数字，也没有"删掉的每条断言落到哪个新文件"的映射** → 门 9 可以靠删测试通过（B1 未写，Task 4/6 又正是删测试的那两步）。缺：① 基线快照（文件数/用例数）；② `HeaderSetup.test.tsx` 37 条断言的逐条去向清单；③ "不得净减少断言数"的规则。
- **B3 设计里唯一"非结构性"的机制没有测试。** 整个方案的卖点是"切表=换 key，结构性根治"，唯一靠运行时守卫的是 `withSlot` 的 base 归属判据（T23:1445-1456）。门 3 的用例（`larkDraft.test.ts:315-325`、T23:1163-1176）都是"先编辑链接框、后渲染"，**没有**"请求在途 → 编辑链接框 → 响应到达"的顺序。规格 §8:244「链接框内容被编辑 → base 与判决一并作废」在异步落地时是否成立，全靠这段没人测的守卫。缺：一个"resolve/readTableSchema 在 `setLink` 之后才 resolve，断言 `effectiveBase` 仍为 null、probe 未被写入"的用例（hook 层即可写）。
- **B4 probes 与 `live` 没有"谁赢"的裁决规则。** 状态条规则 3/4（骨架:172-174）用的是服务端对**已保存目标**的 live 读（`schemaInvalid`），步骤 ①/③ 用的是 probes。两者可以同时成立且互相矛盾：状态条红字"已确认，但表头已失效（需重新校验）→ 第 ② 步"（规格 §5.1 的吵醒条件 ①）与"两表 verdict 均 ok → 第 ③ 步可勾选"（规格 §5.2 完成条件）会同时出现在屏幕上。后端在 confirm 时会 409 兜住（`target.py:546-550`），所以不是静默损坏，但 Global Constraint 1「判决只有一个来源」在页面上不成立。缺：live 报 schema 错时是否作废对应 probe、状态条与步骤谁优先。
- **B5 规格 §8 的错误边界表没有"请求永不返回"这一行。** `api.ts:420-440` 的 `request` 既无超时也无 `AbortSignal`（`mutation` 亦然），而 hook 把 "loading" 写进 probe 后只靠 `finally` 收尾（T23:1509、1534-1537）。叠加 A3，页面可以永久停在 loading（probe 层）或永久拒绝再校验（`inFlight` 层），用户唯一的逃生口是编辑链接框或刷新——这两条都没有写进 §8，也没有"重新校验"按钮的降级设计。
- **B6 门 1 的"改动前必须红"在 hook 层是空红。** T23:1344-1348 的期望输出是 `Failed to resolve import "../hooks/useLarkDraft"`——文件不存在导致的红，证明不了任何行为。真正的红证在 T23:1732（把 `withSlot` 的 key 改成只用 `role` 后该用例必须变红）✓ 这条有，但它写在 Task 3 的自查里，不在门 1 的验收路径上；而门 1 的字面断言（"切换执行表后旧表红字消失"）是**渲染层**的，属 Task 6（未写）。缺：把 T23:1732 的变异检验升级成"门 1 的证据"，并补渲染层用例。
- **B7 规格 §8:243「provision / retype 后：作废受影响 role 的 probe 并重新校验」没有任何执行者。** `LarkDraftActions`（骨架:184-195）只有 `acceptCreatedTable` / `acceptRebuiltTable`，没有 provision/retype 的入口；`StepHeadersProps`（骨架:246-263）只有 `onChanged: () => Promise<void>`、`onTableCreated`、`onTableRebuilt`。更糟的是 T23:951 与交接说明 T23:1761 规定"渲染层**未读才显示校验按钮**"，而 `checkTable` 又被 T23:951 称为"表头修好后重新校验的唯一入口"。于是：一张被判 `bad` 的表被 retype/provision 修好表头后，probe 仍是 `bad`（没有失效、没有自动重校验）、校验按钮又不显示（因为它有 probe，不是 `unread`）→ `stepsComplete().tables/headers` 永远为 false，第 ③ 步"两表 verdict 均 ok 才可勾选"永远无法达成。**这是四条里最致命的一条**：它不是遗漏一个测试，而是新页面在"表头修好之后"这条主路径上走不通。

---

## C. 验收门可判定性逐条

| 门 | 能不能判定 | 缺什么 |
|---|---|---|
| **1** 本次 bug 回归 | 逻辑层可判定 ✓；**渲染层不可判定** | hook 层用例 T23:1075-1097 断言 `bad → 切表 → ok`，且 T23:1732 给了变异检验（证明它不是空测）。但门 1 的字面要求是"切换执行表后旧表红字消失"——那是 Task 6（未写）。另外"改动前必须红"目前只有 import 失败（B6）。缺：Task 6 的页面级用例（切换下拉后 `container` 内旧表的 `schema_errors` 文案不再出现）+ 把变异检验写进门 1 |
| **2** 不串味 | 可判定 ✓ | `larkDraft.test.ts` 三处 `verdictFor`（两种 role 同表、切表各判各的）+ hook T23:1314-1333（同表两 role 不同 verdict）。仅一点小缺：规格 §3 的目标"任一处判决只渲染一次"没有断言，也没有归属 task |
| **3** unread 诚实 | 逻辑层可判定 ✓；**在途作废不可判定** | 逻辑层：`baseIsCurrent` 2 例（`:314-330`）、`effectiveBase` 2 例（`:332-347`）、`verdictFor` unread 1 例（`:379-386`）；hook：`setLink` 一条（T23:1163-1176）。缺：B3 的"在途响应不回写"；以及"未校验 → 显示「尚未校验这张表」"的**文案**没有任何测试或常量（规格 §8 只写了行为，没写这句文案由谁渲染，Task 5/6 未写，门 3 的"不显示空白"因此无法判定） |
| **4** 健康态预算 | **不可判定** | Task 5/6 未写（B1）。而且规格/骨架没给计数口径：`role="alert"` 是"整页"还是"状态条容器内"？"4 个步骤标题"用什么数（`StepSection` 实例数？`getAllByRole("heading")`？）？— 建议在 `LarkCheck.test.tsx` 里用 `container.querySelectorAll("[role=alert]").length === 0` + `getAllByTestId("step-title").length === 4` 这类可执行写法，并写进 Task 6 |
| **5** 两个吵醒条件 | 逻辑层可判定 ✓；**渲染层不可判定** | `describeHealth` 的 8 条顺序 + 冲突优先级（`:454-549`）覆盖了红/黄与 `step` 的取值。但"状态条变红 + 第②/④步自动展开"是 Task 5/6。且页面里 `schemaInvalid` 从哪来（`state.live.schema_errors`）没有任何 task 写：交接说明 T23:1762 只说"由 `describeHealth(...).step` 决定展开"，没说输入怎么算 |
| **6** 安全确认不被吃掉 | **不可判定** | Task 4 未写（B1）。风险是门 6 可以用"删掉 `HeaderSetup.test.tsx` 的 37 条、加 3 条浅测"通过（B2）；`Mock API`/e2e 里三个弹窗路径也没有基线。缺：37 条断言的去向清单 + 每个对话框至少一条"必须点确认才生效"的断言 |
| **7** probe 缓存 | 可判定 ✓ | hook T23:1136-1161 用 `readTableSchema` 调用计数钉住 1 → 2 → 2，T23:1733 给了变异检验。注意它证明的是"`setTable` 不发请求"，不等于"页面下拉切换不重复请求"——下拉 `onChange` 是否只调 `setTable` 由 Task 5/6 定；建议把这条断言复制到 `StepTables` 的组件测试 |
| **8** e2e | **不可判定** | Task 7 未写（B1）；`mock-api.mjs` 只有 `/api/lark/resolve`（`mock-api.mjs:735`），没有 `table-schema`；e2e fixture 的 `schema_errors` 仍是恒 `[]`（`e2e/lark-check.spec.ts:17,45,124,141,190`），也就是规格 §1.1 自己承认的"这条路径零测试"在本次重构后**依旧零测试**（"表头失效"恰好是门 5 的吵醒条件）。"无横向溢出"（约束 9）也没有写成可执行断言 |
| **9** 全绿 | 后端可判定 ✓；**前端不可判定** | 后端给了基线 `504 passed`（T1:562）与 518 的推导（T1:570-576），命令完整。前端**没有任何全量基线数字**（只有 `api.test.ts 3`、`larkDraft 16`、`hook 13`、三文件 32），而 Task 4/6 会删/重写 76 条既有用例（B2）→ `npx vitest run` 全绿可以靠删测试达成。缺：前端基线快照 + 净减少规则 |

---

## D. probes / 状态资源的增长与释放

**结构**：`probes: Record<string, ProbeSlot>` 长在 `LarkBase` 对象上（T23:641-648），key = `` `${table_id}:${role}` ``（T23:665-667）。写入点只有三处：`readLink` 播种执行表的首个 probe（T23:1576-1578）、`runCheck` 的成功/失败/loading 写槽（T23:1509、1517-1529、1532）、以及 `acceptCreatedTable`/`acceptRebuiltTable` 触发的 `runCheck`（T23:1656、1690）。**没有任何删除、TTL、上限或 LRU**——对比后端同名缓存 `backend/app/lark/cache.py`（`DEFAULT_TTL_SECONDS = 60.0` + `_prune_expired`），前端这一份既不过期也不淘汰。

**什么限制了它的增长**：
1. key 只能由"当前选中的表 + role"产生，而选中项来自 `draft[role].base.tables`（下拉的唯一来源，T23:1759），所以**每个 base 对象最多 2 × N 条**（N = 该 base 的表数，role 两种）；同一个 key 反复校验只是覆盖（T23:1454 `{...current.probes, [key]: slot}`），不增长。
2. 同时存活的 base 对象最多两个（`draft.execution.base`、`draft.bug.base`；缺陷库链接为空时二者共用同一个对象，T23:685-692）。因此总量上限 ≈ `2 × (2 × N)` 条，没有随会话时长或点击次数增长的路径。
3. 每条 Probe 的体积 = 该表整份字段表（`describe_fields` 的输出，8–50 项）+ 两个字符串数组 + 可选错误串，量级 KB 以下。一个 200 张表、全被校验过的 base ≈ 400 条、数百 KB 上限——**有界但代码里没有任何机制保证这个界**（界来自"能选到的表只有 base 里的表"这一 UI 事实）。

**什么时候释放**：
1. `setLink`：框里文本 ≠ `base.source_url` 时把 `base` 置 `null`（T23:1547-1550）→ 整个 probe map 变成不可达，随 GC 回收。这是主要释放路径。
2. `readLink`：**每次都新建 `probes = {}`**（T23:1575）→ 重新读取同一段链接会无条件丢掉该 base 的全部旧 probe（顺带把"表在 Lark 侧被删/改列"的陈旧判决清掉，只保留本次播种的那条）。
3. `resetDraft` / `groupId` 变化 → `emptyDraft()`（T23:1497、1696）。
4. `acceptRebuiltTable`：`withoutTableProbes`（删被替换表的两个 role）+ `withoutRoleProbes`（删另一 role 全部）（T23:1672-1673）。**只有这一条按内容删除**。

**泄漏路径（逐条回答提问）**：
- **频繁 `checkTable`**：probe 不涨（覆盖同一 key），但有两个副作用：① `inFlight` 的 key 在请求永不返回时**永久占用**（A3），此后这张表的校验点击全部静默失效；② 每次都会把槽置 `"loading"`（T23:1509）→ 请求不返回则 probe 永远停 `"loading"`（`verdictOf` 返回 `loading`，不是 `unread`），`stepsComplete().tables` 永远 false。
- **切 base**：结构性释放 ✓（新 base 是新对象；旧对象的 probes 不可达）。风险只在 `withSlot` 的守卫用 `base_token` 判等（T23:1452-1453）：两个**不同的 base 对象可以有同一个 token**（同一个库被读两次），于是"上一次读取的迟到响应"可以写进"这一次读取的新 base"。数据描述的是同一个 base+table，内容仍然有效，所以我不把它算缺陷——但守卫的真实语义是"同一个 token"，不是"同一次读取"，这一点在规格 §8 的"按 `base_token` 归属作废"里也没写清。
- **切组**：`setDraft(emptyDraft())` + `inFlight.clear()`（T23:1497-1500）释放引用 ✓。残留：在途请求仍会落地，`withSlot` 只按 token 判等 → 若新组的 draft 恰好已经读了同一个 base，老组的迟到响应会写进新组的 probe。内容等价、危害低，但 `inFlight.clear()` 还有第二个后果：老请求的 `finally`（T23:1535）会 `delete` 新组**同 key 的新请求**留下的条目，去重不变式被打破（同一 key 可以再排第三个请求）。
- **重建表后旧 probe 残留**：`withoutTableProbes(base.probes, replaced.table_id)` 的 `prefix = `${tableId}:`` 会删掉该表**两个 role** 的 probe ✓，被替换表不残留；但另一 role 的 `tableId` 可能仍指着它（A4），此时它没有 probe → verdict 诚实地回到 `unread` ✓。
- **`nameOf` 兜底**：表在 Lark 里被删/改名后，旧 probe 仍存活到链接被重读为止，下拉会显示原始 `table_id`（`larkDraft.ts:705-707`）——不是泄漏，但"陈旧判决 + 陈旧表名"会一直显示。

**`loading`/`checking` 状态（同类问题）**：
- 两者都是**单槽** `TableRole | null`（T23:1485-1486），而底层资源是 per (role, table)。`checking` 的 `finally` 有 role 判等（T23:1536 `current === role ? null : current`），跨 role 重叠是对的；但**同 role、两张表**重叠时先结束的那个会把标记清掉（另一张表还在 `loading`）。`reading` 更弱：`setReading(null)` 无条件（T23:1613），两个 role 的读取重叠时先结束的会把另一个的圈收掉。影响限于 loading 指示，判决仍由 probe 层决定。
- 更值得注意的**双真值源**：交接说明 T23:1761 说"`checking`/`reading` 是渲染 loading 的唯一依据"，而骨架:127-134 与 T23:1509 又把 `"loading"` 写进 probe（`verdictOf` 也返回 `loading`）。两者可以不一致：`setChecking(role)` 在任何写入之前就执行（T23:1509-1510），若 `withSlot` 因 base 不匹配而丢弃写入（T23:1453），UI 会显示"正在校验"但 verdict 是 `unread`。建议二选一（probe 的 `loading` 槽为准，`checking`/`reading` 只用于禁用按钮）。

---

## E. 建议新增但规格未写的条目（含归属 Task）

| # | 条目 | 一句理由 | 归属 |
|---|---|---|---|
| E1 | **请求放大/按钮禁用**：规格 §7 只约束了 `/lark/table-schema` 单次请求预算（happy path 1 次），没有约束页面。而 `readLink` 没有 in-flight 守卫（T23:1564-1620；只有 `runCheck` 有），双击「读取」= N 次 `resolve`（每次 2–4 个 Lark 请求）+ N 次表校验；`checkTable` 也不短路（T23:951 有意为之） | 现成的料已经在 `StepTablesProps` 里（`reading`/`checking`，骨架:235-236），差一句"非空即禁用"的规格条文与一条组件测试 | 规格 §5.2「完成条件」列 + Task 5（`StepTables`）；Task 6 加断言 |
| E2 | **可访问性**：状态条只有 `tone: "ok"|"warn"|"bad"` + 文案（骨架:140），门 4 只写了"页面无 `role="alert"`"，容易被读成"不要任何 ARIA live 区" | 这个页面现有实现是有 `role="status"` 的（`LarkCheck.tsx:608,665,728,733,833`），重写后应保留：strip 用 `role="status"` + `aria-live="polite"`，校验中给按钮 `aria-busy`，`verdict === "loading"` 的禁用态要有可读原因（T23:1761 已要求禁用） | 规格 §5.1 + Task 5 |
| E3 | **会话过期/401 的处理归属**：`api.ts:431-434` 在 401 时广播 `testdeck:unauthorized`，但这份计划里四个 task 没有一个说重写后的页面在 401 时怎么办（旧页面也不处理，由外层接管） | 新页面把"读取/校验/保存"三个入口都收进 hook 后，如果一个 401 只变成一行 `error`，用户会在一个已登出的页面上反复点校验 | Task 6（页面层 `onError` 与事件订阅）+ 规格 §8 补一行 |
| E4 | **probe 的时效边界**：规格 §4.2/§8 只说"编辑链接框/切 base/重建"如何作废，没说一张**已经校验通过**的表在 Lark 侧被改列之后（用户不动任何输入框）怎么回到 `unread`，也没说 probe 有没有 TTL | 现在唯一能让 ok 变回未读的动作是"重新读取链接"或"重建"；而 §5.1 的吵醒条件 ①（`live.schema_errors`）会在状态条上红着说"表头已失效"，步骤 ① 却仍显示 ok（B4）。要么给 probe 加 TTL/失效规则，要么明确"以 live 为准，两者冲突时以 live 作废 probe" | 规格 §4.2 + Task 6（`live` 报错时调用 `checkTable` 或作废 probe） |

---

## F. 我实际验证了什么

**通读**：规格全文 291 行；骨架全文 309 行；T1 全文 600 行；T23 全文 1763 行；`backend/app/lark/target.py` 全文；`backend/app/lark/fields.py` 全文；`backend/tests/test_lark_target.py`（1-340 行 + 452-520 的 parametrize）；`backend/tests/conftest.py`（95-170、240-420、450-545、560-737、770-902）；`backend/app/lark/client.py`（25-84、420-484）；`backend/app/archive.py:35-66`；`backend/app/db.py:37-40`；`frontend/src/api.ts`（120-200、300-340、400-539）；`frontend/src/api.test.ts` 全文；`frontend/tsconfig.app.json`、`vite.config.ts`、`package.json`、`tsconfig.json`；`.github/workflows/publish.yml`；`frontend/src/views/LarkCheck.tsx`（60-180、176-212、614-646、690-736、814-830 等抽查段）。

**用脚本量过的数字**（不是目测）：
- T1 Step 2 测试整块 = `awk 'NR>=108&&NR<=361'` = **254 行**；T1 Step 5 实现整块 = `NR>=415&&NR<=495` = **81 行**（对照 T1:105 的 240、T1:412 的 83）。
- 行号位移算式：`_validate_target_tokens` 原 335 → +1（`import re`）→ +81（整块）= **417**；Step 6 再插 10 行（`_refuse_bad_token` 8 行 + 2 空行）→ `_validate_target_tokens` = **427**（对照 T1:6 的 419-426/429/447-448）。位移后第 335 行 = 原文第 253 行 = `locked_target_for` docstring 内的 `statement_timeout` 段（`target.py:253`）。
- 前端测试存量：`src/**/*.test.ts*` 共 **21 个文件**，`it(`/`test(` 正则计数 **≥256 例**（`HeaderSetup.test.tsx` 37、`LarkCheck.test.tsx` 39、`Execution.test.tsx` 46 等）。`it.each` 的展开未计入，故是下界。
- 后端既有用例 29 = 静态数（7 个 resolve 用例 + 6 + 4 + 2（`@pytest.mark.parametrize("send_fingerprint")`）+ 5（`test_saving_refuses_ids...`，`test_lark_target.py:488-501` 确认 5 组）+ 5），与 T1:394/549 的 `29 deselected` / `43 passed` 自洽。
- 规格字数声明：`LarkCheck.tsx:823-825` JSX 文本去空白 ≈ **139 字**（824 行单行 130 字），`:817-820` ≈ **43 字**（规格:53 写 194 / 78）。
- `HeaderSetup.tsx` = **946 行** ✓（规格:55 正确）；`styles.css:109` 确为 `.lark-check-layout { max-width: 900px; }` ✓；`LarkCheck.tsx` 的 `inline-status` 出现 **13** 次、`HeaderSetup.tsx` **14** 次 ✓（规格:51）；`git log --oneline -- frontend/src/views/LarkCheck.tsx | wc -l` = **11** 次提交，其中 4 条标题与规格 §1.3 列出的四个 hash 逐字一致 ✓；`resolved.schema_errors` 在 `:638`、`setExecutionTableId` 的 onChange 在 `:621`、`const liveErrors` 在 `:205`、`setResolved(null)` 在 `:181`（规格 §1.1 各锚点基本准确，仅 `:696`「保存选择」按钮实际在 `:694-700`）。
- 前端基线一致性：`frontend/dist/assets/` 里没有骨架:33 声称的 `index-li5seUpy.js`（现有 `index-Dx930F5e.js` / `index-BaL0XFeg.css`）。
- 三处 API/后端锚点核对通过：`client.py:454 list_fields`、`:429 list_tables`、`:34 LarkError`（T1:17-20）；`fields.py:50/61/73/99/103`（T1:26-32）；`api.ts:127/140/171/173/310/442/456/529-534`（T23:6-7、:17）；`TableRole`(171)/`mutation`(442) 同文件、无需新 import ✓（T23:201）。
- 测试会绿的静态推演（我逐条走了一遍代码）：`test_table_schema_judges_one_table_by_the_role_that_asked` 的字段字典与 7 条 bug 级缺失列顺序，与 `conftest.py:252-259`（`self.fields` 由 `REQUIRED_RUN_FIELD_TYPES.items()` 生成）+ `fields.py:61-74` 的插入顺序完全吻合；`fields_error`/`del bases[...]` 两条 409 分支与 `conftest.py:614-621`、`:640-660` 的行为吻合；新 9 个函数 × parametrize = 14 例 ✓；hook 13 个用例的期望值我按 T23 的实现逐条推演过（含 `withBase 必须最后调用`、`acceptCreatedTable` 把新表写进宿主 base、重建后另一 role 变 unread），未发现自相矛盾。

**没有验证的（明确说）**：我一律**没有**运行 `vitest` / `pytest` / `npm` / `playwright`，也没有 `git commit`（本次复审禁止）。因此 T1:370-394 的红色输出、T1:549 的 `43 passed`、T1:562-576 的 `504/518 passed`、T23:164-169 / :839 / :1719 / :1726 的 `3/16/13/32 passed`、骨架:33 的 `built in 1.32s`、以及各处的"本机实测"都**未被复现**，我只做了静态核对与自洽性推演。`test_table_schema_writes_nothing_to_the_database` 的"零 flush/零 commit"我按 `app/db.py:37-39`（`with Session(engine)` → `close()`，不 commit）+ `require_admin` 只读（`auth.py:91-94`）推理为成立，但**没有实际执行**；后端测试库容器（127.0.0.1:5433）的当前状态我也没查（未跑 `docker`/`nc`）。Task 4–7 不存在，故门 4/5/6/8 与 e2e/mock 的行为无从验证。
