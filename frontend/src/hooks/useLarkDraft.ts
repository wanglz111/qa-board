import { useCallback, useEffect, useRef, useState } from "react";

import type { LarkResolved, LarkTarget, Table, TableRole, TableSchema } from "../api";
import {
  draftFromTarget,
  effectiveBase,
  emptyDraft,
  probeKey,
  suggestBugTable,
  withCreatedTable,
  type CompletedTable,
  type Draft,
  type LarkBase,
  type Probe,
  type ProbeSlot,
  type RoleDraft
} from "../larkDraft";

export type LarkDraftActions = {
  draft: Draft;
  reading: TableRole | null;
  checking: TableRole | null;
  setLink: (role: TableRole, url: string) => void;
  readLink: (role: TableRole) => Promise<TableRole | null>;
  setTable: (role: TableRole, tableId: string) => void;
  checkTable: (role: TableRole) => Promise<void>;
  invalidateRole: (role: TableRole) => void;          // 作废该 role 当前表的 probe
  recheckRole: (role: TableRole) => Promise<void>;    // = invalidateRole + checkTable
  acceptCreatedTable: (role: TableRole, table: Table) => void;
  acceptRebuiltTable: (role: TableRole, table: Table, replaced: Table) => void;
  resetDraft: (target: LarkTarget | null) => void;
};

type Options = {
  groupId: string;
  resolve: (url: string) => Promise<LarkResolved>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  onError: (message: string) => void;
};

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function otherRole(role: TableRole): TableRole {
  return role === "execution" ? "bug" : "execution";
}

function baseFrom(resolved: LarkResolved, probes: Record<string, ProbeSlot>): LarkBase {
  return {
    base_token: resolved.base_token,
    base_name: resolved.base_name,
    source_url: resolved.source_url,
    tables: resolved.tables,
    read_errors: resolved.read_errors ?? [],
    probes
  };
}

// resolve 已经算过一次执行表的字段与缺失：把它播种成 execution+selected.table_id 的
// 首个 probe（规格 §7「判决单一来源」）。role 或 table 不匹配一律不播种。
function seededProbe(resolved: LarkResolved): Probe {
  return {
    fields: resolved.execution_fields,
    required: resolved.required_execution_fields,
    schema_errors: resolved.schema_errors
  };
}

// 读不到就是读不到：空 fields + read_error，verdictOf 因此回 unreadable，不冒充 ok。
function unreadableProbe(message: string): Probe {
  return { fields: {}, required: [], schema_errors: [], read_error: message };
}

function withRole(draft: Draft, role: TableRole, next: RoleDraft): Draft {
  return role === "execution" ? { ...draft, execution: next } : { ...draft, bug: next };
}

// 把 base 写回它真正的宿主 role：缺陷库链接为空时两个 role 用的是执行表的那个 base，
// 这时缺陷表的 probe 也必须写进那个 base，否则 verdictFor(role) 永远看不到它。
function withBase(draft: Draft, current: LarkBase, next: LarkBase): Draft {
  if (draft.execution.base === current) {
    return { ...draft, execution: { ...draft.execution, base: next } };
  }
  if (draft.bug.base === current) {
    return { ...draft, bug: { ...draft.bug, base: next } };
  }
  return draft;
}

// 迟到的响应不许污染已经换掉的 base：baseToken 是这次请求出发时的那个 base 才算数。
function withSlot(
  draft: Draft,
  role: TableRole,
  baseToken: string,
  key: string,
  slot: ProbeSlot
): Draft {
  const current = effectiveBase(draft, role);
  if (!current || current.base_token !== baseToken) return draft;
  const next: LarkBase = { ...current, probes: { ...current.probes, [key]: slot } };
  return withBase(draft, current, next);
}

function withoutRoleProbes(
  probes: Record<string, ProbeSlot>,
  role: TableRole
): Record<string, ProbeSlot> {
  const suffix = `:${role}`;
  const next: Record<string, ProbeSlot> = {};
  for (const [key, slot] of Object.entries(probes)) {
    if (!key.endsWith(suffix)) next[key] = slot;
  }
  return next;
}

function withoutTableProbes(
  probes: Record<string, ProbeSlot>,
  tableId: string
): Record<string, ProbeSlot> {
  const prefix = `${tableId}:`;
  const next: Record<string, ProbeSlot> = {};
  for (const [key, slot] of Object.entries(probes)) {
    if (!key.startsWith(prefix)) next[key] = slot;
  }
  return next;
}

