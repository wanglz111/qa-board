import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { Group, LarkCheck, LarkConfirmationState } from "../api";
import { LarkCheckView } from "./LarkCheck";

const GROUP: Group = {
  id: "0918-id",
  name: "Sprint 0918",
  source_name: "0918.csv",
  source_version: "1",
  count: 14,
  created_at: "2026-09-16T08:00:00Z"
};

const CHECK: LarkCheck = {
  base_name: "旧版测试管理",
  execution_table_name: "执行记录",
  bug_table_name: "缺陷记录",
  execution_fields: { 用例: "text", 结果: "single_select", 截图: "attachment" },
  bug_fields: { 问题描述: "text", 进展状态: "single_select" },
  required_execution_fields: ["用例", "结果", "截图"],
  required_bug_fields: ["问题描述", "进展状态"],
  schema_errors: [],
  read_errors: [],
  schema_fingerprint: "schema-1",
  target_fingerprint: "target-1"
};

function unconfirmed(): LarkConfirmationState {
  return {
    confirmed: false,
    confirmation: null,
    current: {
      base_token: "app-token",
      execution_table_id: "tbl-runs",
      bug_table_id: "tbl-defects",
      base_name: "旧版测试管理",
      execution_table_name: "执行记录",
      bug_table_name: "缺陷记录",
      schema_fingerprint: "schema-1",
      target_fingerprint: "target-1",
      schema_errors: [],
      read_errors: []
    }
  };
}

function renderCheck(overrides: Partial<Parameters<typeof LarkCheckView>[0]> = {}) {
  const confirm = vi.fn().mockResolvedValue({
    group_id: GROUP.id,
    base_token: "app-token",
    execution_table_id: "tbl-runs",
    bug_table_id: "tbl-defects",
    base_name: "旧版测试管理",
    execution_table_name: "执行记录",
    bug_table_name: "缺陷记录",
    schema_fingerprint: "schema-1",
    target_fingerprint: "target-1",
    confirmed_at: "2026-09-16T10:00:00Z",
    valid: true
  });
  render(
    <LarkCheckView
      loadGroups={async () => [GROUP]}
      loadCheck={async () => CHECK}
      loadConfirmation={async () => unconfirmed()}
      confirm={confirm}
      {...overrides}
    />
  );
  return { confirm };
}

it("shows the names actually read from Lark", async () => {
  renderCheck();

  expect(await screen.findByText("旧版测试管理")).toBeVisible();
  expect(screen.getByText("执行记录")).toBeVisible();
  expect(screen.getByText("缺陷记录")).toBeVisible();
  expect(screen.getByText(/用例 · text/)).toBeVisible();
  expect(await screen.findByText(/尚未确认：本地结果不会写入 Lark/)).toBeVisible();
});

it("requires an explicit consent toggle before confirming", async () => {
  const { confirm } = renderCheck();

  const button = await screen.findByRole("button", { name: /确认本组写入目标/ });
  expect(button).toBeDisabled();
  expect(confirm).not.toHaveBeenCalled();

  await userEvent.click(screen.getByLabelText("允许向上述旧表新增本组记录"));
  expect(button).toBeEnabled();
  await userEvent.click(button);

  expect(confirm).toHaveBeenCalledWith("0918-id", {
    base_token: "app-token",
    execution_table_id: "tbl-runs",
    bug_table_id: "tbl-defects",
    schema_fingerprint: "schema-1",
    target_fingerprint: "target-1",
    allow_writes: true
  });
  expect(await screen.findByText(/已确认：本组新记录只会新增/)).toBeVisible();
});

it("blocks confirmation and explains when Lark reports schema errors", async () => {
  renderCheck({
    loadCheck: async () => ({
      ...CHECK,
      schema_errors: ["缺少必填字段「截图」"],
      schema_fingerprint: null,
      target_fingerprint: null
    })
  });

  expect(await screen.findByText("缺少必填字段「截图」")).toBeVisible();
  expect(screen.getByLabelText("允许向上述旧表新增本组记录")).toBeDisabled();
  expect(screen.getByRole("button", { name: /确认本组写入目标/ })).toBeDisabled();
});

it("marks an earlier confirmation invalid when the target changed", async () => {
  renderCheck({
    loadConfirmation: async () => ({
      confirmed: false,
      confirmation: {
        group_id: GROUP.id,
        base_token: "app-token",
        execution_table_id: "tbl-runs",
        bug_table_id: "tbl-defects",
        base_name: "旧版测试管理",
        execution_table_name: "执行记录",
        bug_table_name: "缺陷记录",
        schema_fingerprint: "schema-old",
        target_fingerprint: "target-old",
        confirmed_at: "2026-09-15T10:00:00Z",
        valid: false
      },
      current: unconfirmed().current
    })
  });

  expect(await screen.findByText(/此前的确认已失效/)).toBeVisible();
  expect(screen.getByRole("button", { name: /确认本组写入目标/ })).toBeDisabled();
});

it("queues previously saved local attempts only after confirmation", async () => {
  const enqueueSync = vi.fn().mockResolvedValue({ queued: 2 });
  const loadSync = vi
    .fn()
    .mockResolvedValueOnce({
      confirmed: true,
      queued: 0,
      synced: 1,
      failed: 0,
      uncertain: 0,
      last_error_kind: null,
      pending_attempts: 2,
      detail: "目标表已确认，可显式排入同步"
    })
    .mockResolvedValueOnce({
      confirmed: true,
      queued: 2,
      synced: 1,
      failed: 0,
      uncertain: 0,
      last_error_kind: null,
      pending_attempts: 2,
      detail: "目标表已确认，可显式排入同步"
    });
  renderCheck({
    loadConfirmation: async () => ({
      ...unconfirmed(),
      confirmed: true,
      confirmation: {
        group_id: GROUP.id,
        base_token: "app-token",
        execution_table_id: "tbl-runs",
        bug_table_id: "tbl-defects",
        base_name: "旧版测试管理",
        execution_table_name: "执行记录",
        bug_table_name: "缺陷记录",
        schema_fingerprint: "schema-1",
        target_fingerprint: "target-1",
        confirmed_at: "2026-09-16T10:00:00Z",
        valid: true
      }
    }),
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
