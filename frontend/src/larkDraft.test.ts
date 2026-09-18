import { describe, expect, it } from "vitest";

import type { LarkTarget, SyncStatus } from "./api";
import {
  baseIsCurrent,
  describeHealth,
  draftFromTarget,
  effectiveBase,
  emptyDraft,
  nameOf,
  probeFor,
  probeKey,
  stepsComplete,
  suggestBugTable,
  verdictFor,
  verdictOf,
  withCreatedTable,
  type CompletedTable,
  type Draft,
  type LarkBase,
  type Probe,
  type RoleDraft
} from "./larkDraft";

const URL = "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs";
const BUG_URL = "https://tenant.larksuite.com/base/app-bugs";

const TABLES = [
  { table_id: "tbl-runs", name: "执行记录" },
  { table_id: "tbl-bugs", name: "缺陷记录" }
];

const TARGET: LarkTarget = {
  group_id: "0918-id",
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

function base(overrides: Partial<LarkBase> = {}): LarkBase {
  return {
    base_token: "app-exec",
    base_name: "执行库",
    source_url: URL,
    tables: TABLES,
    read_errors: [],
    probes: {},
    ...overrides
  };
}

function role(overrides: Partial<RoleDraft> = {}): RoleDraft {
  return { url: URL, base: null, tableId: "", viewId: null, ...overrides };
}

function draftWith(execution: Partial<RoleDraft> = {}, bug: Partial<RoleDraft> = {}): Draft {
  return { execution: role(execution), bug: role({ url: "", ...bug }) };
}

function probe(overrides: Partial<Probe> = {}): Probe {
  return { fields: {}, required: [], schema_errors: [], ...overrides };
}

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    confirmed: true,
    queued: 0,
    synced: 1,
    failed: 0,
    uncertain: 0,
    parked: 0,
    last_error_kind: null,
    pending_attempts: 0,
    detail: "目标表已确认，可显式排入同步",
    ...overrides
  };
}

describe("verdictOf", () => {
  it("names all five states and lets a failed read win over missing headers", () => {
    expect(verdictOf(undefined)).toBe("unread");
    expect(verdictOf("loading")).toBe("loading");
    expect(verdictOf(probe({ read_error: "无法读取该数据表" }))).toBe("unreadable");
    expect(verdictOf(probe({ schema_errors: ["缺少必填字段「截图」"] }))).toBe("bad");
    expect(verdictOf(probe())).toBe("ok");
    expect(
      verdictOf(probe({ read_error: "读不到", schema_errors: ["缺少必填字段「截图」"] }))
    ).toBe("unreadable");
  });
});

describe("baseIsCurrent", () => {
  it("invalidates a base as soon as the link box differs from the link that was read", () => {
    const execution = base();
    const read = draftWith({ base: execution, tableId: "tbl-runs" });
    expect(baseIsCurrent(read.execution)).toBe(true);
    expect(baseIsCurrent({ ...read.execution, url: `  ${URL}  ` })).toBe(true);

    const edited: Draft = { ...read, execution: { ...read.execution, url: `${URL}?table=x` } };
    expect(baseIsCurrent(edited.execution)).toBe(false);
    expect(effectiveBase(edited, "execution")).toBeNull();
    expect(verdictFor(edited, "execution")).toBe("unread");
  });

  it("is false for a role whose link was never read", () => {
    expect(baseIsCurrent(role())).toBe(false);
  });
});

describe("effectiveBase", () => {
  it("falls back to the execution base only while the defect link box is empty", () => {
    const execution = base();
    const draft = draftWith({ base: execution, tableId: "tbl-runs" });
    expect(effectiveBase(draft, "bug")).toBe(execution);

    const pending: Draft = { ...draft, bug: { ...draft.bug, url: BUG_URL } };
    expect(effectiveBase(pending, "bug")).toBeNull();
    expect(verdictFor(pending, "bug")).toBe("unread");
  });

  it("keeps the execution role out of a defect base that is waiting to be read", () => {
    const draft = draftWith({}, { url: BUG_URL, base: base({ base_token: "app-bugs" }) });
    expect(effectiveBase(draft, "execution")).toBeNull();
  });
});

