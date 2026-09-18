import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { LarkResolved, LarkTarget, TableRole, TableSchema } from "../api";
import { effectiveBase, emptyDraft, probeFor, probeKey, verdictFor, type Draft } from "../larkDraft";
import { useLarkDraft } from "./useLarkDraft";

const URL = "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs";
const BUG_URL = "https://tenant.larksuite.com/base/app-bugs";
const OTHER_URL = "https://tenant.larksuite.com/base/app-exec";

const RESOLVED: LarkResolved = {
  source_url: URL,
  base_token: "app-exec",
  base_name: "执行库",
  tables: [
    { table_id: "tbl-runs", name: "执行记录" },
    { table_id: "tbl-bugs", name: "缺陷记录" }
  ],
  selected: { table_id: "tbl-runs", table_name: "执行记录", view_id: "vew-main" },
  execution_fields: { 用例: "text", 结果: "single_select", 截图: "attachment" },
  required_execution_fields: ["用例", "结果", "截图"],
  schema_errors: [],
  read_errors: []
};

const BAD_RESOLVED: LarkResolved = {
  ...RESOLVED,
  schema_errors: ["缺少必填字段「截图」"]
};

// 缺陷库链接读到的第二个 base。
const BUG_RESOLVED: LarkResolved = {
  source_url: BUG_URL,
  base_token: "app-bugs",
  base_name: "缺陷库",
  tables: [
    { table_id: "tbl-online", name: "线上缺陷" },
    { table_id: "tbl-past", name: "历史缺陷" }
  ],
  selected: { table_id: "tbl-online", table_name: "线上缺陷", view_id: null },
  execution_fields: {},
  required_execution_fields: [],
  schema_errors: [],
  read_errors: []
};

// 同一个 base 的另一段链接：缺陷库链接指向它时，缺陷表选到的还是 tbl-runs。
const OTHER_EXEC_RESOLVED: LarkResolved = {
  ...RESOLVED,
  source_url: OTHER_URL,
  selected: { table_id: "tbl-runs", table_name: "执行记录", view_id: null }
};

