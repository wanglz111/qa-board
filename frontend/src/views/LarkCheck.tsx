import { useEffect, useState } from "react";
import { LoaderCircle, ShieldCheck, ShieldOff } from "lucide-react";

import type {
  Group,
  LarkCheck,
  LarkConfirmPayload,
  LarkConfirmation,
  LarkConfirmationState
} from "../api";

type Props = {
  loadGroups: () => Promise<Group[]>;
  loadCheck: () => Promise<LarkCheck>;
  loadConfirmation: (groupId: string) => Promise<LarkConfirmationState>;
  confirm: (groupId: string, payload: LarkConfirmPayload) => Promise<LarkConfirmation>;
  initialGroupId?: string;
};

export function LarkCheckView({
  loadGroups,
  loadCheck,
  loadConfirmation,
  confirm,
  initialGroupId
}: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState("");
  const [check, setCheck] = useState<LarkCheck | null>(null);
  const [state, setState] = useState<LarkConfirmationState | null>(null);
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadGroups(), loadCheck()])
      .then(([loadedGroups, loadedCheck]) => {
        if (cancelled) return;
        setGroups(loadedGroups);
        setCheck(loadedCheck);
        const preferred = loadedGroups.find((group) => group.id === initialGroupId) ?? loadedGroups[0];
        if (preferred) setGroupId(preferred.id);
      })
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "读取 Lark 失败"))
      .finally(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGroupId]);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    setAllowWrites(false);
    setNotice("");
    loadConfirmation(groupId)
      .then((result) => !cancelled && setState(result))
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "读取确认状态失败"));
    return () => {
      cancelled = true;
    };
  }, [groupId, loadConfirmation]);

  const blocked = Boolean(check && (check.read_errors.length > 0 || check.schema_errors.length > 0));
  const confirmable = Boolean(
    check && !blocked && groupId && check.target_fingerprint && check.schema_fingerprint
  );

  async function submitConfirmation() {
    if (!check || !confirmable) return;
    const current = state?.current;
    const baseToken = current?.base_token ?? "";
    const executionTableId = current?.execution_table_id ?? "";
    const bugTableId = current?.bug_table_id ?? "";
    const schemaFingerprint = current?.schema_fingerprint ?? check.schema_fingerprint ?? "";
    const targetFingerprint = current?.target_fingerprint ?? check.target_fingerprint ?? "";
    if (!baseToken || !executionTableId || !bugTableId) {
      setError("未读取到目标表标识，请刷新后再确认");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const confirmation = await confirm(groupId, {
        base_token: baseToken,
        execution_table_id: executionTableId,
        bug_table_id: bugTableId,
        schema_fingerprint: schemaFingerprint,
        target_fingerprint: targetFingerprint,
        allow_writes: allowWrites
      });
      setState((current) => ({
        confirmed: true,
        confirmation,
        current: current?.current ?? {
          base_token: null,
          execution_table_id: null,
          bug_table_id: null,
          base_name: check.base_name,
          execution_table_name: check.execution_table_name,
          bug_table_name: check.bug_table_name,
          schema_fingerprint: check.schema_fingerprint,
          target_fingerprint: check.target_fingerprint,
          schema_errors: check.schema_errors,
          read_errors: check.read_errors
        }
      }));
      setNotice("已确认：本组新记录只会新增，旧记录与旧缺陷不会被修改");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "确认失败");
    } finally {
      setBusy(false);
    }
  }

  const confirmed = state?.confirmed === true;
  const invalidated = state?.confirmation !== null && state?.confirmation?.valid === false;

  return (
    <section className="workspace-section lark-check-layout" aria-labelledby="lark-title">
      <div className="section-heading">
        <div><p className="eyebrow">LARK</p><h2 id="lark-title">旧表只读检查与写入确认</h2></div>
      </div>

      <label>
        测试组
        <select aria-label="测试组" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>{group.name}</option>
          ))}
        </select>
      </label>

      <div className="lark-panel">
        <h3>从 Lark API 实际读取到的目标</h3>
        {check ? (
          <dl className="lark-facts">
            <div><dt>多维表格</dt><dd>{check.base_name ?? "未读取"}</dd></div>
            <div><dt>执行记录表</dt><dd>{check.execution_table_name ?? "未读取"}</dd></div>
            <div><dt>缺陷表</dt><dd>{check.bug_table_name ?? "未读取"}</dd></div>
          </dl>
        ) : (
          <p className="inline-status"><LoaderCircle className="spin" size={16} />读取中</p>
        )}

        {check && Object.keys(check.execution_fields).length > 0 ? (
          <p className="lark-fields">
            执行表字段：
            {Object.entries(check.execution_fields).map(([name, type]) => (
              <span key={name} className="lark-field">{name} · {type}</span>
            ))}
          </p>
        ) : null}

        {check?.read_errors.map((item) => (
          <p key={item} className="inline-status error" role="alert">{item}</p>
        ))}
        {check?.schema_errors.map((item) => (
          <p key={item} className="inline-status error" role="alert">{item}</p>
        ))}
      </div>

      <div className="lark-panel">
        <h3>写入确认</h3>
        {confirmed ? (
          <p className="inline-status saved" role="status">
            <ShieldCheck size={16} />
            已确认 {state?.confirmation?.execution_table_name} / {state?.confirmation?.bug_table_name}
          </p>
        ) : (
          <p className="inline-status" role="status">
            <ShieldOff size={16} />
            {invalidated
              ? "目标表或字段已变化，此前的确认已失效，需要重新确认"
              : "尚未确认：本地结果不会写入 Lark"}
          </p>
        )}
        <label className="lark-consent">
          <input
            type="checkbox"
            checked={allowWrites}
            disabled={blocked}
            onChange={(event) => setAllowWrites(event.target.checked)}
          />
          允许向上述旧表新增本组记录
        </label>
        <button
          type="button"
          className="primary"
          disabled={!allowWrites || !confirmable || busy}
          onClick={() => void submitConfirmation()}
        >
          {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
          确认本组写入目标
        </button>
        {notice ? <p className="inline-status saved" role="status">{notice}</p> : null}
        {error ? <p className="inline-status error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
