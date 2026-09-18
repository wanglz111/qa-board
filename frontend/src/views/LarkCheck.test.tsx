import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ApiError, type Group, type LarkResolved, type LarkTarget, type LarkTargetState, type ProvisionPlan, type SyncStatus, type TableSchema } from "../api";
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
// baseIsCurrent 会判成「链接已改动、尚未读取」（规格 §4.2）。预填是**异步**落地的（目标读回来
// 那一刻才 resetDraft）：不等它到位就 clear，清空会与预填赛跑，框里最后留下「预填 + 输入」
// 两段拼接 —— 那同样会让 baseIsCurrent 判 false，所以这里是等它，不是抢它。
async function readExecutionLink(container: HTMLElement): Promise<void> {
  const box = within(executionBlock(container)).getByLabelText("Lark 文档链接");
  await waitFor(() => expect(box).toHaveValue(RESOLVED.source_url));
  await userEvent.clear(box);
  await userEvent.type(box, RESOLVED.source_url);
  await userEvent.click(within(executionBlock(container)).getByRole("button", { name: "读取表格" }));
}

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
  // 预填是异步落地的：不等它到位就 clear，清空会与预填赛跑，框里留下「预填 + 输入」两段拼接。
  await waitFor(() => expect(link).toHaveValue(RESOLVED.source_url));
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
  // 四步全完成 = ④ 也没有未了的事：stepsComplete 的 queueClean 要 pending_attempts 也是 0，
  // 否则这一步永远是 todo，「配完 → 页面安静」这条规格就无从验证。
  const { container } = renderCheck({
    loadTarget: vi.fn().mockResolvedValue(stateWith(confirmedTarget())),
    loadSync: vi.fn().mockResolvedValue(syncStatus({ pending_attempts: 0 }))
  });

  // 目标与队列都是异步读回来的：等这一行真的落地，再断言它的语气与文案。
  const strip = await waitFor(() => {
    const line = container.querySelector(".lark-health-strip");
    expect(line).toHaveAttribute("data-tone", "ok");
    return line as HTMLElement;
  });
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

// ---------------------------------------------------------------------------
// 逐条搬回来的旧用例（brief Step 5 的收尾指令：Step 6 全绿后另开一次提交，
// 按新 DOM 把旧断言的**行为**搬回来）。驱动方式全换：`第 N 步` 标题按钮展开
// 步骤正文（收起态不渲染 children），角色块用 `.lark-role[data-role=…]`。
// 行为不再存在、无法逐字搬的，在用例里写清它现在落在哪，见 task-6-report.md。
// ---------------------------------------------------------------------------

// 前置未完成的步是 disabled，点不动；页面同一时刻也只展开一步，收起态不渲染 children ——
// 别的步被自动展开时，第 ① 步的链接框根本不在 DOM 里（旧页面常驻），对着一个已经脱离文档的
// input 调 clear 会报 "could not be focused"。所以先「确保某步展开」再操作：已经展开时它什么都
// 不做（不会把步收起来），否则点开它。
async function ensureStepOpen(index: number): Promise<void> {
  // 必须锚在开头：状态条 rule 1 的文案是「尚未选择 Lark 表：请在第 1 步粘贴链接并保存」，
  // 它本身也是个按钮（可跳转），松散匹配会同时命中它和标题。
  const title = screen.getByRole("button", { name: new RegExp(`^第 ${index} 步`) });
  await waitFor(() => expect(title).toBeEnabled());
  if (title.getAttribute("aria-expanded") !== "true") await userEvent.click(title);
}

function bugBlock(container: HTMLElement): HTMLElement {
  return container.querySelector(".lark-role[data-role='bug']") as HTMLElement;
}

// 该组还没有保存过目标：没有可预填的链接，缺陷这个 role 也没有可借的 base。
function emptyTargetState(): LarkTargetState {
  return { target: null, live: null, read_errors: [] };
}