const TARGET: LarkTarget = {
  group_id: "group-1",
  source_url: URL,
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

type Api = {
  resolve: (url: string) => Promise<LarkResolved>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  onError: (message: string) => void;
};

const okSchema: Api["readTableSchema"] = async (_baseToken, tableId) => ({
  table_id: tableId,
  fields: { 用例: "text" },
  required: ["用例"],
  schema_errors: []
});

function setup(overrides: Partial<Api> = {}) {
  const resolve = vi.fn(overrides.resolve ?? (async () => RESOLVED));
  const readTableSchema = vi.fn(overrides.readTableSchema ?? okSchema);
  const onError = vi.fn(overrides.onError ?? (() => undefined));
  const view = renderHook(
    (props: { groupId: string }) => useLarkDraft({ ...props, resolve, readTableSchema, onError }),
    { initialProps: { groupId: "group-1" } }
  );
  return { ...view, resolve, readTableSchema, onError };
}

// probeFor 的返回值是 Probe | "loading" | undefined；测试里只想拿真正的 probe。
function probeOf(draft: Draft, role: TableRole) {
  const slot = probeFor(draft, role);
  return slot && slot !== "loading" ? slot : null;
}

type Harness = ReturnType<typeof setup>;

// 链接框是页面的输入框：hook 只从框里读 url，所以每次读取都要先填框。
async function readLink(harness: Harness, role: TableRole, url: string) {
  await act(async () => {
    harness.result.current.setLink(role, url);
  });
  await act(async () => {
    await harness.result.current.readLink(role);
  });
}

describe("useLarkDraft", () => {
  it("hands out the newly selected table's verdict instead of the previous table's failure", async () => {
    const harness = setup({ resolve: async () => BAD_RESOLVED });
    const { result, readTableSchema } = harness;
    readTableSchema.mockImplementation(async (_baseToken, tableId) => ({
      table_id: tableId,
      fields: { 用例: "text" },
      required: ["用例"],
      schema_errors: tableId === "tbl-bugs" ? [] : ["缺少必填字段「截图」"]
    }));

    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "execution")).toBe("bad");

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });

    expect(verdictFor(result.current.draft, "execution")).toBe("ok");
    expect(probeOf(result.current.draft, "execution")?.schema_errors).toEqual([]);
  });

  it("keeps a table nobody checked unread and never borrows another table's or role's verdict", async () => {
    const harness = setup();
    const { result } = harness;
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");

    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });

    // tbl-bugs 的 bug-role probe 已经被自动校验过，execution role 一次都没有：
    // 判决必须是 unread，不许借用那张表在另一个 role 下的结论。
    expect(probeFor(result.current.draft, "execution")).toBeUndefined();
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");
    expect(
      result.current.draft.execution.base?.probes[probeKey("tbl-bugs", "bug")]
    ).toBeDefined();
  });

  it("stops falling back to the execution base once the defect link box holds an unread link", async () => {
    const harness = setup();
    const { result } = harness;
    await readLink(harness, "execution", URL);
    expect(effectiveBase(result.current.draft, "bug")).toBe(
      result.current.draft.execution.base
    );

    await act(async () => {
      result.current.setLink("bug", BUG_URL);
    });

    expect(effectiveBase(result.current.draft, "bug")).toBeNull();
    expect(verdictFor(result.current.draft, "bug")).toBe("unread");
  });

  it("does not ask for the same table twice when the select is switched back and forth", async () => {
    const harness = setup();
    const { result, readTableSchema } = harness;
    await readLink(harness, "execution", URL);
    // 执行表的判决来自 resolve 的播种，零请求；缺陷表自动校验一次。
    expect(readTableSchema).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });
    expect(readTableSchema).toHaveBeenCalledTimes(2);

    await act(async () => {
      result.current.setTable("execution", "tbl-runs");
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(readTableSchema).toHaveBeenCalledTimes(2);
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");
  });

  it("drops the base and the verdict as soon as the link box is edited", async () => {
    const harness = setup({ resolve: async () => BAD_RESOLVED });
    const { result } = harness;
    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "execution")).toBe("bad");

    await act(async () => {
      result.current.setLink("execution", `${URL}&view=vew-main`);
    });

    expect(effectiveBase(result.current.draft, "execution")).toBeNull();
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");
    expect(result.current.draft.execution.tableId).toBe("tbl-runs");
  });

  it("records a failed check as unreadable with the reason it was given", async () => {
    const harness = setup();
    const { result, readTableSchema, onError } = harness;
    await readLink(harness, "execution", URL);
    readTableSchema.mockRejectedValueOnce(new Error("无法读取该数据表，请确认应用仍是协作者"));

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });

    expect(verdictFor(result.current.draft, "execution")).toBe("unreadable");
    expect(probeOf(result.current.draft, "execution")?.read_error).toBe(
      "无法读取该数据表，请确认应用仍是协作者"
    );
    expect(onError).toHaveBeenCalledWith("无法读取该数据表，请确认应用仍是协作者");
  });

  it("refuses a schema answer that names another table", async () => {
    const harness = setup();
    const { result, readTableSchema, onError } = harness;
    await readLink(harness, "execution", URL);
    readTableSchema.mockResolvedValueOnce({
      table_id: "tbl-other",
      fields: { 用例: "text" },
      required: ["用例"],
      schema_errors: []
    });

    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    await act(async () => {
      await result.current.checkTable("execution");
    });

    expect(verdictFor(result.current.draft, "execution")).toBe("unreadable");
    expect(onError).toHaveBeenCalledWith("校验结果与请求的表不一致：请求 tbl-bugs，返回 tbl-other");
  });

  it("follows a rebuilt table and invalidates the other role's probes", async () => {
    const harness = setup();
    const { result, readTableSchema } = harness;
    await readLink(harness, "execution", URL);
    expect(verdictFor(result.current.draft, "bug")).toBe("ok");

    await act(async () => {
      result.current.acceptRebuiltTable(
        "execution",
        { table_id: "tbl-runs2", name: "执行记录" },
        { table_id: "tbl-runs", name: "执行记录" }
      );
    });
    await waitFor(() => expect(verdictFor(result.current.draft, "execution")).toBe("ok"));

    expect(result.current.draft.execution.tableId).toBe("tbl-runs2");
    expect(result.current.draft.execution.base?.tables.map((table) => table.table_id)).toEqual([
      "tbl-runs2",
      "tbl-bugs"
    ]);
    expect(result.current.draft.execution.viewId).toBeNull();
    expect(verdictFor(result.current.draft, "bug")).toBe("unread");
    expect(readTableSchema).toHaveBeenCalledWith("app-exec", "tbl-runs2", "execution");
  });

  it("offers a table it just created as that role's selection and checks it once", async () => {
    const harness = setup();
    const { result, readTableSchema } = harness;
    await readLink(harness, "execution", URL);
    expect(readTableSchema).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.acceptCreatedTable("bug", { table_id: "tbl-new", name: "新建缺陷表" });
    });
    await waitFor(() => expect(readTableSchema).toHaveBeenCalledTimes(2));

    expect(result.current.draft.bug.tableId).toBe("tbl-new");
    // 缺陷库链接为空：新表落进两个 role 共用的那个 base，所以两边都看得到它。
    expect(result.current.draft.execution.base?.tables.map((table) => table.table_id)).toEqual([
      "tbl-new",
      "tbl-runs",
      "tbl-bugs"
    ]);
    await waitFor(() => expect(verdictFor(result.current.draft, "bug")).toBe("ok"));
  });

  it("resets the draft when the group changes", async () => {
    const harness = setup();
    const { result, rerender } = harness;
    await readLink(harness, "execution", URL);
    expect(effectiveBase(result.current.draft, "execution")).not.toBeNull();

    await act(async () => {
      rerender({ groupId: "group-2" });
    });

    expect(result.current.draft).toEqual(emptyDraft());
  });

  it("prefills a saved target and still calls both tables unread", () => {
    const { result } = setup();

    act(() => {
      result.current.resetDraft(TARGET);
    });

    expect(result.current.draft.execution.url).toBe(URL);
    expect(result.current.draft.execution.tableId).toBe("tbl-runs");
    expect(result.current.draft.bug.tableId).toBe("tbl-bugs");
    expect(verdictFor(result.current.draft, "execution")).toBe("unread");
    expect(verdictFor(result.current.draft, "bug")).toBe("unread");
  });

  it("reports a refused read and writes no base", async () => {
    const { result, onError } = setup({
      resolve: async () => {
        throw new Error("该链接指向的不是多维表格");
      }
    });

    let returned: TableRole | null = "bug";
    await act(async () => {
      result.current.setLink("execution", URL);
    });
    await act(async () => {
      returned = await result.current.readLink("execution");
    });

    expect(returned).toBeNull();
    expect(onError).toHaveBeenCalledWith("该链接指向的不是多维表格");
    expect(result.current.draft.execution.base).toBeNull();
    expect(result.current.reading).toBeNull();
  });

  it("keeps one table's two roles apart when both roles point at it", async () => {
    const harness = setup({
      resolve: async (url) => (url === OTHER_URL ? OTHER_EXEC_RESOLVED : BAD_RESOLVED),
      readTableSchema: async (_baseToken, tableId, role) => ({
        table_id: tableId,
        fields: { 用例: "text" },
        required: ["用例"],
        schema_errors: role === "execution" ? ["缺少必填字段「截图」"] : []
      })
    });
    const { result } = harness;

    await readLink(harness, "execution", URL);
    await readLink(harness, "bug", OTHER_URL);

    expect(result.current.draft.execution.tableId).toBe("tbl-runs");
    expect(result.current.draft.bug.tableId).toBe("tbl-runs");
    expect(verdictFor(result.current.draft, "execution")).toBe("bad");
    expect(verdictFor(result.current.draft, "bug")).toBe("ok");
  });

  // 表头缺列 → bad；修好表头后（第二次校验）→ ok。这是 provision / retype 之后的主路径。
  it("recheckRole recomputes the verdict after the headers are repaired", async () => {
    const state = { repaired: false };
    const readTableSchema = vi.fn(async (_base: string, tableId: string) => ({
      table_id: tableId,
      fields: { 用例: "text" },
      required: ["用例", "截图"],
      schema_errors: state.repaired ? [] : ["缺少必填字段「截图」"]
    }));
    const badResolved: LarkResolved = {
      ...RESOLVED,
      schema_errors: ["缺少必填字段「截图」"]
    };
    const harness = setup({ resolve: async () => badResolved, readTableSchema });

    await readLink(harness, "execution", URL);
    expect(verdictFor(harness.result.current.draft, "execution")).toBe("bad");

    state.repaired = true;
    await act(async () => {
      await harness.result.current.recheckRole("execution");
    });
    expect(verdictFor(harness.result.current.draft, "execution")).toBe("ok");
  });

  it("invalidateRole drops the verdict back to unread", async () => {
    const harness = setup();
    await readLink(harness, "execution", URL);
    expect(verdictFor(harness.result.current.draft, "execution")).toBe("ok");

    await act(async () => {
      harness.result.current.invalidateRole("execution");
    });
    expect(verdictFor(harness.result.current.draft, "execution")).toBe("unread");
  });
});
