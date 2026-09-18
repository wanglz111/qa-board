import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import {
  type CreateTablePayload,
  type CreateTableResult,
  type LarkTarget,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type RetypeFieldsPayload,
  type RetypeFieldsResult,
  type Table
} from "../../api";
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

it("closes the dialog when the group changes", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PLAN);
  const { rerender } = render(props({ loadPlan }));

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  expect(screen.getByRole("dialog")).toBeVisible();

  rerender(props({ loadPlan, groupId: "g2" }));

  // The dialog belonged to the previous group's table; the new group starts
  // with nothing open (the page also re-keys the three dialogs, which drops
  // their ticks and their messages).
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The new group's plan arrives instead of the old one's headers.
  expect(await screen.findByRole("button", { name: "设置表头" })).toBeVisible();
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
    .mockResolvedValueOnce({ created_fields: ["结果"], schema_errors: [], target: TARGET })
    .mockResolvedValue({ created_fields: ["问题描述"], schema_errors: [], target: TARGET });
  const retype = vi.fn().mockResolvedValue({ retyped_fields: ["优先级"], schema_errors: [], target: TARGET });
  const onRoleFixed = vi.fn();
  render(props({ plan, provision, retype, onRoleFixed }));

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
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
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
