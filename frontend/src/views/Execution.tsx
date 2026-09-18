import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Keyboard, LoaderCircle, PictureInPicture2, PlayCircle } from "lucide-react";

import type {
  Attempt,
  AttemptResult,
  Group,
  GroupCase,
  GroupProgress,
  LegacyHistory as LegacyHistoryData,
  Screenshot,
  SubmitPayload,
  SyncStatus
} from "../api";
import { ApiError } from "../api";
import { toneOf, type Tone } from "../caseTone";
import { CaseDetail } from "../components/CaseDetail";
import { CaseGrid } from "../components/CaseGrid";
import { GroupSelector } from "../components/GroupSelector";
import { History } from "../components/History";
import { LegacyHistory } from "../components/LegacyHistory";
import {
  OutcomeForm,
  type OutcomeFormHandle,
  type SaveInput,
  type SaveStatus
} from "../components/OutcomeForm";
import { allTested, clearCursor, nextUntestedIndex, readCursor, startIndexFor, writeCursor } from "../executionCursor";
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
  screenshotUrl?: (screenshotId: string) => string;
  loadSync?: (groupId: string) => Promise<SyncStatus>;
  loadLegacyHistory?: (groupId: string, code: string) => Promise<LegacyHistoryData>;
  legacyAttachmentUrl?: (refId: string, index: number) => string;
  referenceAssetUrl?: (assetId: string) => string;
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

// A rejected `commitReserved` cannot be retried into success with an edited
// payload: the row is already committed (the earlier attempt landed and only its
// read-back failed), the edited payload mints a new key, no row carries that key,
// and `submit_attempt` refuses with 409 「Attempt is already committed」. The only
// other 409 the route answers is an idempotency-key collision, which the
// signature — it carries this reservation's own id — rules out in practice. Both
// mean "this save did not land", which is all the message claims.
function isAlreadyCommitted(reason: unknown) {
  return reason instanceof ApiError && reason.status === 409;
}

// A read is not trusted to have the shape its type promises: an unmocked
// `/api/groups/:id/cases` answers `{}`, and a non-array that reaches the render
// body throws while the grid counts iterate it — React then unmounts the whole
// tree and the operator gets a blank page. Anything that is not a list degrades
// to the empty state the desk already knows how to show.
function asCaseList(value: unknown): GroupCase[] {
  return Array.isArray(value) ? (value as GroupCase[]) : [];
}

// The worker drains its outbox every few seconds, so a badge read once per save
// would claim work is still waiting long after the row reached Lark.
const SYNC_POLL_MS = 3000;