describe("verdictFor", () => {
  it("gives each table its own verdict when the selected table changes", () => {
    const execution = base({
      probes: {
        [probeKey("tbl-runs", "execution")]: probe({ schema_errors: ["缺少必填字段「截图」"] }),
        [probeKey("tbl-bugs", "execution")]: probe()
      }
    });
    const runs = draftWith({ base: execution, tableId: "tbl-runs" });
    expect(verdictFor(runs, "execution")).toBe("bad");

    const bugs: Draft = { ...runs, execution: { ...runs.execution, tableId: "tbl-bugs" } };
    expect(verdictFor(bugs, "execution")).toBe("ok");
  });

  it("keeps the two roles of one table apart", () => {
    const shared = base({
      probes: {
        [probeKey("tbl-runs", "execution")]: probe({ schema_errors: ["缺少必填字段「截图」"] }),
        [probeKey("tbl-runs", "bug")]: probe()
      }
    });
    const draft = draftWith(
      { base: shared, tableId: "tbl-runs" },
      { url: URL, base: shared, tableId: "tbl-runs" }
    );
    expect(verdictFor(draft, "execution")).toBe("bad");
    expect(verdictFor(draft, "bug")).toBe("ok");
  });

  it("reports an unread table as unread instead of borrowing the sibling's verdict", () => {
    const execution = base({
      probes: { [probeKey("tbl-runs", "execution")]: probe() }
    });
    const draft = draftWith({ base: execution, tableId: "tbl-bugs" });
    expect(probeFor(draft, "execution")).toBeUndefined();
    expect(verdictFor(draft, "execution")).toBe("unread");
  });
});

describe("suggestBugTable", () => {
  it("prefers the stored defect table, then the first table that is not the execution one", () => {
    expect(suggestBugTable(TABLES, "tbl-runs", TARGET)).toBe("tbl-bugs");
    expect(suggestBugTable(TABLES, "tbl-runs", null)).toBe("tbl-bugs");
    expect(suggestBugTable(TABLES, "tbl-bugs", null)).toBe("tbl-runs");
    // 存下来的缺陷表不在这次读到的表里：退回建议值，而不是把一个没有的表交出去。
    expect(suggestBugTable(TABLES, "tbl-runs", { ...TARGET, bug_table_id: "tbl-gone" })).toBe(
      "tbl-bugs"
    );
    expect(suggestBugTable([{ table_id: "tbl-runs", name: "执行记录" }], "tbl-runs", null)).toBe(
      "tbl-runs"
    );
    expect(suggestBugTable([], "tbl-runs", null)).toBe("");
  });
});

describe("withCreatedTable", () => {
  it("offers a created table only inside the base it was created in, and only once", () => {
    const created: CompletedTable = {
      table_id: "tbl-new",
      name: "新建执行表",
      base_token: "app-exec"
    };
    expect(withCreatedTable(TABLES, created, "app-exec").map((t) => t.table_id)).toEqual([
      "tbl-new",
      "tbl-runs",
      "tbl-bugs"
    ]);
    expect(withCreatedTable(TABLES, created, "app-bugs")).toEqual(TABLES);
    expect(withCreatedTable(TABLES, null, "app-exec")).toEqual(TABLES);
    expect(withCreatedTable(TABLES, { ...created, table_id: "tbl-runs" }, "app-exec")).toEqual(
      TABLES
    );
  });
});

describe("nameOf", () => {
  it("falls back to the id for a table this page never read", () => {
    expect(nameOf(TABLES, "tbl-runs")).toBe("执行记录");
    expect(nameOf(TABLES, "tbl-unknown")).toBe("tbl-unknown");
  });
});

describe("emptyDraft / draftFromTarget", () => {
  it("starts empty and prefills a saved target without pretending it was read", () => {
    expect(emptyDraft()).toEqual({
      execution: { url: "", base: null, tableId: "", viewId: null },
      bug: { url: "", base: null, tableId: "", viewId: null }
    });

    const draft = draftFromTarget(TARGET);
    expect(draft.execution.url).toBe(URL);
    expect(draft.execution.tableId).toBe("tbl-runs");
    expect(draft.bug.url).toBe("");
    expect(draft.bug.tableId).toBe("tbl-bugs");
    expect(draft.execution.base).toBeNull();
    expect(verdictFor(draft, "execution")).toBe("unread");
    expect(verdictFor(draft, "bug")).toBe("unread");
    expect(draftFromTarget(null)).toEqual(emptyDraft());
  });
});

