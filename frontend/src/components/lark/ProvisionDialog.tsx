import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ListPlus, LoaderCircle } from "lucide-react";

import {
  ApiError,
  type ProvisionFailureDetail,
  type ProvisionField,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type TableRole
} from "../../api";
import { ROLE_LABELS, messageOf } from "./StepHeaders";

type ProvisionDialogProps = {
  groupId: string;
  plan: ProvisionPlan | null;
  open: boolean;
  onClose: () => void;
  onOpenRequest: () => void;
  onFinished: (notice: string) => void;
  onChanged: () => Promise<void>;
  // 表头真的建出来了：该 role 的 probe 已作废，页面要重新校验它（B7）。
  onRoleFixed: (role: TableRole) => void;
  provision: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  reloadPlan: () => void;
};

const ROLES: TableRole[] = ["execution", "bug"];

// A refused run is the one 409 whose detail is an object; every other refusal
// is a plain string the Error already carries.
export function refusalOf(
  reason: unknown,
  fallback: string
): { message: string; createdFields: string[] } {
  if (reason instanceof ApiError && typeof reason.detail === "object" && reason.detail !== null) {
    const detail = reason.detail as Partial<ProvisionFailureDetail>;
    if (detail.reason === "provision_failed") {
      return {
        message: typeof detail.message === "string" && detail.message ? detail.message : fallback,
        createdFields: Array.isArray(detail.created_fields) ? detail.created_fields : []
      };
    }
  }
  return { message: messageOf(reason, fallback), createdFields: [] };
}

function createdCopy(created: number, viewCreated: boolean): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`已创建 ${created} 个表头`);
  if (viewCreated) parts.push("已创建 TestDeck 视图");
  return parts.join("，");
}

// One dialog's focus trap. Every focusable control counts: trapping only the
// buttons left the header checkboxes unreachable and let Shift+Tab out to the
// page behind.
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

