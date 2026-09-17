import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import {
  ApiError,
  type Group,
  type LarkResolved,
  type LarkTarget,
  type LarkTargetState,
  type SyncStatus
} from "../api";
import { LarkCheckView } from "./LarkCheck";

const GROUP: Group = {
  id: "0918-id",
  name: "Sprint 0918",
  source_name: "0918.csv",
  source_version: "1",
  count: 14,
  created_at: "2026-09-16T08:00:00Z"
};

const RESOLVED: LarkResolved = {
  source_url: "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs",
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

// A group whose defect table lives in a second multi-dimensional table: the
// 缺陷库链接 field is what keeps the two roles apart.
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

const TARGET: LarkTarget = {
  group_id: GROUP.id,
  source_url: RESOLVED.source_url,
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

const TARGET_STATE: LarkTargetState = {
  target: TARGET,
  live: { schema_errors: [], read_errors: [] },
  read_errors: []
};

// The stored table is missing two headers, so the page may offer to create them.
const PROVISION_PLAN = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  }
};

const CLEAN_PLAN = { roles: { execution: [], bug: [] } };

function confirmedTarget(): LarkTarget {
  return { ...TARGET, confirmed_at: "2026-09-16T10:00:00Z", confirmed: true };
}

function stateWith(
  target: LarkTarget,
  live: { schema_errors: string[]; read_errors: string[] } = {
    schema_errors: [],
    read_errors: []
  }
): LarkTargetState {
  return { target, live, read_errors: [] };
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
    pending_attempts: 2,
    detail: "目标表已确认，可显式排入同步",
    ...overrides
  };
}

function emptyTargetState(): LarkTargetState {
  return { target: null, live: null, read_errors: [] };
}

function renderCheck(overrides: Partial<Parameters<typeof LarkCheckView>[0]> = {}) {
  const resolve = vi.fn().mockResolvedValue(RESOLVED);
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, confirmation_cleared: false });
  const confirmTarget = vi.fn().mockResolvedValue(confirmedTarget());
  const loadPlan = vi.fn().mockResolvedValue(CLEAN_PLAN);
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [], target: TARGET });
  render(
    <LarkCheckView
      loadGroups={async () => [GROUP]}
      resolve={resolve}
      loadTarget={loadTarget}
      saveTarget={saveTarget}
      confirmTarget={confirmTarget}
      loadPlan={loadPlan}
      provision={provision}
      {...overrides}
    />
  );
  return { resolve, loadTarget, saveTarget, confirmTarget, loadPlan, provision };
}

async function readExecutionLink() {
  await userEvent.type(screen.getByLabelText("Lark 文档链接"), RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));
  return screen.findByLabelText("执行记录表");
}

it("shows the group's stored Lark target before anything is approved", async () => {
  renderCheck();

  expect(await screen.findByText("执行库")).toBeVisible();
  expect(screen.getByText("执行记录")).toBeVisible();
  expect(screen.getByText("缺陷记录")).toBeVisible();
  expect(await screen.findByText(/尚未确认：本地结果不会写入 Lark/)).toBeVisible();
});

it("requires an explicit consent toggle before confirming", async () => {
  const { confirmTarget } = renderCheck();

  const button = await screen.findByRole("button", { name: /确认本组写入目标/ });
  expect(button).toBeDisabled();
  expect(confirmTarget).not.toHaveBeenCalled();

  await userEvent.click(screen.getByLabelText("允许向上述旧表新增本组记录"));
  expect(button).toBeEnabled();
  await userEvent.click(button);

  expect(confirmTarget).toHaveBeenCalledWith(
    "0918-id",
    "app-exec|tbl-runs|app-exec|tbl-bugs"
  );
  expect(await screen.findByText(/已确认：本组新记录只会新增/)).toBeVisible();
});

it("blocks confirmation and explains when the live table reports schema errors", async () => {
  renderCheck({
    loadTarget: async () =>
      stateWith(TARGET, { schema_errors: ["缺少必填字段「截图」"], read_errors: [] })
  });

  expect(await screen.findByText("缺少必填字段「截图」")).toBeVisible();
  expect(screen.getByLabelText("允许向上述旧表新增本组记录")).toBeDisabled();
  expect(screen.getByRole("button", { name: /确认本组写入目标/ })).toBeDisabled();
});

