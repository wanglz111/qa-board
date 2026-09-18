import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  ApiError, type CreateTablePayload, type CreateTableResult, type Group, type LarkResolved, type LarkTarget,
  type LarkTargetChangeDetail, type LarkTargetPayload, type LarkTargetState, type ProvisionFieldsPayload,
  type ProvisionFieldsResult, type ProvisionPlan, type RebuildTablePayload, type RebuildTableResult,
  type RetypeFieldsPayload, type RetypeFieldsResult, type SyncEnqueueResult, type SyncStatus,
  type TableRole, type TableSchema
} from "../api";
import { LarkHealthStrip } from "../components/lark/LarkHealthStrip";
import { StepApprove } from "../components/lark/StepApprove";
import { StepHeaders } from "../components/lark/StepHeaders";
import { StepSection } from "../components/lark/StepSection";
import { StepSync } from "../components/lark/StepSync";
import { StepTables } from "../components/lark/StepTables";
import { TargetChangeDialog, type TargetSide } from "../components/TargetChangeDialog";
import { useLarkDraft } from "../hooks/useLarkDraft";
import { describeHealth, effectiveBase, nameOf, stepsComplete, verdictFor, type Health, type StepId } from "../larkDraft";

type Props = {
  loadGroups: () => Promise<Group[]>;
  resolve: (url: string) => Promise<LarkResolved>;
  loadTarget: (groupId: string) => Promise<LarkTargetState>;
  saveTarget: (groupId: string, payload: LarkTargetPayload) => Promise<{ target: LarkTarget; live: LarkTargetState["live"]; confirmation_cleared: boolean }>;
  confirmTarget: (groupId: string, targetFingerprint: string) => Promise<LarkTarget>;
  loadSync?: (groupId: string) => Promise<SyncStatus>;
  enqueueSync?: (groupId: string) => Promise<SyncEnqueueResult>;
  retrySync?: (groupId: string, releaseUncertain?: boolean) => Promise<{ requeued: number; released: number; repointed?: number }>;
  loadPlan?: (groupId: string) => Promise<ProvisionPlan>;
  provision?: (groupId: string, payload: ProvisionFieldsPayload) => Promise<ProvisionFieldsResult>;
  retype?: (groupId: string, payload: RetypeFieldsPayload) => Promise<RetypeFieldsResult>;
  createTable?: (groupId: string, payload: CreateTablePayload) => Promise<CreateTableResult>;
  rebuild?: (groupId: string, payload: RebuildTablePayload) => Promise<RebuildTableResult>;
  readTableSchema: (baseToken: string, tableId: string, role: TableRole) => Promise<TableSchema>;
  initialGroupId?: string;
};

type PendingChange = { payload: LarkTargetPayload; previous: TargetSide | null; next: TargetSide };
type Identity = LarkTargetChangeDetail["diff"]["next"];
const STEP_ORDER: StepId[] = ["tables", "headers", "approve", "sync"];
const STEP_LABELS: Record<StepId, string> = { tables: "选表", headers: "表头", approve: "确认写入", sync: "同步" };
const HEADER_HINT = "先在第 1 步读取链接并保存目标表，这里才有可校验的表头";
// describeHealth 第 8 条会把「队列还没读回来」写成「待同步 0 · 失败 0」。没读到的数字不许出口
// （GC2）：队列未读时状态条只报这一行（warn、不可跳转），八条规则的文案仍逐字来自 describeHealth。
const SYNC_UNREAD: Health = { tone: "warn", step: null, text: "尚未读取同步状态：队列数字还没有加载，请按「刷新」重读这一组" };

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

function isTargetChange(detail: unknown): detail is LarkTargetChangeDetail {
  return typeof detail === "object" && detail !== null && (detail as { reason?: unknown }).reason === "target_changed"
    && Boolean((detail as { diff?: { changed?: unknown } }).diff?.changed);
}

function sideOf(target: LarkTarget | null): TargetSide {
  return { execution_table_name: target?.execution_table_name ?? "", execution_table_id: target?.execution_table_id ?? "", bug_table_name: target?.bug_table_name ?? "", bug_table_id: target?.bug_table_id ?? "" };
}

