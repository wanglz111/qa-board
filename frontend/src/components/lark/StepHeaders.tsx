import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Table2 } from "lucide-react";

import {
  type CreateTablePayload,
  type CreateTableResult,
  type LarkTarget,
  type ProvisionFieldsPayload,
  type ProvisionFieldsResult,
  type ProvisionPlan,
  type RebuildTablePayload,
  type RebuildTableResult,
  type RetypeFieldsPayload,
  type RetypeFieldsResult,
  type Table,
  type TableRole
} from "../../api";
import { ProvisionDialog } from "./ProvisionDialog";
import { RetypeDialog } from "./RetypeDialog";
import { RebuildDialog } from "./RebuildDialog";

type StepHeadersProps = {
  groupId: string;
  target: LarkTarget | null;
  // 契约收口（Round 1 复审 + Task 6 交叉核对）：**没有 plan / planError 两个 props**。
  // plan 由本组件用 loadPlan 自己读，页面不传；这两个名字只作为组件内部 state 存在。
  busy: boolean;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  targetFingerprint: string;
  schemaFingerprint: string | null;
  bases: Record<TableRole, string>;
  tableNames: Record<TableRole, string>;
  onChanged: () => Promise<void>;
  // B7：provision / retype 成功后必须让该 role 的判决重算（页面接到 recheckRole 上）。
  // 少了它，"表头修好了但第 ③ 步永远不可勾选"。
  onRoleFixed: (role: TableRole) => void;
  onTableCreated: (role: TableRole, table: Table) => void;
  onTableRebuilt: (role: TableRole, table: Table, replaced: Table) => void;
  // 只有一条路：本组件按 groupId / targetFingerprint / schemaFingerprint 自己读
  // （与旧 HeaderSetup.tsx:210-241 一致）。因此它是**必填**，页面不得也不需注入 plan。
  loadPlan: (groupId: string) => Promise<ProvisionPlan>;
  // A new group or a re-pointed target must not keep a dialog, a notice or a
  // tick: remounting the three dialogs is how that reset is expressed here.
  resetKey?: string;
};

