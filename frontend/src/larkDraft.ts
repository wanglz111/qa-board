import type { LarkResolved, LarkTarget, SyncStatus, Table, TableRole } from "./api";

export type Probe = {
  fields: Record<string, string>;
  required: string[];
  schema_errors: string[];
  read_error?: string;
};

export type ProbeSlot = Probe | "loading";

export type LarkBase = {
  base_token: string;
  base_name: string;
  source_url: string;
  tables: Table[];
  read_errors: string[];
  probes: Record<string, ProbeSlot>;
};

export type RoleDraft = { url: string; base: LarkBase | null; tableId: string; viewId: string | null };

export type Draft = { execution: RoleDraft; bug: RoleDraft };

export type Verdict = "unread" | "loading" | "ok" | "bad" | "unreadable";

export type StepId = "tables" | "headers" | "approve" | "sync";

export type Health = { tone: "ok" | "warn" | "bad"; text: string; step: StepId | null };

export type CompletedTable = Table & { base_token: string };

// resolve 一次拿回来的东西里混着两种寿命不同的数据：base 级（tables / base_name，切表后
// 仍有效）和表级（execution_fields / required_execution_fields / schema_errors，切表即
// 失效）。Probe 就是后半部分，三项与 LarkResolved 上那三项同形。
export function probeKey(tableId: string, role: TableRole): string {
  return `${tableId}:${role}`;
}

// 判决的唯一来源（规格 §4.2）：只看这张表自己的 probe，不看任何读取时的快照。
export function verdictOf(slot: ProbeSlot | undefined): Verdict {
  if (slot === "loading") return "loading";
  if (!slot) return "unread";
  if (slot.read_error) return "unreadable";
  return slot.schema_errors.length > 0 ? "bad" : "ok";
}

// base 只在它确实由当前框里那段链接读出来时才有效（规格 §4.2）。编辑链接框即视为未
// 读取 —— 这是同类 stale 坑的第二个入口，执行表与缺陷表都要过这一关。
export function baseIsCurrent(role: RoleDraft): boolean {
  return role.base?.source_url === role.url.trim();
}

// 缺陷库链接为空 = 与执行表同库（规格 §4.1），这时才借执行表的 base；框里已经有一段
// 尚未读取的链接时不许借，宁可回 unread（验收门 3）。
export function effectiveBase(draft: Draft, role: TableRole): LarkBase | null {
  const own = draft[role].base;
  if (own && baseIsCurrent(draft[role])) return own;
  if (role === "execution") return null;
  if (draft.bug.url.trim() !== "") return null;
  const execution = draft.execution.base;
  return execution && baseIsCurrent(draft.execution) ? execution : null;
}

export function probeFor(draft: Draft, role: TableRole): ProbeSlot | undefined {
  const base = effectiveBase(draft, role);
  const tableId = draft[role].tableId;
  if (!base || !tableId) return undefined;
  return base.probes[probeKey(tableId, role)];
}

export function verdictFor(draft: Draft, role: TableRole): Verdict {
  return verdictOf(probeFor(draft, role));
}

export function nameOf(tables: Table[], tableId: string): string {
  return tables.find((table) => table.table_id === tableId)?.name ?? tableId;
}

// 已存的缺陷表优先（新的读取里仍然有它才算数）；否则第一个不是执行表的；否则第一张。
// 语义与 views/LarkCheck.tsx 里的旧 suggestBugTable 逐字一致，只是入参从 LarkResolved
// 收成 tables。
export function suggestBugTable(
  tables: Table[],
  executionTableId: string,
  target: LarkTarget | null
): string {
  const ids = tables.map((table) => table.table_id);
  if (target && ids.includes(target.bug_table_id)) return target.bug_table_id;
  const other = tables.find((table) => table.table_id !== executionTableId);
  return other?.table_id ?? ids[0] ?? "";
}