export function ExecutionView({
  loadGroups,
  loadCases,
  loadProgress,
  loadAttempts,
  submit,
  reserveRetest,
  commitReserved,
  uploadScreenshot,
  screenshotUrl,
  loadSync,
  loadLegacyHistory,
  legacyAttachmentUrl,
  referenceAssetUrl,
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
  const [inFlight, setInFlight] = useState(0);
  const [images, setImages] = useState<File[]>([]);
  const [status, setStatus] = useState<SaveStatus | null>(null);
  const [reserved, setReserved] = useState<Attempt | null>(null);
  const [failure, setFailure] = useState("");
  const [lastAttemptId, setLastAttemptId] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [legacyVersion, setLegacyVersion] = useState(0);
  // "A request is in flight" is a count, not a flag: a save and a retest
  // reservation are two different requests, and with one boolean the
  // reservation's `finally` released the save's spinner while that save was still
  // on the wire — which re-armed the keyboard shortcuts and the save button
  // mid-save. No test can tell the count apart from the boolean any more (the one
  // entry that made the overlap reachable, `LegacyHistory`'s 复测 button, is
  // `disabled` now), so the count is the invariant written into the structure
  // rather than a behaviour a test pins.
  const submitting = inFlight > 0;
  const beginRequest = () => setInFlight((count) => count + 1);
  // Floored at zero: a stray release must not leave the counter negative, where
  // the next request would bring it back to `0` and the desk would look idle
  // while it is still waiting on the server.
  const endRequest = () => setInFlight((count) => Math.max(0, count - 1));
  // The visit identity: it increments on exactly the two events that move the
  // desk (`selectGroup`, `showCase`), so a save that outlives several awaits
  // compares it to tell whether the operator is still on the case it belongs to.
  const caseRequest = useRef(0);
  // Which group the cases currently in state were loaded for. A save outlives
  // several awaits while the group list stays clickable, so it has to check this
  // before touching a list the operator may already have replaced.
  const loadedGroup = useRef<string | null>(null);
  const deskMountRef = useRef<HTMLDivElement>(null);
  const [deskHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "execution-desk";
    return host;
  });
  const formRef = useRef<OutcomeFormHandle>(null);
  const keyFor = useIdempotencyKey();
  const pip = usePiP();

  useLayoutEffect(() => {
    deskMountRef.current?.append(deskHost);
  }, [deskHost]);
  // Stable per-group loader: a fresh closure here would re-fetch on every render.
  const legacyLoader = useCallback(
    (code: string) => {
      if (!loadLegacyHistory || !selectedGroupId) {
        return Promise.reject(new Error("未选择测试组"));
      }
      return loadLegacyHistory(selectedGroupId, code);
    },
    [loadLegacyHistory, selectedGroupId]
  );

  // A save only queues the write; the worker reaches Lark a few seconds later.
  // So while something is genuinely queued the page keeps asking, and the
  // legacy panel is re-read once the queue drains — otherwise the badge counts
  // every local result as 待同步 forever and the panel keeps its pre-save
  // snapshot ("旧表没有该用例的失败记录") even though the row is already there.
  const syncDraining = sync !== null && sync.queued > (sync.parked ?? 0);
  useEffect(() => {
    if (!loadSync || !selectedGroupId || !syncDraining) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      loadSync(selectedGroupId)
        .then((latest) => {
          if (cancelled) return;
          setSync(latest);
          if (latest.queued === 0) setLegacyVersion((version) => version + 1);
        })
        .catch(() => {
          // Leave the numbers as they are; the next save or group switch reads again.
        });
    }, SYNC_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [loadSync, selectedGroupId, sync, syncDraining]);

  useEffect(() => {
    let cancelled = false;
    loadGroups()
      .then((result) => {
        if (cancelled) return;
        setGroups(result);
        // Reopening the page should land on the group the operator was working
        // in, not on whichever group the server lists first.
        const remembered = readCursor();
        // A cursor naming a group that is gone can never be honoured again, so
        // drop it here rather than letting it fall through silently on every
        // later open.
        if (remembered && !result.some((group) => group.id === remembered.groupId)) {
          clearCursor();
        }
        const rememberedGroup = remembered?.groupId ?? null;
        const preferred =
          result.find((group) => group.id === initialGroupId) ??
          result.find((group) => group.id === rememberedGroup) ??
          result[0];
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
    // Invalidate before the round trip below, not after it: `loadedGroup` is the
    // authority the case-scoped writes read, and the list it stands for is gone
    // from this line on. One round-trip of truth lag is enough for a save still
    // in flight to repaint this group's cases under the new selection.
    loadedGroup.current = null;
    setCaseIndex(0);
    setAttempts([]);
    setReserved(null);
    setLastAttemptId(null);
    setImages([]);
    setStatus(null);
    // Defence in depth: clearing `cases` above unmounts <OutcomeForm>, so its
    // state (note, result, console, validation) dies with the instance anyway.
    // This line does not depend on that unmount happening.
    formRef.current?.reset();
    setFailure("");
    setSync(null);
    setLoadingCase(true);
    void loadProgress(groupId)
      .then((stats) => setProgress((current) => ({ ...current, [groupId]: stats })))
      .catch(() => undefined);
    void loadSync?.(groupId).then(setSync).catch(() => undefined);
    try {
      // Guarded here, before the value is stored or counted: everything below
      // (the start index, the progress line, the grid) reads this same list.
      const result = asCaseList(await loadCases(groupId));
      if (requestId !== caseRequest.current) return;
      setCases(result);
      loadedGroup.current = groupId;
      // Resume where the operator left off, else at the first case nobody has
      // run. This is the whole point of the page: coming back after a break
      // must not mean re-reading the first row of the group.
      const start = startIndexFor(result, readCursor(), groupId);
      setCaseIndex(start);
      const current = result[start];
      if (current) {
        writeCursor({ groupId, code: current.code });
        const history = await loadAttempts(groupId, current.code);
        if (requestId === caseRequest.current) setAttempts(history);
      }
    } catch (reason) {
      if (requestId === caseRequest.current) setFailure(message(reason));
    } finally {
      if (requestId === caseRequest.current) setLoadingCase(false);
    }
  }

  async function showCase(index: number, options: { keepStatus?: boolean } = {}) {
    const target = cases[index];
    if (!target || !selectedGroupId) return;
    const requestId = ++caseRequest.current;
    setCaseIndex(index);
    writeCursor({ groupId: selectedGroupId, code: target.code });
    setAttempts([]);
    setReserved(null);
    // A retry button must never point at another case's attempt: leaving the case
    // retires the id it was offered for.
    setLastAttemptId(null);
    setImages([]);
    // Moving on by hand abandons the previous save message; moving on because the
    // save just landed keeps it, so the operator sees the proof on the case they
    // were sent to.
    if (!options.keepStatus) setStatus(null);
    // A note typed for one case must never be submitted under the next one.
    formRef.current?.reset();
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
    // The case and the group this save belongs to. Both are snapshotted: the
    // awaits below are long enough for the operator to switch groups, and two
    // groups can hold the same code.
    const savedGroupId = selectedGroupId;
    const savedIndex = caseIndex;
    // The visit this save belongs to. `caseRequest` increments on exactly the two
    // "the desk moved" events (`selectGroup`, `showCase`), so it is the visit
    // identity: an index snapshot cannot tell "never left" from "left and came
    // back to the same case".
    const savedVisit = caseRequest.current;
    const saved = cases[savedIndex];
    if (!saved || !savedGroupId) return;
    // The group is part of the key. `Attempt.idempotency_key` is unique across the
    // whole table and the server dedupes on it, so two groups holding the same
    // code and given an identical payload would otherwise share one key: the
    // second save reads as a replay of the first and answers 409 「Idempotency key
    // conflict」, and every retry mints the same key again (the signature behind it
    // has not changed), so the result is never stored until the operator edits
    // something or reloads.
    const signature = JSON.stringify([
      savedGroupId,
      saved.code,
      input.result,
      input.note,
      input.consoleText,
      reserved?.id ?? null
    ]);
    const payload: SubmitPayload = {
      result: input.result,
      note: input.note,
      console_text: input.consoleText,
      idempotency_key: keyFor(signature)
    };
    beginRequest();
    setStatus(null);
    // Whether this save commits a reservation or creates a row. The catch needs
    // it: a rejected commit is a different animal from a rejected create.
    const committingReservation = Boolean(reserved && commitReserved);
    let advanceTo: number | null = null;
    // Whether the row is stored is the one thing the catch below has to know:
    // everything after the submit is *reading back* a save that already landed,
    // and calling that 「保存失败…可重试」 invites the operator to edit the note and
    // save again — which appends a second row for a result that was stored the
    // first time. The flag is set the moment the await answers, before any read.
    let stored = false;
    try {
      const attempt = reserved && commitReserved
        ? await commitReserved(reserved.id, payload)
        : await submit(savedGroupId, saved.code, payload);
      stored = true;
      // The retry id is a case-scoped thing: it is the id 重试上传截图 would
      // upload the files on screen into. `showCase` retires it on the way out, so
      // a save that lands after the operator moved must not hand it back —
      // otherwise the next case's attachments get filed against this attempt.
      if (loadedGroup.current === savedGroupId && caseRequest.current === savedVisit) {
        setLastAttemptId(attempt.id);
      }
      const history = await loadAttempts(savedGroupId, saved.code);
      // The panel under the case on screen must show *that* case's history: a
      // save that landed while the operator pressed ←/→ would otherwise paint the
      // case it belongs to over the one they are reading.
      if (loadedGroup.current === savedGroupId && caseRequest.current === savedVisit) {
        setAttempts(history);
      }
      await refreshProgress(savedGroupId);
      // The cases were loaded once. Without this the operator who just recorded
      // the last result would not see 本组已全部测过 until they reloaded. The
      // response is the authority on the result, and the list is only touched
      // while it is still this group's. `updated` feeds the advance decision
      // below as well, but honestly: `nextUntestedIndex` never inspects index
      // `from`, so the saved row's own `latest_result` cannot move the jump
      // target — this array is here for `setCases` and the banner.
      const updated = cases.map((item) =>
        item.code === saved.code ? { ...item, latest_result: attempt.result } : item
      );
      if (loadedGroup.current === savedGroupId) setCases(asCaseList(updated));
      let confirmed = sync?.confirmed ?? false;
      if (loadSync) {
        try {
          const latestSync = await loadSync(savedGroupId);
          // The badge belongs to whatever group is on screen, so a save that
          // outlived a group switch must not write its numbers into it.
          if (loadedGroup.current === savedGroupId) setSync(latestSync);
          confirmed = latestSync.confirmed;
        } catch {
          // The badge keeps its previous value; the save itself already succeeded.
        }
      }
      const uploaded = await uploadAll(attempt.id, images);
      // The confirmation follows the operator to the next case, so it names the
      // case it is about.
      // Deliberately outside the guard: this is a notification that an event
      // happened, not a description of the desk, and it names its own case
      // (`{code} 已保存到本地 · …`) — gating it would silently swallow the
      // confirmation for a save that outlived a group switch.
      setStatus(
        uploaded
          ? {
              tone: "saved",
              text: confirmed
                ? `${saved.code} 已保存到本地 · 将新增到 Lark 旧表`
                : `${saved.code} 已保存到本地 · 尚未确认 Lark 目标表`
            }
          : { tone: "error", text: `${saved.code} 结果已保存到本地，但截图上传失败` }
      );
      // A failed upload keeps the attachments: the reset below only clears the
      // form's own four fields, so the file stays on screen for 重试上传截图 and
      // the retry still names this attempt — the desk does not move on either.
      // A *successful* upload clears them, but only on the visit the save belongs
      // to: clearing them after the operator moved would throw away the
      // attachments they have meanwhile added for the case now on screen —
      // evidence they believe is attached, lost without a word.
      if (loadedGroup.current === savedGroupId && caseRequest.current === savedVisit) {
        if (uploaded) setImages([]);
      }
      // One guard for both effects. `save()` outlives a case switch (it takes
      // several awaits while the ←/→ buttons stay clickable), so by now the form
      // on screen may belong to a *different* case: clearing it would throw away
      // what the operator typed there, and jumping would steal their choice of
      // where to be — coming back to the same case is still a move, which is why
      // the visit token decides and not the index. This is the mirror of the bug
      // being fixed — a lost draft instead of a misattributed one.
      // The group half is belt and braces here: every group switch bumps
      // `caseRequest` too, so the visit token already implies it and no test can
      // tell whether this conjunct ran — keep it as the readable statement of
      // what the guard is about.
      if (loadedGroup.current === savedGroupId && caseRequest.current === savedVisit) {
        formRef.current?.reset();
        // Retire the reservation this save consumed — and only here, once every
        // read this save owns has finished. Retiring it right after the commit
        // meant a read that then failed left the operator holding a stored row and
        // no reservation: pressing save again minted a *different* key (the
        // signature carries the reservation id) and appended a second row for a
        // result that was already stored. Holding it keeps that retry idempotent —
        // same reservation, same key, so the server answers with the row it has.
        // The narrowing only clears the reservation this save consumed: one the
        // operator made is theirs, and a reservation made while this save was in
        // flight is unreachable through the UI now (`LegacyHistory`'s 复测 button
        // is `disabled`), but the identity check stays as the statement of
        // ownership rather than as a behaviour some test pins.
        setReserved((current) => (current?.id === reserved?.id ? null : current));
        // The text is stored, but the evidence is not: staying on this case is
        // what keeps the screenshot attached to the attempt it belongs to and
        // the retry button pointed at the right record. Advancing here would
        // hand the next case a retry that uploads into this one.
        advanceTo = uploaded ? nextUntestedIndex(updated, savedIndex) : null;
      }
    } catch (reason) {
      setStatus(
        stored
          ? {
              // The row is stored; only a read that follows it failed. Same shape
              // as the failed-upload line above: say what landed, name what did
              // not, and offer no retry that would store the result twice.
              tone: "error",
              text: `${saved.code} 结果已保存到本地，但执行记录读取失败（${message(reason)}）`
            }
          : {
              // The submit request itself was rejected: nothing was stored, so the
              // form must keep the note for the retry — unless this was a
              // reservation the server has already committed. That one can never
              // be retried into success once the payload is edited (the signature
              // carries the payload, so the edit mints a new key that no row
              // carries, and the route refuses the attempt it already committed).
              // 「可重试」 there is the same false invitation this defect is about,
              // one layer down: the way out is to reload, not to press save again.
              tone: "error",
              text:
                committingReservation && isAlreadyCommitted(reason)
                  ? `重测 ${reserved?.label ?? ""} 已经提交过，这次修改没有保存：刷新页面后可重新提交`
                  : `保存失败：${message(reason)}，可重试`
            }
      );
    } finally {
      endRequest();
    }
    // The advance sits outside the `try`, so nothing it does can be reported as
    // 「保存失败」.
    if (advanceTo !== null) await showCase(advanceTo, { keepStatus: true });
  }

  async function retryUpload() {
    if (!lastAttemptId) return;
    beginRequest();
    let uploaded = false;
    try {
      uploaded = await uploadAll(lastAttemptId, images);
    } catch {
      // `uploadAll` reports a failed upload by returning false today, but the
      // count must not depend on that: one rejection escaping here would leave
      // the counter above zero and lock the save button and the keyboard
      // shortcuts for the rest of the session.
      uploaded = false;
    } finally {
      endRequest();
    }
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
    const requestedGroupId = selectedGroupId;
    const requestedVisit = caseRequest.current;
    beginRequest();
    try {
      const attempt = await reserveRetest(requestedGroupId, current.code);
      // A reservation that arrives after the desk moved is dropped: `save()`
      // prefers `commitReserved(reserved.id, …)` whenever `reserved` is set, so
      // keeping it would commit the new case's result into the old case's
      // attempt. Dropping loses nothing — the reservation is still `started` and
      // carries no result.
      if (loadedGroup.current !== requestedGroupId || caseRequest.current !== requestedVisit) return;
      setReserved(attempt);
      setStatus({ tone: "info", text: `已预留重测 ${attempt.label}，提交后生效` });
    } catch (reason) {
      setStatus({ tone: "error", text: `无法开始重测：${message(reason)}` });
    } finally {
      endRequest();
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
    onTogglePiP: () => void pip.toggle(deskHost),
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
  // The sidebar grid and the desk's progress line are two renderings of the same
  // array, so both read `toneOf` rather than counting for themselves: one
  // classification means the two renderings agree for *any* input — including a
  // row the server omits `latest_result` from — and the four numbers stay a
  // partition of `cases` by construction.
  const counts: Record<Tone, number> = { passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const item of cases) counts[toneOf(item.latest_result)] += 1;
  const { passed, failed, skipped, untested } = counts;
  // 「未执行」 is a decision — the operator looked and said so — hence `done`, but
  // it is neither 通过 nor 不通过.
  const done = passed + failed + skipped;

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
        {cases.length > 0 ? (
          <CaseGrid
            cases={cases}
            caseIndex={caseIndex}
            // Clicking the square of the case already on screen must be a
            // no-op: `showCase` resets the form, so re-entering the current
            // case would silently wipe a half-typed 失败说明.
            onJump={(index) => {
              if (index !== caseIndex) void showCase(index);
            }}
          />
        ) : null}
      </aside>

      <div className="execution-desk-mount" ref={deskMountRef} />
      {createPortal(
        <>
        <div className="execution-toolbar">
          <span className="shortcut-hint" title="Enter 通过 · Backspace 不通过 · Ctrl+B 未执行 · ←/→ 切换用例 · Ctrl+P 画中画">
            <Keyboard size={15} />
            Enter 通过 · Backspace 不通过 · Ctrl+B 未执行 · ←/→ 切换
          </span>
          {/* The sidebar grid — and the legend that names all four counts with
              it — is left behind when the desk moves into the PiP window, so the
              line spells every count out instead of using marks: `✓1 ✗0 ○1` read
              as if nothing had been skipped. */}
          {cases.length > 0 ? (
            <span
              className="desk-progress"
              title={`通过 ${passed} · 不通过 ${failed} · 跳过 ${skipped} · 未测 ${untested}`}
              aria-label={`已测 ${done} / ${cases.length}：通过 ${passed}，不通过 ${failed}，跳过 ${skipped}，未测 ${untested}`}
            >
              {done}/{cases.length} · 通过{passed} 不通过{failed} 跳过{skipped} 未测{untested}
            </span>
          ) : null}
          <button
            type="button"
            className="ghost-button"
            disabled={!pip.supported}
            aria-pressed={pip.pipWindow !== null}
            title={pip.supported ? "在独立小窗口中查看当前用例（Ctrl+P）" : "当前浏览器不支持画中画"}
            onClick={() => void pip.toggle(deskHost)}
          >
            <PictureInPicture2 size={16} />
            {pip.pipWindow ? "关闭画中画" : "画中画"}
          </button>
        </div>
        {pip.supported ? null : <p className="inline-status">当前浏览器不支持画中画，执行工作台可继续使用。</p>}
        {failure ? <p className="inline-status error" role="alert">{failure}</p> : null}
        {activeCase ? (
          <>
            {/* Landing on the last row of a finished group is not the operator's
                answer to "what is left?" — say it out loud. No role="status":
                the save confirmation announces at the same moment, and two
                polite regions speaking at once read as noise. */}
            {allTested(cases) ? (
              <p className="inline-status saved">本组已全部测过</p>
            ) : null}
            <CaseDetail
              testCase={activeCase}
              position={caseIndex + 1}
              total={cases.length}
              onPrevious={() => void showCase(caseIndex - 1)}
              onNext={() => void showCase(caseIndex + 1)}
              referenceAssetUrl={referenceAssetUrl}
            />
            {loadingCase ? (
              <p className="inline-status"><LoaderCircle className="spin" size={16} />读取执行记录</p>
            ) : (
              <History attempts={attempts} screenshotUrl={screenshotUrl} />
            )}
            {loadLegacyHistory && selectedGroupId && activeCase ? (
              <LegacyHistory
                code={activeCase.code}
                loadHistory={legacyLoader}
                attachmentUrl={legacyAttachmentUrl}
                attempts={attempts}
                screenshotUrl={screenshotUrl}
                onStartRetest={reserveRetest ? () => void startRetest() : undefined}
                retestDisabled={submitting}
                reservedLabel={reserved?.label ?? null}
                reloadKey={legacyVersion}
              />
            ) : null}
            <div className="outcome-panel">
              <div className="outcome-heading">
                <h3>录入结果</h3>
                {sync ? (
                  <span className={`sync-badge ${sync.confirmed ? "confirmed" : "unconfirmed"}`}>
                    {sync.confirmed
                      ? `Lark 目标已确认 · 待同步 ${sync.queued} 条 · 已同步 ${sync.synced} 条`
                      : "Lark 未确认：结果仅保存在本地"}
                    {/* A queue that stops draining has to say so here: "待同步 3 ·
                        已同步 0" with a hidden failure reads as a slow worker. The
                        reason itself belongs to the Lark check page. */}
                    {sync.confirmed && (sync.failed ?? 0) > 0 ? ` · 失败 ${sync.failed}` : ""}
                    {sync.confirmed && (sync.parked ?? 0) > 0
                      ? ` · 待管理员处理 ${sync.parked}`
                      : ""}
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
        </>,
        deskHost
      )}
    </section>
  );
}