export function LarkCheckView({
  loadGroups, resolve, loadTarget, saveTarget, confirmTarget, loadSync, enqueueSync,
  retrySync, loadPlan, provision, retype, createTable, rebuild, readTableSchema, initialGroupId
}: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [state, setState] = useState<LarkTargetState | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncRead, setSyncRead] = useState(false);
  const [allowWrites, setAllowWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  // undefined = 用户还没点过标题（第 1 步展开，四步全完成则全收）；null = 用户主动收起；StepId = 用户最后打开的步。
  const [chosen, setChosen] = useState<StepId | null | undefined>(undefined);

  const actions = useLarkDraft({ groupId, resolve, readTableSchema, onError: setError });
  const { draft, reading, checking, recheckRole } = actions;

  useEffect(() => {
    let cancelled = false;
    loadGroups()
      .then((loaded) => {
        if (cancelled) return;
        setGroups(loaded);
        setGroupId((current) => (current && loaded.some((group) => group.id === current) ? current
          : loaded.find((group) => group.id === initialGroupId)?.id ?? loaded[0]?.id ?? ""));
      })
      .catch((reason) => !cancelled && setError(messageOf(reason, "读取测试组失败")));
    return () => { cancelled = true; };
    // loadGroups 是 App 传下来的稳定引用；进依赖会让它换组即重跑。
  }, [initialGroupId]);

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    // 换组：上一组的目标、同步计数、展开的步、消息都不属于这一组。
    setAllowWrites(false); setNotice(""); setError(""); setPendingChange(null);
    setState(null); setSync(null); setSyncRead(false); setChosen(undefined);
    loadTarget(groupId)
      .then((result) => {
        if (cancelled) return;
        setState(result);
        actions.resetDraft(result.target);   // 预填只发生在「目标刚读到」这一刻，不冲掉用户改过的选择
      })
      .catch((reason) => !cancelled && setError(messageOf(reason, "读取该组的 Lark 目标失败")));
    loadSync?.(groupId)
      .then((result) => { if (!cancelled) { setSync(result); setSyncRead(true); } })
      .catch((reason) => { if (!cancelled) { setSync(null); setSyncRead(false); setError(messageOf(reason, "读取同步状态失败")); } });
    return () => { cancelled = true; };
    // resetDraft 的身份不稳定，进依赖会变成「换组即重读」的循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, loadTarget]);

  const target = state?.target ?? null;
  const liveErrors = [...(state?.read_errors ?? []), ...(state?.live?.read_errors ?? [])];
  const schemaInvalid = (state?.live?.schema_errors.length ?? 0) > 0;
  const blocked = liveErrors.length > 0 || schemaInvalid;
  const confirmed = target?.confirmed === true;
  const invalidated = confirmed && schemaInvalid;
  const syncFailed = sync?.failed ?? 0, syncUncertain = sync?.uncertain ?? 0, syncParked = sync?.parked ?? 0;
  const syncTrouble = syncFailed + syncUncertain + syncParked > 0;
  // 前面几条规则都沉默 = 只有第 8 条会开口；它报计数，所以队列必须先真的读回来（syncRead）。
  const queueUnread = confirmed && !syncRead && liveErrors.length === 0 && !schemaInvalid;
  const health: Health = queueUnread ? SYNC_UNREAD : describeHealth({ target, liveErrors, schemaInvalid, sync });
  // E4：probe 没有 TTL。目标已保存时「表头」这步以服务端 live.schema_errors 为准（probe 只回答
  // 「这次待保存的选择合不合格」），否则服务端说失效、第 ① 步还显示 ok，两个真值打架。
  const done: Record<StepId, boolean> = { ...stepsComplete(draft, target, sync), headers: target !== null && !schemaInvalid };
  const executionBase = effectiveBase(draft, "execution"), bugBase = effectiveBase(draft, "bug");
  const executionVerdict = verdictFor(draft, "execution"), bugVerdict = verdictFor(draft, "bug");
  // 「前置未完成不可进」：① 永远可进；② 没 target 时进去是一句回第 ① 步的提示（规格 §12 P2）；
  // ③ 要两表 verdict 都 ok，否则勾选也点不动；④ 要有已确认目标或真的有待处理异常。
  const enterable: Record<StepId, boolean> = {
    tables: true, headers: true,
    approve: target !== null && executionVerdict === "ok" && bugVerdict === "ok",
    sync: confirmed || syncTrouble
  };
  // 只有 D2 的两条「必须主动提醒」抢导航：状态条变红，或指向第 ④ 步（含 parked 的 warn）。
  // 「尚未确认」也带 step=approve，但那是正常进度 —— 抢它会把用户从第 ① 步拽走。
  const autoOpen = health.step === "sync" || health.tone === "bad" ? health.step : null;
  const lastAuto = useRef<StepId | null>(null);
  useEffect(() => {
    const before = lastAuto.current;
    lastAuto.current = autoOpen;
    if (autoOpen === null || autoOpen === before) return;   // 分类没变就不抢用户导航
    setChosen(autoOpen);
  }, [autoOpen]);
  const allDone = STEP_ORDER.every((step) => done[step]);
  // 唤醒的自动展开必须是**派生**的，不能只交给上面那个被动 effect 去 setChosen：数据落地的那一次
  // 提交里 chosen 还是 undefined，若不带 autoOpen 就落到 "tables"，目标步先被渲染成 attention，
  // 下一帧才变 open —— 页面闪一格红标题，同步断言的测试就会读到 attention（复审 I1）。
  // 用户选择仍优先：chosen 一旦有值（点过标题，或自动展开已生效），一切照旧听 chosen。
  const openStep: StepId | null = chosen === undefined ? (autoOpen ?? (allDone ? null : "tables")) : chosen;
  const summaries: Record<StepId, string> = {
    tables: executionVerdict === "ok" && bugVerdict === "ok" ? "两张表都已校验" : "还有表没有校验",
    headers: target ? `已保存目标：${target.execution_table_name} / ${target.bug_table_name}` : HEADER_HINT,
    approve: confirmed ? (invalidated ? "确认已失效，需要重新确认" : "已确认") : "尚未确认：本地结果不会写入 Lark",
    sync: syncTrouble ? `失败 ${syncFailed} · 待人工确认 ${syncUncertain} · 待管理员处理 ${syncParked}`
      : `待同步 ${sync?.queued ?? 0} · 已同步 ${sync?.synced ?? 0}`
  };

  function buildPayload(acknowledge: boolean): LarkTargetPayload {
    return {
      source_url: draft.execution.base?.source_url ?? target?.source_url ?? "", execution_base_token: executionBase?.base_token ?? "",
      execution_table_id: draft.execution.tableId, execution_view_id: executionBase ? draft.execution.viewId : null,
      bug_base_token: bugBase?.base_token ?? "", bug_table_id: draft.bug.tableId,
      expected_previous_fingerprint: target?.target_fingerprint ?? null, acknowledge_change: acknowledge
    };
  }

  // 名字只对「本页读到过的那张表」存在；没读过的表用 id 自称最诚实。
  function namedSide(identity: Identity): TargetSide {
    return { execution_table_name: nameOf(executionBase?.tables ?? [], identity.execution_table_id), execution_table_id: identity.execution_table_id, bug_table_name: nameOf(bugBase?.tables ?? [], identity.bug_table_id), bug_table_id: identity.bug_table_id };
  }

  function identityChanged(): boolean {
    if (!target || !executionBase || !bugBase) return false;
    return target.execution_base_token !== executionBase.base_token || target.execution_table_id !== draft.execution.tableId
      || target.bug_base_token !== bugBase.base_token || target.bug_table_id !== draft.bug.tableId;
  }

  async function persist(payload: LarkTargetPayload) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await saveTarget(groupId, payload);
      setPendingChange(null);
      // PUT 已经回了保存后的行与它依据的实时读取：不再补一次 GET（那次失败会被页面吞掉）。
      setState({ target: result.target, live: result.live ?? null, read_errors: result.live?.read_errors ?? [] });
      setNotice(result.confirmation_cleared ? "目标表已更换：此前的写入确认已被清除，需要重新确认" : "已保存该组的 Lark 目标表");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409 && typeof reason.detail === "object" && reason.detail !== null) {
        const body = reason.detail as LarkTargetChangeDetail;
        if (body.reason === "stale_page") {   // 别的页面动过这一组：重读；弹窗也跟着下去
          setPendingChange(null);
          const refreshed = await loadTarget(groupId).catch(() => null);
          if (refreshed) setState(refreshed);
          setError("其他页面已改过该组的目标表，已重新读取；本次选择仍然保留，请核对后再次点击「保存选择」");
          return;
        }
        if (isTargetChange(reason.detail)) {   // 服务端发现本页还没看见的改动：同一个确认弹窗挡在中间
          setPendingChange({ payload, previous: body.diff.previous ? namedSide(body.diff.previous) : null, next: namedSide(payload) });
          return;
        }
        setError(typeof reason.detail === "string" ? reason.detail : messageOf(reason, "保存 Lark 目标失败"));
        return;
      }
      setError(messageOf(reason, "保存 Lark 目标失败"));
    } finally { setBusy(false); }
  }

  function saveSelection() {
    setError(""); setNotice("");
    const payload = buildPayload(false);
    if (!payload.source_url || !payload.execution_table_id || !payload.bug_table_id) return;
    if (identityChanged()) { setPendingChange({ payload, previous: sideOf(target), next: namedSide(payload) }); return; }   // 绝不静默改指向
    void persist(payload);
  }

  async function confirmChange() { if (pendingChange) await persist({ ...pendingChange.payload, acknowledge_change: true }); }

  async function approveWrites() {
    if (!target || !allowWrites) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await confirmTarget(groupId, target.target_fingerprint);
      setState((current) => (current ? { ...current, target: updated } : current));
      setNotice("已确认：本组新记录只会新增，旧记录与旧缺陷不会被修改");
    } catch (reason) { setError(messageOf(reason, "确认失败")); } finally { setBusy(false); }
  }

  // 只报新插入的行会让按钮看起来是死的：队列里已经有的行也答「已排入 0 条」。每个动过的计数都点名。
  async function queueSavedAttempts() {
    if (!enqueueSync) return;
    setQueueing(true); setError("");
    try {
      const result = await enqueueSync(groupId);
      const moved: string[] = [];
      if (result.queued > 0) moved.push(`已排入 ${result.queued} 条本地结果`);
      if (result.repointed > 0) moved.push(`${result.repointed} 条任务已重新指向当前目标表`);
      if (result.requeued > 0) moved.push(`已重新排队 ${result.requeued} 条失败结果`);
      setNotice(moved.length > 0 ? `${moved.join("，")}，仅新增记录` : "没有需要排入的本地结果：这一组的本地结果都已经在队列里");
      const refreshed = await loadSync?.(groupId);
      if (refreshed) { setSync(refreshed); setSyncRead(true); }
    } catch (reason) { setError(messageOf(reason, "排入同步失败")); } finally { setQueueing(false); }
  }

  // 释放一条 uncertain 任务可能追加第二条远端记录：要管理员显式声明他核对过旧表。
  async function retryQueuedJobs(releaseUncertain: boolean) {
    if (!retrySync) return;
    setRetrying(true); setError("");
    try {
      const result = await retrySync(groupId, releaseUncertain);
      const moved: string[] = [];
      if (result.requeued > 0) moved.push(`已重新排队 ${result.requeued} 条失败结果`);
      if (result.released > 0) moved.push(`释放 ${result.released} 条待人工确认`);
      if ((result.repointed ?? 0) > 0) moved.push(`${result.repointed} 条任务已重新指向当前目标表`);
      setNotice(moved.join("，") || "没有需要重试的同步任务");
      const refreshed = await loadSync?.(groupId);
      if (refreshed) { setSync(refreshed); setSyncRead(true); }
    } catch (reason) { setError(messageOf(reason, "重试同步失败")); } finally { setRetrying(false); }
  }

  async function refreshTarget() {
    if (!groupId) return;
    setError("");
    try {
      setState(await loadTarget(groupId));
      const refreshed = await loadSync?.(groupId);
      if (refreshed) { setSync(refreshed); setSyncRead(true); }
    } catch (reason) { setError(messageOf(reason, "读取该组的 Lark 目标失败")); }
  }

  // 改过表头的那次运行已在服务端作废确认：先本地撤销，失败的重读也不能让「已确认」和「已创建 …」并排。
  // 表头本身的重算交给 onRoleFixed（B7），不在这里猜哪个 role 被改了。
  async function reloadAfterProvision() {
    setState((current) => (current?.target ? { ...current, target: { ...current.target, confirmed: false, confirmed_at: null } } : current));
    if (!groupId) return;
    try { setState(await loadTarget(groupId)); } catch (reason) { setError(messageOf(reason, "读取该组的 Lark 目标失败")); }
  }

  return (
    <section className="workspace-section lark-check-layout" aria-labelledby="lark-title">
      <div className="section-heading"><div><p className="eyebrow">LARK</p><h2 id="lark-title">连接本组的 Lark 多维表格</h2></div></div>
      <label>
        测试组
        <select aria-label="测试组" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          {groups.map((group) => (<option key={group.id} value={group.id}>{group.name}</option>))}
        </select>
      </label>
      <div className="lark-panel">
        <div className="lark-panel-heading">
          <LarkHealthStrip health={health} onJump={setChosen} />
          <button type="button" className="ghost-button" disabled={!groupId} onClick={() => void refreshTarget()}><RefreshCw size={15} />刷新</button>
        </div>
        {liveErrors.map((item) => (<p key={item} className="inline-status error" role="alert">{item}</p>))}
        {notice ? <p className="inline-status saved" role="status">{notice}</p> : null}
        {error ? <p className="inline-status error" role="alert">{error}</p> : null}
      </div>
      {STEP_ORDER.map((step, index) => (
        <StepSection
          key={step} index={index + 1} title={STEP_LABELS[step]} summary={summaries[step]}
          state={openStep === step ? "open" : autoOpen === step ? "attention" : done[step] ? "done" : "todo"}
          disabled={!enterable[step]} onOpen={() => setChosen(openStep === step ? null : step)}
        >
          {step === "tables" ? (
            <StepTables draft={draft} target={target} reading={reading} checking={checking} saving={busy}
              onLinkChange={actions.setLink} onRead={(role) => void actions.readLink(role)} onTableChange={actions.setTable}
              onCheck={(role) => void actions.checkTable(role)} onSave={saveSelection} />
          ) : null}
          {step === "headers" ? (<>
            {schemaInvalid ? (<p className="inline-status error" role="alert">服务端最近一次重读说这批表头不合格：{state?.live?.schema_errors.join("；")}。先按下面的动作修好，再重新校验。</p>) : null}
            {target && loadPlan ? (
              <StepHeaders groupId={groupId} target={target} loadPlan={loadPlan} resetKey={groupId} busy={busy}
                provision={provision} retype={retype} createTable={createTable} rebuild={rebuild}
                targetFingerprint={target.target_fingerprint} schemaFingerprint={target.schema_fingerprint}
                bases={{ execution: executionBase?.base_token ?? "", bug: bugBase?.base_token ?? "" }}
                tableNames={{ execution: target.execution_table_name, bug: target.bug_table_name }}
                onChanged={reloadAfterProvision} onRoleFixed={(role) => void recheckRole(role)}
                onTableCreated={actions.acceptCreatedTable} onTableRebuilt={actions.acceptRebuiltTable} />
            ) : (<p className="inline-status">{HEADER_HINT}</p>)}
          </>) : null}
          {step === "approve" ? (
            <StepApprove target={target} confirmed={confirmed} invalidated={invalidated} blocked={blocked}
              allowWrites={allowWrites} busy={busy} onAllowWrites={setAllowWrites} onConfirm={() => void approveWrites()} />
          ) : null}
          {step === "sync" ? (
            <StepSync sync={sync} confirmed={confirmed} queueing={queueing} retrying={retrying || queueing}
              onEnqueue={() => void queueSavedAttempts()} onRetry={(releaseUncertain) => void retryQueuedJobs(releaseUncertain)} />
          ) : null}
        </StepSection>
      ))}
      {pendingChange ? (
        <TargetChangeDialog previous={pendingChange.previous} next={pendingChange.next} pendingAttempts={sync?.pending_attempts ?? null}
          busy={busy} onCancel={() => setPendingChange(null)} onConfirm={() => void confirmChange()} />
      ) : null}
    </section>
  );
}
