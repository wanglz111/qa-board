import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ApiError } from "../api";
import { HeaderSetup } from "./HeaderSetup";

const PLAN = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  }
};

const COMPLETE = { roles: { execution: [], bug: [] } };

function renderSetup(overrides: Partial<Parameters<typeof HeaderSetup>[0]> = {}) {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [] });
  const onChanged = vi.fn();
  const loadPlan = vi.fn().mockResolvedValue(PLAN);
  render(
    <HeaderSetup
      groupId="g1"
      loadPlan={loadPlan}
      provision={provision}
      onChanged={onChanged}
      {...overrides}
    />
  );
  return { provision, onChanged, loadPlan };
}

it("lists exactly what will be created before creating it", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果", "日期"], schema_errors: [] });
  render(<HeaderSetup groupId="g1" loadPlan={vi.fn().mockResolvedValue(PLAN)} provision={provision} onChanged={vi.fn()} />);

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("结果");
  expect(dialog).toHaveTextContent("日期");
  expect(provision).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));
  expect(provision).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ role: "execution", field_names: ["结果", "日期"], acknowledge: true })
  );
});

it("stays hidden when the table already has every header", async () => {
  render(<HeaderSetup groupId="g1" loadPlan={vi.fn().mockResolvedValue({ roles: { execution: [], bug: [] } })} provision={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("表头完整");
  expect(screen.queryByRole("button", { name: "设置表头" })).not.toBeInTheDocument();
});

it("sends only the headers the administrator left ticked", async () => {
  const { provision } = renderSetup();

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "创建表头「日期」" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(provision).toHaveBeenCalledTimes(1);
  expect(provision).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ role: "execution", field_names: ["结果"], create_view: false, acknowledge: true })
  );
});

it("keeps the primary command disabled until a header is ticked", async () => {
  const { provision } = renderSetup();

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  const create = screen.getByRole("button", { name: "创建这些表头" });
  expect(create).toBeEnabled();

  await userEvent.click(screen.getByRole("checkbox", { name: "创建表头「结果」" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "创建表头「日期」" }));

  // Nothing is ticked, so nothing may be created.
  expect(create).toBeDisabled();
  expect(provision).not.toHaveBeenCalled();
});

it("asks for the TestDeck view only when the administrator ticked it", async () => {
  const { provision } = renderSetup();

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(provision).toHaveBeenCalledWith(
    "g1",
    expect.objectContaining({ create_view: true, acknowledge: true })
  );
});

it("reports how many headers were created and asks the page to re-read the target", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [] });
  const { onChanged } = renderSetup({ provision });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText("已创建 1 个表头，请重新确认写入")).toBeVisible();
  // The server clears the write approval with the schema change.
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("reports a refused creation instead of claiming success", async () => {
  const provision = vi.fn().mockRejectedValue(new Error("创建表头失败：没有权限"));
  const { onChanged } = renderSetup({ provision });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(await screen.findByText("创建表头失败：没有权限")).toBeVisible();
  expect(screen.queryByText(/已创建/)).not.toBeInTheDocument();
  expect(onChanged).not.toHaveBeenCalled();
  // The dialog stays up: the administrator has to see the refusal.
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("leaves the approval alone when Lark already had every header", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [] });
  const loadPlan = vi.fn().mockResolvedValueOnce(PLAN).mockResolvedValue(COMPLETE);
  const { onChanged } = renderSetup({ provision, loadPlan });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // Nothing was created, so the approval still stands: neither the notice nor
  // the page may claim it has to be confirmed again.
  expect(await screen.findByText("没有缺少的表头，写入确认保持不变")).toBeVisible();
  expect(onChanged).not.toHaveBeenCalled();
  // The list is still re-read, so the panel stops offering what is there.
  expect(await screen.findByText("表头完整")).toBeVisible();
});

it("takes focus on open and lets Escape cancel without creating anything", async () => {
  const { provision } = renderSetup();

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  expect(screen.getByRole("button", { name: "创建这些表头" })).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(provision).not.toHaveBeenCalled();
});

