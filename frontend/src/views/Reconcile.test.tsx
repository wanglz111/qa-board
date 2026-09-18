import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { ReconcileDiff } from "../api";
import { Reconcile } from "./Reconcile";

// Two rows still need a decision, and one already carries one: the header
// checkbox has to select exactly the two unresolved rows, in row order.
const DIFF: ReconcileDiff = {
  source: "live",
  source_table_name: "执行记录",
  read_errors: [],
  counts: { same: 0, local_only: 1, remote_only: 0, conflict: 2, unmatched: 0 },
  unresolved: 2,
  rows: [
    {
      key: "B-001",
      case_code: "B-001",
      label: "B-001",
      status: "conflict",
      differing: ["result", "console_text"],
      remote_deleted: false,
      local: { attempt_id: "a-1", result: "通过", console_text: "本地日志" },
      remote: { record_id: "r-1", result: "不通过", console_text: "表内日志" },
      decision: null
    },
    {
      key: "B-002",
      case_code: "B-002",
      label: "B-002",
      status: "conflict",
      differing: ["result"],
      remote_deleted: false,
      local: { attempt_id: "a-2", result: "未执行", console_text: null },
      remote: { record_id: "r-2", result: "通过", console_text: null },
      decision: null
    },
    {
      key: "B-003",
      case_code: "B-003",
      label: "B-003",
      status: "local_only",
      differing: [],
      remote_deleted: false,
      local: { attempt_id: "a-3", result: "通过", console_text: "旧日志" },
      remote: null,
      decision: "use_local"
    }
  ]
};

// The administrator deleted this record in Lark: the local row is the only side
// left, and it is the one row the page is allowed to delete.
const DELETED_IN_LARK: ReconcileDiff = {
  ...DIFF,
  counts: { same: 0, local_only: 1, remote_only: 0, conflict: 0, unmatched: 0 },
  unresolved: 1,
  rows: [
    {
      key: "B-009",
      case_code: "B-009",
      label: "B-009",
      status: "local_only",
      differing: [],
      remote_deleted: true,
      local: { attempt_id: "a-9", result: "不通过", console_text: "wallet.bind timeout" },
      remote: null,
      decision: null
    }
  ]
};

it("selects rows in bulk and applies the chosen side", async () => {
  const apply = vi.fn().mockResolvedValue({ pulled: 2, kept: 0, removed: 0, skipped: [] });
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={apply} />);

  await userEvent.click(await screen.findByLabelText("全选有差异的记录"));
  await userEvent.click(screen.getByRole("button", { name: "采用表内记录（2）" }));

  // Adopting rewrites nothing, so the confirmation comes before any request.
  expect(apply).not.toHaveBeenCalled();
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认采用" }));

  expect(apply).toHaveBeenCalledWith("g1", [
    { key: "B-001", action: "use_remote" },
    { key: "B-002", action: "use_remote" }
  ]);
});

