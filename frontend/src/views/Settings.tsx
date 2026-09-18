import { useEffect, useState } from "react";
import { LoaderCircle, Save, Users } from "lucide-react";

import { type LarkPeople } from "../api";

type Props = {
  load: () => Promise<LarkPeople>;
  save: (payload: { reporter_open_id: string; owner_open_id: string }) => Promise<LarkPeople>;
};

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function SettingsView({ load, save }: Props) {
  const [reporter, setReporter] = useState("");
  const [owner, setOwner] = useState("");
  const [state, setState] = useState<LarkPeople | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((loaded) => {
        if (cancelled) return;
        setState(loaded);
        setReporter(loaded.reporter_open_id);
        setOwner(loaded.owner_open_id);
      })
      .catch((reason) => {
        if (!cancelled) setError(messageOf(reason, "读取人员设置失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const submit = async () => {
    // Nothing readable means nothing to compare against: a save here would send
    // two empty strings, and empty is how this endpoint says "erase it".
    if (state === null) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const saved = await save({ reporter_open_id: reporter.trim(), owner_open_id: owner.trim() });
      setState(saved);
      setReporter(saved.reporter_open_id);
      setOwner(saved.owner_open_id);
      setNotice("人员设置已保存");
    } catch (reason) {
      setError(messageOf(reason, "保存人员设置失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workspace-section settings-panel" aria-labelledby="settings-title">
      <div className="section-heading">
        <div><h2 id="settings-title"><Users size={18} />人员设置</h2></div>
      </div>
      <p className="inline-status">
        执行记录的 报告人 / 负责人 和 缺陷记录的 反馈人 都是人员列，只接受本应用名下的
        open_id（<code>ou_</code> 开头）。姓名和邮箱会被 Lark 拒绝，服务端也会先挡下来。
      </p>
      <p className="inline-status">
        报告人一处配置、两侧共用：执行记录的「报告人」和缺陷记录的「反馈人」用的是同一个 id。
        负责人留空就保持空——交给领导之后再填。
      </p>

      <label>
        报告人 open_id
        <input
          aria-label="报告人 open_id"
          value={reporter}
          placeholder={state?.env_reporter_open_id || "ou_..."}
          onChange={(event) => setReporter(event.target.value)}
        />
      </label>
      <label>
        负责人 open_id
        <input
          aria-label="负责人 open_id"
          value={owner}
          placeholder="ou_..."
          onChange={(event) => setOwner(event.target.value)}
        />
      </label>

      <p className="inline-status">
        {`当前实际写入：报告人 `}
        <code>{state === null ? "（未知）" : state.effective_reporter_open_id || "（空）"}</code>
        {` · 负责人 `}
        <code>{state === null ? "（未知）" : state.effective_owner_open_id || "（空）"}</code>
        {state && !state.reporter_open_id && state.env_reporter_open_id
          ? "（报告人用的还是环境变量里的兜底值）"
          : ""}
      </p>

      {notice ? <p className="inline-status saved" role="status">{notice}</p> : null}
      {error ? <p className="inline-status error" role="alert">{error}</p> : null}

      <button type="button" className="primary" disabled={busy || state === null} onClick={() => void submit()}>
        {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
        保存人员设置
      </button>
    </section>
  );
}
