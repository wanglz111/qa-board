import { useEffect, useRef, useState } from "react";
import { ChevronRight, FileStack, Images, LoaderCircle, RefreshCw } from "lucide-react";

import type { Group, GroupCase } from "../api";

type Props = {
  loadGroups: () => Promise<Group[]>;
  loadCases: (groupId: string) => Promise<GroupCase[]>;
  refreshKey: number;
};

export function GroupsView({ loadGroups, loadCases, refreshKey }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cases, setCases] = useState<GroupCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const caseRequest = useRef(0);

  useEffect(() => { void refresh(); }, [refreshKey]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const result = await loadGroups();
      setGroups(result);
      if (selected && !result.some((group) => group.id === selected)) setSelected(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally { setLoading(false); }
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

  const activeGroup = groups.find((group) => group.id === selected);
  return (
    <section className="workspace-section groups-layout" aria-labelledby="groups-title">
      <div className="group-index">
        <div className="section-heading">
          <div><p className="eyebrow">GROUPS</p><h2 id="groups-title">测试组</h2></div>
          <button className="icon-button" title="刷新" aria-label="刷新测试组" onClick={refresh}><RefreshCw size={17} /></button>
        </div>
        {loading ? <p className="inline-status"><LoaderCircle className="spin" size={16} />正在加载</p> : error ? <p className="inline-status error">{error}</p> : groups.length === 0 ? <div className="empty-list"><FileStack size={24} /><span>暂无测试组</span></div> : (
          <div className="group-list">{groups.map((group) => (
            <button className={group.id === selected ? "group-row active" : "group-row"} key={group.id} onClick={() => selectGroup(group.id)}>
              <div><strong>{group.name}</strong><span>{group.source_name} · v{group.source_version} · {new Date(group.created_at).toLocaleDateString()}</span></div>
              <span className="case-count">{group.count}</span><ChevronRight size={17} />
            </button>
          ))}</div>
        )}
      </div>
      <div className="case-index">
        <div className="case-index-heading"><div><p className="eyebrow">CASES</p><h3>{activeGroup?.name ?? "选择测试组"}</h3></div>{activeGroup && <span>{activeGroup.count} 条</span>}</div>
        {activeGroup ? <div className="case-table-wrap"><table><thead><tr><th>顺序</th><th>编号</th><th>标题</th><th>优先级</th><th>原型</th></tr></thead><tbody>{cases.map((testCase) => <tr key={testCase.id}><td>{testCase.position}</td><td><code>{testCase.code}</code></td><td>{testCase.title}</td><td>{testCase.priority ?? "-"}</td><td>{testCase.reference_assets.length > 0 ? <span className="case-asset-count"><Images size={14} />原型 {testCase.reference_assets.length} 张</span> : "-"}</td></tr>)}</tbody></table></div> : <div className="empty-list"><FileStack size={24} /><span>未选择测试组</span></div>}
      </div>
    </section>
  );
}
