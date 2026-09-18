import { LoaderCircle } from "lucide-react";

import type { LarkTarget, Table, TableRole } from "../../api";
import {
  baseIsCurrent,
  effectiveBase,
  probeFor,
  verdictOf,
  type Draft,
  type LarkBase,
  type ProbeSlot,
  type Verdict
} from "../../larkDraft";

type StepTablesProps = {
  draft: Draft;
  target: LarkTarget | null;
  reading: TableRole | null;
  checking: TableRole | null;
  saving: boolean;
  onLinkChange: (role: TableRole, url: string) => void;
  onRead: (role: TableRole) => void;
  onTableChange: (role: TableRole, tableId: string) => void;
  onCheck: (role: TableRole) => void;
  onSave: () => void;
};

const EXECUTION_LABEL = "执行记录表";
const BUG_LABEL = "缺陷记录表";
// 缺陷库链接非空但未读取时，整页只有这一行说明：它不冒充判决，也不做成全局红字。
const UNREAD_BUG_LINK_NOTE =
  "这段缺陷库链接尚未读取：缺陷记录表先不列出（它指向的是另一个多维表格），请按「读取缺陷表」使用它。";

// 下拉只列这个 base 里的表。当前选中的 id 不在这个库里时，用 id 本身当标签
// （名字只对「本页读过的表」才存在），决不悄悄换成另一张表 —— 那会让下拉与
// 调用方构造的 payload 指向不同的表。
function optionsFor(base: LarkBase, tableId: string): Table[] {
  if (tableId === "" || base.tables.some((table) => table.table_id === tableId)) return base.tables;
  return [{ table_id: tableId, name: tableId }, ...base.tables];
}

// 判决只从这一张表自己的 probe 派生：verdictOf(probeFor(draft, role))。
// 不读 draft[role].base 之外的任何东西，也不接受「另一张表的结论」当参数。
function verdictLine(props: {
  role: TableRole;
  label: string;
  slot: ProbeSlot | undefined;
  checking: boolean;
  onCheck: (role: TableRole) => void;
}) {
  const { role, label, slot, checking, onCheck } = props;
  const verdict: Verdict = verdictOf(slot);
  const probe = slot !== undefined && slot !== "loading" ? slot : null;
  const detail = probe?.read_error ?? probe?.schema_errors.join("；") ?? "";
  // bad/unreadable 不是终态：表头可能被第 ② 步的 provision / retype / rebuild 修好，
  // 而 probe 是缓存 —— 所以这三种 verdict 都留一个手动刷新的口子，loading 时不留。
  const retryable = verdict === "unread" || verdict === "bad" || verdict === "unreadable";
  return (
    <div
      className="lark-verdict"
      data-verdict={verdict}
      aria-busy={verdict === "loading" ? true : undefined}
    >
      {verdict === "loading" ? (
        <p className="inline-status" role="status">
          <LoaderCircle className="spin" size={16} />
          正在校验这张表…
        </p>
      ) : null}
      {verdict === "unread" ? (
        <p className="inline-status" role="status">尚未校验这张表</p>
      ) : null}
      {verdict === "unreadable" ? (
        <p className="inline-status error" role="alert">
          {label}读取失败：{detail || "原因未提供"}
        </p>
      ) : null}
      {verdict === "bad" ? (
        <p className="inline-status error" role="alert">
          {label}：{detail}
        </p>
      ) : null}
      {verdict === "ok" ? (
        <p className="inline-status saved" role="status">{label}表头完整</p>
      ) : null}
      {retryable ? (
        <button type="button" className="ghost-button" disabled={checking} onClick={() => onCheck(role)}>
          {verdict === "unread" ? "校验" : "重新校验"}
        </button>
      ) : null}
    </div>
  );
}

