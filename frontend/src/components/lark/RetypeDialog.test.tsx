import { render, screen } from "@testing-library/react";
import { useMemo } from "react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import {
  ApiError,
  type LarkTarget,
  type ProvisionPlan,
  type RetypeFieldsPayload,
  type RetypeFieldsResult
} from "../../api";
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
  plan: ProvisionPlan;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  onChanged?: () => Promise<void>;
  onRoleFixed?: (role: "execution" | "bug") => void;
};

function Harness({ plan, retype, onChanged, onRoleFixed = vi.fn() }: HarnessProps) {
  // The shell re-reads whenever `loadPlan` changes identity, so the reader is
  // created once. After a run the plan is read again — and the run is what the
  // repaired table is about, so the second read answers with a complete table.
  const loadPlan = useMemo(
    () => vi.fn().mockResolvedValueOnce(plan).mockResolvedValue(COMPLETE),
    [plan]
  );
  return (
    <StepHeaders
      groupId="g1"
      target={null}
      loadPlan={loadPlan}
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
  const retype = vi.fn().mockResolvedValue({ retyped_fields: ["优先级"], schema_errors: [], target: TARGET });
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
  const retype = vi.fn().mockResolvedValue({ retyped_fields: [], schema_errors: [], target: TARGET });
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
  const retype = vi.fn().mockResolvedValue({ retyped_fields: [], schema_errors: [], target: TARGET });
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
  // The plan really does carry a wrong type here (the old case's fixture): the
  // entry stays hidden because the page cannot repair — not because there is
  // nothing to repair.
  render(<Harness plan={RETYPE_PLAN} />);

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
