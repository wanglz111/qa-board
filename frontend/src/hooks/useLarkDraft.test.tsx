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

// 另一个 base，表 id 与执行库重名：切 base 后对同名表的校验必须真的再发一次（复审 A3）。
const SWAP_URL = "https://tenant.larksuite.com/base/app-swap";
const SWAP_RESOLVED: LarkResolved = {
  ...RESOLVED,
  source_url: SWAP_URL,
  base_token: "app-swap",
  base_name: "换库",
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

  // 复审 A3 / R-F14：去重键含 base，同一张表在另一个 base 里不算重复请求。
  it("does not let one base's in-flight check swallow the same table in another base", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    const readTableSchema = vi.fn(async (baseToken: string, tableId: string) => {
      if (baseToken === "app-exec" && tableId === "tbl-runs") {
        await gate;
        return { table_id: tableId, fields: {}, required: [], schema_errors: ["旧 base 的迟到结论"] };
      }
      return { table_id: tableId, fields: {}, required: [], schema_errors: [] };
    });
    const harness = setup({
      resolve: async (url) => (url === SWAP_URL ? SWAP_RESOLVED : RESOLVED),
      readTableSchema
    });
    const { result } = harness;

    await readLink(harness, "execution", URL);
    // 第一次校验挂在 app-exec 上不落地
    let stuck: Promise<void> = Promise.resolve();
    await act(async () => {
      stuck = result.current.checkTable("execution");
    });
    expect(readTableSchema).toHaveBeenCalledWith("app-exec", "tbl-runs", "execution");

    // 切到另一个 base（同名表 tbl-runs），再校验一次：不同的 base 不算重复
    await readLink(harness, "execution", SWAP_URL);
    await act(async () => {
      await result.current.checkTable("execution");
    });
    expect(readTableSchema).toHaveBeenCalledWith("app-swap", "tbl-runs", "execution");

    // 迟到的那份属于旧 base：不许写进现在的 base，判决停在换库之后的 ok
    release();
    await act(async () => {
      await stuck;
    });
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");
  });

  // 复审 A3：checking 只回答「这个 role 现在选中的那张表是不是在飞」。
  it("does not report a role as busy for a table other than the one being checked", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    const readTableSchema = vi.fn(async (_baseToken: string, tableId: string) => {
      if (tableId === "tbl-runs") await gate;
      return { table_id: tableId, fields: {}, required: [], schema_errors: [] };
    });
    const harness = setup({ readTableSchema });
    const { result } = harness;
    await readLink(harness, "execution", URL); // 缺陷表自动校验（tbl-bugs，不挂）

    let stuck: Promise<void> = Promise.resolve();
    await act(async () => {
      stuck = result.current.checkTable("execution");
    });
    expect(result.current.checking).toBe("execution");

    // 选到另一张表：正在飞的那次不是给它的，checking 不许替它说「在加载」
    await act(async () => {
      result.current.setTable("execution", "tbl-bugs");
    });
    expect(result.current.checking).toBeNull();

    release();
    await act(async () => {
      await stuck;
    });
  });

  // 复审 A3：失败的那次必须从登记表里释放，否则这张表的校验按钮永久失效。
  it("releases the in-flight entry when a check fails, so the next attempt is not swallowed", async () => {
    const harness = setup();
    const { result, readTableSchema, onError } = harness;
    await readLink(harness, "execution", URL);
    readTableSchema.mockRejectedValueOnce(new Error("读取该表字段失败"));

    await act(async () => {
      await result.current.checkTable("execution");
    });
    expect(onError).toHaveBeenCalledWith("读取该表字段失败");
    expect(verdictFor(result.current.draft, "execution")).toBe("unreadable");

    await act(async () => {
      await result.current.checkTable("execution");
    });
    expect(readTableSchema).toHaveBeenCalledTimes(3);
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");
  });

  // 复审 A3：api.ts 没有超时，永不落地的请求过了放弃窗口就必须允许重发。
  it("re-issues a check that never settled once the abandon window has passed", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let gated = false;
    const readTableSchema = vi.fn(async (_baseToken: string, tableId: string) => {
      if (tableId === "tbl-runs" && !gated) {
        gated = true;
        await gate;
      }
      return { table_id: tableId, fields: {}, required: [], schema_errors: [] };
    });
    const harness = setup({ readTableSchema });
    const { result } = harness;
    await readLink(harness, "execution", URL); // 缺陷表自动校验：第 1 次

    let stuck: Promise<void> = Promise.resolve();
    await act(async () => {
      stuck = result.current.checkTable("execution"); // 第 2 次：挂住不落地
    });

    clock.mockReturnValue(1_000 + 31_000);
    await act(async () => {
      await result.current.checkTable("execution"); // 超过放弃窗口，必须再发一次
    });
    clock.mockRestore();

    release();
    await act(async () => {
      await stuck;
    });
    expect(readTableSchema).toHaveBeenCalledTimes(3);
  });

  // recheckRole 的意义是「修好之后的结论」：修好之前发出去、之后才落地的那份答案
  // 不许把它按回去（B7 的窄窗口）。
  it("refuses to let a pre-repair answer land after the headers were repaired", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let repaired = false;
    let gated = false;
    const readTableSchema = vi.fn(async (_baseToken: string, tableId: string) => {
      // 答案在请求发出时就已经定了（服务端读表头的那一刻），落地时可能已经过时。
      const answer = {
        table_id: tableId,
        fields: {},
        required: [],
        schema_errors: repaired ? [] : ["缺少必填字段「截图」"]
      };
      if (tableId === "tbl-runs" && !gated) {
        gated = true;
        await gate;
      }
      return answer;
    });
    const harness = setup({ readTableSchema });
    const { result } = harness;
    await readLink(harness, "execution", URL); // 缺陷表自动校验：第 1 次

    let stuck: Promise<void> = Promise.resolve();
    await act(async () => {
      stuck = result.current.checkTable("execution"); // 第 2 次：修好之前发出，挂着
    });

    repaired = true;
    await act(async () => {
      await result.current.recheckRole("execution"); // 第 3 次：修好之后的结论
    });
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");

    release();
    await act(async () => {
      await stuck; // 旧答案这时才落地
    });
    expect(verdictFor(result.current.draft, "execution")).toBe("ok");
  });

  // 复审 A4：重建换掉的是表本身，两个 role 都指着它时必须一起跟随。
  it("follows the rebuilt table in the other role when both roles named it", async () => {
    const harness = setup();
    await readLink(harness, "execution", URL);
    // 让两个 role 都指向同一张表：缺陷表也选 tbl-runs
    await act(async () => {
      harness.result.current.setTable("bug", "tbl-runs");
    });

    await act(async () => {
      harness.result.current.acceptRebuiltTable(
        "execution",
        { table_id: "tbl-new", name: "执行记录（新）" },
        { table_id: "tbl-runs", name: "执行记录" }
      );
    });

    expect(harness.result.current.draft.execution.tableId).toBe("tbl-new");
    expect(harness.result.current.draft.bug.tableId).toBe("tbl-new");
    expect(
      harness.result.current.draft.execution.base?.tables.some(
        (table) => table.table_id === "tbl-runs"
      )
    ).toBe(false);
  });

  // 复审 E1：双击「读取表格」不该发两次 resolve。
  it("does not resolve twice when the read button is hit twice", async () => {
    let release: (value: LarkResolved) => void = () => undefined;
    const resolve = vi.fn(
      () =>
        new Promise<LarkResolved>((settle) => {
          release = settle;
        })
    );
    const harness = setup({ resolve });
    await act(async () => {
      harness.result.current.setLink("execution", URL);
    });

    let first: Promise<TableRole | null> = Promise.resolve(null);
    let second: Promise<TableRole | null> = Promise.resolve(null);
    await act(async () => {
      first = harness.result.current.readLink("execution");
      second = harness.result.current.readLink("execution");
      release(RESOLVED);
      await Promise.all([first, second]);
    });

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  // 复审 B5：withSlot 的 base 守卫是这套设计里唯一非结构性的机制，必须有测试钉住。
  it("a late response does not write a verdict into a base the box no longer holds", async () => {
    let release: (value: LarkResolved) => void = () => undefined;
    const resolve = vi.fn(
      () =>
        new Promise<LarkResolved>((settle) => {
          release = settle;
        })
    );
    const harness = setup({ resolve });
    await act(async () => {
      harness.result.current.setLink("execution", URL);
    });

    let pending: Promise<TableRole | null> = Promise.resolve(null);
    await act(async () => {
      pending = harness.result.current.readLink("execution");
    });
    // 请求还在飞的时候，管理员把链接框改成了另一段链接
    await act(async () => {
      harness.result.current.setLink("execution", OTHER_URL);
    });
    await act(async () => {
      release(RESOLVED);
      await pending;
    });

    // 迟到的那份响应属于旧链接：base 判为不当前，判决诚实地停在 unread
    expect(verdictFor(harness.result.current.draft, "execution")).toBe("unread");
  });

  // A4 的边界：同名表 id 落在另一个 base 里时，它不是这次重建的对象，不许被拖走。
  it("leaves the other role alone when the same table id lives in another base", async () => {
    const harness = setup({
      resolve: async (url) => (url === SWAP_URL ? SWAP_RESOLVED : RESOLVED)
    });
    const { result } = harness;
    await readLink(harness, "execution", URL);
    await readLink(harness, "bug", SWAP_URL);
    expect(result.current.draft.bug.tableId).toBe("tbl-runs");

    await act(async () => {
      result.current.acceptRebuiltTable(
        "execution",
        { table_id: "tbl-new", name: "执行记录（新）" },
        { table_id: "tbl-runs", name: "执行记录" }
      );
    });

    expect(result.current.draft.execution.tableId).toBe("tbl-new");
    // 缺陷库那个 base 里的 tbl-runs 没被重建，缺陷 role 留在它自己的表上
    expect(result.current.draft.bug.tableId).toBe("tbl-runs");
    expect(result.current.draft.bug.base?.base_token).toBe("app-swap");
  });
});