// 第二个多维表格：缺陷库单独给链接时，两个 role 各读各的 base。
const BUG_RESOLVED: LarkResolved = {
  source_url: "https://tenant.larksuite.com/wiki/node-2?table=tbl-online",
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

// 目标为 null 的组（emptyTargetState）没有可预填的链接：框一直空着，等「预填」会白等。
async function readExecutionLinkOnEmptyGroup(container: HTMLElement): Promise<void> {
  const box = within(executionBlock(container)).getByLabelText("Lark 文档链接");
  await userEvent.type(box, RESOLVED.source_url);
  await userEvent.click(within(executionBlock(container)).getByRole("button", { name: "读取表格" }));
}

async function readBugLink(container: HTMLElement, url: string): Promise<void> {
  const box = within(bugBlock(container)).getByLabelText(/缺陷库链接/);
  await userEvent.type(box, url);
  await userEvent.click(within(bugBlock(container)).getByRole("button", { name: "读取缺陷表" }));
}

it("shows the group's stored Lark target before anything is approved", async () => {
  // 旧页面靠 dl.lark-facts 显示「执行库 / 执行记录 / 缺陷记录」；规格 §1.2 把那块判成重复信息，
  // 两个表名改由第 ② 步的 summary 承载，多维表格名只在读过链接后出现（第 ① 步已读取那一行）。
  renderCheck();

  expect(await screen.findByText("已保存目标：执行记录 / 缺陷记录")).toBeVisible();
  expect(screen.getByText("尚未确认：本地结果不会写入 Lark")).toBeVisible();
});

it("requires an explicit consent toggle before confirming", async () => {
  const { container, confirmTarget } = renderCheck();

  await readExecutionLink(container);
  await ensureStepOpen(3);

  const button = screen.getByRole("button", { name: /确认本组写入目标/ });
  expect(button).toBeDisabled();
  expect(confirmTarget).not.toHaveBeenCalled();

  await userEvent.click(screen.getByLabelText("允许向上述旧表新增本组记录"));
  expect(button).toBeEnabled();
  await userEvent.click(button);

  expect(confirmTarget).toHaveBeenCalledWith("0918-id", "app-exec|tbl-runs|app-exec|tbl-bugs");
  expect(await screen.findByText(/已确认：本组新记录只会新增/)).toBeVisible();
});

it("blocks confirmation and explains when the live table reports schema errors", async () => {
  const { container } = renderCheck({
    loadTarget: async () => stateWith(TARGET, { schema_errors: ["缺少必填字段「截图」"], read_errors: [] })
  });

  // E4：目标在时表头以服务端 live 为准，原因落在第 ② 步正文顶部。表头失效 ⇒ 状态条变红、
  // 第 ② 步被自动展开 ⇒ 第 ① 步收起。先等这次自动导航**落定**（它就展现在这条原因行上），
  // 再展开第 ① 步：抢在它前面展开，输入框会在 clear 的中途被卸载（"could not be focused"）。
  expect(await screen.findByText(/服务端最近一次重读说这批表头不合格：缺少必填字段「截图」/)).toBeVisible();

  await ensureStepOpen(1);
  await readExecutionLink(container);

  await ensureStepOpen(3);
  expect(screen.getByLabelText("允许向上述旧表新增本组记录")).toBeDisabled();
  expect(screen.getByRole("button", { name: /确认本组写入目标/ })).toBeDisabled();
});

it("marks an earlier write approval invalid when the live schema changed", async () => {
  const { container } = renderCheck({
    loadTarget: async () => stateWith(confirmedTarget(), { schema_errors: ["缺少必填字段「截图」"], read_errors: [] })
  });

  // 收起态的那一行就是证据：「确认已失效」不用展开也看得见。
  expect(await screen.findByText("确认已失效，需要重新确认")).toBeVisible();
  // 等自动导航落定（状态条 rule 3 变红 → 第 ② 步展开）再碰第 ① 步，理由同上一条用例。
  expect(await screen.findByText(/已确认，但表头已失效/)).toBeVisible();

  await ensureStepOpen(1);
  await readExecutionLink(container);
  await ensureStepOpen(3);
  expect(screen.getByText(/此前的确认已失效/)).toBeVisible();
  expect(screen.getByRole("button", { name: /确认本组写入目标/ })).toBeDisabled();
});

it("reads a pasted link into selectable tables and its detected fields", async () => {
  const { container, resolve } = renderCheck();

  await readExecutionLink(container);

  expect(resolve).toHaveBeenCalledWith(RESOLVED.source_url);
  // 旧页面把 execution_fields 逐条列出来（「用例 · text」）。改造后字段只喂判决、不再铺开：
  // 表头细节归第 ② 步的 StepHeaders（缺什么、类型对不对），所以这里断的是读取结果本身。
  expect(await screen.findByText(/已读取「执行库」的 2 张数据表/)).toBeVisible();
  expect(within(executionBlock(container)).getByLabelText("执行记录表")).toHaveValue("tbl-runs");
  expect(within(bugBlock(container)).getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");
});

it("queues previously saved local attempts only after confirmation", async () => {
  const enqueueSync = vi.fn().mockResolvedValue({ queued: 2, repointed: 0, requeued: 0 });
  const loadSync = vi.fn().mockResolvedValueOnce(syncStatus()).mockResolvedValueOnce(syncStatus({ queued: 2 }));
  renderCheck({ loadTarget: async () => stateWith(confirmedTarget()), loadSync, enqueueSync });

  await ensureStepOpen(4);
  expect(await screen.findByText(/已同步 1/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /把已保存的本地结果排入同步/ }));

  expect(enqueueSync).toHaveBeenCalledWith("0918-id");
  expect(await screen.findByText(/已排入 2 条本地结果/)).toBeVisible();
  // 健康态状态条也含「待同步 N」：这里断的是第 ④ 步正文那一行（队列详情）。
  expect(await screen.findByText(/待同步 2 · 已同步 1 · 失败 0/)).toBeVisible();
});

it("says what the queue button moved instead of only reporting new rows", async () => {
  const enqueueSync = vi.fn().mockResolvedValue({ queued: 0, repointed: 3, requeued: 1 });
  const loadSync = vi.fn().mockResolvedValue(syncStatus({ queued: 3, failed: 1, parked: 3 }));
  renderCheck({ loadTarget: async () => stateWith(confirmedTarget()), loadSync, enqueueSync });

  // failed/parked 非零 → 状态条变红并自动展开第 ④ 步（GC5 的第二条唤醒条件）。
  await userEvent.click(await screen.findByRole("button", { name: /把已保存的本地结果排入同步/ }));

  const notice = await screen.findByText(/3 条任务已重新指向当前目标表/);
  expect(notice).toHaveTextContent("已重新排队 1 条失败结果");
  expect(notice).not.toHaveTextContent("已排入 0 条本地结果");
});

it("tells an operator when there was nothing left to enqueue", async () => {
  const enqueueSync = vi.fn().mockResolvedValue({ queued: 0, repointed: 0, requeued: 0 });
  renderCheck({
    loadTarget: async () => stateWith(confirmedTarget()),
    loadSync: async () => syncStatus({ queued: 1 }),
    enqueueSync
  });

  await ensureStepOpen(4);
  await userEvent.click(screen.getByRole("button", { name: /把已保存的本地结果排入同步/ }));

  expect(await screen.findByText(/没有需要排入的本地结果：这一组的本地结果都已经在队列里/)).toBeVisible();
});

it("prints why the last sync failed, not just the internal category", async () => {
  const loadSync = vi.fn().mockResolvedValue(
    syncStatus({
      failed: 1,
      last_error_kind: "create_execution_failed",
      last_error:
        "Lark create failed HTTP 403: HTTPStatusError，Lark code 91403：Forbidden；请在 Lark 开放平台为应用开通「查看、评论、编辑和管理多维表格」权限并发布"
    })
  );
  renderCheck({ loadTarget: async () => stateWith(confirmedTarget()), loadSync });

  expect(await screen.findByText(/最近错误 create_execution_failed/)).toBeVisible();
  expect(await screen.findByText(/Lark create failed HTTP 403/)).toBeVisible();
  expect(screen.getByText(/Lark 开放平台为应用开通/)).toBeVisible();
});

it("shows no reason line when nothing has failed", async () => {
  renderCheck({ loadTarget: async () => stateWith(confirmedTarget()), loadSync: async () => syncStatus() });

  await ensureStepOpen(4);
  await screen.findByText(/已同步 1/);
  expect(screen.queryByText(/最近错误/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Lark create failed|Lark rejected/)).not.toBeInTheDocument();
});

it("lets an operator recover failed and uncertain syncs explicitly", async () => {
  const retrySync = vi
    .fn()
    .mockResolvedValueOnce({ requeued: 2, released: 0 })
    .mockResolvedValueOnce({ requeued: 0, released: 1 });
  const loadSync = vi.fn().mockResolvedValue(
    syncStatus({ failed: 2, uncertain: 1, last_error_kind: "create_bug_failed", pending_attempts: 3 })
  );
  renderCheck({ loadTarget: async () => stateWith(confirmedTarget()), loadSync, retrySync });

  // 「失败 2」也出现在状态条（同步失败 2 条 …）：这里断的是第 ④ 步正文那一行。
  expect(await screen.findByText(/待同步 0 · 已同步 1 · 失败 2/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: /重试失败的同步/ }));
  expect(retrySync).toHaveBeenCalledWith("0918-id", false);
  expect(await screen.findByText(/已重新排队 2 条失败结果/)).toBeVisible();

  // A duplicate is possible, so releasing "uncertain" needs its own command.
  await userEvent.click(screen.getByRole("button", { name: /已核对远端，释放待人工确认/ }));
  expect(retrySync).toHaveBeenLastCalledWith("0918-id", true);
  expect(await screen.findByText(/释放 1 条待人工确认/)).toBeVisible();
});

