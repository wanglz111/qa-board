import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const ROLES: TableRole[] = ["execution", "bug"];

// 请求挂死时的兜底：api.ts 的 request() 没有超时，超过这个时长就认为那次校验已经作废，
// 允许重新发起（复审 A3）。它只管「能不能重发」，不动 probe 槽位：槽位仍然是 loading。
const CHECK_ABANDON_MS = 30_000;

// 在途登记的值：发起时刻（放弃窗口用）+ 递增序号（身份用 —— 毫秒时钟在同一毫秒内会撞车，
// 被顶掉的那次就会误以为自己还是最新的一次）。
type Flight = { startedAt: number; seq: number };

// 去重键与 probe 槽位键不是一个东西：槽位键永远只是 `${table_id}:${role}`（契约），
// 去重键才带 base。切 base 后对同名表的校验不能被上一段的在途请求吞掉（复审 A3）。
function flightKeyFor(baseToken: string, tableId: string, role: TableRole): string {
  return `${baseToken}:${probeKey(tableId, role)}`;
}

// checking 只回答一个问题：这个 role 现在选中的那张表是不是正在校验。按
// (base_token, table_id, role) 判等，而不是只按 role —— 同一 role 的另一张表在飞时，
// 不许替当前这张表说「在加载」（复审 A3 / R-F14）。两个 role 都在飞时先报 execution。
function checkingFor(draft: Draft, flights: readonly string[]): TableRole | null {
  for (const role of ROLES) {
    const base = effectiveBase(draft, role);
    const tableId = draft[role].tableId;
    if (!base || !tableId) continue;
    if (flights.includes(flightKeyFor(base.base_token, tableId, role))) return role;
  }
  return null;
}

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

  // 异步回落到地上时要读「当次渲染」的 draft（链接框可能在请求飞行中被改过），
  // 闭包里的 draft 是发起那次请求时的旧值 —— 用 ref 拿最新的。
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // 同一张表、同一个 role、同一个 base 的校验不许并发重复发请求（验收门 7）；键含 base
  // 才不会把「另一个 base 里的同名表」当成重复吞掉（复审 A3）。值在 finally 里释放。
  const inFlight = useRef<Map<string, Flight>>(new Map());
  const flightSeq = useRef(0);
  // 登记表的渲染镜像：checking 由它 + 当前选中表派生，不再单独记一份状态。
  const [flightKeys, setFlightKeys] = useState<readonly string[]>([]);

  // 双击「读取表格」不该发两次 resolve（复审 E1）。
  const readInFlight = useRef<Set<TableRole>>(new Set());
  // 复位（换组 / resetDraft）会让上一份 draft 作废。await 是没法取消的：resolve 可能跨过
  // 复位才落地，那份响应属于旧 draft，不许写进来 —— 读之前记下自己那一代，落地时对不上
  // 就整个作废（复审 Important 1）。新 target 用同一段链接时 baseIsCurrent 会重新成立，
  // 光靠它挡不住这种「陈旧的 base 又变回当前」的情形。
  const generation = useRef(0);

  const syncFlightKeys = useCallback(() => {
    setFlightKeys([...inFlight.current.keys()]);
  }, []);

  const checking = useMemo(
    () => checkingFor(draft, flightKeys),
    [draft, flightKeys]
  );

  useEffect(() => {
    // 换了测试组：draft 复位（行为契约）。上一组的链接、base、判决都不属于这一组。
    // 在飞的那次读取也随之作废（generation）。
    generation.current += 1;
    setDraft(emptyDraft());
    setReading(null);
    inFlight.current.clear();
    readInFlight.current.clear();
    setFlightKeys([]);
  }, [groupId]);

  const runCheck = useCallback(
    async (role: TableRole, baseToken: string, tableId: string): Promise<void> => {
      if (!baseToken || !tableId) return;
      const slotKey = probeKey(tableId, role);
      const flightKey = flightKeyFor(baseToken, tableId, role);
      const now = Date.now();
      const started = inFlight.current.get(flightKey);
      if (started && now - started.startedAt < CHECK_ABANDON_MS) return;
      const seq = (flightSeq.current += 1);
      inFlight.current.set(flightKey, { startedAt: now, seq });
      syncFlightKeys();
      setDraft((current) => withSlot(current, role, baseToken, slotKey, "loading"));
      // 只有「最新的一次」能写结果：recheckRole 会顶掉在途的那次，迟到的那份旧答案
      // 不许把修好之后的判决按回去。
      const isNewest = () => inFlight.current.get(flightKey)?.seq === seq;
      try {
        const schema = await readTableSchema(baseToken, tableId, role);
        if (!isNewest()) return;
        // 服务端说它答的是另一张表：这份字段不能挂到这张表的 key 上，那正是这次
        // 重构要根治的「串味」。当作一次失败的读取处理。
        if (schema.table_id !== tableId) {
          const message = `校验结果与请求的表不一致：请求 ${tableId}，返回 ${schema.table_id}`;
          setDraft((current) =>
            withSlot(current, role, baseToken, slotKey, unreadableProbe(message))
          );
          onError(message);
          return;
        }
        setDraft((current) =>
          withSlot(current, role, baseToken, slotKey, {
            fields: schema.fields,
            required: schema.required,
            schema_errors: schema.schema_errors
          })
        );
      } catch (reason) {
        if (!isNewest()) return;
        const message = messageOf(reason, "读取该表字段失败");
        setDraft((current) => withSlot(current, role, baseToken, slotKey, unreadableProbe(message)));
        onError(message);
      } finally {
        // 只释放「我这一次」的登记：被顶掉/被放弃的那次不许删掉后来者的键。
        if (inFlight.current.get(flightKey)?.seq === seq) inFlight.current.delete(flightKey);
        syncFlightKeys();
      }
    },
    [readTableSchema, onError, syncFlightKeys]
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
      // 双击「读取表格」不该发两次 resolve（复审 E1）。
      if (readInFlight.current.has(role)) return null;
      readInFlight.current.add(role);
      const startedGeneration = generation.current;
      setReading(role);
      let result: TableRole | null = null;
      let pending: { role: TableRole; baseToken: string; tableId: string } | null = null;
      try {
        const resolved = await resolve(url);
        // 这份响应属于哪一份 draft？复位过就作废：不写 base、不改选中、也不顺手校验
        // 缺陷表（复审 Important 1）。返回 null = 这次读取没有生效。
        if (generation.current !== startedGeneration) return null;
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
        readInFlight.current.delete(role);
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
      // 还在飞的那次是「修好之前」发出的：把它从登记表里撤掉，否则 runCheck 会把它当成
      // 重复请求吞掉调用，而它迟到的答案又会把判决按回去（B7 在窄窗口里复发）。撤掉之后
      // isNewest 会让那份旧答案落地时自己作废。
      inFlight.current.delete(flightKeyFor(base.base_token, tableId, role));
      syncFlightKeys();
      // 不带 base 复用：runCheck 自己会按 baseToken 写回，切了 base 就写不进去（那是正确行为）。
      await runCheck(role, base.base_token, tableId);
    },
    [invalidateRole, runCheck, syncFlightKeys]
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
      let next = withRole(current, role, {
        ...current[role],
        tableId: table.table_id,
        viewId: null
      });
      // 另一个 role 若也指着被替换的这张表，必须一起跟随（复审 A4）：重建换掉的是表本身。
      // 但只有同一个 base 里的同名表才算「同一张表」—— 另一个 base 里恰好同名的表不在
      // 这次重建的范围内，把它拖到一张不属于它的新表上更糟。
      const other = otherRole(role);
      const otherBase = effectiveBase(current, other);
      const otherFollows =
        current[other].tableId === replaced.table_id &&
        otherBase !== null &&
        otherBase.base_token === base.base_token;
      if (otherFollows) {
        next = withRole(next, other, {
          ...next[other],
          tableId: table.table_id,
          viewId: null
        });
      }
      const applied = withBase(next, base, nextBase);
      setDraft(applied);
      void runCheck(role, base.base_token, table.table_id);
      // otherFollows 已经保证另一个 role 用的是同一个 base，写回时不会串到别的库。
      if (otherFollows) void runCheck(other, base.base_token, table.table_id);
    },
    [runCheck, onError]
  );

  const resetDraft = useCallback((target: LarkTarget | null) => {
    // 复位 = 之前读到的东西都不算数（含还在飞的那次读取）：draft 本身只由 target 预填。
    generation.current += 1;
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
