import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw, ShieldCheck, ShieldOff, Upload } from "lucide-react";

import {
  ApiError,
  type Group,
  type LarkResolved,
  type LarkTarget,
  type LarkTargetChangeDetail,
  type LarkTargetPayload,
  type LarkTargetState,
  type SyncStatus
} from "../api";
import { TargetChangeDialog, type TargetSide } from "../components/TargetChangeDialog";

type Props = {
  loadGroups: () => Promise<Group[]>;
  resolve: (url: string) => Promise<LarkResolved>;
  loadTarget: (groupId: string) => Promise<LarkTargetState>;
  saveTarget: (
    groupId: string,
    payload: LarkTargetPayload
  ) => Promise<{ target: LarkTarget; confirmation_cleared: boolean }>;
  confirmTarget: (groupId: string, targetFingerprint: string) => Promise<LarkTarget>;
  loadSync?: (groupId: string) => Promise<SyncStatus>;
  enqueueSync?: (groupId: string) => Promise<{ queued: number }>;
  retrySync?: (
    groupId: string,
    releaseUncertain?: boolean
  ) => Promise<{ requeued: number; released: number }>;
  initialGroupId?: string;
};

type PendingChange = {
  payload: LarkTargetPayload;
  previous: TargetSide | null;
  next: TargetSide;
};

type Table = { table_id: string; name: string };

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function nameOf(tables: Table[], tableId: string): string {
  return tables.find((table) => table.table_id === tableId)?.name ?? tableId;
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
  initialGroupId
}: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [state, setState] = useState<LarkTargetState | null>(null);
  const [link, setLink] = useState("");
  const [resolved, setResolved] = useState<LarkResolved | null>(null);
  const [bugLink, setBugLink] = useState("");
  const [bugResolved, setBugResolved] = useState<LarkResolved | null>(null);
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
    setExecutionTableId("");
    setBugTableId("");
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

  const executionTables = resolved?.tables ?? [];
  const bugBase = bugResolved ?? resolved;
  const bugTables = bugBase?.tables ?? [];
  const executionBaseToken = resolved?.base_token ?? "";
  const bugBaseToken = bugBase?.base_token ?? "";
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
      bug_table_name: nameOf(bugTables, bugTableId),
      bug_table_id: bugTableId
    };
  }

  function buildPayload(acknowledge: boolean): LarkTargetPayload {
    return {
      source_url: resolved?.source_url ?? target?.source_url ?? "",
      execution_base_token: executionBaseToken,
      execution_table_id: executionTableId,
      execution_view_id: executionViewId,
      bug_base_token: bugBaseToken,
      bug_table_id: bugTableId,
      expected_previous_fingerprint: target?.target_fingerprint ?? null,
      acknowledge_change: acknowledge
    };
  }

  function sideFromIdentity(identity: LarkTargetChangeDetail["diff"]["next"]): TargetSide {
    return {
      execution_table_name:
        target?.execution_table_id === identity.execution_table_id
          ? target.execution_table_name
          : identity.execution_table_id,
      execution_table_id: identity.execution_table_id,
      bug_table_name:
        target?.bug_table_id === identity.bug_table_id
          ? target.bug_table_name
          : identity.bug_table_id,
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
      setBugResolved(null);
      setExecutionTableId(selected);
      setBugTableId(suggestBugTable(result, selected, target));
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
      setBugTableId(suggestBugTable(result, executionTableId, target));
    } catch (reason) {
      setError(messageOf(reason, "读取缺陷表失败"));
    } finally {
      setReadingBug(false);
    }
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

  function identityChanged(): boolean {
    if (!target || !resolved) return false;
    return (
      target.execution_base_token !== executionBaseToken ||
      target.execution_table_id !== executionTableId ||
      target.bug_base_token !== bugBaseToken ||
      target.bug_table_id !== bugTableId
    );
  }

  async function persist(payload: LarkTargetPayload) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await saveTarget(groupId, payload);
      setPendingChange(null);
      setState((current) => (current ? { ...current, target: result.target } : current));
      setNotice(
        result.confirmation_cleared
          ? "目标表已更换：此前的写入确认已被清除，需要重新确认"
          : "已保存该组的 Lark 目标表"
      );
      const refreshed = await loadTarget(groupId).catch(() => null);
      if (refreshed) setState(refreshed);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        const detail = reason.detail;
        if (typeof detail === "object" && detail !== null) {
          const body = detail as LarkTargetChangeDetail;
          if (body.reason === "stale_page") {
            // Another tab moved the group after this page loaded, so the page's
            // fingerprint is not a basis for an acknowledgement: re-read instead.
            const refreshed = await loadTarget(groupId).catch(() => null);
            if (refreshed) setState(refreshed);
            setError("其他页面已改过该组的目标表，请刷新后重新选择");
            return;
          }
          if (isTargetChange(detail)) {
            // The server found a change the page had not seen yet: the same
            // acknowledgement dialog stands between the two.
            setPendingChange({
              payload,
              previous: body.diff.previous ? sideFromIdentity(body.diff.previous) : null,
              next: body.diff.next
                ? sideFromIdentity(body.diff.next)
                : draftSide()
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
    if (!resolved || !executionTableId || !bugTableId) return;
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
      setNotice(`已排入 ${result.queued} 条本地结果，仅新增记录`);
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
      setNotice(
        releaseUncertain
          ? `已重新排队 ${result.requeued} 条失败结果，释放 ${result.released} 条待人工确认`
          : `已重新排队 ${result.requeued} 条失败结果`
      );
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

        {bugTables.length > 0 ? (
          <label>
            缺陷记录表
            <select
              aria-label="缺陷记录表"
              value={bugTableId}
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
          disabled={!resolved || !executionTableId || !bugTableId || busy}
          onClick={() => void saveSelection()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : null}
          保存选择
        </button>
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
        {confirmed ? (
          <div className="lark-queue">
            <p className="inline-status">
              待同步 {sync?.queued ?? 0} · 已同步 {sync?.synced ?? 0} · 失败 {sync?.failed ?? 0} · 待人工确认 {sync?.uncertain ?? 0}
              {sync?.last_error_kind ? ` · 最近错误 ${sync.last_error_kind}` : ""}
            </p>
            {enqueueSync ? (
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
            {retrySync && (sync?.failed ?? 0) > 0 ? (
              <button
                type="button"
                className="ghost-button"
                disabled={retryingSync}
                onClick={() => void retryQueuedJobs(false)}
              >
                {retryingSync ? <LoaderCircle className="spin" size={16} /> : null}
                重试失败的同步（{sync?.failed} 条）
              </button>
            ) : null}
            {retrySync && (sync?.uncertain ?? 0) > 0 ? (
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
            {(sync?.uncertain ?? 0) > 0 ? (
              <p className="attachment-hint">
                释放待人工确认前，请先在旧表搜索该复测标签：若远端其实已写入，释放后会再新增一条记录。
              </p>
            ) : null}
            <p className="attachment-hint">同步只新增执行记录；不通过时会新增缺陷，旧记录与旧缺陷不会被修改。</p>
          </div>
        ) : null}
        {notice ? <p className="inline-status saved" role="status">{notice}</p> : null}
        {error ? <p className="inline-status error" role="alert">{error}</p> : null}
      </div>

      {pendingChange ? (
        <TargetChangeDialog
          previous={pendingChange.previous}
          next={pendingChange.next}
          pendingAttempts={sync?.pending_attempts ?? 0}
          busy={busy}
          onCancel={() => setPendingChange(null)}
          onConfirm={() => void confirmChange()}
        />
      ) : null}
    </section>
  );
}
