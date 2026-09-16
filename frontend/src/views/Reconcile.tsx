import { useEffect, useRef, useState } from "react";
import { AlertTriangle, GitCompare, LoaderCircle, RefreshCw } from "lucide-react";

import {
  type Group,
  type ReconcileDecision,
  type ReconcileDiff,
  type ReconcileRow
} from "../api";

type ApplyResult = { pulled: number; kept: number; skipped: { key: string; reason: string }[] };

// Both sides of a row carry the value a difference is judged on.
type SideRecord = { result: string | null; console_text: string | null } | null;

type Props = {
  groupId?: string;
  load: (groupId: string, source: "live" | "stored") => Promise<ReconcileDiff>;
  apply: (groupId: string, decisions: ReconcileDecision[]) => Promise<ApplyResult>;
  loadGroups?: () => Promise<Group[]>;
};

const STATUS_LABEL: Record<ReconcileRow["status"], string> = {
  same: "一致",
  local_only: "仅本地",
  remote_only: "仅表里",
  conflict: "冲突",
  unmatched: "未匹配"
};

// The diff names field keys; the page shows the header the administrator sees.
const FIELD_LABEL: Record<string, string> = { result: "结果", console_text: "控制台" };

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function badgeClass(result: string | null): string {
  if (result === "通过") return "result-badge result-pass";
  if (result === "不通过") return "result-badge result-fail";
  return "result-badge result-skip";
}

function SideValue({ value }: { value: SideRecord }) {
  if (!value) return <span className="reconcile-missing">无</span>;
  return (
    <div className="reconcile-value">
      <span className={badgeClass(value.result)}>{value.result ?? "未执行"}</span>
      {value.console_text ? <code className="reconcile-console">{value.console_text}</code> : null}
    </div>
  );
}