export function ProvisionDialog({
  groupId,
  plan,
  open,
  onClose,
  onOpenRequest,
  onFinished,
  onChanged,
  onRoleFixed,
  provision,
  reloadPlan
}: ProvisionDialogProps) {
  const [ticked, setTicked] = useState<Record<TableRole, string[]>>({ execution: [], bug: [] });
  const [createView, setCreateView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runNotice, setRunNotice] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const missing: Record<TableRole, ProvisionField[]> = {
    execution: plan?.roles?.execution ?? [],
    bug: plan?.roles?.bug ?? []
  };
  const missingTotal = missing.execution.length + missing.bug.length;
  const viewExists = (role: TableRole) => plan?.views?.[role]?.exists === true;
  const provisionedRoles = ROLES.filter((role) => missing[role].length > 0);
  const viewMissing = provisionedRoles.some((role) => !viewExists(role));
  // Only a header the administrator can still see may be sent: a reload can
  // drop a ticked name from the plan, and a hidden tick must not create it.
  const tickedNames = (role: TableRole) =>
    missing[role].filter((field) => ticked[role].includes(field.name)).map((field) => field.name);
  const tickedTotal = ROLES.reduce((total, role) => total + tickedNames(role).length, 0);

  // The overlay is mounted only while the confirmation is pending; the
  // overlay claims modality, so focus has to move in.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  function openDialog() {
    setTicked({
      execution: missing.execution.map((field) => field.name),
      bug: missing.bug.map((field) => field.name)
    });
    setRunNotice("");
    setCreateView(false);
    setError("");
    onOpenRequest();
  }

  function closeDialog() {
    setRunNotice("");
    setCreateView(false);
    onClose();
  }

  function toggle(role: TableRole, name: string) {
    setTicked((current) => ({
      ...current,
      [role]: current[role].includes(name)
        ? current[role].filter((item) => item !== name)
        : [...current[role], name]
    }));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) closeDialog();
      return;
    }
    trapFocus(event, dialogRef.current);
  }

  async function createTicked() {
    const roles = ROLES.filter((role) => tickedNames(role).length > 0);
    if (roles.length === 0) return;
    setBusy(true);
    setError("");
    setRunNotice("");
    let created = 0;
    let viewCreated = false;
    let failure = "";
    // The roles this run really changed. Their probes are stale from that
    // moment on, and only a re-check can lift a `bad` verdict — the page's own
    // "校验" button is offered for `unread` alone (B7).
    const changedRoles: TableRole[] = [];
    try {
      for (const role of roles) {
        try {
          const result = await provision(groupId, {
            role,
            field_names: tickedNames(role),
            // Never ask for a view the table already carries.
            create_view: createView && !viewExists(role),
            acknowledge: true
          });
          const changed = (result.created_fields?.length ?? 0) > 0 || result.view?.created === true;
          created += result.created_fields?.length ?? 0;
          if (result.view?.created) viewCreated = true;
          if (changed) changedRoles.push(role);
        } catch (reason) {
          const refusal = refusalOf(reason, "创建表头失败");
          failure = refusal.message;
          // The backend creates the fields before the view, so a refusal can
          // still have changed the table it refuses to finish. The count is
          // this run's own, not the running total: an earlier role's fields
          // must not make this role look edited.
          created += refusal.createdFields.length;
          if (refusal.createdFields.length > 0) changedRoles.push(role);
          break;
        }
      }
      // The verdict is retired before the page re-reads the target: the probe
      // belongs to the table this run just edited, not to the one on screen.
      for (const role of changedRoles) onRoleFixed(role);
      // Only a run that really changed the table clears the write approval, so
      // the page is only asked to re-read it then.
      if (created > 0 || viewCreated) {
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the write still happened.
        }
      }
      // The plan is re-read after every attempt, refusals included: a run can
      // have created fields while the panel still lists them as missing.
      reloadPlan();
      if (failure) {
        setError(failure);
        // The count stays inside the dialog, next to the refusal it belongs to.
        if (created > 0) setRunNotice(`${createdCopy(created, viewCreated)}，请重新确认写入`);
      } else {
        closeDialog();
        onFinished(
          created > 0 || viewCreated
            ? `${createdCopy(created, viewCreated)}，请重新确认写入`
            : "没有缺少的表头，写入确认保持不变"
        );
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return missingTotal > 0 ? (
      <button type="button" className="primary" onClick={openDialog}>
        <ListPlus size={16} />
        设置表头
      </button>
    ) : null;
  }

  return (
    <div className="header-setup-overlay" onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        className="header-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="header-setup-title"
      >
        <h3 id="header-setup-title">设置表头</h3>
        <p className="inline-status">
          只会创建下面勾选的表头；表中已有的字段不会被修改。
        </p>

        <ul className="header-setup-roles">
          {ROLES.filter((role) => missing[role].length > 0).map((role) => (
            <li className="header-setup-role" key={role}>
              <h4>{ROLE_LABELS[role]}</h4>
              <ul className="header-setup-fields">
                {missing[role].map((field) => (
                  <li className="header-setup-row" key={field.name}>
                    <input
                      type="checkbox"
                      checked={ticked[role].includes(field.name)}
                      aria-label={`创建表头「${field.name}」`}
                      onChange={() => toggle(role, field.name)}
                    />
                    <span className="header-setup-name">{field.name}</span>
                    <span className="header-setup-type">{field.type_name}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        {viewMissing ? (
          <label className="header-setup-view">
            <input
              type="checkbox"
              checked={createView}
              onChange={(event) => setCreateView(event.target.checked)}
            />
            同时创建 TestDeck 视图
          </label>
        ) : (
          <p className="inline-status">TestDeck 视图已存在，不会被重复创建。</p>
        )}

        {runNotice ? (
          <p className="inline-status saved" role="status">
            {runNotice}
          </p>
        ) : null}
        {error ? (
          <p className="inline-status error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="header-setup-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={closeDialog}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="primary"
            disabled={busy || tickedTotal === 0}
            onClick={() => void createTicked()}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <ListPlus size={16} />}
            创建这些表头
          </button>
        </div>
      </div>
    </div>
  );
}
