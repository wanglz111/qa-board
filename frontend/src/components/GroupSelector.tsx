import { FileStack } from "lucide-react";

import type { Group, GroupProgress } from "../api";

type Props = {
  groups: Group[];
  selectedId: string | null;
  progress: Record<string, GroupProgress>;
  onSelect: (groupId: string) => void;
};

function progressLabel(progress: GroupProgress | undefined, count: number) {
  if (!progress) return `${count} 条`;
  const done = progress.passed + progress.failed + progress.skipped;
  return `${done}/${count}`;
}

export function GroupSelector({ groups, selectedId, progress, onSelect }: Props) {
  if (groups.length === 0) {
    return <div className="empty-list"><FileStack size={24} /><span>暂无测试组</span></div>;
  }
  return (
    <div className="group-list" role="list">
      {groups.map((group) => {
        const stats = progress[group.id];
        return (
          <button
            type="button"
            role="listitem"
            key={group.id}
            className={group.id === selectedId ? "group-row active" : "group-row"}
            aria-pressed={group.id === selectedId}
            onClick={() => onSelect(group.id)}
          >
            <div>
              <strong>{group.name}</strong>
              <span>
                {group.source_name} · v{group.source_version} ·{" "}
                {progressLabel(stats, group.count)}
              </span>
            </div>
            {stats ? (
              <span className="progress-pips">
                <span className="pip passed">{stats.passed}</span>
                <span className="pip failed">{stats.failed}</span>
                <span className="pip skipped">{stats.skipped}</span>
              </span>
            ) : null}
            <span className="case-count">{group.count}</span>
          </button>
        );
      })}
    </div>
  );
}