// 目标变更的确认流：路由（本页发现 / 服务端发现）与「确认哪一次选择」都在这一组。
const SWITCH_PAYLOAD = {
  source_url: RESOLVED.source_url,
  execution_base_token: "app-exec",
  execution_table_id: "tbl-bugs",
  execution_view_id: null,
  bug_base_token: "app-exec",
  bug_table_id: "tbl-bugs",
  expected_previous_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs",
  acknowledge_change: true
};

function changeDetail(reason: "target_changed" | "stale_page", previousBugId: string, nextBugId: string) {
  return {
    reason,
    diff: {
      changed: true,
      changed_keys: ["bug_table_id"],
      previous: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: previousBugId
      },
      next: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: nextBugId
      }
    }
  };
}

it("asks for confirmation before switching a group to another table", async () => {
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: { schema_errors: [], read_errors: [] }, confirmation_cleared: false });
  const { container } = renderCheck({ resolve: vi.fn().mockResolvedValue(RESOLVED), saveTarget, loadTarget: vi.fn().mockResolvedValue(TARGET_STATE) });

  await readExecutionLink(container);
  await userEvent.selectOptions(within(executionBlock(container)).getByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("执行记录");
  expect(dialog).toHaveTextContent("tbl-runs → tbl-bugs");
  expect(saveTarget).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget).toHaveBeenLastCalledWith(GROUP.id, SWITCH_PAYLOAD);
});

