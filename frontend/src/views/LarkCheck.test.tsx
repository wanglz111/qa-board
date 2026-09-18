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
