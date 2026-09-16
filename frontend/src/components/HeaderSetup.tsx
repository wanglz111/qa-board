import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ListPlus, LoaderCircle, Table2 } from "lucide-react";

import type {
  CreateTablePayload,
  CreateTableResult,
  ProvisionField,
  ProvisionFieldsPayload,
  ProvisionFieldsResult,
  ProvisionPlan,
  TableRole
} from "../api";

type Table = { table_id: string; name: string };

type Props = {
  groupId: string;
  loadPlan: (groupId: string) => Promise<ProvisionPlan>;
  provision: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  onChanged: () => void | Promise<void>;
  // A new table is only offered when the page can also name the base to build
  // it in; without a base the button stays out of the way.
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  bases?: Record<TableRole, string>;
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

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

// The overlay is mounted only while the confirmation is pending, and it is a
// plain div rather than a <dialog>, because jsdom does not implement showModal.
export function HeaderSetup({
  groupId,
  loadPlan,
  provision,
  onChanged,
  createTable,
  bases,
  onTableCreated
}: Props) {
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Record<TableRole, string[]>>({
    execution: [],
    bug: []
  });
  const [createView, setCreateView] = useState(false);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<TableRole, string>>(DEFAULT_TABLE_NAME);
  const [tableBusy, setTableBusy] = useState<TableRole | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setLoadError("");
    // The header names another group now: no message may linger under it.
    setNotice("");
    setError("");
    loadPlan(groupId)
      .then((loaded) => !cancelled && setPlan(loaded))
      .catch((reason) => !cancelled && setLoadError(messageOf(reason, "读取缺失表头失败")));
    return () => {
      cancelled = true;
    };
  }, [groupId, loadPlan]);

  // The overlay claims modality, so focus has to move in.
  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  const missing: Record<TableRole, ProvisionField[]> = {
    execution: plan?.roles?.execution ?? [],
    bug: plan?.roles?.bug ?? []
  };
  const missingTotal = missing.execution.length + missing.bug.length;
  // Only a header the administrator can still see may be sent: a reload can
  // drop a ticked name from the plan, and a hidden tick must not create it.
  const tickedNames = (role: TableRole) =>
    missing[role].filter((field) => ticked[role].includes(field.name)).map((field) => field.name);
  const tickedTotal = ROLES.reduce((total, role) => total + tickedNames(role).length, 0);

  function openDialog() {
    setTicked({
      execution: missing.execution.map((field) => field.name),
      bug: missing.bug.map((field) => field.name)
    });
    setError("");
    setOpen(true);
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
      if (!busy) setOpen(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = dialogRef.current?.contains(active) ?? false;
    if (!event.shiftKey && (!inside || active === last)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (!inside || active === first)) {
      event.preventDefault();
      last.focus();
    }
  }

  async function createTicked() {
    const roles = ROLES.filter((role) => tickedNames(role).length > 0);
    if (roles.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    let created = 0;
    let succeeded = 0;
    let failure = "";
    try {
      for (const role of roles) {
        try {
          const result = await provision(groupId, {
            role,
            field_names: tickedNames(role),
            create_view: createView,
            acknowledge: true
          });
          succeeded += 1;
          created += result.created_fields?.length ?? 0;
        } catch (reason) {
          failure = messageOf(reason, "创建表头失败");
          break;
        }
      }
      // Any accepted call clears the group's write approval, even when Lark
      // turned out to have every header already: the page has to re-read the
      // target instead of keeping the old consent on screen.
      if (succeeded > 0) {
        try {
          await onChanged();
        } catch {
          // The page reports its own reload failure; the call still succeeded.
        }
        const reloaded = await loadPlan(groupId).catch(() => null);
        if (reloaded) setPlan(reloaded);
      }
      if (failure) {
        setError(failure);
      } else {
        setOpen(false);
      }
      if (succeeded > 0) setNotice(`已创建 ${created} 个表头，请重新确认写入`);
    } finally {
      setBusy(false);
    }
  }

  async function createRoleTable(role: TableRole) {
    if (!createTable || !onTableCreated) return;
    const baseToken = bases?.[role] ?? "";
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

  const status = loadError
    ? loadError
    : plan === null
      ? "正在读取表头…"
      : missingTotal === 0
        ? "表头完整"
        : `缺少 ${missingTotal} 个表头：${ROLES.filter((role) => missing[role].length > 0)
            .map((role) => `${ROLE_LABELS[role]} ${missing[role].length}`)
            .join(" · ")}`;

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
        {createTable && onTableCreated ? (
          <div className="lark-new-tables">
            {ROLES.map((role) => (
              <div className="lark-new-table" key={role}>
                <label>
                  {TABLE_NAME_LABELS[role]}
                  <input
                    value={names[role]}
                    disabled={!bases?.[role] || tableBusy !== null}
                    onChange={(event) =>
                      setNames((current) => ({ ...current, [role]: event.target.value }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className="ghost-button"
                  aria-label={CREATE_TABLE_LABELS[role]}
                  disabled={!bases?.[role] || !names[role].trim() || tableBusy !== null}
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
      {!open && error ? (
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

            <label className="header-setup-view">
              <input
                type="checkbox"
                checked={createView}
                onChange={(event) => setCreateView(event.target.checked)}
              />
              同时创建 TestDeck 视图
            </label>

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
                onClick={() => setOpen(false)}
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
    </div>
  );
}
