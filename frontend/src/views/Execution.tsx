import { useEffect, useRef, useState } from "react";
import { Keyboard, LoaderCircle, PictureInPicture2, PlayCircle } from "lucide-react";

import type {
  Attempt,
  AttemptResult,
  Group,
  GroupCase,
  GroupProgress,
  Screenshot,
  SubmitPayload,
  SyncStatus
} from "../api";
import { CaseDetail } from "../components/CaseDetail";
import { GroupSelector } from "../components/GroupSelector";
import { History } from "../components/History";
import {
  OutcomeForm,
  type OutcomeFormHandle,
  type SaveInput,
  type SaveStatus
} from "../components/OutcomeForm";
import { dispatchCaseKey, useCaseKeys, type CaseKeyHandlers } from "../useCaseKeys";
import { usePiP } from "../usePiP";

type Props = {
  loadGroups: () => Promise<Group[]>;
  loadCases: (groupId: string) => Promise<GroupCase[]>;
  loadProgress: (groupId: string) => Promise<GroupProgress>;
  loadAttempts: (groupId: string, code: string) => Promise<Attempt[]>;
  submit: (groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>;
  reserveRetest?: (groupId: string, code: string) => Promise<Attempt>;
  commitReserved?: (attemptId: string, payload: SubmitPayload) => Promise<Attempt>;
  uploadScreenshot?: (attemptId: string, file: File) => Promise<Screenshot>;
  loadSync?: (groupId: string) => Promise<SyncStatus>;
  initialGroupId?: string;
};

// A retry after a network error reuses the same key so the server returns the
// attempt it already stored instead of appending a duplicate.
function useIdempotencyKey() {
  const pending = useRef<{ signature: string; key: string } | null>(null);
  return (signature: string) => {
    if (pending.current?.signature !== signature) {
      pending.current = { signature, key: crypto.randomUUID() };
    }
    return pending.current.key;
  };
}

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : "保存失败";
}