it("acknowledges the selection the dialog was opened for, not a later edit", async () => {
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  const { container } = renderCheck({ saveTarget });

  await readExecutionLink(container);
  await userEvent.selectOptions(within(executionBlock(container)).getByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  await screen.findByRole("dialog");

  // The page behind the dialog is still live code; changing the draft must not
  // change what the acknowledgement puts on the wire.
  await userEvent.selectOptions(within(bugBlock(container)).getByLabelText("缺陷记录表"), "tbl-runs");
  await userEvent.click(screen.getByRole("button", { name: "确认切换" }));

  expect(saveTarget).toHaveBeenLastCalledWith(GROUP.id, SWITCH_PAYLOAD);
});

it("cancels a re-point without saving anything", async () => {
  const { container, saveTarget } = renderCheck();

  await readExecutionLink(container);
  await userEvent.selectOptions(within(executionBlock(container)).getByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  await userEvent.click(await screen.findByRole("button", { name: "取消" }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(saveTarget).not.toHaveBeenCalled();
});

it("opens the dialog when the server alone reports the group already moved", async () => {
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, changeDetail("target_changed", "tbl-runs", "tbl-bugs")));
  const { container } = renderCheck({ saveTarget });

  await readExecutionLink(container);
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByRole("dialog")).toBeVisible();
});

it("shows a plain server refusal as a readable message", async () => {
  // The token check refuses these ids with 422, not with a change request.
  const saveTarget = vi
    .fn()
    .mockRejectedValue(new ApiError(422, "缺陷表 id 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接"));
  const { container } = renderCheck({ saveTarget });

  await readExecutionLink(container);
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByText(/不是有效的多维表格标识/)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("tells the administrator to refresh when another page already moved the group", async () => {
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, changeDetail("stale_page", "tbl-runs", "tbl-bugs")));
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  const { container } = renderCheck({ saveTarget, loadTarget });

  await readExecutionLink(container);
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByText(/其他页面已改过该组的目标表/)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The page re-reads the stored target instead of letting a stale page acknowledge.
  expect(loadTarget).toHaveBeenCalledTimes(2);
});

it("closes the change dialog when the server calls the page stale", async () => {
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, changeDetail("stale_page", "tbl-runs", "tbl-bugs")));
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  const { container } = renderCheck({ saveTarget, loadTarget });

  await readExecutionLink(container);
  await userEvent.selectOptions(within(executionBlock(container)).getByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  await userEvent.click(await screen.findByRole("button", { name: "确认切换" }));

  // The scrim used to stay above the explanation, offering a diff the server
  // had already refused; the message is what the administrator must see.
  expect(await screen.findByText(/其他页面已改过该组的目标表/)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The page re-reads the stored target and never acknowledges a second time.
  expect(loadTarget).toHaveBeenCalledTimes(2);
  const acknowledged = saveTarget.mock.calls.filter(([, payload]) => payload.acknowledge_change);
  expect(acknowledged).toHaveLength(1);

  // The draft survives, so the administrator may press 保存选择 again — that
  // re-opens the gate instead of silently replaying the refused PUT.
  expect(within(executionBlock(container)).getByLabelText("执行记录表")).toHaveValue("tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(saveTarget).toHaveBeenCalledTimes(1);
});

it("sends the defect role from the second base the administrator read", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  const { container } = renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLinkOnEmptyGroup(container);
  await readBugLink(container, BUG_RESOLVED.source_url);
  await userEvent.selectOptions(await within(bugBlock(container)).findByLabelText("缺陷记录表"), "tbl-past");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_base_token: "app-exec",
    execution_table_id: "tbl-runs",
    bug_base_token: "app-bugs",
    bug_table_id: "tbl-past"
  });
});

it("keeps the second base's defect link when the execution link is re-read", async () => {
  const reread: LarkResolved = { ...RESOLVED, base_name: "执行库（重读）" };
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED).mockResolvedValue(reread);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  const { container } = renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLinkOnEmptyGroup(container);
  await readBugLink(container, BUG_RESOLVED.source_url);

  // Re-reading the execution link must not silently move the defect role back
  // into the execution base while the form still shows the other base.
  const link = within(executionBlock(container)).getByLabelText("Lark 文档链接");
  await userEvent.clear(link);
  await userEvent.type(link, RESOLVED.source_url);
  await userEvent.click(within(executionBlock(container)).getByRole("button", { name: "读取表格" }));

  expect(await screen.findByText(/已读取「执行库（重读）」的 2 张数据表/)).toBeVisible();
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(within(bugBlock(container)).getByLabelText(/缺陷库链接/)).toHaveValue(BUG_RESOLVED.source_url);
  expect(await within(bugBlock(container)).findByLabelText("缺陷记录表")).toHaveValue("tbl-online");

  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_base_token: "app-exec",
    bug_base_token: "app-bugs",
    bug_table_id: "tbl-online"
  });
});