it("keeps Tab, checkboxes included, inside the dialog instead of the page behind", async () => {
  render(
    <>
      <HeaderSetup
        groupId="g1"
        loadPlan={vi.fn().mockResolvedValue(PLAN)}
        provision={vi.fn()}
        onChanged={vi.fn()}
      />
      <button type="button">页面上的按钮</button>
    </>
  );

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  const dialog = screen.getByRole("dialog");
  const outside = screen.getByRole("button", { name: "页面上的按钮" });
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

it("creates a role's table with its default name and hands the new table back", async () => {
  const createTable = vi
    .fn()
    .mockResolvedValue({ table: { table_id: "tbl-new", name: "缺陷记录" }, role: "bug" });
  const onTableCreated = vi.fn();
  renderSetup({
    loadPlan: vi.fn().mockResolvedValue(COMPLETE),
    createTable,
    onTableCreated,
    bases: { execution: "app-exec", bug: "app-bugs" }
  });

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
  renderSetup({
    loadPlan: vi.fn().mockResolvedValue(COMPLETE),
    createTable: vi.fn(),
    onTableCreated: vi.fn(),
    bases: { execution: "app-exec", bug: "" }
  });

  await screen.findByText("表头完整");
  expect(screen.getByRole("button", { name: "新建执行记录数据表" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "新建缺陷记录数据表" })).toBeDisabled();
  expect(screen.getByLabelText("新表名称（缺陷记录）")).toHaveAttribute("maxlength", "100");
});

it("closes the dialog when the group changes", async () => {
  const loadPlan = vi.fn().mockResolvedValue(PLAN);
  const props = { groupId: "g1", loadPlan, provision: vi.fn(), onChanged: vi.fn() };
  const { rerender } = render(<HeaderSetup {...props} />);

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  expect(screen.getByRole("dialog")).toBeVisible();

  rerender(<HeaderSetup {...props} groupId="g2" />);

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(loadPlan).toHaveBeenLastCalledWith("g2");
  // The new group's plan arrives instead of the old one's headers.
  expect(await screen.findByRole("button", { name: "设置表头" })).toBeVisible();
});

it("re-reads the header list when the target it describes changes", async () => {
  const loadPlan = vi.fn().mockResolvedValueOnce(PLAN).mockResolvedValue(COMPLETE);
  const props = {
    groupId: "g1",
    loadPlan,
    provision: vi.fn(),
    onChanged: vi.fn(),
    targetFingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs"
  };
  const { rerender } = render(<HeaderSetup {...props} />);

  expect(await screen.findByRole("button", { name: "设置表头" })).toBeVisible();

  // The group now points at another table: the old list describes a table that
  // will not receive the headers, so it may not stay on screen.
  rerender(<HeaderSetup {...props} targetFingerprint="app-exec|tbl-fresh|app-exec|tbl-bugs" />);

  expect(await screen.findByText("表头完整")).toBeVisible();
  expect(loadPlan).toHaveBeenCalledTimes(2);
});

it("re-reads the header list after a refusal", async () => {
  const loadPlan = vi.fn().mockResolvedValueOnce(PLAN).mockResolvedValue(COMPLETE);
  const provision = vi.fn().mockRejectedValue(new Error("创建表头失败：没有权限"));
  renderSetup({ loadPlan, provision });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
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
  const { onChanged } = renderSetup({ provision });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // The refusal is an object, not a plain string: its readable message is what
  // the administrator needs, and the fields it did create were really created.
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("创建视图失败：没有权限");
  expect(dialog).toHaveTextContent("已创建 2 个表头，请重新确认写入");
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("does not offer a TestDeck view the table already carries", async () => {
  const plan = {
    ...PLAN,
    views: {
      execution: { name: "TestDeck", exists: true, view_id: "vew-1" },
      bug: { name: "TestDeck", exists: false, view_id: null }
    }
  };
  const provision = vi.fn().mockResolvedValue({ created_fields: ["结果"], schema_errors: [] });
  renderSetup({ loadPlan: vi.fn().mockResolvedValue(plan), provision });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));

  expect(screen.queryByRole("checkbox", { name: "同时创建 TestDeck 视图" })).not.toBeInTheDocument();
  expect(screen.getByText(/TestDeck 视图已存在/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));
  expect(provision).toHaveBeenCalledWith("g1", expect.objectContaining({ create_view: false }));
});

it("only asks for the view in the role that is missing it", async () => {
  const plan = {
    roles: {
      execution: PLAN.roles.execution,
      bug: [{ name: "问题描述", type: 1, type_name: "text", properties: {} }]
    },
    views: {
      execution: { name: "TestDeck", exists: true, view_id: "vew-1" },
      bug: { name: "TestDeck", exists: false, view_id: null }
    }
  };
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [] });
  renderSetup({ loadPlan: vi.fn().mockResolvedValue(plan), provision });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  expect(provision).toHaveBeenCalledWith("g1", expect.objectContaining({ role: "execution", create_view: false }));
  expect(provision).toHaveBeenCalledWith("g1", expect.objectContaining({ role: "bug", create_view: true }));
});

it("clears the new-table message once that role's base moves", async () => {
  const createTable = vi
    .fn()
    .mockResolvedValue({ table: { table_id: "tbl-new", name: "缺陷记录" }, role: "bug" });
  const props = {
    groupId: "g1",
    loadPlan: vi.fn().mockResolvedValue(COMPLETE),
    provision: vi.fn(),
    onChanged: vi.fn(),
    createTable,
    onTableCreated: vi.fn(),
    bases: { execution: "app-exec", bug: "app-bugs" }
  };
  const { rerender } = render(<HeaderSetup {...props} />);

  await userEvent.click(await screen.findByRole("button", { name: "新建缺陷记录数据表" }));
  expect(await screen.findByText(/已新建数据表「缺陷记录」/)).toBeVisible();

  rerender(<HeaderSetup {...props} bases={{ execution: "app-exec", bug: "app-other" }} />);

  // The message described a table in app-bugs; it says nothing about app-other.
  expect(screen.queryByText(/已新建数据表/)).not.toBeInTheDocument();
});