describe("describeHealth", () => {
  const confirmed: LarkTarget = { ...TARGET, confirmed: true, confirmed_at: "2026-09-18T00:00:00Z" };

  it("answers the eight rules in the pinned order", () => {
    // 1 还没有目标
    expect(
      describeHealth({ target: null, liveErrors: [], schemaInvalid: false, sync: null })
    ).toEqual({
      tone: "warn",
      step: "tables",
      text: "尚未选择 Lark 表：请在第 1 步粘贴链接并保存"
    });
    // 2 已保存目标读失败
    expect(
      describeHealth({
        target: TARGET,
        liveErrors: ["Lark 中找不到执行记录表 tbl-runs"],
        schemaInvalid: false,
        sync: null
      })
    ).toEqual({
      tone: "bad",
      step: "headers",
      text: "目标表读取失败：Lark 中找不到执行记录表 tbl-runs"
    });
    // 3 表头失效且已确认
    expect(
      describeHealth({ target: confirmed, liveErrors: [], schemaInvalid: true, sync: null })
    ).toEqual({ tone: "bad", step: "headers", text: "已确认，但表头已失效（需重新校验）" });
    // 4 表头失效且未确认
    expect(
      describeHealth({ target: TARGET, liveErrors: [], schemaInvalid: true, sync: null })
    ).toEqual({ tone: "bad", step: "headers", text: "表头缺失，尚不能确认写入" });
    // 5 同步失败 / 待人工确认
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ failed: 3, uncertain: 1 })
      })
    ).toEqual({ tone: "bad", step: "sync", text: "同步失败 3 条 · 待人工确认 1 条" });
    // 6 待管理员处理
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ parked: 2 })
      })
    ).toEqual({ tone: "warn", step: "sync", text: "待管理员处理 2 条" });
    // 7 未确认
    expect(
      describeHealth({ target: TARGET, liveErrors: [], schemaInvalid: false, sync: null })
    ).toEqual({ tone: "warn", step: "approve", text: "未确认：本地结果不会写入 Lark" });
    // 8 其它
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ queued: 4 })
      })
    ).toEqual({
      tone: "ok",
      step: null,
      text: "已确认 · 执行记录 / 缺陷记录 · 待同步 4 · 失败 0"
    });
  });

  it("lets the earlier rule win when two conditions are true at once", () => {
    expect(
      describeHealth({
        target: confirmed,
        liveErrors: ["读取失败"],
        schemaInvalid: true,
        sync: syncStatus({ failed: 9 })
      })
    ).toEqual({ tone: "bad", step: "headers", text: "目标表读取失败：读取失败" });

    // 表头没失效但队列有失败：第 5 条比第 7 条（未确认）先赢。
    expect(
      describeHealth({
        target: TARGET,
        liveErrors: [],
        schemaInvalid: false,
        sync: syncStatus({ failed: 9 })
      })
    ).toEqual({ tone: "bad", step: "sync", text: "同步失败 9 条 · 待人工确认 0 条" });
    // 表头失效且未确认：第 4 条比第 5 条先赢，队列失败不改变指向的步骤。
    expect(
      describeHealth({
        target: TARGET,
        liveErrors: [],
        schemaInvalid: true,
        sync: syncStatus({ failed: 9 })
      })
    ).toEqual({ tone: "bad", step: "headers", text: "表头缺失，尚不能确认写入" });
  });
});

describe("stepsComplete", () => {
  it("marks a step complete only when that step has nothing left", () => {
    const verified = base({
      probes: {
        [probeKey("tbl-runs", "execution")]: probe(),
        [probeKey("tbl-bugs", "bug")]: probe()
      }
    });
    const draft = draftWith(
      { base: verified, tableId: "tbl-runs" },
      { url: URL, base: verified, tableId: "tbl-bugs" }
    );
    const confirmed: LarkTarget = { ...TARGET, confirmed: true, confirmed_at: "2026-09-18T00:00:00Z" };

    expect(stepsComplete(draft, null, null)).toEqual({
      tables: true,
      headers: false,
      approve: false,
      sync: false
    });
    expect(stepsComplete(draft, TARGET, syncStatus())).toEqual({
      tables: true,
      headers: true,
      approve: false,
      sync: false
    });
    expect(stepsComplete(draft, confirmed, syncStatus())).toEqual({
      tables: true,
      headers: true,
      approve: true,
      sync: true
    });
    expect(stepsComplete(draft, confirmed, syncStatus({ queued: 1 }))).toEqual({
      tables: true,
      headers: true,
      approve: true,
      sync: false
    });
    expect(stepsComplete(draft, confirmed, null)).toEqual({
      tables: true,
      headers: true,
      approve: true,
      sync: false
    });
  });

  it("keeps the table step open while either role has an unread table", () => {
    const executionOnly = base({ probes: { [probeKey("tbl-runs", "execution")]: probe() } });
    const draft = draftWith(
      { base: executionOnly, tableId: "tbl-runs" },
      { url: URL, base: executionOnly, tableId: "tbl-bugs" }
    );
    expect(stepsComplete(draft, TARGET, syncStatus()).tables).toBe(false);
    expect(stepsComplete(draft, TARGET, syncStatus()).headers).toBe(false);
  });
});