it("names the tables the page will send when only the server reports the change", async () => {
  // The group gained a target after this page loaded, so the page holds no
  // fingerprint and the server answers with the change it just found.
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, changeDetail("target_changed", "tbl-gone", "tbl-bugs")));
  const { container } = renderCheck({ saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLinkOnEmptyGroup(container);
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  const dialog = await screen.findByRole("dialog");
  // The name slot carries the table the page is about to send, not its id.
  expect(dialog.querySelector(".target-change-pair")).toHaveTextContent("tbl-gone → 缺陷记录");
  expect(dialog).toHaveTextContent("tbl-gone → tbl-bugs");
});

it("does not leave one group's target under another group's header", async () => {
  const other: Group = { ...GROUP, id: "0919-id", name: "Sprint 0919" };
  const resolve = vi.fn().mockRejectedValue(new Error("读取 Lark 表格失败"));
  const loadTarget = vi.fn().mockResolvedValueOnce(TARGET_STATE).mockReturnValue(new Promise(() => {}));
  const { container } = renderCheck({ loadGroups: async () => [GROUP, other], loadTarget, resolve });

  expect(await screen.findByText("已保存目标：执行记录 / 缺陷记录")).toBeVisible();
  await readExecutionLink(container);
  expect(await screen.findByText("读取 Lark 表格失败")).toBeVisible();

  await userEvent.selectOptions(screen.getByLabelText("测试组"), other.id);

  // 多维表格名只在「已读取…」那一行里（旧页面有独立的 执行库 一格，exact 查询能命中它）。
  expect(screen.queryByText(/已读取「执行库」/)).not.toBeInTheDocument();
  expect(screen.queryByText("读取 Lark 表格失败")).not.toBeInTheDocument();
  expect(await screen.findByText(/尚未选择 Lark 表/)).toBeVisible();
});

it("shows the target and the live read the save itself returned", async () => {
  const saved = { ...TARGET, execution_table_name: "新执行记录" };
  const saveTarget = vi.fn().mockResolvedValue({
    target: saved,
    live: { schema_errors: ["缺少必填字段「截图」"], read_errors: [] },
    confirmation_cleared: false
  });
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  const { container } = renderCheck({ saveTarget, loadTarget });

  await readExecutionLink(container);
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByText(/已保存该组的 Lark 目标表/)).toBeVisible();
  // PUT 回给的那次 live 读取：表头失效 ⇒ 状态条变红、第 ② 步自动展开并在正文顶部说原因。
  expect(await screen.findByText(/服务端最近一次重读说这批表头不合格：缺少必填字段「截图」/)).toBeVisible();
  // 收起第 ② 步（点已展开的标题），让那一行 summary 把保存回来的目标念出来。
  await userEvent.click(screen.getByRole("button", { name: /^第 2 步/ }));
  expect(screen.getByText("已保存目标：新执行记录 / 缺陷记录")).toBeVisible();
  // The PUT already answered with the saved row and its live state.
  expect(loadTarget).toHaveBeenCalledTimes(1);
});

it("does not claim a record count while the sync status is unreadable", async () => {
  const loadSync = vi.fn().mockRejectedValue(new Error("读取同步状态失败"));
  const { container } = renderCheck({ loadTarget: async () => stateWith(confirmedTarget()), loadSync });

  // 队列没读回来的时候，describeHealth 第 8 条会写出它没读过的「待同步 0 · 失败 0」；
  // 页面因此不进那一条：状态条只报「尚未读取同步状态」（GC2 的诚实性约束）。
  expect(await screen.findByText(/尚未读取同步状态/)).toBeVisible();

  await readExecutionLink(container);
  await userEvent.selectOptions(within(executionBlock(container)).getByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).not.toHaveTextContent("条已保存的本地记录");
});

it("renders the reason a base yielded no tables", async () => {
  const { container } = renderCheck({
    resolve: async () => ({
      ...RESOLVED,
      tables: [],
      read_errors: ["该多维表格中没有数据表，请先在 Lark 中新建数据表"]
    })
  });

  await readExecutionLink(container);

  expect(await screen.findByText(/该多维表格中没有数据表/)).toBeVisible();
});