export function StepTables({
  draft,
  target,
  reading,
  checking,
  saving,
  onLinkChange,
  onRead,
  onTableChange,
  onCheck,
  onSave
}: StepTablesProps) {
  const executionBase = baseIsCurrent(draft.execution) ? draft.execution.base : null;
  // 缺陷库链接为空 = 与执行表同库；框里有未读取的链接 = 没有可列的表（不是回落）。
  const bugBase = effectiveBase(draft, "bug");
  const bugLink = draft.bug.url.trim();
  const executionSlot = probeFor(draft, "execution");
  const bugSlot = probeFor(draft, "bug");
  const executionOptions = executionBase ? optionsFor(executionBase, draft.execution.tableId) : [];
  const bugOptions = bugBase ? optionsFor(bugBase, draft.bug.tableId) : [];
  const saveDisabled =
    !executionBase || !bugBase || !draft.execution.tableId || !draft.bug.tableId || saving;
  const saveTitle = target
    ? `当前已保存：${target.execution_table_name} / ${target.bug_table_name}`
    : "本组尚未保存过 Lark 表";

  return (
    <div className="lark-step-tables">
      <div className="lark-role" data-role="execution">
        <label>
          Lark 文档链接
          <input
            value={draft.execution.url}
            placeholder="https://…/wiki/… 或 /base/…"
            onChange={(event) => onLinkChange("execution", event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={reading !== null || !draft.execution.url.trim()}
          onClick={() => onRead("execution")}
        >
          {reading === "execution" ? <LoaderCircle className="spin" size={16} /> : null}
          读取表格
        </button>
        {executionBase ? (
          <div className="lark-role-tables">
            <p className="inline-status saved" role="status">
              已读取「{executionBase.base_name}」的 {executionBase.tables.length} 张数据表
            </p>
            {executionBase.read_errors.map((item) => (
              <p key={item} className="inline-status error" role="alert">{item}</p>
            ))}
            {executionOptions.length > 0 ? (
              <label>
                执行记录表
                <select
                  aria-label="执行记录表"
                  value={draft.execution.tableId}
                  disabled={executionSlot === "loading"}
                  onChange={(event) => onTableChange("execution", event.target.value)}
                >
                  {executionOptions.map((table) => (
                    <option key={table.table_id} value={table.table_id}>{table.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {verdictLine({
              role: "execution",
              label: EXECUTION_LABEL,
              slot: executionSlot,
              checking: checking === "execution",
              onCheck
            })}
          </div>
        ) : null}
      </div>

      <div className="lark-role" data-role="bug">
        <label>
          缺陷库链接（可选，默认与执行表同一多维表格）
          <input
            value={draft.bug.url}
            placeholder="https://…/wiki/… 或 /base/…"
            onChange={(event) => onLinkChange("bug", event.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={reading !== null || !bugLink}
          onClick={() => onRead("bug")}
        >
          {reading === "bug" ? <LoaderCircle className="spin" size={16} /> : null}
          读取缺陷表
        </button>
        {bugBase ? (
          <div className="lark-role-tables">
            {baseIsCurrent(draft.bug) ? (
              <p className="inline-status saved" role="status">
                已读取「{bugBase.base_name}」的 {bugBase.tables.length} 张数据表
              </p>
            ) : null}
            {baseIsCurrent(draft.bug)
              ? bugBase.read_errors.map((item) => (
                  <p key={item} className="inline-status error" role="alert">{item}</p>
                ))
              : null}
            {bugOptions.length > 0 ? (
              <label>
                缺陷记录表
                <select
                  aria-label="缺陷记录表"
                  value={draft.bug.tableId}
                  disabled={bugSlot === "loading"}
                  onChange={(event) => onTableChange("bug", event.target.value)}
                >
                  {bugOptions.map((table) => (
                    <option key={table.table_id} value={table.table_id}>{table.name}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {verdictLine({
              role: "bug",
              label: BUG_LABEL,
              slot: bugSlot,
              checking: checking === "bug",
              onCheck
            })}
          </div>
        ) : bugLink ? (
          <p className="lark-role-note">{UNREAD_BUG_LINK_NOTE}</p>
        ) : null}
      </div>

      <button type="button" className="primary" disabled={saveDisabled} title={saveTitle} onClick={onSave}>
        {saving ? <LoaderCircle className="spin" size={16} /> : null}
        保存选择
      </button>
    </div>
  );
}
