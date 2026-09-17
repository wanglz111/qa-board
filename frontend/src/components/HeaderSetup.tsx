import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ListPlus, LoaderCircle, Table2, Wrench } from "lucide-react";

import {
  ApiError,
  type CreateTablePayload,
  type CreateTableResult,
  type ProvisionFailureDetail,
  type ProvisionField,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type RetypeField,
  type RetypeFieldsPayload,
  type RetypeFieldsResult,
  type Table,
  type TableRole
} from "../api";

type Props = {
  groupId: string;
  loadPlan: (groupId: string) => Promise<ProvisionPlan>;
  provision: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  // Converts a header that already exists with a type the writer cannot fill.
  // Absent means the page cannot repair a table, so the offer stays hidden.
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  onChanged: () => void | Promise<void>;
  // The table the plan describes. Re-pointing the group changes the identity
  // without re-mounting this component, so the list has to be read again.
  targetFingerprint?: string;
  schemaFingerprint?: string | null;
  // A new table is only offered when the page can also name the base to build
  // it in; without a base the button stays out of the way.
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  // Rebuilds one role's table in the reference layout. Kept apart from the
  // provisioning calls because it does not repair the table in place: it
  // creates a new one, moves the group onto it and re-files its rows.
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  onTableRebuilt?: (role: TableRole, table: Table, replaced: Table) => void;
  bases?: Record<TableRole, string>;
  // The stored table of each role, so the rebuild dialog can name what it
  // replaces instead of talking about 「这张表」.
  tableNames?: Record<TableRole, string>;
  onTableCreated?: (role: TableRole, table: Table) => void;
};

const ROLES: TableRole[] = ["execution", "bug"];
const ROLE_LABELS: Record<TableRole, string> = {
  execution: "执行记录表",
  bug: "缺陷记录表"
};
const DEFAULT_TABLE_NAME: Record<TableRole, string> = {
  execution: "执行记录",
  bug: "缺陷记录"
};
// These labels must not read as "执行记录表"/"缺陷记录表": that is already the
// name of the role's table picker, and a second control answering to it would
// make the page's own labels ambiguous.
const TABLE_NAME_LABELS: Record<TableRole, string> = {
  execution: "新表名称（执行记录）",
  bug: "新表名称（缺陷记录）"
};
const CREATE_TABLE_LABELS: Record<TableRole, string> = {
  execution: "新建执行记录数据表",
  bug: "新建缺陷记录数据表"
};
const REBUILD_LABELS: Record<TableRole, string> = {
  execution: "重建执行记录数据表",
  bug: "重建缺陷记录数据表"
};

// What a rebuilt table is called beside the one it replaces. It mirrors the
// server's own suffix: the dialog names the table the administrator will find
// in Lark, not a description of it.
const REBUILD_SUFFIX = "（表头修正）";

function rebuiltNameOf(name: string): string {
  return `${name || "数据表"}${REBUILD_SUFFIX}`;
}

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

