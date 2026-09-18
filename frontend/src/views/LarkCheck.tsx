import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, ShieldCheck, ShieldOff, Upload } from "lucide-react";

import {
  ApiError,
  type CreateTablePayload,
  type CreateTableResult,
  type Group,
  type LarkResolved,
  type LarkTarget,
  type LarkTargetChangeDetail,
  type LarkTargetPayload,
  type LarkTargetState,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type RetypeFieldsPayload,
  type RetypeFieldsResult,
  type SyncEnqueueResult,
  type SyncStatus,
  type Table,
  type TableRole
} from "../api";
import { StepHeaders } from "../components/lark/StepHeaders";
import { TargetChangeDialog, type TargetSide } from "../components/TargetChangeDialog";

type Props = {
  loadGroups: () => Promise<Group[]>;
  resolve: (url: string) => Promise<LarkResolved>;
  loadTarget: (groupId: string) => Promise<LarkTargetState>;
  saveTarget: (
    groupId: string,
    payload: LarkTargetPayload
  ) => Promise<{
    target: LarkTarget;
    live: LarkTargetState["live"];
    confirmation_cleared: boolean;
  }>;
  confirmTarget: (groupId: string, targetFingerprint: string) => Promise<LarkTarget>;
  loadSync?: (groupId: string) => Promise<SyncStatus>;
  enqueueSync?: (groupId: string) => Promise<SyncEnqueueResult>;
  retrySync?: (
    groupId: string,
    releaseUncertain?: boolean
  ) => Promise<{ requeued: number; released: number; repointed?: number }>;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  initialGroupId?: string;
};

type PendingChange = {
  payload: LarkTargetPayload;
  previous: TargetSide | null;
  next: TargetSide;
};

// A table this page just created lives in one base, so it is only offered
// while that base is still the one the role points at: the select and the
// payload keep naming the same table.
type CreatedTable = Table & { base_token: string };

type Identity = LarkTargetChangeDetail["diff"]["next"];

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function nameOf(tables: Table[], tableId: string): string {
  return tables.find((table) => table.table_id === tableId)?.name ?? tableId;
}

function withCreatedTable(
  tables: Table[],
  created: CreatedTable | null,
  baseToken: string
): Table[] {
  if (!created || !baseToken || created.base_token !== baseToken) return tables;
  if (tables.some((table) => table.table_id === created.table_id)) return tables;
  return [created, ...tables];
}

function sideOf(target: LarkTarget | null): TargetSide {
  return {
    execution_table_name: target?.execution_table_name ?? "",
    execution_table_id: target?.execution_table_id ?? "",
    bug_table_name: target?.bug_table_name ?? "",
    bug_table_id: target?.bug_table_id ?? ""
  };
}

// The stored defect table wins when the freshly resolved base still offers it;
// otherwise the first table that is not the execution table is the suggestion.
function suggestBugTable(base: LarkResolved, executionTableId: string, target: LarkTarget | null) {
  const ids = base.tables.map((table) => table.table_id);
  if (target && ids.includes(target.bug_table_id)) return target.bug_table_id;
  const other = base.tables.find((table) => table.table_id !== executionTableId);
  return other?.table_id ?? ids[0] ?? "";
}

function isTargetChange(detail: unknown): detail is LarkTargetChangeDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { reason?: unknown }).reason === "target_changed" &&
    Boolean((detail as { diff?: { changed?: unknown } }).diff?.changed)
  );
}