it("renders the reason the second link yielded no defect tables", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValue({
    ...BUG_RESOLVED,
    tables: [],
    read_errors: ["缺陷库中没有数据表，请先在 Lark 中新建数据表"]
  });
  const { container } = renderCheck({ resolve, loadTarget: async () => emptyTargetState() });

  await readExecutionLinkOnEmptyGroup(container);
  await readBugLink(container, BUG_RESOLVED.source_url);

  expect(await screen.findByText(/缺陷库中没有数据表/)).toBeVisible();
});

it("lets a parked-only group re-point its jobs and says how many moved", async () => {
  const retrySync = vi.fn().mockResolvedValueOnce({ requeued: 0, released: 0, repointed: 2 });
  const loadSync = vi.fn().mockResolvedValue(syncStatus({ failed: 0, parked: 2 }));
  renderCheck({ loadTarget: async () => stateWith(confirmedTarget()), loadSync, retrySync });

  // parked 非零 ⇒ 状态条 amber 并指向第 ④ 步（GC5 的第二条唤醒条件含 parked）。
  expect(await screen.findByText("待管理员处理 2 条")).toBeVisible();
  expect(screen.getByText(/待同步 0 · 已同步 1/)).toBeVisible();
  expect(screen.getByText(/条记录正在等待管理员处理/)).toBeVisible();
  expect(screen.queryByText(/因目标表更换而暂停/)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /重新指向当前目标表/ }));

  expect(retrySync).toHaveBeenCalledWith("0918-id", false);
  expect(await screen.findByText(/2 条任务已重新指向当前目标表/)).toBeVisible();
});

it("says a parked group is still unconfirmed instead of blaming a table change", async () => {
  const retrySync = vi.fn().mockResolvedValueOnce({ requeued: 0, released: 0, repointed: 2 });
  const loadSync = vi.fn().mockResolvedValue(syncStatus({ confirmed: false, parked: 2 }));
  renderCheck({ loadTarget: async () => stateWith(TARGET), loadSync, retrySync });

  const hint = await screen.findByText(/条记录正在等待管理员处理/);
  expect(hint).toHaveTextContent("本组目前尚未确认写入目标");
  expect(screen.queryByText(/因目标表更换而暂停/)).not.toBeInTheDocument();

  // The approval can be withdrawn without a table change, so re-pointing alone
  // cannot be promised to fix it; the copy says what else is missing and the
  // re-point action stays reachable for a genuine switch.
  await userEvent.click(screen.getByRole("button", { name: /重新指向当前目标表/ }));
  expect(retrySync).toHaveBeenCalledWith("0918-id", false);
});

it("uses the execution base for the defect role once the link box is cleared", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  const { container } = renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLinkOnEmptyGroup(container);
  const box = within(bugBlock(container)).getByLabelText(/缺陷库链接/);
  await userEvent.type(box, BUG_RESOLVED.source_url);
  await userEvent.click(within(bugBlock(container)).getByRole("button", { name: "读取缺陷表" }));
  expect(await within(bugBlock(container)).findByLabelText("缺陷记录表")).toHaveValue("tbl-online");

  // The label promises the execution base when no separate link is given, and
  // clearing the box is exactly that: the old read must stop driving the role.
  await userEvent.clear(box);

  // 一处判据与旧用例不同（Task 5 的 optionsFor：当前 id 不在这个 base 时用 id 当标签，决不
  // 悄悄换成另一张表）：选中的仍是管理员自己挑的 tbl-online，但可选集合已经换成执行表的 base。
  const select = within(bugBlock(container)).getByLabelText("缺陷记录表") as HTMLSelectElement;
  expect(select).toHaveValue("tbl-online");
  expect(Array.from(select.options).map((option) => option.value)).toEqual(["tbl-online", "tbl-runs", "tbl-bugs"]);

  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_base_token: "app-exec",
    bug_base_token: "app-exec",   // 旧断言里「回到执行表那个 base」这一半逐字保留
    bug_table_id: "tbl-online"    // 旧断言这里是 tbl-bugs：下拉不再替管理员换表
  });
});

it("never sends the base of a defect link the administrator replaced", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  const { container } = renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLinkOnEmptyGroup(container);
  const box = within(bugBlock(container)).getByLabelText(/缺陷库链接/);
  await userEvent.type(box, BUG_RESOLVED.source_url);
  await userEvent.click(within(bugBlock(container)).getByRole("button", { name: "读取缺陷表" }));
  expect(await within(bugBlock(container)).findByLabelText("缺陷记录表")).toHaveValue("tbl-online");

  // Typing a replacement without pressing 读取缺陷表 must not leave the read
  // base (app-bugs) in the payload for a URL that is no longer in the box.
  await userEvent.clear(box);
  await userEvent.type(box, "https://tenant.larksuite.com/wiki/node-9?table=tbl-other");
  expect(await screen.findByText(/尚未读取/)).toBeVisible();

  // 旧用例这里要求下拉回落到 tbl-bugs 并把 app-exec 发出去。改造后框里是一段没读过的链接 =
  // 缺陷这个 role 没有 base：页面既不列一个属于别的 base 的下拉，也不让保存把任何一段发出去
  // （「绝不静默改指向」的强版本）—— 旧用例要保证的那件事（app-bugs 不上线）就此结构性成立。
  expect(within(bugBlock(container)).queryByLabelText("缺陷记录表")).toBeNull();
  expect(screen.getByRole("button", { name: "保存选择" })).toBeDisabled();
  expect(saveTarget).not.toHaveBeenCalled();
});