it("marks an earlier write approval invalid when the live schema changed", async () => {
  renderCheck({
    loadTarget: async () =>
      stateWith(confirmedTarget(), {
        schema_errors: ["缺少必填字段「截图」"],
        read_errors: []
      })
  });

  expect(await screen.findByText(/此前的确认已失效/)).toBeVisible();
  expect(screen.getByRole("button", { name: /确认本组写入目标/ })).toBeDisabled();
});

it("reads a pasted link into selectable tables and its detected fields", async () => {
  const { resolve } = renderCheck();

  const executionSelect = await readExecutionLink();

  expect(resolve).toHaveBeenCalledWith(RESOLVED.source_url);
  expect(await screen.findByText(/用例 · text/)).toBeVisible();
  expect(executionSelect).toHaveValue("tbl-runs");
  expect(screen.getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");
});

it("queues previously saved local attempts only after confirmation", async () => {
  const enqueueSync = vi.fn().mockResolvedValue({ queued: 2 });
  const loadSync = vi
    .fn()
    .mockResolvedValueOnce(syncStatus())
    .mockResolvedValueOnce(syncStatus({ queued: 2 }));
  renderCheck({
    loadTarget: async () => stateWith(confirmedTarget()),
    loadSync,
    enqueueSync
  });

  expect(await screen.findByText(/已同步 1/)).toBeVisible();
  const queueButton = screen.getByRole("button", { name: /把已保存的本地结果排入同步/ });
  await userEvent.click(queueButton);

  expect(enqueueSync).toHaveBeenCalledWith("0918-id");
  expect(await screen.findByText(/已排入 2 条本地结果/)).toBeVisible();
  expect(await screen.findByText(/待同步 2/)).toBeVisible();
});

it("lets an operator recover failed and uncertain syncs explicitly", async () => {
  const retrySync = vi
    .fn()
    .mockResolvedValueOnce({ requeued: 2, released: 0 })
    .mockResolvedValueOnce({ requeued: 0, released: 1 });
  const loadSync = vi.fn().mockResolvedValue(
    syncStatus({ failed: 2, uncertain: 1, last_error_kind: "create_bug_failed", pending_attempts: 3 })
  );
  renderCheck({
    loadTarget: async () => stateWith(confirmedTarget()),
    loadSync,
    retrySync
  });

  expect(await screen.findByText(/失败 2/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: /重试失败的同步/ }));
  expect(retrySync).toHaveBeenCalledWith("0918-id", false);
  expect(await screen.findByText(/已重新排队 2 条失败结果/)).toBeVisible();

  // A duplicate is possible, so releasing "uncertain" needs its own command.
  await userEvent.click(
    screen.getByRole("button", { name: /已核对远端，释放待人工确认/ })
  );
  expect(retrySync).toHaveBeenLastCalledWith("0918-id", true);
  expect(await screen.findByText(/释放 1 条待人工确认/)).toBeVisible();
});

it("asks for confirmation before switching a group to another table", async () => {
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, confirmation_cleared: false });
  renderCheck({
    resolve: vi.fn().mockResolvedValue(RESOLVED),
    saveTarget,
    loadTarget: vi.fn().mockResolvedValue(TARGET_STATE)
  });

  await userEvent.type(screen.getByLabelText("Lark 文档链接"), RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));
  await userEvent.selectOptions(await screen.findByLabelText("执行记录表"), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("执行记录");
  expect(dialog).toHaveTextContent("tbl-runs → tbl-bugs");
  expect(saveTarget).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget).toHaveBeenLastCalledWith(GROUP.id, {
    source_url: RESOLVED.source_url,
    execution_base_token: "app-exec",
    execution_table_id: "tbl-bugs",
    execution_view_id: null,
    bug_base_token: "app-exec",
    bug_table_id: "tbl-bugs",
    expected_previous_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs",
    acknowledge_change: true
  });
});