it("says that adopting appends a new record instead of overwriting", async () => {
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={vi.fn()} />);
  await userEvent.click(await screen.findByLabelText("选择 B-001"));
  await userEvent.click(screen.getByRole("button", { name: "采用表内记录（1）" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("新增一条");
  expect(dialog).toHaveTextContent("本地原始记录和截图会原样保留");
});

it("keeps the local record and says the table is never written back", async () => {
  const apply = vi.fn().mockResolvedValue({ pulled: 0, kept: 1, removed: 0, skipped: [] });
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={apply} />);

  await userEvent.click(await screen.findByLabelText("选择 B-002"));
  await userEvent.click(screen.getByRole("button", { name: "保留本地记录（1）" }));

  expect(apply).toHaveBeenCalledWith("g1", [{ key: "B-002", action: "use_local" }]);
  expect(screen.getByText(/只记录这个决定/)).toBeVisible();
});

it("reports each skip reason the server returned", async () => {
  const apply = vi
    .fn()
    .mockResolvedValue({
      pulled: 0,
      kept: 0,
      removed: 0,
      skipped: [{ key: "B-001", reason: "表里没有这条记录" }]
    });
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={apply} />);

  await userEvent.click(await screen.findByLabelText("选择 B-001"));
  await userEvent.click(screen.getByRole("button", { name: "采用表内记录（1）" }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认采用" }));

  expect(await screen.findByText("已拉回 0 条 · 保留 0 条")).toBeVisible();
  expect(await screen.findByText("B-001：表里没有这条记录")).toBeVisible();
});

it("marks rows that already carry a decision", async () => {
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={vi.fn()} />);
  expect(await screen.findByText("已核对")).toBeVisible();
  expect(screen.queryByLabelText("选择 B-003")).not.toBeInTheDocument();
});

it("reads local snapshots without asking for a live table read", async () => {
  const load = vi.fn((_groupId: string, source: "live" | "stored") =>
    Promise.resolve(
      source === "stored" ? { ...DIFF, source, source_table_name: "本地快照" } : DIFF
    )
  );
  render(<Reconcile groupId="g1" load={load} apply={vi.fn()} />);

  await screen.findByText("执行记录");
  load.mockClear();
  await userEvent.click(screen.getByRole("button", { name: "读本地快照" }));

  expect(await screen.findByText("本地快照")).toBeVisible();
  expect(load).toHaveBeenCalledWith("g1", "stored");
  expect(load).not.toHaveBeenCalledWith("g1", "live");
});

it("names a record that left the table instead of calling it local-only", async () => {
  render(
    <Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DELETED_IN_LARK)} apply={vi.fn()} />
  );

  expect(await screen.findByText("表里已删除")).toBeVisible();
  expect(screen.queryByText("仅本地")).not.toBeInTheDocument();
});

it("deletes the local record only after a dialog that says what goes with it", async () => {
  const apply = vi.fn().mockResolvedValue({ pulled: 0, kept: 0, removed: 1, skipped: [] });
  render(
    <Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DELETED_IN_LARK)} apply={apply} />
  );

  await userEvent.click(await screen.findByLabelText("选择 B-009"));
  await userEvent.click(screen.getByRole("button", { name: "删除本地记录（1）" }));

  expect(apply).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("删除本地记录？");
  expect(dialog).toHaveTextContent("截图");
  expect(dialog).toHaveTextContent("无法撤销");

  await userEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));

  expect(apply).toHaveBeenCalledWith("g1", [{ key: "B-009", action: "delete_local" }]);
  expect(await screen.findByText("已拉回 0 条 · 保留 0 条 · 删除 1 条")).toBeVisible();
});

it("leaves the delete button off rows the table still has", async () => {
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={vi.fn()} />);

  const del = await screen.findByRole("button", { name: "删除本地记录（0）" });
  expect(del).toBeDisabled();

  await userEvent.click(screen.getByLabelText("选择 B-001"));
  expect(screen.getByRole("button", { name: "删除本地记录（0）" })).toBeDisabled();
});

it("refuses to mix a deletable row with one it cannot touch", async () => {
  const mixed: ReconcileDiff = {
    ...DIFF,
    counts: { same: 0, local_only: 1, remote_only: 0, conflict: 1, unmatched: 0 },
    unresolved: 2,
    rows: [DIFF.rows[0], DELETED_IN_LARK.rows[0]]
  };
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(mixed)} apply={vi.fn()} />);

  // The count is what would go, so the mixed selection still reads as one row —
  // and the button stays off, because that one row was not chosen on its own.
  await userEvent.click(await screen.findByLabelText("全选有差异的记录"));
  expect(screen.getByRole("button", { name: "删除本地记录（1）" })).toBeDisabled();

  await userEvent.click(screen.getByLabelText("选择 B-001"));
  expect(screen.getByRole("button", { name: "删除本地记录（1）" })).toBeEnabled();
});