it("resets the view choice when the dialog is closed and opened again", async () => {
  renderSetup();

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" }));
  expect(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" })).toBeChecked();

  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));

  // The rows are reseeded on every open, and the view choice goes with them.
  expect(screen.getByRole("checkbox", { name: "同时创建 TestDeck 视图" })).not.toBeChecked();
});

const RETYPE_PLAN = {
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

it("offers to convert a header that already exists with the wrong type", async () => {
  const retype = vi.fn().mockResolvedValue({ retyped_fields: ["优先级"], schema_errors: [] });
  const loadPlan = vi.fn().mockResolvedValueOnce(RETYPE_PLAN).mockResolvedValue(COMPLETE);
  const { onChanged } = renderSetup({ retype, loadPlan });

  expect(await screen.findByText(/1 个表头类型不对/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "修正表头类型" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("优先级");
  // The administrator sees both the wrong type and the one it will become.
  expect(dialog).toHaveTextContent("text → single_select");
  expect(retype).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  expect(retype).toHaveBeenCalledWith("g1", {
    role: "execution",
    field_names: ["优先级"],
    acknowledge: true
  });
  // A real type change clears the write approval, so the page re-reads it.
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("已修正 1 个表头，请重新确认写入")).toBeVisible();
  expect(await screen.findByText("表头完整")).toBeVisible();
});

it("sends only the headers the administrator left ticked for repair", async () => {
  const plan = {
    roles: { execution: [], bug: [] },
    retype: {
      execution: [
        ...RETYPE_PLAN.retype.execution,
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
  const retype = vi.fn().mockResolvedValue({ retyped_fields: [], schema_errors: [] });
  renderSetup({ retype, loadPlan: vi.fn().mockResolvedValue(plan) });

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
  const retype = vi.fn().mockResolvedValue({ retyped_fields: [], schema_errors: [] });
  const loadPlan = vi.fn().mockResolvedValueOnce(RETYPE_PLAN).mockResolvedValue(COMPLETE);
  const { onChanged } = renderSetup({ retype, loadPlan });

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
  const { onChanged } = renderSetup({ retype, loadPlan: vi.fn().mockResolvedValue(RETYPE_PLAN) });

  await userEvent.click(await screen.findByRole("button", { name: "修正表头类型" }));
  await userEvent.click(screen.getByRole("button", { name: "修正这些表头" }));

  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("修正表头类型失败：没有权限");
  expect(dialog).toHaveTextContent("已修正 1 个表头，请重新确认写入");
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("hides the repair command when the page cannot repair a table", async () => {
  renderSetup({ loadPlan: vi.fn().mockResolvedValue(RETYPE_PLAN) });

  // Without a bound repair call the panel may not promise one.
  await screen.findByText("表头完整");
  expect(screen.queryByRole("button", { name: "修正表头类型" })).not.toBeInTheDocument();
});

function rebuildResult(role: "execution" | "bug", requeued = 3) {
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
    target: {}
  };
}

function renderRebuild(overrides: Partial<Parameters<typeof HeaderSetup>[0]> = {}) {
  const rebuild = vi
    .fn()
    .mockResolvedValueOnce(rebuildResult("execution"))
    .mockResolvedValue(rebuildResult("bug"));
  const onTableRebuilt = vi.fn();
  const harness = renderSetup({
    loadPlan: vi.fn().mockResolvedValue(COMPLETE),
    rebuild,
    onTableRebuilt,
    tableNames: { execution: "执行记录", bug: "缺陷记录" },
    ...overrides
  });
  return { ...harness, rebuild, onTableRebuilt };
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

  expect(rebuild).toHaveBeenCalledWith("g1", { role: "execution", acknowledge: true });
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

it("rebuilds every ticked role, one table after the other", async () => {
  const { rebuild, onTableRebuilt } = renderRebuild();

  await screen.findByText("表头完整");
  await userEvent.click(screen.getByRole("button", { name: "重建数据表（表头修正）" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建缺陷记录数据表" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "重建执行记录数据表" }));
  await userEvent.click(screen.getByRole("button", { name: "重建勾选的数据表" }));

  expect(rebuild.mock.calls).toEqual([
    ["g1", { role: "execution", acknowledge: true }],
    ["g1", { role: "bug", acknowledge: true }]
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
  renderSetup({ loadPlan: vi.fn().mockResolvedValue(COMPLETE) });

  await screen.findByText("表头完整");
  expect(
    screen.queryByRole("button", { name: "重建数据表（表头修正）" })
  ).not.toBeInTheDocument();
});

it("says how many rows a rebuild would rewrite and can force one", async () => {
  const { rebuild } = renderRebuild({
    loadPlan: vi
      .fn()
      .mockResolvedValue({ ...COMPLETE, rebuild: { execution: 4, bug: 2 } })
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

  // An unticked box leaves the optional `force` out of the payload entirely, so
  // the request is byte-for-byte the plain rebuild the earlier tests pin down.
  expect(rebuild).toHaveBeenCalledWith("g1", {
    role: "execution",
    acknowledge: true
  });
  expect(rebuild.mock.calls[0][1].force).toBeUndefined();
});
