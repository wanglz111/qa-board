import { render, screen } from "@testing-library/react";
import { useMemo } from "react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import {
  type LarkTarget,
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type Table,
  type TableRole
} from "../../api";
import { StepHeaders } from "./StepHeaders";

const COMPLETE: ProvisionPlan = { roles: { execution: [], bug: [] } };

// Every *Result type carries the target the server answered with, so a fixture
// that omits it is not the shape the component reads.
const TARGET: LarkTarget = {
  group_id: "g1",
  source_url: "https://example.larksuite.com/base/app-exec",
  execution_base_token: "app-exec",
  execution_base_name: "执行库",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-bugs",
  bug_base_name: "缺陷库",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: null,
  target_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs",
  confirmed_at: null,
  confirmed: true
};

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
    target: TARGET
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
  // `loadPlan` is one of the shell's effect dependencies, so it has to keep its
  // identity across renders; the reader answers with the plan under test.
  const read = useMemo(() => loadPlan ?? vi.fn().mockResolvedValue(plan), [loadPlan, plan]);
  return (
    <StepHeaders
      groupId="g1"
      target={null}
      busy={false}
      rebuild={rebuild}
      loadPlan={read}
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
    <Harness rebuild={rebuild} onChanged={onChanged} onTableRebuilt={onTableRebuilt} {...overrides} />
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
