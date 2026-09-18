import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { LarkTarget, TableRole } from "../../api";
import type { Draft, LarkBase, Probe } from "../../larkDraft";
import { StepTables } from "./StepTables";

const TARGET: LarkTarget = {
  group_id: "grp-1",
  source_url: "https://example.larksuite.com/base/app-exec",
  execution_base_token: "app-exec",
  execution_base_name: "执行库",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-exec",
  bug_base_name: "执行库",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: null,
  target_fingerprint: "fp-1",
  confirmed_at: null,
  confirmed: false
};

function probe(overrides: Partial<Probe> = {}): Probe {
  return { fields: {}, required: [], schema_errors: [], ...overrides };
}

// 同一张 tbl-bugs 既是执行表也是缺陷表：两套 required 各自成立，key 里的 role 就是隔断。
const EXECUTION_BASE: LarkBase = {
  base_token: "app-exec",
  base_name: "执行库",
  source_url: TARGET.source_url,
  tables: [
    { table_id: "tbl-runs", name: "执行记录" },
    { table_id: "tbl-bugs", name: "缺陷记录" },
    { table_id: "tbl-new", name: "新表" }
  ],
  read_errors: [],
  probes: {
    "tbl-runs:execution": probe({ schema_errors: ["缺少必填字段「截图」"] }),
    "tbl-bugs:execution": probe(),
    "tbl-bugs:bug": probe({ schema_errors: ["缺少必填字段「缺陷描述」"] })
  }
};

function draftWith(overrides: {
  executionTableId: string;
  bugTableId?: string;
  bugUrl?: string;
  probes?: LarkBase["probes"];
  executionBase?: LarkBase | null;
}): Draft {
  const base = overrides.executionBase === undefined ? EXECUTION_BASE : overrides.executionBase;
  const probes = overrides.probes ?? base?.probes ?? {};
  return {
    execution: {
      url: TARGET.source_url,
      base: base ? { ...base, probes } : null,
      tableId: overrides.executionTableId,
      viewId: null
    },
    bug: { url: overrides.bugUrl ?? "", base: null, tableId: overrides.bugTableId ?? "tbl-bugs", viewId: null }
  };
}

// 下拉真的会切：让 draft 跟着 onTableChange / onLinkChange 动。
function Harness({
  initial,
  onCheck = vi.fn(),
  onSave = vi.fn()
}: {
  initial: Draft;
  onCheck?: (role: TableRole) => void;
  onSave?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <StepTables
      draft={draft}
      target={TARGET}
      reading={null}
      checking={null}
      saving={false}
      onLinkChange={(role, url) =>
        setDraft((current) =>
          role === "execution"
            ? { ...current, execution: { ...current.execution, url } }
            : { ...current, bug: { ...current.bug, url } }
        )
      }
      onRead={vi.fn()}
      onTableChange={(role, tableId) =>
        setDraft((current) =>
          role === "execution"
            ? { ...current, execution: { ...current.execution, tableId } }
            : { ...current, bug: { ...current.bug, tableId } }
        )
      }
      onCheck={onCheck}
      onSave={onSave}
    />
  );
}

function block(container: HTMLElement, role: TableRole): HTMLElement {
  return container.querySelector(`.lark-role[data-role='${role}']`) as HTMLElement;
}

function redLines(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".inline-status.error"));
}

