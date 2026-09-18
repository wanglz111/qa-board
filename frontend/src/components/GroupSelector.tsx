import { Fragment, type ReactNode } from "react";
import { FileStack } from "lucide-react";

import type { Group, GroupProgress } from "../api";

type Props = {
  groups: Group[];
  selectedId: string | null;
  progress: Record<string, GroupProgress>;
  onSelect: (groupId: string) => void;
  // The selected group's own detail, rendered as the row's next sibling. A
  // detail parked after the whole list has to be read back up the page to find
  // out which row it counts — the group it belongs to is the point of it.
  selectedDetail?: ReactNode;
};

function progressLabel(progress: GroupProgress | undefined, count: number) {
  if (!progress) return `${count} 条`;
  const done = progress.passed + progress.failed + progress.skipped;
  return `${done}/${count}`;
}

export function GroupSelector({ groups, selectedId, progress, onSelect, selectedDetail }: Props) {
  if (groups.length === 0) {
    return <div className="empty-list"><FileStack size={24} /><span>暂无测试组</span></div>;
  }
  return (
    <div className="group-list" role="list">
      {groups.map((group) => {
        const stats = progress[group.id];
        const active = group.id === selectedId;
        return (
          // The fragment is not a DOM node, so the row stays the list's own
          // child: `role="list"` here still sees nothing but listitems.
          <Fragment key={group.id}>
            <button
              type="button"
              role="listitem"
              className={active ? "group-row active" : "group-row"}
              aria-pressed={active}
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
            {/* Only the selected row carries a detail, so it can never be
                mistaken for a neighbour's: an expanded panel left behind under
                the previous row would outlive its own selection. */}
            {active && selectedDetail ? (
              <div className="group-row-detail" role="listitem">{selectedDetail}</div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
