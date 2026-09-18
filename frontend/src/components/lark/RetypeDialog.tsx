import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LoaderCircle, Wrench } from "lucide-react";

import {
  type ProvisionPlan,
  type RetypeField,
  type RetypeFieldsPayload,
  type RetypeFieldsResult,
  type TableRole
} from "../../api";
import { ROLE_LABELS, messageOf } from "./StepHeaders";
import { refusalOf } from "./ProvisionDialog";

type RetypeDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  // 表头类型真的改了：该 role 的 probe 已作废，页面要重新校验它（B7）。
  onRoleFixed: (role: TableRole) => void;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  reloadPlan: () => void;
};

const ROLES: TableRole[] = ["execution", "bug"];

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

export function RetypeDialog({
  groupId,
  plan,
  open,
  onClose,
  onOpenRequest,
  onFinished,
  onChanged,
  onRoleFixed,
  retype,
  reloadPlan
}: RetypeDialogProps) {
  const [retypeTicked, setRetypeTicked] = useState<Record<TableRole, string[]>>({
    execution: [],
    bug: []
  });
  const [retypeNotice, setRetypeNotice] = useState("");
  const [retypeBusy, setRetypeBusy] = useState(false);
  const [error, setError] = useState("");
  const retypeRef = useRef<HTMLDivElement>(null);
  const retypeConfirmRef = useRef<HTMLButtonElement>(null);
  const wrongType: Record<TableRole, RetypeField[]> = {
    execution: plan?.retype?.execution ?? [],
    bug: plan?.retype?.bug ?? []
  };
  const wrongTypeTotal = wrongType.execution.length + wrongType.bug.length;
  // Same rule as the creation dialog: only a header still in the plan may be
  // sent, so a reload cannot leave a hidden name ticked.
  const retypeNames = (role: TableRole) =>
    wrongType[role]
      .filter((field) => retypeTicked[role].includes(field.name))
      .map((field) => field.name);
  const retypeTotal = ROLES.reduce((total, role) => total + retypeNames(role).length, 0);

  useEffect(() => {
    if (open) retypeConfirmRef.current?.focus();
  }, [open]);

  function openRetypeDialog() {
    setRetypeTicked({
      execution: wrongType.execution.map((field) => field.name),
      bug: wrongType.bug.map((field) => field.name)
    });
    setRetypeNotice("");
    setError("");
    onOpenRequest();
  }

  function closeRetypeDialog() {
    setRetypeNotice("");
    onClose();
  }

  function toggleRetype(role: TableRole, name: string) {
    setRetypeTicked((current) => ({
      ...current,
      [role]: current[role].includes(name)
        ? current[role].filter((item) => item !== name)
        : [...current[role], name]
    }));
  }

  function handleRetypeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!retypeBusy) closeRetypeDialog();
      return;
    }
    trapFocus(event, retypeRef.current);
  }

  async function runRetype() {
    if (!retype) return;
    const roles = ROLES.filter((role) => retypeNames(role).length > 0);
    if (roles.length === 0) return;
    setRetypeBusy(true);
    setError("");
    setRetypeNotice("");
    let retyped = 0;
    let failure = "";
    let convertedBeforeFailure = 0;
    // The roles whose headers this run really converted: their verdicts are
    // stale and only a re-check can lift a `bad` one (B7).
    const changedRoles: TableRole[] = [];
    try {
      for (const role of roles) {
        try {
          const result = await retype(groupId, {
            role,
            field_names: retypeNames(role),
            acknowledge: true
          });
          const converted = result.retyped_fields?.length ?? 0;
          retyped += converted;
          if (converted > 0) changedRoles.push(role);
        } catch (reason) {
          const refusal = refusalOf(reason, "修正表头类型失败");
          failure = refusal.message;
          // A refused run can still have converted the headers before it.
          convertedBeforeFailure = refusal.createdFields.length;
          retyped += convertedBeforeFailure;
          if (convertedBeforeFailure > 0) changedRoles.push(role);
          break;
        }
      }
      // The verdict is retired before the page re-reads the target.
      for (const role of changedRoles) onRoleFixed(role);
      // Only a run that really converted a column clears the write approval, so
      // the page is only asked to re-read the table then.
      if (retyped > 0) {
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the repair still happened.
        }
      }
      reloadPlan();
      if (failure) {
        setError(failure);
        if (convertedBeforeFailure > 0) {
          setRetypeNotice(`已修正 ${convertedBeforeFailure} 个表头，请重新确认写入`);
        }
      } else {
        closeRetypeDialog();
        onFinished(retyped > 0 ? `已修正 ${retyped} 个表头，请重新确认写入` : "没有需要修正的表头");
      }
    } finally {
      setRetypeBusy(false);
    }
  }

  if (!open) {
    return retype && wrongTypeTotal > 0 ? (
      <button type="button" className="ghost-button" onClick={openRetypeDialog}>
        <Wrench size={16} />
        修正表头类型
      </button>
    ) : null;
  }

  return (
    <div className="header-setup-overlay" onKeyDown={handleRetypeKeyDown}>
      <div
        ref={retypeRef}
        className="header-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-retype-title"
      >
        <h3 id="header-retype-title">修正表头类型</h3>
        <p className="inline-status">
          只会把下面勾选的表头改成正确的类型；表头里已有的数据不会被删除。
        </p>

        <ul className="header-setup-roles">
          {ROLES.filter((role) => wrongType[role].length > 0).map((role) => (
            <li className="header-setup-role" key={role}>
              <h4>{ROLE_LABELS[role]}</h4>
              <ul className="header-setup-fields">
                {wrongType[role].map((field) => (
                  <li className="header-setup-row" key={field.name}>
                    <input
                      type="checkbox"
                      checked={retypeTicked[role].includes(field.name)}
                      aria-label={`修正表头「${field.name}」`}
                      onChange={() => toggleRetype(role, field.name)}
                    />
                    <span className="header-setup-name">{field.name}</span>
                    <span className="header-setup-type">
                      {field.current_type_name} → {field.type_name}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {retypeNotice ? (
          <p className="inline-status saved" role="status">
            {retypeNotice}
          </p>
        ) : null}
        {error ? (
          <p className="inline-status error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="header-setup-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={retypeBusy}
            onClick={closeRetypeDialog}
          >
            取消
          </button>
          <button
            ref={retypeConfirmRef}
            type="button"
            className="primary"
            disabled={retypeBusy || retypeTotal === 0}
            onClick={() => void runRetype()}
          >
            {retypeBusy ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}
            修正这些表头
          </button>
        </div>
      </div>
    </div>
  );
}
