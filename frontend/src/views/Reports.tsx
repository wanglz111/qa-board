import { useEffect, useState } from "react";
import { Download, FileSpreadsheet, LoaderCircle } from "lucide-react";

import type { Group } from "../api";

type Props = {
  loadGroups: () => Promise<Group[]>;
  reportUrl: (groupId: string, format: "csv" | "xlsx") => string;
};

export function ReportsView({ loadGroups, reportUrl }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadGroups()
      .then((result) => {
        if (cancelled) return;
        setGroups(result);
        const first = result[0];
        if (first) setSelected(first.id);
      })
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "加载失败"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [loadGroups]);

  const activeGroup = groups.find((group) => group.id === selected);

  return (
    <section className="workspace-section reports-layout" aria-labelledby="reports-title">
      <div className="section-heading">
        <div><p className="eyebrow">REPORTS</p><h2 id="reports-title">导出报告</h2></div>
      </div>
      <div className="report-panel">
        {loading ? (
          <p className="inline-status"><LoaderCircle className="spin" size={16} />正在加载测试组</p>
        ) : error ? (
          <p className="inline-status error" role="alert">{error}</p>
        ) : groups.length === 0 ? (
          <div className="empty-list"><FileSpreadsheet size={24} /><span>暂无测试组可导出</span></div>
        ) : (
          <>
            <label>
              选择测试组
              <select
                aria-label="选择测试组"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}（{group.source_name} · v{group.source_version} · {group.count} 条）
                  </option>
                ))}
              </select>
            </label>
            <p className="report-summary">
              仅导出<strong>{activeGroup?.name}</strong>当前快照的 {activeGroup?.count} 条用例、最新结果与执行次数；
              截图不包含在内，也不会生成公开链接。
            </p>
            <div className="report-actions">
              <a className="primary" download href={reportUrl(selected, "csv")}>
                <Download size={16} />下载 CSV
              </a>
              <a className="ghost-button" download href={reportUrl(selected, "xlsx")}>
                <Download size={16} />下载 XLSX
              </a>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