export function useLarkDraft(opts: Options): LarkDraftActions {
  const { groupId, resolve, readTableSchema, onError } = opts;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [reading, setReading] = useState<TableRole | null>(null);
  const [checking, setChecking] = useState<TableRole | null>(null);

  // 异步回落到地上时要读「当次渲染」的 draft（链接框可能在请求飞行中被改过），
  // 闭包里的 draft 是发起那次请求时的旧值 —— 用 ref 拿最新的。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 同一张表同一个 role 的校验不许并发重复发请求（验收门 7）。
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 换了测试组：draft 复位（行为契约）。上一组的链接、base、判决都不属于这一组。
    setDraft(emptyDraft());
    setReading(null);
    setChecking(null);
    inFlight.current.clear();
  }, [groupId]);

  const runCheck = useCallback(
    async (role: TableRole, baseToken: string, tableId: string): Promise<void> => {
      if (!baseToken || !tableId) return;
      const key = probeKey(tableId, role);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setDraft((current) => withSlot(current, role, baseToken, key, "loading"));
      setChecking(role);
      try {
        const schema = await readTableSchema(baseToken, tableId, role);
        // 服务端说它答的是另一张表：这份字段不能挂到这张表的 key 上，那正是这次
        // 重构要根治的「串味」。当作一次失败的读取处理。
        if (schema.table_id !== tableId) {
          const message = `校验结果与请求的表不一致：请求 ${tableId}，返回 ${schema.table_id}`;
          setDraft((current) =>
            withSlot(current, role, baseToken, key, unreadableProbe(message))
          );
          onError(message);
          return;
        }
        setDraft((current) =>
          withSlot(current, role, baseToken, key, {
            fields: schema.fields,
            required: schema.required,
            schema_errors: schema.schema_errors
          })
        );
      } catch (reason) {
        const message = messageOf(reason, "读取该表字段失败");
        setDraft((current) => withSlot(current, role, baseToken, key, unreadableProbe(message)));
        onError(message);
      } finally {
        inFlight.current.delete(key);
        setChecking((current) => (current === role ? null : current));
      }
    },
    [readTableSchema, onError]
  );

  const setLink = useCallback((role: TableRole, url: string) => {
    setDraft((current) => {
      const roleDraft = current[role];
      // 编辑链接框 = 这张表还没读过：base 与判决一并作废（规格 §4.2）。只有框里
      // 仍是读到过的那段链接（trim 后逐字相同）时才留着 base。
      const stillCurrent = roleDraft.base !== null && roleDraft.base.source_url === url.trim();
      const next: RoleDraft = stillCurrent
        ? { ...roleDraft, url }
        : { url, base: null, tableId: roleDraft.tableId, viewId: null };
      return withRole(current, role, next);
    });
  }, []);

  const setTable = useCallback((role: TableRole, tableId: string) => {
    setDraft((current) => {
      const roleDraft = current[role];
      if (roleDraft.tableId === tableId) return current;
      // view 只描述链接当时选中的那张表：换表即丢，不当成新表的 view 存下去。
      return withRole(current, role, { ...roleDraft, tableId, viewId: null });
    });
  }, []);

  const readLink = useCallback(
    async (role: TableRole): Promise<TableRole | null> => {
      const url = draftRef.current[role].url.trim();
      if (!url) return null;
      setReading(role);
      let result: TableRole | null = null;
      let pending: { role: TableRole; baseToken: string; tableId: string } | null = null;
      try {
        const resolved = await resolve(url);
        const selected = resolved.selected.table_id ?? resolved.tables[0]?.table_id ?? "";
        const current = draftRef.current;
        const probes: Record<string, ProbeSlot> = {};
        if (role === "execution" && selected !== "" && selected === resolved.selected.table_id) {
          probes[probeKey(selected, "execution")] = seededProbe(resolved);
        }
        const readRole: RoleDraft = {
          // 框里现在是哪段链接就留哪段：服务端回显的 source_url 与它不同源时
          // baseIsCurrent 会判 false，判决诚实地回到 unread，而不是拿旧判决顶着。
          url: current[role].url,
          base: baseFrom(resolved, probes),
          tableId: selected,
          viewId: resolved.selected.view_id
        };
        let next = withRole(current, role, readRole);
        // 缺陷库链接为空 = 与执行表同库：缺陷表的下拉必须落在同一个 base 的表里，
        // 选中的表不在这批表里时退回建议值（旧页面的 effectiveBugTableId 规则）。
        if (role === "execution" && next.bug.url.trim() === "") {
          const chosen =
            next.bug.tableId !== "" &&
            resolved.tables.some((table) => table.table_id === next.bug.tableId);
          if (!chosen) {
            next = withRole(next, "bug", {
              ...next.bug,
              tableId: suggestBugTable(resolved.tables, selected, null),
              viewId: null
            });
          }
        }
        setDraft(next);
        // 同库场景顺手校验一次缺陷表（规格 §8）。借来的 base 会把 probe 写回宿主 role。
        const bugBase = effectiveBase(next, "bug");
        if (bugBase && next.bug.tableId !== "") {
          pending = { role: "bug", baseToken: bugBase.base_token, tableId: next.bug.tableId };
        }
        result = role;
      } catch (reason) {
        onError(messageOf(reason, role === "bug" ? "读取缺陷表失败" : "读取 Lark 表格失败"));
        result = null;
      } finally {
        setReading(null);
      }
      // 读取的 spinner 收掉之后再校验，页面不会同时转两个圈。
      if (pending) await runCheck(pending.role, pending.baseToken, pending.tableId);
      return result;
    },
    [resolve, runCheck, onError]
  );

  const checkTable = useCallback(
    async (role: TableRole): Promise<void> => {
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      const tableId = current[role].tableId;
      if (!base || !tableId) return;
      await runCheck(role, base.base_token, tableId);
    },
    [runCheck]
  );

  const invalidateRole = useCallback((role: TableRole) => {
    setDraft((current) => {
      const base = effectiveBase(current, role);
      const tableId = current[role].tableId;
      if (!base || !tableId) return current;
      // 表头变了，对这张表的结论就不再成立：这张表的 probe 一律作废（同库时另一个
      // role 的 probe 挂的是同一张表的表头，跟着一起作废），别的表不动。
      const next: LarkBase = {
        ...base,
        probes: withoutTableProbes(base.probes, tableId)
      };
      return withBase(current, base, next);
    });
  }, []);

  const recheckRole = useCallback(
    async (role: TableRole): Promise<void> => {
      // 先取 base/tableId，再作废：作废只清 probe，不动这两个值。
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      const tableId = current[role].tableId;
      if (!base || !tableId) return;
      invalidateRole(role);
      // 不带 base 复用：runCheck 自己会按 baseToken 写回，切了 base 就写不进去（那是正确行为）。
      await runCheck(role, base.base_token, tableId);
    },
    [invalidateRole, runCheck]
  );

  const acceptCreatedTable = useCallback(
    (role: TableRole, table: Table) => {
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      if (!base) {
        onError("请先读取该多维表格链接，再把新建的数据表加入选择");
        return;
      }
      // 新建的表落进它被创建时所在的那个 base；两个 role 共用同一个 base 时，
      // 它会同时出现在两个下拉里 —— 服务端的 list_tables 之后也会这么答。
      const created: CompletedTable = { ...table, base_token: base.base_token };
      const nextBase: LarkBase = {
        ...base,
        tables: withCreatedTable(base.tables, created, base.base_token)
      };
      // 先改选中（此 role 对象里还挂着旧 base），再把新 base 写回 —— withBase 必须最后
      // 做，否则它换上的 tables 会被 withRole 拿旧 role 对象覆盖掉。
      const selected = withRole(current, role, {
        ...current[role],
        tableId: table.table_id,
        viewId: null
      });
      setDraft(withBase(selected, base, nextBase));
      void runCheck(role, base.base_token, table.table_id);
    },
    [runCheck, onError]
  );

  const acceptRebuiltTable = useCallback(
    (role: TableRole, table: Table, replaced: Table) => {
      const current = draftRef.current;
      const base = effectiveBase(current, role);
      if (!base) {
        onError("请先读取该多维表格链接，再重建数据表");
        return;
      }
      const created: CompletedTable = { ...table, base_token: base.base_token };
      // 重建在服务端换掉了目标表：被替换表从表单里下去，它的 probe 与另一个 role 的
      // probe 一并作废（重建会改到目标表的表头，规格 §8）。
      let probes = withoutTableProbes(base.probes, replaced.table_id);
      probes = withoutRoleProbes(probes, otherRole(role));
      const nextBase: LarkBase = {
        ...base,
        tables: withCreatedTable(
          base.tables.filter((item) => item.table_id !== replaced.table_id),
          created,
          base.base_token
        ),
        probes
      };
      // 同上：withBase 最后做。
      const selected = withRole(current, role, {
        ...current[role],
        tableId: table.table_id,
        viewId: null
      });
      setDraft(withBase(selected, base, nextBase));
      void runCheck(role, base.base_token, table.table_id);
    },
    [runCheck, onError]
  );

  const resetDraft = useCallback((target: LarkTarget | null) => {
    setDraft(draftFromTarget(target));
  }, []);

  return {
    draft,
    reading,
    checking,
    setLink,
    readLink,
    setTable,
    checkTable,
    invalidateRole,
    recheckRole,
    acceptCreatedTable,
    acceptRebuiltTable,
    resetDraft
  };
}
