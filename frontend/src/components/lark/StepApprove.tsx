import { LoaderCircle, ShieldCheck, ShieldOff } from "lucide-react";

import type { LarkTarget } from "../../api";

type StepApproveProps = {
  target: LarkTarget | null;
  confirmed: boolean;
  invalidated: boolean;
  blocked: boolean;
  allowWrites: boolean;
  busy: boolean;
  onAllowWrites: (value: boolean) => void;
  onConfirm: () => void;
};

export function StepApprove({
  target,
  confirmed,
  invalidated,
  blocked,
  allowWrites,
  busy,
  onAllowWrites,
  onConfirm
}: StepApproveProps) {
  // 「能不能确认」只由调用方算好的这两个事实决定：这一步不重算 live，也不看 draft。
  const confirmable = !blocked && !invalidated;
  return (
    <div className="lark-approve">
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
          disabled={!confirmable}
          onChange={(event) => onAllowWrites(event.target.checked)}
        />
        允许向上述旧表新增本组记录
      </label>
      <button
        type="button"
        className="primary"
        disabled={!allowWrites || !confirmable || busy}
        onClick={onConfirm}
      >
        {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
        确认本组写入目标
      </button>
    </div>
  );
}