export function Reconcile({ groupId, load, apply, loadGroups }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState(groupId ?? "");
  const [source, setSource] = useState<"live" | "stored">("live");
  const [diff, setDiff] = useState<ReconcileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // The overlay claims modality, so focus has to move in: otherwise the page
  // behind it stays reachable while the dialog is up.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // The parent may own the initial group; a change there is a change of subject.
  useEffect(() => {
    if (groupId) setActiveGroupId(groupId);
  }, [groupId]);

  useEffect(() => {
    if (!loadGroups) return;
    let cancelled = false;
    loadGroups()
      .then((loaded) => {
        if (cancelled) return;
        setGroups(loaded);
        setActiveGroupId((current) =>
          current && loaded.some((group) => group.id === current) ? current : loaded[0]?.id ?? ""
        );
      })
      .catch((reason) => !cancelled && setError(messageOf(reason, "读取测试组失败")));
    return () => {
      cancelled = true;
    };
  }, [loadGroups]);

  useEffect(() => {
    if (!activeGroupId) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSelected([]);
    setConfirming(false);
    setResult(null);
    load(activeGroupId, source)
      .then((next) => !cancelled && setDiff(next))
      .catch((reason) => !cancelled && setError(messageOf(reason, "读取对账结果失败")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [activeGroupId, source, refreshKey, load]);

  const rows = diff?.rows ?? [];
  const counts = diff?.counts;
  // A row is unresolved until it carries a decision; only those get a checkbox.
  const unresolved = rows.filter((row) => row.status !== "same" && row.decision === null);
  const selectedRows = rows.filter((row) => selected.includes(row.key));
  const allSelected = unresolved.length > 0 && unresolved.every((row) => selected.includes(row.key));

  function toggleRow(key: string) {
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    );
  }

  function toggleAll() {
    setSelected(allSelected ? [] : unresolved.map((row) => row.key));
  }

  function decisionsFor(action: ReconcileDecision["action"]): ReconcileDecision[] {
    // Row order, so the payload reads like the table the administrator sees.
    return selectedRows.map((row) => ({ key: row.key, action }));
  }

  // The server answers with what it actually did, so the page only ever repeats
  // it: a skipped row stays a skip and never shows up as a change.
  async function run(decisions: ReconcileDecision[]) {
    if (!activeGroupId || decisions.length === 0) return;
    setBusy(true);
    setError("");
    setConfirming(false);
    try {
      const applied = await apply(activeGroupId, decisions);
      setResult(applied);
      setSelected([]);
      const refreshed = await load(activeGroupId, source).catch(() => null);
      if (refreshed) setDiff(refreshed);
    } catch (reason) {
      setError(messageOf(reason, "应用对账决定失败"));
    } finally {
      setBusy(false);
    }
  }

  // A group this page never listed is still selectable by id, so the box always
  // names the group whose rows are on screen.
  const options =
    groups.length > 0
      ? groups.map((group) => ({ id: group.id, name: group.name }))
      : activeGroupId
        ? [{ id: activeGroupId, name: activeGroupId }]
        : [];

  return (
    <section className="workspace-section reconcile-layout" aria-labelledby="reconcile-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RECONCILE</p>
          <h2 id="reconcile-title">对账</h2>
        </div>
      </div>

      <div className="lark-panel">
        <label>
          测试组
          <select
            aria-label="测试组"
            value={activeGroupId}
            onChange={(event) => setActiveGroupId(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <div className="reconcile-source" role="group" aria-label="读取方式">
          <button
            type="button"
            className={source === "live" ? "active" : ""}
            aria-pressed={source === "live"}
            onClick={() => setSource("live")}
          >
            当场读表
          </button>
          <button
            type="button"
            className={source === "stored" ? "active" : ""}
            aria-pressed={source === "stored"}
            onClick={() => setSource("stored")}
          >
            读本地快照
          </button>
        </div>
        <p className="attachment-hint">
          「当场读表」会向 Lark 读取当前执行表；「读本地快照」只读本机保存的记录，Lark
          连不上时也能对账。
        </p>
      </div>

      <div className="lark-panel">
        <div className="lark-panel-heading">
          <div>
            <h3>差异</h3>
            <p className="inline-status reconcile-source-name">
              {diff?.source_table_name ? (
                <>
                  来源：<strong>{diff.source_table_name}</strong>
                </>
              ) : (
                "尚未读取"
              )}
            </p>
          </div>
          <button
            type="button"
            className="ghost-button"
            disabled={!activeGroupId || loading}
            onClick={() => setRefreshKey((key) => key + 1)}
          >
            {loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
            重新读取
          </button>
        </div>

        {(diff?.read_errors ?? []).map((item) => (
          <p key={item} className="inline-status error" role="alert">
            {item}
          </p>
        ))}

        {counts ? (
          <p className="reconcile-counts">
            一致 {counts.same} · 仅本地 {counts.local_only} · 仅表里 {counts.remote_only} · 冲突{" "}
            {counts.conflict}
            {counts.unmatched > 0 ? ` · 未匹配 ${counts.unmatched}` : ""}
          </p>
        ) : null}

        {diff && rows.length === 0 ? (
          <div className="empty-list">
            <GitCompare size={24} />
            <span>本地与表内没有可对账的记录</span>
          </div>
        ) : rows.length > 0 ? (
          <div className="reconcile-table-wrap">
            <table className="reconcile-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="全选有差异的记录"
                      checked={allSelected}
                      ref={(node) => {
                        if (node) node.indeterminate = selected.length > 0 && !allSelected;
                      }}
                      disabled={unresolved.length === 0}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>
                    <span className="visually-hidden">选择</span>用例
                  </th>
                  <th>状态</th>
                  <th>本地记录</th>
                  <th>表内记录</th>
                  <th>差异字段</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={`reconcile-row ${row.status}`}>
                    <td>
                      {row.status !== "same" && row.decision === null ? (
                        <input
                          type="checkbox"
                          aria-label={`选择 ${row.key}`}
                          checked={selected.includes(row.key)}
                          onChange={() => toggleRow(row.key)}
                        />
                      ) : null}
                    </td>
                    <td>
                      <code>{row.case_code || row.key}</code>
                      {row.label !== row.case_code ? (
                        <span className="reconcile-label">{row.label}</span>
                      ) : null}
                    </td>
                    <td>
                      <span className={`reconcile-status ${row.status}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                      {row.decision ? <span className="reconcile-done">已核对</span> : null}
                    </td>
                    <td>
                      <SideValue value={row.local} />
                    </td>
                    <td>
                      <SideValue value={row.remote} />
                    </td>
                    <td>
                      {row.differing.map((field) => (
                        <span key={field} className="reconcile-diff-field">
                          {FIELD_LABEL[field] ?? field}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : loading ? (
          <p className="inline-status">
            <LoaderCircle className="spin" size={16} />
            正在读取对账结果
          </p>
        ) : null}
      </div>

      <div className="lark-panel">
        <h3>处理勾选的差异</h3>
        <div className="reconcile-actions">
          <button
            type="button"
            className="primary"
            disabled={selected.length === 0 || busy}
            onClick={() => setConfirming(true)}
          >
            采用表内记录（{selected.length}）
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={selected.length === 0 || busy}
            onClick={() => void run(decisionsFor("use_local"))}
          >
            保留本地记录（{selected.length}）
          </button>
        </div>
        <p className="attachment-hint">
          「保留本地记录」只记录这个决定：Lark
          表只接收新增记录，本地结果不会写回表。两种处理都不会改动本地原始记录和截图。
        </p>
        {source === "stored" ? (
          <p className="attachment-hint">
            「读本地快照」不联网；采用表内记录时服务器仍会当场读表，以表内当前值为准。
          </p>
        ) : null}
        {selectedRows.length > 0 ? (
          <p className="attachment-hint">已勾选：{selectedRows.map((row) => row.key).join("、")}</p>
        ) : null}

        {result ? (
          <div className="reconcile-result" role="status">
            <p className="inline-status saved">
              已拉回 {result.pulled} 条 · 保留 {result.kept} 条
            </p>
            {result.skipped.map((skip) => (
              <p key={`${skip.key}-${skip.reason}`} className="inline-status warning">
                {skip.key}：{skip.reason}
              </p>
            ))}
          </div>
        ) : null}
        {error ? (
          <p className="inline-status error" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {confirming ? (
        <div
          className="reconcile-overlay"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              setConfirming(false);
            }
          }}
        >
          <div
            className="reconcile-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reconcile-dialog-title"
          >
            <h3 id="reconcile-dialog-title">采用表内记录？</h3>
            <p>
              这会在本组新增一条记录（source=reconcile），本地原始记录和截图会原样保留，这条新记录不会写回
              Lark。
            </p>
            <ul className="reconcile-dialog-keys">
              {selectedRows.map((row) => (
                <li key={row.key}>{row.key}</li>
              ))}
            </ul>
            <p className="attachment-hint">
              采用后本组会多出一条来自表内的记录，原来的本地记录与截图仍然留在本地，不会被改写。
            </p>
            <div className="reconcile-dialog-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
              <button
                ref={confirmRef}
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void run(decisionsFor("use_remote"))}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <AlertTriangle size={16} />}
                确认采用
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