it("acknowledges the selection the dialog was opened for, not a later edit", async () => {
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  renderCheck({ saveTarget });

  const executionSelect = await readExecutionLink();
  await userEvent.selectOptions(executionSelect, "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  await screen.findByRole("dialog");

  // The page behind the dialog is still live code; changing the draft must not
  // change what the acknowledgement puts on the wire.
  await userEvent.selectOptions(screen.getByLabelText("缺陷记录表"), "tbl-runs");
  await userEvent.click(screen.getByRole("button", { name: "确认切换" }));

  expect(saveTarget).toHaveBeenLastCalledWith(GROUP.id, {
    source_url: RESOLVED.source_url,
    execution_base_token: "app-exec",
    execution_table_id: "tbl-bugs",
    execution_view_id: null,
    bug_base_token: "app-exec",
    bug_table_id: "tbl-bugs",
    expected_previous_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs",
    acknowledge_change: true
  });
});

it("cancels a re-point without saving anything", async () => {
  const { saveTarget } = renderCheck();

  const select = await readExecutionLink();
  await userEvent.selectOptions(select, "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  await userEvent.click(await screen.findByRole("button", { name: "取消" }));

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(saveTarget).not.toHaveBeenCalled();
});

it("opens the dialog when the server alone reports the group already moved", async () => {
  const detail = {
    reason: "target_changed",
    diff: {
      changed: true,
      changed_keys: ["execution_table_id"],
      previous: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-bugs"
      },
      next: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-bugs"
      }
    }
  };
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, detail));
  renderCheck({ saveTarget });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByRole("dialog")).toBeVisible();
});

it("shows a plain server refusal as a readable message", async () => {
  // The token check refuses these ids with 422, not with a change request.
  const saveTarget = vi
    .fn()
    .mockRejectedValue(
      new ApiError(422, "缺陷表 id 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接")
    );
  renderCheck({ saveTarget });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByText(/不是有效的多维表格标识/)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("tells the administrator to refresh when another page already moved the group", async () => {
  const stale = {
    reason: "stale_page",
    diff: {
      changed: true,
      changed_keys: ["execution_table_id"],
      previous: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-bugs"
      },
      next: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-bugs"
      }
    }
  };
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, stale));
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  renderCheck({ saveTarget, loadTarget });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByText(/其他页面已改过该组的目标表/)).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The page re-reads the stored target instead of letting a stale page acknowledge.
  expect(loadTarget).toHaveBeenCalledTimes(2);
});

it("closes the change dialog when the server calls the page stale", async () => {
  const stale = {
    reason: "stale_page",
    diff: {
      changed: true,
      changed_keys: ["execution_table_id"],
      previous: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-bugs"
      },
      next: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-bugs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-bugs"
      }
    }
  };
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, stale));
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  renderCheck({ saveTarget, loadTarget });

  await userEvent.selectOptions(await readExecutionLink(), "tbl-bugs");
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
  expect(screen.getByLabelText("执行记录表")).toHaveValue("tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByRole("dialog")).toBeVisible();
  expect(saveTarget).toHaveBeenCalledTimes(1);
});

it("sends the defect role from the second base the administrator read", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLink();
  await userEvent.type(screen.getByLabelText(/缺陷库链接/), BUG_RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取缺陷表" }));
  await userEvent.selectOptions(await screen.findByLabelText("缺陷记录表"), "tbl-past");
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
  const resolve = vi
    .fn()
    .mockResolvedValueOnce(RESOLVED)
    .mockResolvedValueOnce(BUG_RESOLVED)
    .mockResolvedValue(reread);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  const link = screen.getByLabelText("Lark 文档链接");
  await readExecutionLink();
  await userEvent.type(screen.getByLabelText(/缺陷库链接/), BUG_RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取缺陷表" }));

  // Re-reading the execution link must not silently move the defect role back
  // into the execution base while the form still shows the other base.
  await userEvent.clear(link);
  await userEvent.type(link, RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));

  expect(await screen.findByText(/已读取「执行库（重读）」的 2 张数据表/)).toBeVisible();
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(screen.getByLabelText(/缺陷库链接/)).toHaveValue(BUG_RESOLVED.source_url);
  expect(await screen.findByLabelText("缺陷记录表")).toHaveValue("tbl-online");

  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_base_token: "app-exec",
    bug_base_token: "app-bugs",
    bug_table_id: "tbl-online"
  });
});

