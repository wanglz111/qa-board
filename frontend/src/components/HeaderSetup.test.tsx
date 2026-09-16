import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

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

it("still asks the page to re-read the target when Lark created nothing new", async () => {
  const provision = vi.fn().mockResolvedValue({ created_fields: [], schema_errors: [] });
  const { onChanged } = renderSetup({ provision });

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  await userEvent.click(screen.getByRole("button", { name: "创建这些表头" }));

  // The server clears the write approval for every accepted call, including a
  // repeat where every header already existed.
  expect(await screen.findByText("已创建 0 个表头，请重新确认写入")).toBeVisible();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("takes focus on open and lets Escape cancel without creating anything", async () => {
  const { provision } = renderSetup();

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  expect(screen.getByRole("button", { name: "创建这些表头" })).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(provision).not.toHaveBeenCalled();
});

it("keeps Tab inside the dialog instead of reaching the page behind it", async () => {
  renderSetup();

  await userEvent.click(await screen.findByRole("button", { name: "设置表头" }));
  const cancel = screen.getByRole("button", { name: "取消" });
  const create = screen.getByRole("button", { name: "创建这些表头" });

  expect(create).toHaveFocus();
  await userEvent.tab();
  expect(cancel).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(create).toHaveFocus();
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
});