export const ROLES: TableRole[] = ["execution", "bug"];
export const ROLE_LABELS: Record<TableRole, string> = {
  execution: "执行记录表",
  bug: "缺陷记录表"
};
export const DEFAULT_TABLE_NAME: Record<TableRole, string> = {
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

// What a rebuilt table is called beside the one it replaces. It mirrors the
// server's own suffix: the dialog names the table the administrator will find
// in Lark, not a description of it.
const REBUILD_SUFFIX = "（表头修正）";

export function rebuiltNameOf(name: string): string {
  return `${name || "数据表"}${REBUILD_SUFFIX}`;
}

export function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function StepHeaders({
  groupId,
  provision,
  retype,
  createTable,
  rebuild,
  targetFingerprint,
  schemaFingerprint,
  bases,
  tableNames,
  onChanged,
  onRoleFixed,
  onTableCreated,
  onTableRebuilt,
  loadPlan,
  resetKey
}: StepHeadersProps) {
  // The plan lives here and only here: `loadPlan` is the single source, and no
  // parent may inject a plan through props (B7 / Task 6 cross-check).
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [notice, setNotice] = useState("");
  const [createError, setCreateError] = useState("");
  const [names, setNames] = useState<Record<TableRole, string>>(DEFAULT_TABLE_NAME);
  const [tableBusy, setTableBusy] = useState<TableRole | null>(null);
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [retypeOpen, setRetypeOpen] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const executionBase = bases?.execution ?? "";
  const bugBase = bases?.bug ?? "";
  const baseOf = (role: TableRole) => (role === "execution" ? executionBase : bugBase);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setPlanError("");
    loadPlan(groupId)
      .then((loaded) => !cancelled && setPlan(loaded))
      .catch((reason) => !cancelled && setPlanError(messageOf(reason, "读取缺失表头失败")));
    return () => {
      cancelled = true;
    };
  }, [groupId, targetFingerprint, schemaFingerprint, loadPlan, generation]);

  // The header names another group now: no message may linger under it.
  useEffect(() => {
    setNotice("");
    setCreateError("");
    setProvisionOpen(false);
    setRetypeOpen(false);
    setRebuildOpen(false);
  }, [groupId, resetKey]);

  // A message about a table created in one base must not survive that base
  // moving to another one.
  useEffect(() => {
    setNotice("");
  }, [executionBase, bugBase]);

  const reloadPlan = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  async function createRoleTable(role: TableRole) {
    if (!createTable) return;
    const baseToken = baseOf(role);
    const tableName = names[role].trim();
    if (!baseToken || !tableName) return;
    setTableBusy(role);
    setNotice("");
    setCreateError("");
    try {
      const result = await createTable(groupId, {
        role,
        base_token: baseToken,
        table_name: tableName,
        acknowledge: true
      });
      const table = result.table;
      if (!table?.table_id) {
        setCreateError("新建数据表失败：Lark 没有返回数据表 id");
        return;
      }
      const created = { table_id: table.table_id, name: table.name || tableName };
      onTableCreated(role, created);
      setNotice(`已新建数据表「${created.name}」，请把它保存为本组的${ROLE_LABELS[role]}`);
    } catch (reason) {
      setCreateError(messageOf(reason, "新建数据表失败"));
    } finally {
      setTableBusy(null);
    }
  }

  const statusParts: string[] = [];
  const missing: Record<TableRole, number> = {
    execution: plan?.roles?.execution?.length ?? 0,
    bug: plan?.roles?.bug?.length ?? 0
  };
  const missingTotal = missing.execution + missing.bug;
  const wrongType: Record<TableRole, number> = {
    execution: plan?.retype?.execution?.length ?? 0,
    bug: plan?.retype?.bug?.length ?? 0
  };
  const wrongTypeTotal = wrongType.execution + wrongType.bug;
  if (missingTotal > 0) {
    statusParts.push(
      `缺少 ${missingTotal} 个表头：${ROLES.filter((role) => missing[role] > 0)
        .map((role) => `${ROLE_LABELS[role]} ${missing[role]}`)
        .join(" · ")}`
    );
  }
  if (retype && wrongTypeTotal > 0) {
    statusParts.push(
      `${wrongTypeTotal} 个表头类型不对：${ROLES.filter((role) => wrongType[role] > 0)
        .map((role) => `${ROLE_LABELS[role]} ${wrongType[role]}`)
        .join(" · ")}`
    );
  }
  const status = planError
    ? planError
    : plan === null
      ? "正在读取表头…"
      : statusParts.length > 0
        ? statusParts.join(" · ")
        : "表头完整";
  // The dialog that is open carries its own refusal; only a refusal with no
  // dialog left to hold it is shown here.
  const shellError = !provisionOpen && !retypeOpen && !rebuildOpen ? createError : "";

  return (
    <div className="lark-provision">
      <p className={`inline-status${planError ? " error" : ""}`} role={planError ? "alert" : "status"}>
        {status}
      </p>
      <div className="lark-provision-actions">
        {provision ? (
          <ProvisionDialog
            key={`provision-${resetKey ?? groupId}`}
            groupId={groupId}
            plan={plan}
            open={provisionOpen}
            onClose={() => setProvisionOpen(false)}
            // The notice on the page belongs to the run that produced it. A
            // new run may not be read together with the previous run's line,
            // so the line goes when its action is taken up again.
            onOpenRequest={() => {
              setNotice("");
              setProvisionOpen(true);
            }}
            onFinished={setNotice}
            onChanged={onChanged}
            onRoleFixed={onRoleFixed}
            provision={provision}
            reloadPlan={reloadPlan}
          />
        ) : null}
        {retype ? (
          <RetypeDialog
            key={`retype-${resetKey ?? groupId}`}
            groupId={groupId}
            plan={plan}
            open={retypeOpen}
            onClose={() => setRetypeOpen(false)}
            onOpenRequest={() => {
              setNotice("");
              setRetypeOpen(true);
            }}
            onFinished={setNotice}
            onChanged={onChanged}
            onRoleFixed={onRoleFixed}
            retype={retype}
            reloadPlan={reloadPlan}
          />
        ) : null}
        {rebuild ? (
          <RebuildDialog
            key={`rebuild-${resetKey ?? groupId}`}
            groupId={groupId}
            plan={plan}
            open={rebuildOpen}
            onClose={() => setRebuildOpen(false)}
            onOpenRequest={() => {
              setNotice("");
              setRebuildOpen(true);
            }}
            onFinished={setNotice}
            onChanged={onChanged}
            rebuild={rebuild}
            tableNames={tableNames}
            onTableRebuilt={onTableRebuilt}
            reloadPlan={reloadPlan}
            targetFingerprint={targetFingerprint}
            schemaFingerprint={schemaFingerprint}
            loadPlan={loadPlan}
          />
        ) : null}
        {createTable ? (
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
      {shellError ? (
        <p className="inline-status error" role="alert">
          {shellError}
        </p>
      ) : null}
    </div>
  );
}