export function LarkCheckView({
  loadGroups,
  resolve,
  loadTarget,
  saveTarget,
  confirmTarget,
  loadSync,
  enqueueSync,
  retrySync,
  loadPlan,
  provision,
  retype,
  createTable,
  rebuild,
  initialGroupId
}: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [state, setState] = useState<LarkTargetState | null>(null);
  const [link, setLink] = useState("");
  const [resolved, setResolved] = useState<LarkResolved | null>(null);
  const [bugLink, setBugLink] = useState("");
  const [bugResolved, setBugResolved] = useState<LarkResolved | null>(null);
  // The link text that actually produced bugResolved. Without it the box could
  // show one base while the payload kept sending the base of an older read.
  const [bugReadUrl, setBugReadUrl] = useState("");
  const [executionTableId, setExecutionTableId] = useState("");
  const [bugTableId, setBugTableId] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readingBug, setReadingBug] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [retryingSync, setRetryingSync] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [createdTables, setCreatedTables] = useState<Record<TableRole, CreatedTable | null>>({
    execution: null,
    bug: null
  });

  useEffect(() => {
    let cancelled = false;
    loadGroups()
      .then((loaded) => {
        if (cancelled) return;
        setGroups(loaded);
        setGroupId((current) => {
          if (current && loaded.some((group) => group.id === current)) return current;
          return loaded.find((group) => group.id === initialGroupId)?.id ?? loaded[0]?.id ?? "";
        });
      })
      .catch((reason) => !cancelled && setError(messageOf(reason, "读取测试组失败")));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGroupId]);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    setAllowWrites(false);
    setNotice("");
    setPendingChange(null);
    setResolved(null);
    setBugResolved(null);
    setBugReadUrl("");
    setExecutionTableId("");
    setBugTableId("");
    setCreatedTables({ execution: null, bug: null });
    // The header names another group now: neither its stored target (and its
    // fingerprint) nor the previous group's message may linger under it.
    setState(null);
    setError("");
    loadTarget(groupId)
      .then((result) => !cancelled && setState(result))
      .catch(
        (reason) => !cancelled && setError(messageOf(reason, "读取该组的 Lark 目标失败"))
      );
    loadSync?.(groupId)
      .then((result) => !cancelled && setSync(result))
      .catch(() => !cancelled && setSync(null));
    return () => {
      cancelled = true;
    };
  }, [groupId, loadTarget]);

  const target = state?.target ?? null;
  const liveErrors = [
    ...(state?.read_errors ?? []),
    ...(state?.live?.read_errors ?? []),
    ...(state?.live?.schema_errors ?? [])
  ];
  const blocked = liveErrors.length > 0;
  const confirmed = target?.confirmed === true;
  const invalidated = confirmed && (state?.live?.schema_errors.length ?? 0) > 0;
  const confirmable = Boolean(target && !blocked && groupId && target.target_fingerprint);
  const syncFailed = sync?.failed ?? 0;
  const syncParked = sync?.parked ?? 0;

  const executionBaseToken = resolved?.base_token ?? "";
  // The box is the source of truth for the defect base, and it only selects
  // another base while it still holds the link that was actually read. An empty
  // box — and any text the administrator has not read — means the execution
  // base, which is what the field's label promises.
  const trimmedBugLink = bugLink.trim();
  const bugReadApplies =
    bugResolved !== null && trimmedBugLink !== "" && trimmedBugLink === bugReadUrl;
  const bugBase = bugReadApplies ? bugResolved : resolved;
  const bugBaseToken = bugBase?.base_token ?? "";
  // A table created through this page is added to the role's list, so the
  // pending selection and the payload can name it like any resolved table.
  const executionTables = withCreatedTable(
    resolved?.tables ?? [],
    createdTables.execution,
    executionBaseToken
  );
  const bugTables = withCreatedTable(bugBase?.tables ?? [], createdTables.bug, bugBaseToken);
  const bugLinkUnread = trimmedBugLink !== "" && !bugReadApplies;
  // A table id read from another base — or from a link the box no longer holds
  // — is not a choice this base offers; fall back to the suggestion so the
  // select and the payload can never name different tables.
  const bugTableIdChosen = bugTables.some((table) => table.table_id === bugTableId);
  const effectiveBugTableId = bugTableIdChosen
    ? bugTableId
    : bugBase
      ? suggestBugTable(bugBase, executionTableId, target)
      : "";
  // A view id only describes the table the link pointed at; re-pointing the role
  // drops it rather than storing a view of a table that is no longer selected.
  const executionViewId =
    resolved && executionTableId === resolved.selected.table_id
      ? resolved.selected.view_id
      : null;

  function draftSide(): TargetSide {
    return {
      execution_table_name: nameOf(executionTables, executionTableId),
      execution_table_id: executionTableId,
      bug_table_name: nameOf(bugTables, effectiveBugTableId),
      bug_table_id: effectiveBugTableId
    };
  }

  function buildPayload(acknowledge: boolean): LarkTargetPayload {
    return {
      source_url: resolved?.source_url ?? target?.source_url ?? "",
      execution_base_token: executionBaseToken,
      execution_table_id: executionTableId,
      execution_view_id: executionViewId,
      bug_base_token: bugBaseToken,
      bug_table_id: effectiveBugTableId,
      expected_previous_fingerprint: target?.target_fingerprint ?? null,
      acknowledge_change: acknowledge
    };
  }

  // Names only exist for the tables this page resolved; an id is the honest
  // label for a table it never read.
  function namedSide(identity: Identity): TargetSide {
    return {
      execution_table_name: nameOf(executionTables, identity.execution_table_id),
      execution_table_id: identity.execution_table_id,
      bug_table_name: nameOf(bugTables, identity.bug_table_id),
      bug_table_id: identity.bug_table_id
    };
  }

  async function readExecutionLink() {
    const url = link.trim();
    if (!url) return;
    setReading(true);
    setError("");
    setNotice("");
    try {
      const result = await resolve(url);
      const selected = result.selected.table_id ?? result.tables[0]?.table_id ?? "";
      setResolved(result);
      setExecutionTableId(selected);
      // A defect table read from its own link stays where it is: the form, the
      // payload and the suggestion all keep describing the base it came from —
      // but only while the box still holds that link.
      const defectBase = bugReadApplies && bugResolved ? bugResolved : result;
      setBugTableId(suggestBugTable(defectBase, selected, target));
    } catch (reason) {
      setError(messageOf(reason, "读取 Lark 表格失败"));
    } finally {
      setReading(false);
    }
  }

  async function readBugLink() {
    const url = bugLink.trim();
    if (!url) return;
    setReadingBug(true);
    setError("");
    setNotice("");
    try {
      const result = await resolve(url);
      setBugResolved(result);
      setBugReadUrl(url);
      setBugTableId(suggestBugTable(result, executionTableId, target));
    } catch (reason) {
      setError(messageOf(reason, "读取缺陷表失败"));
    } finally {
      setReadingBug(false);
    }
  }

  // A new table becomes that role's pending selection: it is not a target yet,
  // the administrator still has to save it with 「保存选择」.
  function acceptCreatedTable(role: TableRole, table: Table) {
    const baseToken = role === "execution" ? executionBaseToken : bugBaseToken;
    setCreatedTables((current) => ({ ...current, [role]: { ...table, base_token: baseToken } }));
    if (role === "execution") {
      setExecutionTableId(table.table_id);
    } else {
      setBugTableId(table.table_id);
    }
    setError("");
  }

  // A rebuild moves the group onto a brand new table on the server, so the
  // page has to follow it: the role's selection becomes the rebuilt table and
  // the one it replaced is dropped from the created list, otherwise 「保存选择」
  // would keep offering a table the server has already walked away from.
  function acceptRebuiltTable(role: TableRole, table: Table, replaced: Table) {
    if (replaced.table_id !== table.table_id) {
      setCreatedTables((current) => {
        if (current[role]?.table_id !== replaced.table_id) return current;
        return { ...current, [role]: null };
      });
    }
    acceptCreatedTable(role, table);
  }

  async function refreshTarget() {
    if (!groupId) return;
    setError("");
    try {
      setState(await loadTarget(groupId));
    } catch (reason) {
      setError(messageOf(reason, "读取该组的 Lark 目标失败"));
    }
  }

  // A run that changed the table has already invalidated the approval on the
  // server. Dropping it here first means a failed re-read cannot leave 「已确认」
  // sitting next to 「已创建 …」.
  async function reloadAfterProvision() {
    setState((current) =>
      current?.target
        ? { ...current, target: { ...current.target, confirmed: false, confirmed_at: null } }
        : current
    );
    await refreshTarget();
  }

  function identityChanged(): boolean {
    if (!target || !resolved) return false;
    return (
      target.execution_base_token !== executionBaseToken ||
      target.execution_table_id !== executionTableId ||
      target.bug_base_token !== bugBaseToken ||
      target.bug_table_id !== effectiveBugTableId
    );
  }

  async function persist(payload: LarkTargetPayload) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await saveTarget(groupId, payload);
      setPendingChange(null);
      // The PUT already answered with the saved row and the live read it was
      // based on; re-reading it here only added a request whose failure the
      // page swallowed.
      setState({
        target: result.target,
        live: result.live ?? null,
        read_errors: result.live?.read_errors ?? []
      });
      setNotice(
        result.confirmation_cleared
          ? "目标表已更换：此前的写入确认已被清除，需要重新确认"
          : "已保存该组的 Lark 目标表"
      );
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        const detail = reason.detail;
        if (typeof detail === "object" && detail !== null) {
          const body = detail as LarkTargetChangeDetail;
          if (body.reason === "stale_page") {
            // Another tab moved the group after this page loaded, so the page's
            // fingerprint is not a basis for an acknowledgement: re-read instead.
            // The dialog has to come down with it — a diff the server just
            // refused must not stay on top of the explanation.
            setPendingChange(null);
            const refreshed = await loadTarget(groupId).catch(() => null);
            if (refreshed) setState(refreshed);
            setError(
              "其他页面已改过该组的目标表，已重新读取；本次选择仍然保留，请核对后再次点击「保存选择」"
            );
            return;
          }
          if (isTargetChange(detail)) {
            // The server found a change the page had not seen yet: the same
            // acknowledgement dialog stands between the two.
            setPendingChange({
              payload,
              previous: body.diff.previous ? namedSide(body.diff.previous) : null,
              // Name what the acknowledgement is about to send, from the tables
              // this page resolved: the server's echo only carries ids.
              next: namedSide(payload)
            });
            return;
          }
        }
        setError(typeof detail === "string" ? detail : messageOf(reason, "保存 Lark 目标失败"));
        return;
      }
      setError(messageOf(reason, "保存 Lark 目标失败"));
    } finally {
      setBusy(false);
    }
  }

  async function saveSelection() {
    if (!resolved || !executionTableId || !effectiveBugTableId) return;
    setError("");
    setNotice("");
    if (identityChanged()) {
      // Never re-point a group silently: the acknowledgement dialog comes first.
      setPendingChange({ payload: buildPayload(false), previous: sideOf(target), next: draftSide() });
      return;
    }
    await persist(buildPayload(false));
  }

  async function confirmChange() {
    if (!pendingChange) return;
    await persist({ ...pendingChange.payload, acknowledge_change: true });
  }

  async function approveWrites() {
    if (!target || !allowWrites) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const updated = await confirmTarget(groupId, target.target_fingerprint);
      setState((current) => (current ? { ...current, target: updated } : current));
      setNotice("已确认：本组新记录只会新增，旧记录与旧缺陷不会被修改");
    } catch (reason) {
      setError(messageOf(reason, "确认失败"));
    } finally {
      setBusy(false);
    }
  }

  async function queueSavedAttempts() {
    if (!enqueueSync) return;
    setQueueing(true);
    setError("");
    try {
      const result = await enqueueSync(groupId);
      // Reporting only the newly inserted rows is what made this button look
      // dead: rows already in the queue answered "已排入 0 条" while nothing
      // moved. Every count it moved is named now.
      const moved: string[] = [];
      if (result.queued > 0) moved.push(`已排入 ${result.queued} 条本地结果`);
      if (result.repointed > 0) {
        moved.push(`${result.repointed} 条任务已重新指向当前目标表`);
      }
      if (result.requeued > 0) moved.push(`已重新排队 ${result.requeued} 条失败结果`);
      setNotice(
        moved.length > 0
          ? `${moved.join("，")}，仅新增记录`
          : "没有需要排入的本地结果：这一组的本地结果都已经在队列里"
      );
      const refreshed = await loadSync?.(groupId);
      if (refreshed) setSync(refreshed);
    } catch (reason) {
      setError(messageOf(reason, "排入同步失败"));
    } finally {
      setQueueing(false);
    }
  }

  // Releasing an uncertain job can append a second remote record, so it stays a
  // separate command that says the administrator checked the old table.
  async function retryQueuedJobs(releaseUncertain: boolean) {
    if (!retrySync) return;
    setRetryingSync(true);
    setError("");
    try {
      const result = await retrySync(groupId, releaseUncertain);
      // Each count is a different decision, so only the ones that moved are
      // reported: a parked-only group has no failures to speak of.
      const moved: string[] = [];
      if (result.requeued > 0) moved.push(`已重新排队 ${result.requeued} 条失败结果`);
      if (result.released > 0) moved.push(`释放 ${result.released} 条待人工确认`);
      if ((result.repointed ?? 0) > 0) {
        moved.push(`${result.repointed} 条任务已重新指向当前目标表`);
      }
      setNotice(moved.join("，") || "没有需要重试的同步任务");
      const refreshed = await loadSync?.(groupId);
      if (refreshed) setSync(refreshed);
    } catch (reason) {
      setError(messageOf(reason, "重试同步失败"));
    } finally {
      setRetryingSync(false);
    }
  }

  return (
    <section className="workspace-section lark-check-layout" aria-labelledby="lark-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">LARK</p>
          <h2 id="lark-title">连接本组的 Lark 多维表格</h2>
        </div>
      </div>

      <label>
        测试组
        <select aria-label="测试组" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </label>

      <div className="lark-panel">
        <div className="lark-panel-heading">
          <h3>已保存的目标</h3>
          <button
            type="button"
            className="ghost-button"
            disabled={!groupId}
            onClick={() => void refreshTarget()}
          >
            <RefreshCw size={15} />
            刷新
          </button>
        </div>
        {target ? (
          <dl className="lark-facts">
            <div>
              <dt>多维表格</dt>
              <dd>{target.execution_base_name || "未读取"}</dd>
            </div>
            <div>
              <dt>执行记录表</dt>
              <dd>{target.execution_table_name || "未读取"}</dd>
            </div>
            <div>
              <dt>缺陷表</dt>
              <dd>{target.bug_table_name || "未读取"}</dd>
            </div>
          </dl>
        ) : (
          <p className="inline-status">该组还没有选择 Lark 表，请粘贴链接后读取。</p>
        )}
        {liveErrors.map((item) => (
          <p key={item} className="inline-status error" role="alert">
            {item}
          </p>
        ))}
      </div>

      <div className="lark-panel">
        <h3>从链接选择表</h3>
        <label>
          Lark 文档链接
          <input
            value={link}
            placeholder="https://…/wiki/… 或 /base/…"
            onChange={(event) => setLink(event.target.value)}
          />
        </label>
        <button type="button" className="ghost-button" disabled={reading || !link.trim()} onClick={() => void readExecutionLink()}>
          {reading ? <LoaderCircle className="spin" size={16} /> : null}
          读取表格
        </button>

        {resolved ? (
          <div className="lark-roles">
            <p className="inline-status saved" role="status">
              已读取「{resolved.base_name}」的 {resolved.tables.length} 张数据表
            </p>
            {(resolved.read_errors ?? []).map((item) => (
              <p key={item} className="inline-status error" role="alert">
                {item}
              </p>
            ))}
            <label>
              执行记录表
              <select
                aria-label="执行记录表"
                value={executionTableId}
                onChange={(event) => setExecutionTableId(event.target.value)}
              >
                {executionTables.map((table) => (
                  <option key={table.table_id} value={table.table_id}>
                    {table.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="lark-fields">
              执行表字段：
              {Object.entries(resolved.execution_fields).map(([name, type]) => (
                <span key={name} className="lark-field">
                  {name} · {type}
                </span>
              ))}
            </p>
            {resolved.schema_errors.map((item) => (
              <p key={item} className="inline-status error" role="alert">
                {item}
              </p>
            ))}
          </div>
        ) : null}

        <label>
          缺陷库链接（可选，默认与执行表同一多维表格）
          <input
            value={bugLink}
            placeholder="https://…/wiki/… 或 /base/…"
            onChange={(event) => setBugLink(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={readingBug || !bugLink.trim()}
          onClick={() => void readBugLink()}
        >
          {readingBug ? <LoaderCircle className="spin" size={16} /> : null}
          读取缺陷表
        </button>

        {bugLinkUnread ? (
          <p className="inline-status" role="status">
            这段缺陷库链接尚未读取：缺陷表暂时使用执行表所在的多维表格，请按「读取缺陷表」使用它。
          </p>
        ) : null}

        {(bugReadApplies ? bugResolved?.read_errors ?? [] : []).map((item) => (
          <p key={item} className="inline-status error" role="alert">
            {item}
          </p>
        ))}

        {bugTables.length > 0 ? (
          <label>
            缺陷记录表
            <select
              aria-label="缺陷记录表"
              value={effectiveBugTableId}
              onChange={(event) => setBugTableId(event.target.value)}
            >
              {bugTables.map((table) => (
                <option key={table.table_id} value={table.table_id}>
                  {table.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <button
          type="button"
          className="primary"
          disabled={!resolved || !executionTableId || !effectiveBugTableId || busy}
          onClick={() => void saveSelection()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : null}
          保存选择
        </button>

        {target && loadPlan && provision ? (
          <StepHeaders
            groupId={groupId}
            target={target}
            busy={busy}
            provision={provision}
            retype={retype}
            createTable={createTable}
            rebuild={rebuild}
            loadPlan={loadPlan}
            resetKey={`${groupId}|${target.target_fingerprint}`}
            targetFingerprint={target.target_fingerprint}
            schemaFingerprint={target.schema_fingerprint}
            bases={{ execution: executionBaseToken, bug: bugBaseToken }}
            tableNames={{
              execution: target.execution_table_name,
              bug: target.bug_table_name
            }}
            onChanged={reloadAfterProvision}
            // Task 6 把它接给 `useLarkDraft` 的「作废该 role 的 probe + 重校验」。
            // 本 task 只做最小替换，页面还没有 draft，所以这里是空实现：回调的
            // 契约由 StepHeaders.test.tsx 的三条用例钉住，接线归 Task 6。
            onRoleFixed={() => {}}
            onTableCreated={acceptCreatedTable}
            onTableRebuilt={acceptRebuiltTable}
          />
        ) : null}
      </div>

      <div className="lark-panel">
        <h3>写入确认</h3>
        {confirmed && !invalidated ? (
          <p className="inline-status saved" role="status">
            <ShieldCheck size={16} />
            已确认 {target?.execution_table_name} / {target?.bug_table_name}
          </p>
        ) : (
          <p className="inline-status" role="status">
            <ShieldOff size={16} />
            {invalidated
              ? "目标表字段已变化，此前的确认已失效，需要重新确认"
              : "尚未确认：本地结果不会写入 Lark"}
          </p>
        )}
        <label className="lark-consent">
          <input
            type="checkbox"
            checked={allowWrites}
            disabled={blocked}
            onChange={(event) => setAllowWrites(event.target.checked)}
          />
          允许向上述旧表新增本组记录
        </label>
        <button
          type="button"
          className="primary"
          disabled={!allowWrites || !confirmable || busy}
          onClick={() => void approveWrites()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
          确认本组写入目标
        </button>
        {confirmed || syncParked > 0 ? (
          <div className="lark-queue">
            <p className="inline-status">
              待同步 {sync?.queued ?? 0} · 已同步 {sync?.synced ?? 0} · 失败 {syncFailed} · 待人工确认 {sync?.uncertain ?? 0} · 待管理员处理 {syncParked}
              {sync?.last_error_kind ? ` · 最近错误 ${sync.last_error_kind}` : ""}
            </p>
            {/* The category alone is not actionable: this is what Lark actually
                answered, plus the remedy the API already worded. */}
            {sync?.last_error ? (
              <p className="inline-status error" role="alert">
                {sync.last_error}
              </p>
            ) : null}
            <div className="lark-queue-actions">
              {confirmed && enqueueSync ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={queueing || (sync?.pending_attempts ?? 0) === 0}
                  onClick={() => void queueSavedAttempts()}
                >
                  {queueing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
                  把已保存的本地结果排入同步
                </button>
              ) : null}
              {confirmed && retrySync && syncFailed > 0 ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={retryingSync}
                  onClick={() => void retryQueuedJobs(false)}
                >
                  {retryingSync ? <LoaderCircle className="spin" size={16} /> : null}
                  重试失败的同步（{syncFailed} 条）
                </button>
              ) : null}
              {retrySync && syncParked > 0 ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={retryingSync}
                  onClick={() => void retryQueuedJobs(false)}
                >
                  {retryingSync ? <LoaderCircle className="spin" size={16} /> : null}
                  重新指向当前目标表（{syncParked} 条）
                </button>
              ) : null}
              {confirmed && retrySync && (sync?.uncertain ?? 0) > 0 ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={retryingSync}
                  onClick={() => void retryQueuedJobs(true)}
                >
                  {retryingSync ? <LoaderCircle className="spin" size={16} /> : null}
                  已核对远端，释放待人工确认（{sync?.uncertain} 条）
                </button>
              ) : null}
            </div>
            {confirmed && (sync?.uncertain ?? 0) > 0 ? (
              <p className="attachment-hint">
                释放待人工确认前，请先在旧表搜索该复测标签：若远端其实已写入，释放后会再新增一条记录。
              </p>
            ) : null}
            {syncParked > 0 ? (
              <p className="attachment-hint">
                {syncParked} 条记录正在等待管理员处理，不会自行同步：只有管理员确认它们应写入当前目标表后才会继续。若目标表确实更换过，按「重新指向当前目标表」或「把已保存的本地结果排入同步」都会把它们重新指向当前目标表；若本组的写入确认已被撤销，需要先重新确认。
                {confirmed ? null : "本组目前尚未确认写入目标，这些记录不会同步。"}
              </p>
            ) : null}
            {confirmed ? (
              <p className="attachment-hint">同步只新增执行记录；不通过时会新增缺陷，旧记录与旧缺陷不会被修改。</p>
            ) : null}
          </div>
        ) : null}
        {notice ? <p className="inline-status saved" role="status">{notice}</p> : null}
        {error ? <p className="inline-status error" role="alert">{error}</p> : null}
      </div>

      {pendingChange ? (
        <TargetChangeDialog
          previous={pendingChange.previous}
          next={pendingChange.next}
          pendingAttempts={sync?.pending_attempts ?? null}
          busy={busy}
          onCancel={() => setPendingChange(null)}
          onConfirm={() => void confirmChange()}
        />
      ) : null}
    </section>
  );
}
