import { AlertTriangle, LoaderCircle } from "lucide-react";

export type TargetSide = {
  execution_table_name: string;
  execution_table_id: string;
  bug_table_name: string;
  bug_table_id: string;
};

type Props = {
  previous: TargetSide | null;
  next: TargetSide;
  pendingAttempts: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

type Part = {
  key: string;
  label: string;
  changed: boolean;
  previousName: string;
  previousId: string;
  nextName: string;
  nextId: string;
};

const UNSET = "未选择";

// The overlay is mounted only while the change is pending, and it is a plain
// div rather than a <dialog>, because jsdom does not implement showModal.
export function TargetChangeDialog({
  previous,
  next,
  pendingAttempts,
  busy,
  onCancel,
  onConfirm
}: Props) {
  const parts: Part[] = [
    {
      key: "execution",
      label: "执行记录表",
      previousName: previous?.execution_table_name ?? UNSET,
      previousId: previous?.execution_table_id ?? UNSET,
      nextName: next.execution_table_name,
      nextId: next.execution_table_id,
      changed:
        previous === null ||
        previous.execution_table_id !== next.execution_table_id ||
        previous.execution_table_name !== next.execution_table_name
    },
    {
      key: "bug",
      label: "缺陷记录表",
      previousName: previous?.bug_table_name ?? UNSET,
      previousId: previous?.bug_table_id ?? UNSET,
      nextName: next.bug_table_name,
      nextId: next.bug_table_id,
      changed:
        previous === null ||
        previous.bug_table_id !== next.bug_table_id ||
        previous.bug_table_name !== next.bug_table_name
    }
  ].filter((part) => part.changed);

  return (
    <div className="dialog-overlay">
      <div
        className="target-change-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="target-change-title"
      >
        <h3 id="target-change-title">切换本组的 Lark 目标表？</h3>

        <ul className="target-change-parts">
          {parts.map((part) => (
            <li key={part.key}>
              <strong>{part.label}</strong>
              <span className="target-change-pair">
                {part.previousName} → {part.nextName}
              </span>
              <code>
                {part.previousId} → {part.nextId}
              </code>
            </li>
          ))}
        </ul>

        <p>确认切换后：</p>
        <ul className="target-change-consequences">
          <li>已排队的同步任务会停下，直到管理员把它们重新指向新表。</li>
          <li>本组的写入确认会被清除，需要重新确认后才能写入。</li>
          <li>
            本组 {pendingAttempts} 条已保存的本地记录，只有管理员重新排队后才会进入新表。
          </li>
        </ul>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <AlertTriangle size={16} />}
            确认切换
          </button>
        </div>
      </div>
    </div>
  );
}