describe("StepTables", () => {
  it("describes only the table the select currently names (门 2)", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Harness
        initial={draftWith({
          executionTableId: "tbl-runs",
          probes: { ...EXECUTION_BASE.probes, "tbl-bugs:bug": probe() }
        })}
      />
    );

    expect(redLines(container)).toHaveLength(1);
    expect(redLines(container)[0]).toHaveTextContent("执行记录表：缺少必填字段「截图」");

    await user.selectOptions(screen.getByLabelText("执行记录表"), "tbl-bugs");

    expect(redLines(container)).toHaveLength(0);
    expect(block(container, "execution").querySelector('[data-verdict="ok"]')).not.toBeNull();
    expect(container.textContent).not.toContain("缺少必填字段「截图」");
  });

  it("keeps two verdicts apart even when both roles point at the same table (门 2)", () => {
    const { container } = render(<Harness initial={draftWith({ executionTableId: "tbl-runs" })} />);

    expect(block(container, "execution")).toHaveTextContent("执行记录表：缺少必填字段「截图」");
    expect(block(container, "execution")).not.toHaveTextContent("缺陷描述");
    expect(block(container, "bug")).toHaveTextContent("缺陷记录表：缺少必填字段「缺陷描述」");
    expect(block(container, "bug")).not.toHaveTextContent("截图");
  });

  it("calls an unchecked table unread instead of borrowing the other one's verdict (门 3)", async () => {
    const user = userEvent.setup();
    const onCheck = vi.fn();
    const { container } = render(
      <Harness initial={draftWith({ executionTableId: "tbl-new" })} onCheck={onCheck} />
    );

    expect(within(block(container, "execution")).getByText("尚未校验这张表")).toBeInTheDocument();
    expect(block(container, "execution").querySelectorAll(".inline-status.error")).toHaveLength(0);
    // 同一页上另一张表有自己的红字：它一个字都不许跑到这张表头上
    expect(redLines(container)).toHaveLength(1);
    expect(redLines(container)[0]).toHaveTextContent("缺陷描述");

    await user.click(within(block(container, "execution")).getByRole("button", { name: "校验" }));
    expect(onCheck).toHaveBeenCalledWith("execution");
  });

  it("renders loading and unreadable as their own states, never as a missing-column line", () => {
    const loading = render(
      <Harness initial={draftWith({ executionTableId: "tbl-runs", probes: { "tbl-runs:execution": "loading" } })} />
    );
    expect(loading.container.querySelector('[data-verdict="loading"]')).toHaveTextContent("正在校验这张表…");
    expect(screen.getByLabelText("执行记录表")).toBeDisabled();
    loading.unmount();

    const unreadable = render(
      <Harness
        initial={draftWith({
          executionTableId: "tbl-runs",
          probes: { "tbl-runs:execution": probe({ read_error: "应用不是该多维表格的协作者" }) }
        })}
      />
    );
    const line = unreadable.container.querySelector('[data-verdict="unreadable"]') as HTMLElement;
    expect(line).toHaveTextContent("执行记录表读取失败：应用不是该多维表格的协作者");
    expect(within(line).getByRole("button", { name: "重新校验" })).toBeInTheDocument();
  });

  it("turns an unread defect link into one note where the select would be (门 3)", () => {
    const { container } = render(
      <Harness
        initial={draftWith({
          executionTableId: "tbl-runs",
          bugUrl: "https://example.larksuite.com/base/app-bugs",
          probes: { "tbl-runs:execution": probe() }
        })}
      />
    );

    const notes = container.querySelectorAll(".lark-role-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("这段缺陷库链接尚未读取");
    expect(notes[0]).not.toHaveAttribute("role");
    expect(screen.queryByLabelText("缺陷记录表")).toBeNull();
    expect(redLines(container)).toHaveLength(0);
  });

  it("falls back to the execution base while the defect box is empty, and saves the selection", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { unmount } = render(
      <Harness initial={draftWith({ executionTableId: "tbl-bugs" })} onSave={onSave} />
    );

    expect(screen.getByLabelText("缺陷记录表")).toHaveValue("tbl-bugs");
    const save = screen.getByRole("button", { name: "保存选择" });
    expect(save).toHaveAttribute("title", "当前已保存：执行记录 / 缺陷记录");
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    unmount();

    render(<Harness initial={draftWith({ executionTableId: "", executionBase: null })} />);
    expect(screen.getByRole("button", { name: "保存选择" })).toBeDisabled();
  });

  it("offers the manual re-check while a table is bad, and withholds it while loading (B7)", async () => {
    const user = userEvent.setup();
    const onCheck = vi.fn();
    const { container, unmount } = render(
      <Harness initial={draftWith({ executionTableId: "tbl-runs" })} onCheck={onCheck} />
    );

    // 表头在别处（第 ② 步的 provision / retype / rebuild）被修好后，判决必须能手动刷新：
    // bad 不是终态，所以「重新校验」在这里必须在。
    const executionBlock = block(container, "execution");
    expect(executionBlock.querySelector('[data-verdict="bad"]')).not.toBeNull();
    await user.click(within(executionBlock).getByRole("button", { name: "重新校验" }));
    expect(onCheck).toHaveBeenCalledWith("execution");
    unmount();

    // 校验在飞的时候没有第二个入口：只有 loading 行与 aria-busy
    const loading = render(
      <Harness initial={draftWith({ executionTableId: "tbl-runs", probes: { "tbl-runs:execution": "loading" } })} />
    );
    const loadingLine = loading.container.querySelector('[data-verdict="loading"]') as HTMLElement;
    expect(loadingLine).toHaveAttribute("aria-busy", "true");
    expect(within(loadingLine).queryByRole("button")).toBeNull();
  });
});