// 本页新建的表只属于它被创建时所在的那个 base；同一个 base 内按 table_id 去重，
// 重复接受同一张表不会在下拉里出现两次。
export function withCreatedTable(
  tables: Table[],
  created: CompletedTable | null,
  baseToken: string
): Table[] {
  if (!created || !baseToken || created.base_token !== baseToken) return tables;
  if (tables.some((table) => table.table_id === created.table_id)) return tables;
  return [created, ...tables];
}

export function emptyDraft(): Draft {
  return {
    execution: { url: "", base: null, tableId: "", viewId: null },
    bug: { url: "", base: null, tableId: "", viewId: null }
  };
}

// 已保存的目标只用来预填链接与两个 tableId；base 仍为 null，所以每张表的判决都是
// unread，直到有人在第 ① 步真的读一次、校验一次（验收门 3）。
export function draftFromTarget(target: LarkTarget | null): Draft {
  if (!target) return emptyDraft();
  return {
    execution: {
      url: target.source_url,
      base: null,
      tableId: target.execution_table_id,
      viewId: null
    },
    bug: { url: "", base: null, tableId: target.bug_table_id, viewId: null }
  };
}

// 判定顺序本身就是契约（规格 §5.1 / 本计划 §Interfaces 的 8 行表）：先来的条件赢，
// 后面的条件不再看。
export function describeHealth(input: {
  target: LarkTarget | null;
  liveErrors: string[];
  schemaInvalid: boolean;
  sync: SyncStatus | null;
}): Health {
  const { target, liveErrors, schemaInvalid, sync } = input;
  if (!target) {
    return { tone: "warn", step: "tables", text: "尚未选择 Lark 表：请在第 1 步粘贴链接并保存" };
  }
  if (liveErrors.length > 0) {
    return { tone: "bad", step: "headers", text: `目标表读取失败：${liveErrors[0]}` };
  }
  if (schemaInvalid && target.confirmed) {
    return { tone: "bad", step: "headers", text: "已确认，但表头已失效（需重新校验）" };
  }
  if (schemaInvalid) {
    return { tone: "bad", step: "headers", text: "表头缺失，尚不能确认写入" };
  }
  const failed = sync?.failed ?? 0;
  const uncertain = sync?.uncertain ?? 0;
  if (failed + uncertain > 0) {
    return {
      tone: "bad",
      step: "sync",
      text: `同步失败 ${failed} 条 · 待人工确认 ${uncertain} 条`
    };
  }
  const parked = sync?.parked ?? 0;
  if (parked > 0) {
    return { tone: "warn", step: "sync", text: `待管理员处理 ${parked} 条` };
  }
  if (!target.confirmed) {
    return { tone: "warn", step: "approve", text: "未确认：本地结果不会写入 Lark" };
  }
  return {
    tone: "ok",
    step: null,
    text:
      `已确认 · ${target.execution_table_name} / ${target.bug_table_name}` +
      ` · 待同步 ${sync?.queued ?? 0} · 失败 0`
  };
}

// 「这一步完成了」= 这一步没有未了的事，逐条对应规格 §5.2 的「完成条件」列：
// ① 两个 tableId 都选中且各自校验通过；② 已保存 target 且两表仍校验通过；
// ③ target 已确认写入；④ 已确认且队列干净（parked 由管理员处理，不算这一步未完成）。
export function stepsComplete(
  draft: Draft,
  target: LarkTarget | null,
  sync: SyncStatus | null
): Record<StepId, boolean> {
  const verified =
    verdictFor(draft, "execution") === "ok" && verdictFor(draft, "bug") === "ok";
  const chosen = draft.execution.tableId !== "" && draft.bug.tableId !== "";
  const confirmed = target?.confirmed === true;
  const queueClean =
    sync !== null &&
    sync.queued === 0 &&
    sync.pending_attempts === 0 &&
    sync.failed === 0 &&
    sync.uncertain === 0;
  return {
    tables: chosen && verified,
    headers: target !== null && verified,
    approve: confirmed,
    sync: confirmed && queueClean
  };
}