it("keeps the box and the payload in agreement when a read defect link is edited", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  const { container } = renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLinkOnEmptyGroup(container);
  const box = within(bugBlock(container)).getByLabelText(/缺陷库链接/);
  await userEvent.type(box, BUG_RESOLVED.source_url);
  await userEvent.click(within(bugBlock(container)).getByRole("button", { name: "读取缺陷表" }));
  await userEvent.selectOptions(await within(bugBlock(container)).findByLabelText("缺陷记录表"), "tbl-past");

  // The administrator replaces the link. What they picked in the first base
  // must not survive on the wire.
  await userEvent.clear(box);
  await userEvent.type(box, "https://tenant.larksuite.com/wiki/node-9?table=tbl-other");
  expect(await screen.findByText(/尚未读取/)).toBeVisible();
  expect(within(bugBlock(container)).queryByLabelText("缺陷记录表")).toBeNull();
  expect(screen.getByRole("button", { name: "保存选择" })).toBeDisabled();
  expect(saveTarget).not.toHaveBeenCalled();
});

// 第 ② 步的正文只在它展开时挂载（StepHeaders 连同三个对话框、两个新表输入框都在里面）：
// 这些用例都要先点开第 ② 步；要碰第 ① 步的下拉/保存按钮时再切回去。
// 旧文件的 PROVISION_PLAN 只缺表头（新文件的 PLAN 还带一条 retype），这里照旧。
const PROVISION_PLAN: ProvisionPlan = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  }
};

it("lists the missing headers before creating them and re-reads the target after", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PROVISION_PLAN);
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [], target: TARGET });
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  renderCheck({ loadPlan, provision, loadTarget });

  await ensureStepOpen(2);
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("结果");
  expect(dialog).toHaveTextContent("日期");
  expect(provision).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(provision).toHaveBeenCalledWith(
    GROUP.id,
    expect.objectContaining({ role: "execution", field_names: ["结果", "日期"], acknowledge: true })
  );
  expect(await screen.findByText(/已创建 2 个表头，请重新确认写入/)).toBeVisible();
  // Creating headers clears the group's write approval on the server, so the
  // page has to re-read the target instead of keeping the old consent on screen.
  expect(loadTarget).toHaveBeenCalledTimes(2);
});

it("does not offer header setup once the live schema is complete", async () => {
  renderCheck();

  await ensureStepOpen(2);
  expect(await screen.findByText("表头完整")).toBeVisible();
  expect(screen.queryByRole("button", { name: "设置表头" })).not.toBeInTheDocument();
});

it("shows the cleared write approval the header creation forced", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PROVISION_PLAN);
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
  // The server clears confirmed_at when it changes the schema, so the re-read
  // comes back unconfirmed.
  const loadTarget = vi.fn().mockResolvedValueOnce(stateWith(confirmedTarget())).mockResolvedValue(stateWith(TARGET));
  renderCheck({ loadPlan, provision, loadTarget });

  // 「已确认」现在是第 ③ 步收起时的那一行 summary（旧页面在写入确认面板里）。
  expect(await screen.findByText("已确认")).toBeVisible();

  await ensureStepOpen(2);
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText("尚未确认：本地结果不会写入 Lark")).toBeVisible();
  expect(screen.queryByText("已确认")).not.toBeInTheDocument();
});

it("drops the approval the header creation invalidated even when the re-read fails", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PROVISION_PLAN);
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
  const loadTarget = vi
    .fn()
    .mockResolvedValueOnce(stateWith(confirmedTarget()))
    .mockRejectedValue(new Error("读取该组的 Lark 目标失败"));
  renderCheck({ loadPlan, provision, loadTarget });

  expect(await screen.findByText("已确认")).toBeVisible();

  await ensureStepOpen(2);
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // The server already cleared the approval, so the page may not keep showing
  // it just because the confirming re-read failed.
  expect(await screen.findByText("尚未确认：本地结果不会写入 Lark")).toBeVisible();
  expect(screen.queryByText("已确认")).not.toBeInTheDocument();
  expect(screen.getByText("读取该组的 Lark 目标失败")).toBeVisible();
});