it("names the tables the page will send when only the server reports the change", async () => {
  const detail = {
    reason: "target_changed",
    diff: {
      changed: true,
      changed_keys: ["bug_table_id"],
      previous: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-gone"
      },
      next: {
        execution_base_token: "app-exec",
        execution_table_id: "tbl-runs",
        bug_base_token: "app-exec",
        bug_table_id: "tbl-bugs"
      }
    }
  };
  // The group gained a target after this page loaded, so the page holds no
  // fingerprint and the server answers with the change it just found.
  const saveTarget = vi.fn().mockRejectedValue(new ApiError(409, detail));
  renderCheck({ saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  const dialog = await screen.findByRole("dialog");
  // The name slot carries the table the page is about to send, not its id.
  expect(dialog.querySelector(".target-change-pair")).toHaveTextContent("tbl-gone → 缺陷记录");
  expect(dialog).toHaveTextContent("tbl-gone → tbl-bugs");
});

it("does not leave one group's target under another group's header", async () => {
  const other: Group = { ...GROUP, id: "0919-id", name: "Sprint 0919" };
  const resolve = vi.fn().mockRejectedValue(new Error("读取 Lark 表格失败"));
  const loadTarget = vi
    .fn()
    .mockResolvedValueOnce(TARGET_STATE)
    .mockReturnValue(new Promise(() => {}));
  renderCheck({ loadGroups: async () => [GROUP, other], loadTarget, resolve });

  expect(await screen.findByText("执行库")).toBeVisible();
  await userEvent.type(screen.getByLabelText("Lark 文档链接"), RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));
  expect(await screen.findByText("读取 Lark 表格失败")).toBeVisible();

  await userEvent.selectOptions(screen.getByLabelText("测试组"), other.id);

  expect(screen.queryByText("执行库")).not.toBeInTheDocument();
  expect(screen.queryByText("读取 Lark 表格失败")).not.toBeInTheDocument();
  expect(screen.getByText(/该组还没有选择 Lark 表/)).toBeVisible();
});

it("shows the target and the live read the save itself returned", async () => {
  const saved = { ...TARGET, execution_table_name: "新执行记录" };
  const saveTarget = vi.fn().mockResolvedValue({
    target: saved,
    live: { schema_errors: ["缺少必填字段「截图」"], read_errors: [] },
    confirmation_cleared: false
  });
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  renderCheck({ saveTarget, loadTarget });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(await screen.findByText(/已保存该组的 Lark 目标表/)).toBeVisible();
  expect(screen.getByText("缺少必填字段「截图」")).toBeVisible();
  // The PUT already answered with the saved row and its live state.
  expect(loadTarget).toHaveBeenCalledTimes(1);
});

it("does not claim a record count while the sync status is unreadable", async () => {
  const loadSync = vi.fn().mockRejectedValue(new Error("读取同步状态失败"));
  renderCheck({ loadSync });

  await userEvent.selectOptions(await readExecutionLink(), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).not.toHaveTextContent("条已保存的本地记录");
});

it("renders the reason a base yielded no tables", async () => {
  renderCheck({
    resolve: async () => ({
      ...RESOLVED,
      tables: [],
      read_errors: ["该多维表格中没有数据表，请先在 Lark 中新建数据表"]
    })
  });

  await userEvent.type(screen.getByLabelText("Lark 文档链接"), RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取表格" }));

  expect(await screen.findByText(/该多维表格中没有数据表/)).toBeVisible();
});

it("renders the reason the second link yielded no defect tables", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValue({
    ...BUG_RESOLVED,
    tables: [],
    read_errors: ["缺陷库中没有数据表，请先在 Lark 中新建数据表"]
  });
  renderCheck({ resolve, loadTarget: async () => emptyTargetState() });

  await readExecutionLink();
  await userEvent.type(screen.getByLabelText(/缺陷库链接/), BUG_RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取缺陷表" }));

  expect(await screen.findByText(/缺陷库中没有数据表/)).toBeVisible();
});

it("lets a parked-only group re-point its jobs and says how many moved", async () => {
  const retrySync = vi.fn().mockResolvedValueOnce({ requeued: 0, released: 0, repointed: 2 });
  const loadSync = vi.fn().mockResolvedValue(syncStatus({ failed: 0, parked: 2 }));
  renderCheck({
    loadTarget: async () => stateWith(confirmedTarget()),
    loadSync,
    retrySync
  });

  expect(await screen.findByText(/待同步 0/)).toBeVisible();
  expect(screen.getByText(/待管理员处理 2/)).toBeVisible();
  expect(screen.getByText(/条记录正在等待管理员处理/)).toBeVisible();
  expect(screen.queryByText(/因目标表更换而暂停/)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /重新指向当前目标表/ }));

  expect(retrySync).toHaveBeenCalledWith("0918-id", false);
  expect(await screen.findByText(/2 条任务已重新指向当前目标表/)).toBeVisible();
});

