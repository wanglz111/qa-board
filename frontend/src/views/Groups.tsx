import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FileStack,
  Images,
  LoaderCircle,
  RefreshCw
} from "lucide-react";

import type { Group, GroupCase } from "../api";

type Props = {
  loadGroups: (includeArchived?: boolean) => Promise<Group[]>;
  loadCases: (groupId: string) => Promise<GroupCase[]>;
  refreshKey: number;
  archive: (groupId: string) => Promise<Group>;
  restore: (groupId: string) => Promise<Group>;
};

export function GroupsView({ loadGroups, loadCases, refreshKey, archive, restore }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cases, setCases] = useState<GroupCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // The group the confirmation is about: retiring one is not a slip of a click.
  const [confirming, setConfirming] = useState<Group | null>(null);
  const caseRequest = useRef(0);

  useEffect(() => { void refresh(); }, [refreshKey, showArchived]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const result = await loadGroups(showArchived);
      setGroups(result);
      if (selected && !result.some((group) => group.id === selected)) setSelected(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally { setLoading(false); }
  }

  // Retiring (or bringing back) a group changes what the board shows, so the
  // list is re-read rather than patched: the server decides what is on it.
  async function act(change: (groupId: string) => Promise<Group>, groupId: string) {
    setBusy(true);
    setError("");
    try {
      await change(groupId);
      setConfirming(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally { setBusy(false); }
  }

  async function selectGroup(id: string) {
    const requestId = ++caseRequest.current;
    setSelected(id);
    setCases([]);
    try {
      const result = await loadCases(id);
      if (requestId === caseRequest.current) setCases(result);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载失败"); }
  }

  const active = groups.filter((group) => group.archived_at === null);
  const retired = groups.filter((group) => group.archived_at !== null);
  const activeGroup = groups.find((group) => group.id === selected);

  function row(group: Group) {
    return (
      <div className={`group-row-shell ${group.archived_at ? "archived" : ""}`} key={group.id}>
        <button
          className={group.id === selected ? "group-row active" : "group-row"}
          onClick={() => selectGroup(group.id)}
        >
          <div>
            <strong>{group.name}</strong>
            <span>
              {group.source_name} · v{group.source_version} ·{" "}
              {new Date(group.created_at).toLocaleDateString()}
            </span>
          </div>
          <span className="case-count">{group.count}</span><ChevronRight size={17} />
        </button>
        {group.archived_at ? (
          <button
            type="button"
            className="ghost-button group-row-action"
            aria-label={`恢复 ${group.name}`}
            disabled={busy}
            onClick={() => void act(restore, group.id)}
          >
            <ArchiveRestore size={15} />恢复
          </button>
        ) : (
          <button
            type="button"
            className="ghost-button group-row-action"
            aria-label={`归档 ${group.name}`}
            disabled={busy}
            onClick={() => setConfirming(group)}
          >
            <Archive size={15} />归档
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="workspace-section groups-layout" aria-labelledby="groups-title">
      <div className="group-index">
        <div className="section-heading">
          <div><p className="eyebrow">GROUPS</p><h2 id="groups-title">测试组</h2></div>
          <div className="group-list-actions">
            <button
              type="button"
              className="ghost-button"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((current) => !current)}
            >
              {showArchived ? "隐藏已归档" : "显示已归档"}
            </button>
            <button className="icon-button" title="刷新" aria-label="刷新测试组" onClick={refresh}><RefreshCw size={17} /></button>
          </div>
        </div>
        {loading ? <p className="inline-status"><LoaderCircle className="spin" size={16} />正在加载</p> : error ? <p className="inline-status error">{error}</p> : groups.length === 0 ? <div className="empty-list"><FileStack size={24} /><span>{showArchived ? "暂无测试组" : "板上没有测试组（已归档的组在「显示已归档」里）"}</span></div> : (
          <div className="group-list">
            {active.map(row)}
            {showArchived && retired.length > 0 ? (
              <>
                <p className="group-list-divider">已归档（{retired.length}）</p>
                {retired.map(row)}
              </>
            ) : null}
          </div>
        )}
      </div>
      <div className="case-index">
        <div className="case-index-heading"><div><p className="eyebrow">CASES</p><h3>{activeGroup?.name ?? "选择测试组"}</h3></div>{activeGroup && <span>{activeGroup.count} 条{activeGroup.archived_at ? " · 已归档" : ""}</span>}</div>
        {activeGroup ? <div className="case-table-wrap"><table><thead><tr><th>顺序</th><th>编号</th><th>标题</th><th>优先级</th><th>原型</th></tr></thead><tbody>{cases.map((testCase) => <tr key={testCase.id}><td>{testCase.position}</td><td><code>{testCase.code}</code></td><td>{testCase.title}</td><td>{testCase.priority ?? "-"}</td><td>{testCase.reference_assets.length > 0 ? <span className="case-asset-count"><Images size={14} />原型 {testCase.reference_assets.length} 张</span> : "-"}</td></tr>)}</tbody></table></div> : <div className="empty-list"><FileStack size={24} /><span>未选择测试组</span></div>}
      </div>

      {confirming ? (
        <div
          className="group-archive-overlay"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              setConfirming(null);
            }
          }}
        >
          <div
            className="group-archive-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-archive-title"
          >
            <h3 id="group-archive-title">归档这个测试组？</h3>
            <p>
              <strong>{confirming.name}</strong>会从执行、报告、对账和 Lark
              检查的测试组列表里消失，也不再往 Lark 写新记录。
            </p>
            <p>
              用例、执行记录、截图、报告和 Lark 目标都会原样保留，随时可以点「恢复」把它放回板上。
            </p>
            <p className="attachment-hint">
              归档不动 Lark：这个组以前写进表里的记录仍然在那张表里。重新编排用例后重新导入会生成一个新的测试组，上一轮的记录不会被覆盖——需要干净的表格时，请在 Lark 侧另行处理。
            </p>
            <div className="group-archive-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void act(archive, confirming.id)}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Archive size={16} />}
                确认归档
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