it("re-reads the header list when the saved target moves to another table", async () => {
  const loadPlan = vi.fn().mockResolvedValueOnce({ roles: { execution: [], bug: [] } }).mockResolvedValue(PROVISION_PLAN);
  const repointed: LarkTarget = {
    ...TARGET,
    execution_table_id: "tbl-bugs",
    execution_table_name: "缺陷记录",
    schema_fingerprint: "schema-2",
    target_fingerprint: "app-exec|tbl-bugs|app-exec|tbl-bugs"
  };
  const saveTarget = vi.fn().mockResolvedValue({ target: repointed, live: null, confirmation_cleared: true });
  const { container } = renderCheck({ loadPlan, saveTarget });

  await ensureStepOpen(2);
  expect(await screen.findByText("表头完整")).toBeVisible();

  await ensureStepOpen(1);
  await readExecutionLink(container);
  await userEvent.selectOptions(within(executionBlock(container)).getByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  await userEvent.click(await screen.findByRole("button", { name: "确认切换" }));

  // The old list described tbl-runs; the panel must describe the table the
  // group now points at, or an administrator approves a diff for the wrong one.
  // 注意：第 ② 步正文在切走时被卸载，所以这里还叠了一次「重新挂载」带来的重读；指纹键控的那次
  // 重读由 StepHeaders.test.tsx「re-reads the header list when the target it describes changes」
  // 单独钉住（rerender 换 targetFingerprint，组件不卸载）。
  await ensureStepOpen(2);
  expect(await screen.findByText(/缺少 2 个表头/)).toBeVisible();
  expect(loadPlan).toHaveBeenCalledTimes(2);
});

it("puts a newly created defect table into the draft the page will save", async () => {
  const createTable = vi.fn().mockResolvedValue({ table: { table_id: "tbl-fresh", name: "缺陷记录" }, role: "bug" });
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  const { container } = renderCheck({ createTable, saveTarget });

  await readExecutionLink(container);
  await ensureStepOpen(2);
  await userEvent.click(screen.getByRole("button", { name: "新建缺陷记录数据表" }));

  expect(createTable).toHaveBeenCalledWith(GROUP.id, {
    role: "bug",
    base_token: "app-exec",
    table_name: "缺陷记录",
    acknowledge: true
  });

  // 新表是 draft：它要出现在第 ① 步的下拉里（第 ② 步正文这时已经收起）。
  await ensureStepOpen(1);
  expect(await within(bugBlock(container)).findByLabelText("缺陷记录表")).toHaveValue("tbl-fresh");

  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  await userEvent.click(await screen.findByRole("button", { name: "确认切换" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_base_token: "app-exec",
    bug_base_token: "app-exec",
    bug_table_id: "tbl-fresh"
  });
});

it("leaves the draft alone when creating a table is refused", async () => {
  const createTable = vi.fn().mockRejectedValue(new ApiError(409, "新建数据表失败：没有权限"));
  const { container } = renderCheck({ createTable });

  await readExecutionLink(container);
  await ensureStepOpen(2);
  await userEvent.click(screen.getByRole("button", { name: "新建缺陷记录数据表" }));

  // 拒绝理由留在第 ② 步（对话框已收起，所以由 StepHeaders 自己说）。
  expect(await screen.findByText(/新建数据表失败：没有权限/)).toBeVisible();

  await ensureStepOpen(1);
  expect(within(bugBlock(container)).getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");
});

it("follows the group onto a rebuilt table and drops the one it replaced", async () => {
  // The server builds the replacement, points the group at it and clears the
  // write approval; the page has to follow all three or 「保存选择」 would keep
  // offering the table the group has already walked away from.
  const rebuilt: LarkTarget = {
    ...TARGET,
    bug_table_id: "tbl-fresh",
    bug_table_name: "缺陷记录（表头修正）",
    schema_fingerprint: "schema-2",
    target_fingerprint: "app-exec|tbl-runs|app-exec|tbl-fresh",
    confirmed: false,
    confirmed_at: null
  };
  const rebuild = vi.fn().mockResolvedValue({
    role: "bug",
    table: { table_id: "tbl-fresh", name: "缺陷记录（表头修正）" },
    replaced: { table_id: "tbl-bugs", name: "缺陷记录" },
    requeued: 2,
    schema_errors: [],
    target: rebuilt
  });
  const loadTarget = vi.fn().mockResolvedValueOnce(TARGET_STATE).mockResolvedValue(stateWith(rebuilt));
  const { container, saveTarget } = renderCheck({ rebuild, loadTarget });

  await readExecutionLink(container);
  await ensureStepOpen(2);
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建缺陷记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(rebuild).toHaveBeenCalledWith(GROUP.id, {
    role: "bug",
    acknowledge: true,
    force: false
  });

  await ensureStepOpen(1);
  expect(await within(bugBlock(container)).findByLabelText("缺陷记录表")).toHaveValue("tbl-fresh");
  // The rebuilt destination dropped the approval on the server, so the page
  // says so instead of showing the one that no longer stands.
  expect(await screen.findByText("尚未确认：本地结果不会写入 Lark")).toBeVisible();

  // The server already points the group at the rebuilt table, so the page is
  // not asking for a switch: saving only has to keep naming that table.
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_table_id: "tbl-runs",
    bug_table_id: "tbl-fresh"
  });
});