it("says a parked group is still unconfirmed instead of blaming a table change", async () => {
  const retrySync = vi.fn().mockResolvedValueOnce({ requeued: 0, released: 0, repointed: 2 });
  const loadSync = vi.fn().mockResolvedValue(syncStatus({ confirmed: false, parked: 2 }));
  renderCheck({
    loadTarget: async () => stateWith(TARGET),
    loadSync,
    retrySync
  });

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
  renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLink();
  const box = screen.getByLabelText(/缺陷库链接/);
  await userEvent.type(box, BUG_RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取缺陷表" }));
  expect(await screen.findByLabelText("缺陷记录表")).toHaveValue("tbl-online");

  // The label promises the execution base when no separate link is given, and
  // clearing the box is exactly that: the old read must stop driving the role.
  await userEvent.clear(box);
  expect(screen.getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");

  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_base_token: "app-exec",
    bug_base_token: "app-exec",
    bug_table_id: "tbl-bugs"
  });
});

it("never sends the base of a defect link the administrator replaced", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLink();
  const box = screen.getByLabelText(/缺陷库链接/);
  await userEvent.type(box, BUG_RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取缺陷表" }));
  expect(await screen.findByLabelText("缺陷记录表")).toHaveValue("tbl-online");

  // Typing a replacement without pressing 读取缺陷表 must not leave the read
  // base (app-bugs) in the payload for a URL that is no longer in the box.
  await userEvent.clear(box);
  await userEvent.type(box, "https://tenant.larksuite.com/wiki/node-9?table=tbl-other");
  expect(await screen.findByText(/尚未读取/)).toBeVisible();
  expect(screen.getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");

  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_base_token: "app-exec",
    bug_base_token: "app-exec",
    bug_table_id: "tbl-bugs"
  });
});

it("keeps the box and the payload in agreement when a read defect link is edited", async () => {
  const resolve = vi.fn().mockResolvedValueOnce(RESOLVED).mockResolvedValueOnce(BUG_RESOLVED);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  renderCheck({ resolve, saveTarget, loadTarget: async () => emptyTargetState() });

  await readExecutionLink();
  const box = screen.getByLabelText(/缺陷库链接/);
  await userEvent.type(box, BUG_RESOLVED.source_url);
  await userEvent.click(screen.getByRole("button", { name: "读取缺陷表" }));
  await userEvent.selectOptions(await screen.findByLabelText("缺陷记录表"), "tbl-past");

  // The administrator replaces the link. What they picked in the first base
  // must not survive on the wire: the box now holds an unread link, so the
  // defect role falls back to the execution base and the page says the link
  // still has to be read.
  await userEvent.clear(box);
  await userEvent.type(box, "https://tenant.larksuite.com/wiki/node-9?table=tbl-other");
  expect(await screen.findByText(/尚未读取/)).toBeVisible();
  const select = screen.getByLabelText("缺陷记录表");
  expect(select).toHaveValue("tbl-bugs");

  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  const payload = saveTarget.mock.calls[0][1];
  expect(payload).toMatchObject({ bug_base_token: "app-exec", bug_table_id: "tbl-bugs" });
  // The table the administrator sees and the table on the wire are the same.
  expect(payload.bug_table_id).toBe((select as HTMLSelectElement).value);
});

it("lists the missing headers before creating them and re-reads the target after", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PROVISION_PLAN);
  const provision = vi
    .fn()
    .mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [], target: TARGET });
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  renderCheck({ loadPlan, provision, loadTarget });

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

  expect(await screen.findByText("表头完整")).toBeVisible();
  expect(screen.queryByRole("button", { name: "设置表头" })).not.toBeInTheDocument();
});

it("shows the cleared write approval the header creation forced", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PROVISION_PLAN);
  const provision = vi
    .fn()
    .mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
  // The server clears confirmed_at when it changes the schema, so the re-read
  // comes back unconfirmed.
  const loadTarget = vi
    .fn()
    .mockResolvedValueOnce(stateWith(confirmedTarget()))
    .mockResolvedValue(stateWith(TARGET));
  renderCheck({ loadPlan, provision, loadTarget });

  expect(await screen.findByText(/已确认 执行记录 \/ 缺陷记录/)).toBeVisible();
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText(/尚未确认：本地结果不会写入 Lark/)).toBeVisible();
  expect(screen.queryByText(/已确认 执行记录 \/ 缺陷记录/)).not.toBeInTheDocument();
});

