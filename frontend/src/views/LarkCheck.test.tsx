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
  schema_errors: []
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
    last_error_kind: null,
    pending_attempts: 2,
    detail: "目标表已确认，可显式排入同步",
    ...overrides
  };
}

function renderCheck(overrides: Partial<Parameters<typeof LarkCheckView>[0]> = {}) {
  const resolve = vi.fn().mockResolvedValue(RESOLVED);
  const loadTarget = vi.fn().mockResolvedValue(TARGET_STATE);
  const saveTarget = vi.fn().mockResolvedValue({ target: TARGET, confirmation_cleared: false });
  const confirmTarget = vi.fn().mockResolvedValue(confirmedTarget());
  render(
    <LarkCheckView
      loadGroups={async () => [GROUP]}
      resolve={resolve}
      loadTarget={loadTarget}
      saveTarget={saveTarget}
      confirmTarget={confirmTarget}
      {...overrides}
    />
  );
  return { resolve, loadTarget, saveTarget, confirmTarget };
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
  expect(saveTarget).toHaveBeenLastCalledWith(
    GROUP.id,
    expect.objectContaining({ acknowledge_change: true })
  );
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
  const saveTarget = vi
    .fn()
    .mockRejectedValue(
      new ApiError(409, "缺陷表 id 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接")
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
