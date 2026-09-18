import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, Table2 } from "lucide-react";

import {
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type Table,
  type TableRole
} from "../../api";
import { ROLE_LABELS, messageOf, rebuiltNameOf } from "./StepHeaders";

type RebuildDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  tableNames: Record<TableRole, string>;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
  reloadPlan: () => void;
  targetFingerprint: string;
  schemaFingerprint: string | null;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
};

const ROLES: TableRole[] = ["execution", "bug"];
const REBUILD_LABELS: Record<TableRole, string> = {
  execution: "重建执行记录数据表",
  bug: "重建缺陷记录数据表"
};

function trapFocus(event: KeyboardEvent<HTMLDivElement>, container: HTMLDivElement | null) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    container?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ) ?? []
  );
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = container?.contains(active) ?? false;
  if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && (!inside || active === first)) {
    event.preventDefault();
    last.focus();
  }
}

export function RebuildDialog({
  groupId,
  plan,
  open,
  onClose,
  onOpenRequest,
  onFinished,
  onChanged,
  rebuild,
  tableNames,
  onTableRebuilt,
  reloadPlan,
  targetFingerprint,
  schemaFingerprint,
  loadPlan
}: RebuildDialogProps) {
  const [rebuildTicked, setRebuildTicked] = useState<Record<TableRole, boolean>>({
    execution: false,
    bug: false
  });
  const [rebuildNotice, setRebuildNotice] = useState("");
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildForce, setRebuildForce] = useState(false);
  const [error, setError] = useState("");
  const [freshPlan, setFreshPlan] = useState<ProvisionPlan | null>(null);
  const rebuildRef = useRef<HTMLDivElement>(null);
  const effectivePlan = freshPlan ?? plan;
  // The count is only on screen once the plan carries it, so the sentence that
  // points at the count is promised under the same condition.
  const rebuildCostNote = effectivePlan?.rebuild
    ? "，本组按当前规则重新写入的行数见下（从表里采纳的记录不会重写，本组目标确认前写入的记录也不会）"
    : "";

  useEffect(() => {
    // The primary command starts disabled (nothing is ticked), and a disabled
    // button cannot take focus — so the dialog itself takes it, which is also
    // what announces the replacement to a screen reader.
    if (open) rebuildRef.current?.focus();
  }, [open]);

  // The count this dialog asks the administrator to approve is the one the
  // rebuild will really write, and a result filed since the panel loaded has
  // already minted its job. Read the plan again when the dialog opens, under
  // the same guard as the load above: a late answer must not follow the panel
  // onto another group. A failed read neither holds the dialog shut nor drops
  // the plan already on screen.
  useEffect(() => {
    if (!open || !loadPlan) return;
    let cancelled = false;
    loadPlan(groupId)
      .then((loaded) => !cancelled && setFreshPlan(loaded))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, groupId, targetFingerprint, schemaFingerprint, loadPlan]);

  function openRebuildDialog() {
    // Nothing is ticked to begin with: this one replaces real tables, so it
    // asks for the choice rather than pre-selecting it.
    setRebuildTicked({ execution: false, bug: false });
    setRebuildForce(false);
    setRebuildNotice("");
    setError("");
    onOpenRequest();
  }

  function closeRebuildDialog() {
    setRebuildNotice("");
    onClose();
  }

  function handleRebuildKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!rebuildBusy) closeRebuildDialog();
      return;
    }
    trapFocus(event, rebuildRef.current);
  }

  async function runRebuild() {
    if (!rebuild) return;
    const roles = ROLES.filter((role) => rebuildTicked[role]);
    if (roles.length === 0) return;
    setRebuildBusy(true);
    setError("");
    setRebuildNotice("");
    const moved: { role: TableRole; table: Table; replaced: Table; requeued: number }[] = [];
    let failure = "";
    try {
      for (const role of roles) {
        try {
          const result = await rebuild(groupId, {
            role,
            acknowledge: true,
            force: rebuildForce
          });
          moved.push({
            role,
            table: result.table,
            replaced: result.replaced,
            requeued: result.requeued ?? 0
          });
          // The group now points at the rebuilt table, so this page has to
          // name it too: without this the selection would still offer the
          // table the server just walked away from.
          onTableRebuilt(role, result.table, result.replaced);
        } catch (reason) {
          failure = messageOf(reason, "重建数据表失败");
          break;
        }
      }
      if (moved.length > 0) {
        // The rebuilt destination dropped the write approval on the server.
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the rebuild did happen.
        }
      }
      reloadPlan();

      const copy = moved
        .map(
          (item) =>
            `已重建「${item.table.name}」，重新排入 ${item.requeued} 条「${ROLE_LABELS[item.role]}」记录`
        )
        .join("；");
      const cleanup = moved
        .map((item) => `旧表「${item.replaced.name}」不会自动删除，请确认后手动删除`)
        .join("；");
      if (failure) {
        setError(failure);
        if (moved.length > 0) setRebuildNotice(`${copy}；请重新确认写入`);
      } else {
        closeRebuildDialog();
        onFinished(moved.length > 0 ? `${copy}；${cleanup}；请重新确认写入` : "没有重建任何数据表");
      }
    } finally {
      setRebuildBusy(false);
    }
  }

  if (!open) {
    return rebuild ? (
      <button type="button" className="ghost-button" onClick={openRebuildDialog}>
        <Table2 size={16} />
        重建数据表（表头修正）
      </button>
    ) : null;
  }

  return (
    <div className="header-setup-overlay" onKeyDown={handleRebuildKeyDown}>
      <div
        ref={rebuildRef}
        className="header-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-rebuild-title"
        tabIndex={-1}
      >
        <h3 id="header-rebuild-title">重建数据表（表头修正）</h3>
        <p className="inline-status">
          新建一张表头顺序和类型都正确的新表（执行记录表为 用例 / 结果 / 优先级 /
          负责人 / 截图 / 控制台 / 报告人 / 日期，缺陷记录表为 问题描述 / 优先级 /
          进展状态 / 反馈时间 / 反馈人 / 跟进人 / 备注 / 截图），并把本组指向它。
          结果、优先级、进展状态是下拉框，截图和人员是对应类型的字段。
        </p>
        <p className="inline-status">
          {`表头顺序和主列无法在 Lark 里改，只能换一张表。旧表不会被删除${rebuildCostNote}；重建后需要重新确认写入。`}
        </p>

        <ul className="header-setup-roles">
          {ROLES.map((role) => (
            <li className="header-setup-role" key={role}>
              <h4>{ROLE_LABELS[role]}</h4>
              <ul className="header-setup-fields">
                <li className="header-setup-row">
                  <input
                    type="checkbox"
                    checked={rebuildTicked[role]}
                    aria-label={REBUILD_LABELS[role]}
                    onChange={() =>
                      setRebuildTicked((current) => ({ ...current, [role]: !current[role] }))
                    }
                  />
                  <span className="header-setup-name">
                    {tableNames?.[role] || ROLE_LABELS[role]}
                  </span>
                  <span className="header-setup-type">
                    → {rebuiltNameOf(tableNames?.[role] ?? "")}
                    {effectivePlan?.rebuild
                      ? effectivePlan.rebuild[role] > 0
                        ? `，将重新写入 ${effectivePlan.rebuild[role]} 条记录`
                        : "，这一类没有会被重写的记录"
                      : ""}
                  </span>
                </li>
              </ul>
            </li>
          ))}
        </ul>

        {rebuildNotice ? (
          <p className="inline-status saved" role="status">
            {rebuildNotice}
          </p>
        ) : null}
        {error ? (
          <p className="inline-status error" role="alert">
            {error}
          </p>
        ) : null}

        <label className="header-setup-force">
          <input
            type="checkbox"
            checked={rebuildForce}
            aria-label="强制重建"
            onChange={(event) => setRebuildForce(event.target.checked)}
          />
          <span>
            <strong>强制重建</strong>
            （表头已经正确时也重建：会再建一张新表，并把上面列出的记录重新写入）
          </span>
        </label>

        <div className="header-setup-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={rebuildBusy}
            onClick={closeRebuildDialog}
          >
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={rebuildBusy || !ROLES.some((role) => rebuildTicked[role])}
            onClick={() => void runRebuild()}
          >
            {rebuildBusy ? <LoaderCircle className="spin" size={16} /> : <Table2 size={16} />}
            重建勾选的数据表
          </button>
        </div>
      </div>
    </div>
  );
}