export function ExecutionView({
  loadGroups,
  loadCases,
  loadProgress,
  loadAttempts,
  submit,
  reserveRetest,
  commitReserved,
  uploadScreenshot,
  loadSync,
  initialGroupId
}: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [progress, setProgress] = useState<Record<string, GroupProgress>>({});
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [cases, setCases] = useState<GroupCase[]>([]);
  const [caseIndex, setCaseIndex] = useState(0);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingCase, setLoadingCase] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [images, setImages] = useState<File[]>([]);
  const [status, setStatus] = useState<SaveStatus | null>(null);
  const [reserved, setReserved] = useState<Attempt | null>(null);
  const [failure, setFailure] = useState("");
  const [lastAttemptId, setLastAttemptId] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const caseRequest = useRef(0);
  const deskRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<OutcomeFormHandle>(null);
  const keyFor = useIdempotencyKey();
  const pip = usePiP();

  useEffect(() => {
    let cancelled = false;
    loadGroups()
      .then((result) => {
        if (cancelled) return;
        setGroups(result);
        const preferred = result.find((group) => group.id === initialGroupId) ?? result[0];
        if (preferred) void selectGroup(preferred.id);
      })
      .catch((reason) => !cancelled && setFailure(message(reason)))
      .finally(() => !cancelled && setLoadingGroups(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGroupId]);

  async function selectGroup(groupId: string) {
    const requestId = ++caseRequest.current;
    setSelectedGroupId(groupId);
    setCases([]);
    setCaseIndex(0);
    setAttempts([]);
    setReserved(null);
    setImages([]);
    setStatus(null);
    setFailure("");
    setSync(null);
    setLoadingCase(true);
    void loadProgress(groupId)
      .then((stats) => setProgress((current) => ({ ...current, [groupId]: stats })))
      .catch(() => undefined);
    void loadSync?.(groupId).then(setSync).catch(() => undefined);
    try {
      const result = await loadCases(groupId);
      if (requestId !== caseRequest.current) return;
      setCases(result);
      const first = result[0];
      if (first) {
        const history = await loadAttempts(groupId, first.code);
        if (requestId === caseRequest.current) setAttempts(history);
      }
    } catch (reason) {
      if (requestId === caseRequest.current) setFailure(message(reason));
    } finally {
      if (requestId === caseRequest.current) setLoadingCase(false);
    }
  }

  async function showCase(index: number) {
    const target = cases[index];
    if (!target || !selectedGroupId) return;
    const requestId = ++caseRequest.current;
    setCaseIndex(index);
    setAttempts([]);
    setReserved(null);
    setImages([]);
    setStatus(null);
    setLoadingCase(true);
    try {
      const history = await loadAttempts(selectedGroupId, target.code);
      if (requestId === caseRequest.current) setAttempts(history);
    } catch (reason) {
      if (requestId === caseRequest.current) setFailure(message(reason));
    } finally {
      if (requestId === caseRequest.current) setLoadingCase(false);
    }
  }

  async function refreshProgress(groupId: string) {
    try {
      const stats = await loadProgress(groupId);
      setProgress((current) => ({ ...current, [groupId]: stats }));
    } catch {
      // Progress is a convenience badge; a stale value must not hide the result.
    }
  }

  async function uploadAll(attemptId: string, files: File[]) {
    if (!uploadScreenshot || files.length === 0) return true;
    try {
      for (const file of files) await uploadScreenshot(attemptId, file);
      return true;
    } catch {
      return false;
    }
  }

  async function save(input: SaveInput) {
    const current = cases[caseIndex];
    if (!current || !selectedGroupId) return;
    const signature = JSON.stringify([current.code, input.result, input.note, input.consoleText, reserved?.id ?? null]);
    const payload: SubmitPayload = {
      result: input.result,
      note: input.note,
      console_text: input.consoleText,
      idempotency_key: keyFor(signature)
    };
    setSubmitting(true);
    setStatus(null);
    try {
      const saved = reserved && commitReserved
        ? await commitReserved(reserved.id, payload)
        : await submit(selectedGroupId, current.code, payload);
      setLastAttemptId(saved.id);
      setReserved(null);
      setAttempts(await loadAttempts(selectedGroupId, current.code));
      await refreshProgress(selectedGroupId);
      void loadSync?.(selectedGroupId).then(setSync).catch(() => undefined);
      const uploaded = await uploadAll(saved.id, images);
      setStatus(
        uploaded
          ? { tone: "saved", text: "已保存到本地 · Lark 同步待确认（Plan 03）" }
          : { tone: "error", text: "结果已保存到本地，但截图上传失败" }
      );
      if (uploaded) setImages([]);
    } catch (reason) {
      setStatus({ tone: "error", text: `保存失败：${message(reason)}，可重试` });
    } finally {
      setSubmitting(false);
    }
  }

  async function retryUpload() {
    if (!lastAttemptId) return;
    setSubmitting(true);
    const uploaded = await uploadAll(lastAttemptId, images);
    setSubmitting(false);
    setStatus(
      uploaded
        ? { tone: "saved", text: "截图已全部上传" }
        : { tone: "error", text: "截图上传仍然失败，请稍后重试" }
    );
    if (uploaded) setImages([]);
  }

  async function startRetest() {
    const current = cases[caseIndex];
    if (!current || !selectedGroupId || !reserveRetest) return;
    setSubmitting(true);
    try {
      const attempt = await reserveRetest(selectedGroupId, current.code);
      setReserved(attempt);
      setStatus({ tone: "info", text: `已预留重测 ${attempt.label}，提交后生效` });
    } catch (reason) {
      setStatus({ tone: "error", text: `无法开始重测：${message(reason)}` });
    } finally {
      setSubmitting(false);
    }
  }

  // Keyboard shortcuts must not submit while a request is in flight, and the
  // failure shortcut only opens the note field because the note is mandatory.
  function quickSave(result: AttemptResult) {
    if (submitting || !cases[caseIndex]) return;
    formRef.current?.setResult(result);
    void save({ result, note: null, consoleText: null });
  }

  function revealFailure() {
    if (submitting || !cases[caseIndex]) return;
    formRef.current?.setResult("不通过");
    formRef.current?.focusNote();
  }

  const keyHandlers: CaseKeyHandlers = {
    enabled: !submitting,
    onPass: () => quickSave("通过"),
    onFail: revealFailure,
    onSkip: () => quickSave("未执行"),
    onPrevious: () => void showCase(caseIndex - 1),
    onNext: () => void showCase(caseIndex + 1),
    onBack: () => void showCase(caseIndex - 1),
    onTogglePiP: () => void pip.toggle(deskRef.current),
    onEscape: () => pip.close()
  };
  const keyHandlersRef = useRef(keyHandlers);
  keyHandlersRef.current = keyHandlers;
  useCaseKeys(keyHandlers);

  useEffect(() => {
    const pipDocument = pip.pipWindow?.document;
    if (!pipDocument) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (dispatchCaseKey(event, keyHandlersRef.current)) event.preventDefault();
    };
    pipDocument.addEventListener("keydown", onKeyDown);
    return () => pipDocument.removeEventListener("keydown", onKeyDown);
  }, [pip.pipWindow]);

  const activeCase = cases[caseIndex];

  return (
    <section className="workspace-section execution-layout" aria-labelledby="execution-title">
      <h1 className="visually-hidden" id="execution-title">用例执行</h1>
      <aside className="execution-groups">
        <div className="section-heading">
          <div><p className="eyebrow">GROUPS</p><h2>测试组</h2></div>
        </div>
        {loadingGroups ? (
          <p className="inline-status"><LoaderCircle className="spin" size={16} />正在加载</p>
        ) : (
          <GroupSelector
            groups={groups}
            selectedId={selectedGroupId}
            progress={progress}
            onSelect={(groupId) => void selectGroup(groupId)}
          />
        )}
      </aside>

      <div className="execution-desk" ref={deskRef}>
        <div className="execution-toolbar">
          <span className="shortcut-hint" title="Enter 通过 · Backspace 不通过 · Ctrl+B 未执行 · ←/→ 切换用例 · Ctrl+P 画中画">
            <Keyboard size={15} />
            Enter 通过 · Backspace 不通过 · Ctrl+B 未执行 · ←/→ 切换
          </span>
          <button
            type="button"
            className="ghost-button"
            disabled={!pip.supported}
            aria-pressed={pip.pipWindow !== null}
            title={pip.supported ? "在独立小窗口中查看当前用例（Ctrl+P）" : "当前浏览器不支持画中画"}
            onClick={() => void pip.toggle(deskRef.current)}
          >
            <PictureInPicture2 size={16} />
            {pip.pipWindow ? "关闭画中画" : "画中画"}
          </button>
        </div>
        {pip.supported ? null : <p className="inline-status">当前浏览器不支持画中画，执行工作台可继续使用。</p>}
        {failure ? <p className="inline-status error" role="alert">{failure}</p> : null}
        {activeCase ? (
          <>
            <CaseDetail
              testCase={activeCase}
              position={caseIndex + 1}
              total={cases.length}
              onPrevious={() => void showCase(caseIndex - 1)}
              onNext={() => void showCase(caseIndex + 1)}
            />
            {loadingCase ? (
              <p className="inline-status"><LoaderCircle className="spin" size={16} />读取执行记录</p>
            ) : (
              <History attempts={attempts} />
            )}
            <div className="outcome-panel">
              <div className="outcome-heading">
                <h3>录入结果</h3>
                {sync ? (
                  <span className={`sync-badge ${sync.confirmed ? "confirmed" : "unconfirmed"}`}>
                    {sync.confirmed
                      ? `Lark 目标已确认 · 待同步 ${sync.pending_attempts} 条`
                      : "Lark 未确认：结果仅保存在本地"}
                  </span>
                ) : null}
                {reserveRetest ? (
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={submitting || attempts.length === 0}
                    onClick={() => void startRetest()}
                  >
                    <PlayCircle size={16} />开始重测
                  </button>
                ) : null}
              </div>
              <OutcomeForm
                ref={formRef}
                onSave={(input) => void save(input)}
                submitting={submitting}
                images={images}
                onImagesChange={setImages}
                status={status}
                onRetryUpload={() => void retryUpload()}
              />
            </div>
          </>
        ) : loadingCase ? (
          <p className="inline-status"><LoaderCircle className="spin" size={16} />正在加载用例</p>
        ) : (
          <div className="empty-list"><span>该测试组暂无用例</span></div>
        )}
      </div>
    </section>
  );
}
