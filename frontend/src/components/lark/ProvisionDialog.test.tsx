import { render, screen } from "@testing-library/react";
import { useCallback, useMemo, useState } from "react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import {
  ApiError,
  type LarkTarget,
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
// exactly the wiring the page has (`StepHeaders` holds `open` and `onFinished`
// and the dialog keeps its own ticks and messages).
//
// The shell is rendered without a `provision` call on purpose: its own dialog
// would be a second, unreachable instance of the component under test.
function Harness({
  plan = COMPLETE,
  loadPlan,
  provision,
  onChanged,
  onRoleFixed,
  onTableCreated
}: HarnessProps) {
  // `loadPlan` is one of the shell's effect dependencies, so it has to keep its
  // identity across renders or every render would start another read.
  const planOf: (groupId: string) => Promise<ProvisionPlan> = useMemo(
    () => loadPlan ?? vi.fn().mockResolvedValue(plan),
    [loadPlan, plan]
  );
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ProvisionPlan | null>(null);
  const [notice, setNotice] = useState("");
  const [generation, setGeneration] = useState(0);
  // Every read is wrapped, so the dialog sees the plan the shell would hand
  // down on each generation. `generation` only exists to give the shell a new
  // `loadPlan` identity, which is how it is told to read again.
  const read = useCallback(
    () =>
      planOf("g1").then((loaded) => {
        setCurrent(loaded);
        return loaded;
      }),
    [planOf, generation]
  );
  const close = () => setOpen(false);
  const changed = onChanged ?? vi.fn().mockResolvedValue(undefined);
  const fixed = onRoleFixed ?? vi.fn();
  return (
    <>
      <StepHeaders
        groupId="g1"
        target={null}
        busy={false}
        createTable={vi.fn()}
        loadPlan={read}
        targetFingerprint="app-exec|tbl-runs|app-exec|tbl-bugs"
        schemaFingerprint={null}
        bases={{ execution: "app-exec", bug: "app-bugs" }}
        tableNames={{ execution: "执行记录", bug: "缺陷记录" }}
        onChanged={changed}
        onRoleFixed={fixed}
        onTableCreated={onTableCreated ?? vi.fn()}
        onTableRebuilt={vi.fn()}
      />
      <ProvisionDialog
        groupId="g1"
        plan={current}
        open={open}
        onClose={close}
        onChanged={changed}
        provision={provision ?? vi.fn()}
        reloadPlan={() => setGeneration((value) => value + 1)}
        onOpenRequest={() => setOpen(true)}
        onFinished={setNotice}
        onRoleFixed={fixed}
      />
      {notice ? (
        <p className="inline-status saved" role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}

function renderDialog(props: HarnessProps = {}) {
  render(<Harness {...props} />);
}

// Waits for the shell's first plan read to land, opens the dialog the way the
// page does, then hands it back.
async function openProvision() {
  await screen.findByText(/缺少 2 个表头|表头完整|正在读取表头|读取缺失表头失败/);
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  return screen.findByRole("dialog");
}

it("lists exactly what will be created before creating it", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [], target: TARGET });
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
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
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
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [], target: TARGET });
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
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
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
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [], target: TARGET });
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
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [], target: TARGET });
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
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [], target: TARGET });
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