it("drops the approval the header creation invalidated even when the re-read fails", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PROVISION_PLAN);
  const provision = vi
    .fn()
    .mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
  const loadTarget = vi
    .fn()
    .mockResolvedValueOnce(stateWith(confirmedTarget()))
    .mockRejectedValue(new Error("读取该组的 Lark 目标失败"));
  renderCheck({ loadPlan, provision, loadTarget });

  expect(await screen.findByText(/已确认 执行记录 \/ 缺陷记录/)).toBeVisible();
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // The server already cleared the approval, so the page may not keep showing
  // it just because the confirming re-read failed.
  expect(await screen.findByText(/尚未确认：本地结果不会写入 Lark/)).toBeVisible();
  expect(screen.queryByText(/已确认 执行记录 \/ 缺陷记录/)).not.toBeInTheDocument();
  expect(screen.getByText("读取该组的 Lark 目标失败")).toBeVisible();
});

it("re-reads the header list when the saved target moves to another table", async () => {
  const loadPlan = vi.fn().mockResolvedValueOnce(CLEAN_PLAN).mockResolvedValue(PROVISION_PLAN);
  const repointed: LarkTarget = {
    ...TARGET,
    execution_table_id: "tbl-bugs",
    execution_table_name: "缺陷记录",
    schema_fingerprint: "schema-2",
    target_fingerprint: "app-exec|tbl-bugs|app-exec|tbl-bugs"
  };
  const saveTarget = vi
    .fn()
    .mockResolvedValue({ target: repointed, live: null, confirmation_cleared: true });
  renderCheck({ loadPlan, saveTarget });

  expect(await screen.findByText("表头完整")).toBeVisible();
  await userEvent.selectOptions(await readExecutionLink(), "tbl-bugs");
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));
  await userEvent.click(await screen.findByRole("button", { name: "确认切换" }));

  // The old list described tbl-runs; the panel must describe the table the
  // group now points at, or an administrator approves a diff for the wrong one.
  expect(await screen.findByText(/缺少 2 个表头/)).toBeVisible();
  expect(loadPlan).toHaveBeenCalledTimes(2);
});

it("puts a newly created defect table into the draft the page will save", async () => {
  const createTable = vi
    .fn()
    .mockResolvedValue({ table: { table_id: "tbl-fresh", name: "缺陷记录" }, role: "bug" });
  const saveTarget = vi
    .fn()
    .mockResolvedValue({ target: TARGET, live: null, confirmation_cleared: false });
  renderCheck({ createTable, saveTarget });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "新建缺陷记录数据表" }));

  expect(createTable).toHaveBeenCalledWith(GROUP.id, {
    role: "bug",
    base_token: "app-exec",
    table_name: "缺陷记录",
    acknowledge: true
  });
  expect(await screen.findByLabelText("缺陷记录表")).toHaveValue("tbl-fresh");

  // The new table is only a draft: it becomes the group's target when saved.
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
  const createTable = vi
    .fn()
    .mockRejectedValue(new ApiError(409, "新建数据表失败：没有权限"));
  renderCheck({ createTable });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "新建缺陷记录数据表" }));

  expect(await screen.findByText(/新建数据表失败：没有权限/)).toBeVisible();
  expect(screen.getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");
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
  const loadTarget = vi
    .fn()
    .mockResolvedValueOnce(TARGET_STATE)
    .mockResolvedValue(stateWith(rebuilt));
  const { saveTarget } = renderCheck({ rebuild, loadTarget });

  await readExecutionLink();
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建缺陷记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(rebuild).toHaveBeenCalledWith(GROUP.id, { role: "bug", acknowledge: true });
  expect(await screen.findByLabelText("缺陷记录表")).toHaveValue("tbl-fresh");
  // The rebuilt destination dropped the approval on the server, so the page
  // says so instead of showing the one that no longer stands.
  expect(await screen.findByText(/尚未确认：本地结果不会写入 Lark/)).toBeVisible();

  // The server already points the group at the rebuilt table, so the page is
  // not asking for a switch: saving only has to keep naming that table.
  await userEvent.click(screen.getByRole("button", { name: "保存选择" }));

  expect(saveTarget).toHaveBeenCalledTimes(1);
  expect(saveTarget.mock.calls[0][1]).toMatchObject({
    execution_table_id: "tbl-runs",
    bug_table_id: "tbl-fresh"
  });
});