// A refused run is the one 409 whose detail is an object; every other refusal
// is a plain string the Error already carries.
function refusalOf(
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

// The overlay is mounted only while the confirmation is pending, and it is a
// plain div rather than a <dialog>, because jsdom does not implement showModal.
export function HeaderSetup({
  groupId,
  loadPlan,
  provision,
  retype,
  rebuild,
  onTableRebuilt,
  onChanged,
  targetFingerprint,
  schemaFingerprint,
  createTable,
  bases,
  tableNames,
  onTableCreated
}: Props) {
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [runNotice, setRunNotice] = useState("");
  const [ticked, setTicked] = useState<Record<TableRole, string[]>>({
    execution: [],
    bug: []
  });
  const [createView, setCreateView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retypeOpen, setRetypeOpen] = useState(false);
  const [retypeNotice, setRetypeNotice] = useState("");
  const [retypeTicked, setRetypeTicked] = useState<Record<TableRole, string[]>>({
    execution: [],
    bug: []
  });
  const [retypeBusy, setRetypeBusy] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildNotice, setRebuildNotice] = useState("");
  const [rebuildTicked, setRebuildTicked] = useState<Record<TableRole, boolean>>({
    execution: false,
    bug: false
  });
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [names, setNames] = useState<Record<TableRole, string>>(DEFAULT_TABLE_NAME);
  const [tableBusy, setTableBusy] = useState<TableRole | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const retypeRef = useRef<HTMLDivElement>(null);
  const retypeConfirmRef = useRef<HTMLButtonElement>(null);
  const rebuildRef = useRef<HTMLDivElement>(null);
  const rebuildConfirmRef = useRef<HTMLButtonElement>(null);
  const executionBase = bases?.execution ?? "";
  const bugBase = bases?.bug ?? "";
  const baseOf = (role: TableRole) => (role === "execution" ? executionBase : bugBase);

  // The header names another group now: no message and no dialog may linger
  // under it. A re-pointed target keeps its message, because the message is
  // about the run the administrator just approved, not about the newer table.
  useEffect(() => {
    setNotice("");
    setRunNotice("");
    setRetypeNotice("");
    setRebuildNotice("");
    setError("");
    setOpen(false);
    setRetypeOpen(false);
    setRebuildOpen(false);
    setCreateView(false);
  }, [groupId]);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setLoadError("");
    loadPlan(groupId)
      .then((loaded) => !cancelled && setPlan(loaded))
      .catch((reason) => !cancelled && setLoadError(messageOf(reason, "读取缺失表头失败")));
    return () => {
      cancelled = true;
    };
  }, [groupId, targetFingerprint, schemaFingerprint, loadPlan]);

  // The overlay claims modality, so focus has to move in.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (retypeOpen) retypeConfirmRef.current?.focus();
  }, [retypeOpen]);

  useEffect(() => {
    // The primary command starts disabled (nothing is ticked), and a disabled
    // button cannot take focus — so the dialog itself takes it, which is also
    // what announces the replacement to a screen reader.
    if (rebuildOpen) rebuildRef.current?.focus();
  }, [rebuildOpen]);

  // A message about a table created in one base must not survive that base
  // moving to another one.
  useEffect(() => {
    setNotice("");
  }, [executionBase, bugBase]);

  const missing: Record<TableRole, ProvisionField[]> = {
    execution: plan?.roles?.execution ?? [],
    bug: plan?.roles?.bug ?? []
  };
  const missingTotal = missing.execution.length + missing.bug.length;
  const wrongType: Record<TableRole, RetypeField[]> = {
    execution: plan?.retype?.execution ?? [],
    bug: plan?.retype?.bug ?? []
  };
  const wrongTypeTotal = wrongType.execution.length + wrongType.bug.length;
  const viewExists = (role: TableRole) => plan?.views?.[role]?.exists === true;
  const provisionedRoles = ROLES.filter((role) => missing[role].length > 0);
  const viewMissing = provisionedRoles.some((role) => !viewExists(role));
  // Only a header the administrator can still see may be sent: a reload can
  // drop a ticked name from the plan, and a hidden tick must not create it.
  const tickedNames = (role: TableRole) =>
    missing[role].filter((field) => ticked[role].includes(field.name)).map((field) => field.name);
  const tickedTotal = ROLES.reduce((total, role) => total + tickedNames(role).length, 0);
  // Same rule as the creation dialog: only a header still in the plan may be
  // sent, so a reload cannot leave a hidden name ticked.
  const retypeNames = (role: TableRole) =>
    wrongType[role]
      .filter((field) => retypeTicked[role].includes(field.name))
      .map((field) => field.name);
  const retypeTotal = ROLES.reduce((total, role) => total + retypeNames(role).length, 0);

  function openDialog() {
    setTicked({
      execution: missing.execution.map((field) => field.name),
      bug: missing.bug.map((field) => field.name)
    });
    setRunNotice("");
    setCreateView(false);
    setError("");
    setOpen(true);
  }

  function closeDialog() {
    setOpen(false);
    setRunNotice("");
    setCreateView(false);
  }

  function openRetypeDialog() {
    setRetypeTicked({
      execution: wrongType.execution.map((field) => field.name),
      bug: wrongType.bug.map((field) => field.name)
    });
    setRetypeNotice("");
    setError("");
    setRetypeOpen(true);
  }

  function closeRetypeDialog() {
    setRetypeOpen(false);
    setRetypeNotice("");
  }

  function openRebuildDialog() {
    // Nothing is ticked to begin with: this one replaces real tables, so it
    // asks for the choice rather than pre-selecting it.
    setRebuildTicked({ execution: false, bug: false });
    setRebuildNotice("");
    setError("");
    setRebuildOpen(true);
  }

  function closeRebuildDialog() {
    setRebuildOpen(false);
    setRebuildNotice("");
  }

  function toggleRetype(role: TableRole, name: string) {
    setRetypeTicked((current) => ({
      ...current,
      [role]: current[role].includes(name)
        ? current[role].filter((item) => item !== name)
        : [...current[role], name]
    }));
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

  function handleRetypeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!retypeBusy) closeRetypeDialog();
      return;
    }
    trapFocus(event, retypeRef.current);
  }

  function handleRebuildKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!rebuildBusy) closeRebuildDialog();
      return;
    }
    trapFocus(event, rebuildRef.current);
  }

  async function createTicked() {
    const roles = ROLES.filter((role) => tickedNames(role).length > 0);
    if (roles.length === 0) return;
    setBusy(true);
    setError("");
    setRunNotice("");
    setNotice("");
    let created = 0;
    let viewCreated = false;
    let failure = "";
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
          created += result.created_fields?.length ?? 0;
          if (result.view?.created) viewCreated = true;
        } catch (reason) {
          const refusal = refusalOf(reason, "创建表头失败");
          failure = refusal.message;
          // The backend creates the fields before the view, so a refusal can
          // still have changed the table it refuses to finish.
          created += refusal.createdFields.length;
          break;
        }
      }
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
      const reloaded = await loadPlan(groupId).catch(() => null);
      if (reloaded) setPlan(reloaded);
      if (failure) {
        setError(failure);
        // The count stays inside the dialog, next to the refusal it belongs to.
        if (created > 0) setRunNotice(`${createdCopy(created, viewCreated)}，请重新确认写入`);
      } else {
        closeDialog();
        setNotice(
          created > 0 || viewCreated
            ? `${createdCopy(created, viewCreated)}，请重新确认写入`
            : "没有缺少的表头，写入确认保持不变"
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function runRetype() {
    if (!retype) return;
    const roles = ROLES.filter((role) => retypeNames(role).length > 0);
    if (roles.length === 0) return;
    setRetypeBusy(true);
    setError("");
    setRetypeNotice("");
    setNotice("");
    let retyped = 0;
    let failure = "";
    try {
      for (const role of roles) {
        try {
          const result = await retype(groupId, {
            role,
            field_names: retypeNames(role),
            acknowledge: true
          });
          retyped += result.retyped_fields?.length ?? 0;
        } catch (reason) {
          const refusal = refusalOf(reason, "修正表头类型失败");
          failure = refusal.message;
          // A refused run can still have converted the headers before it.
          retyped += refusal.createdFields.length;
          break;
        }
      }
      // Only a run that really converted a column clears the write approval, so
      // the page is only asked to re-read the table then.
      if (retyped > 0) {
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the repair still happened.
        }
      }
      const reloaded = await loadPlan(groupId).catch(() => null);
      if (reloaded) setPlan(reloaded);
      if (failure) {
        setError(failure);
        if (retyped > 0) setRetypeNotice(`已修正 ${retyped} 个表头，请重新确认写入`);
      } else {
        closeRetypeDialog();
        setNotice(
          retyped > 0 ? `已修正 ${retyped} 个表头，请重新确认写入` : "没有需要修正的表头"
        );
      }
    } finally {
      setRetypeBusy(false);
    }
  }

  async function createRoleTable(role: TableRole) {
    if (!createTable || !onTableCreated) return;
    const baseToken = baseOf(role);
    const tableName = names[role].trim();
    if (!baseToken || !tableName) return;
    setTableBusy(role);
    setError("");
    setNotice("");
    try {
      const result = await createTable(groupId, {
        role,
        base_token: baseToken,
        table_name: tableName,
        acknowledge: true
      });
      const table = result.table;
      if (!table?.table_id) {
        setError("新建数据表失败：Lark 没有返回数据表 id");
        return;
      }
      const created = { table_id: table.table_id, name: table.name || tableName };
      onTableCreated(role, created);
      setNotice(`已新建数据表「${created.name}」，请把它保存为本组的${ROLE_LABELS[role]}`);
    } catch (reason) {
      setError(messageOf(reason, "新建数据表失败"));
    } finally {
      setTableBusy(null);
    }
  }

  async function runRebuild() {
    if (!rebuild) return;
    const roles = ROLES.filter((role) => rebuildTicked[role]);
    if (roles.length === 0) return;
    setRebuildBusy(true);
    setError("");
    setRebuildNotice("");
    setNotice("");
    const moved: { role: TableRole; table: Table; replaced: Table; requeued: number }[] = [];
    let failure = "";
    try {
      for (const role of roles) {
        try {
          const result = await rebuild(groupId, { role, acknowledge: true });
          moved.push({
            role,
            table: result.table,
            replaced: result.replaced,
            requeued: result.requeued ?? 0
          });
          // The group now points at the rebuilt table, so this page has to
          // name it too: without this the selection would still offer the
          // table the server just walked away from.
          onTableRebuilt?.(role, result.table, result.replaced);
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
      const reloaded = await loadPlan(groupId).catch(() => null);
      if (reloaded) setPlan(reloaded);

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
        setNotice(moved.length > 0 ? `${copy}；${cleanup}；请重新确认写入` : "没有重建任何数据表");
      }
    } finally {
      setRebuildBusy(false);
    }
  }

  const statusParts: string[] = [];
  if (missingTotal > 0) {
    statusParts.push(
      `缺少 ${missingTotal} 个表头：${ROLES.filter((role) => missing[role].length > 0)
        .map((role) => `${ROLE_LABELS[role]} ${missing[role].length}`)
        .join(" · ")}`
    );
  }
  if (retype && wrongTypeTotal > 0) {
    statusParts.push(
      `${wrongTypeTotal} 个表头类型不对：${ROLES.filter((role) => wrongType[role].length > 0)
        .map((role) => `${ROLE_LABELS[role]} ${wrongType[role].length}`)
        .join(" · ")}`
    );
  }
  const status = loadError
    ? loadError
    : plan === null
      ? "正在读取表头…"
      : statusParts.length > 0
        ? statusParts.join(" · ")
        : "表头完整";

  return (
    <div className="lark-provision">
      <p className={`inline-status${loadError ? " error" : ""}`} role={loadError ? "alert" : "status"}>
        {status}
      </p>
      <div className="lark-provision-actions">
        {missingTotal > 0 ? (
          <button type="button" className="primary" onClick={openDialog}>
            <ListPlus size={16} />
            设置表头
          </button>
        ) : null}
        {retype && wrongTypeTotal > 0 ? (
          <button type="button" className="ghost-button" onClick={openRetypeDialog}>
            <Wrench size={16} />
            修正表头类型
          </button>
        ) : null}
        {rebuild ? (
          <button type="button" className="ghost-button" onClick={openRebuildDialog}>
            <Table2 size={16} />
            重建数据表（表头修正）
          </button>
        ) : null}
        {createTable && onTableCreated ? (
          <div className="lark-new-tables">
            {ROLES.map((role) => (
              <div className="lark-new-table" key={role}>
                <label>
                  {TABLE_NAME_LABELS[role]}
                  <input
                    value={names[role]}
                    maxLength={100}
                    disabled={!baseOf(role) || tableBusy !== null}
                    onChange={(event) =>
                      setNames((current) => ({ ...current, [role]: event.target.value }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost-button"
                  aria-label={CREATE_TABLE_LABELS[role]}
                  disabled={!baseOf(role) || !names[role].trim() || tableBusy !== null}
                  onClick={() => void createRoleTable(role)}
                >
                  {tableBusy === role ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Table2 size={16} />
                  )}
                  新建数据表
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {notice ? (
        <p className="inline-status saved" role="status">
          {notice}
        </p>
      ) : null}
      {!open && !retypeOpen && !rebuildOpen && error ? (
        <p className="inline-status error" role="alert">
          {error}
        </p>
      ) : null}

      {open ? (
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
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={closeDialog}
              >
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
      ) : null}

      {retypeOpen ? (
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
      ) : null}

      {rebuildOpen ? (
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
              负责人 / 截图 / 控制台 / 报告人 / 日期，缺陷记录表为 问题描述 / 进展状态 /
              跟进人 / 优先级 / 截图 / 反馈人 / 反馈时间 / 备注），并把本组指向它。
              结果、优先级、进展状态是下拉框，截图和人员是对应类型的字段。
            </p>
            <p className="inline-status">
              表头顺序和主列无法在 Lark 里改，只能换一张表。旧表不会被删除，本组已经写入的记录会按当前规则重新写入新表（含截图）；重建后需要重新确认写入。
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
                ref={rebuildConfirmRef}
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
      ) : null}
    </div>
  );
}
