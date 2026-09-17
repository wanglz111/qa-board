import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type {
  Attempt,
  Group,
  GroupCase,
  GroupProgress,
  LegacyHistory as LegacyHistoryData,
  ReferenceAsset,
  Screenshot,
  SubmitPayload,
  SyncStatus
} from "../api";
import { ExecutionView } from "./Execution";

const ZERO_PROGRESS: GroupProgress = { passed: 0, failed: 0, skipped: 0, untested: 1 };

function group(id: string, name: string, sourceName: string): Group {
  return {
    id,
    name,
    source_name: sourceName,
    source_version: "1",
    count: 1,
    created_at: "2026-09-16T08:00:00Z"
  };
}

function testCase(
  id: string,
  title: string,
  expected: string | null = null,
  code = "B-001",
  latestResult: GroupCase["latest_result"] = null
): GroupCase {
  return {
    id,
    code,
    position: 1,
    title,
    module: "账户",
    layer: "服务层",
    priority: "P0",
    preconditions: null,
    test_data: null,
    steps: "打开登录页并提交凭据",
    expected,
    expect_absent: [],
    visual_check: "text_and_visual",
    prototype_note: null,
    reference_assets: [],
    latest_result: latestResult
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

function committed(id: string, label: string, result: Attempt["result"], note: string | null): Attempt {
  return {
    id,
    label,
    sequence: 1,
    state: "committed",
    result,
    note,
    console_text: null,
    source: "execution",
    created_at: "2026-09-16T09:00:00Z",
    screenshots: []
  };
}

function referenceAsset(id: string): ReferenceAsset {
  return {
    id,
    link_id: `${id}-link`,
    asset_key: id,
    name: "节点发售",
    mime: "image/png",
    width: 340,
    height: 1658,
    asset_type: "page",
    screen: "节点发售",
    state: "发售中",
    prototype_version: "v2.0",
    role: "expected",
    caption: null,
    focus: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const EMPTY_LEGACY: LegacyHistoryData = {
  available: true,
  code: "B-001",
  read_errors: [],
  source_table_name: "执行记录",
  base_name: "Untitled bitable",
  bug_table_name: "冒烟测试bug表",
  read_at: "2026-09-17T05:56:38Z",
  certainty: "verified",
  uncertainty: null,
  ambiguous: false,
  original: [],
  retests: [],
  bugs: [],
  unknown_count: 0
};

function syncStatus(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    confirmed: true,
    queued: 0,
    synced: 0,
    failed: 0,
    uncertain: 0,
    parked: 0,
    last_error_kind: null,
    pending_attempts: 0,
    detail: "目标表已确认，可显式排入同步",
    ...overrides
  };
}

// Fake timers do not run promises, so the mount chain needs its own turns.
async function settle(turns = 12) {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderExecution(overrides: Partial<Parameters<typeof ExecutionView>[0]> = {}) {
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockResolvedValue(committed("attempt-1", "B-001", "通过", null));
  const props = {
    loadGroups: async () => [group("0918-id", "Sprint 0918", "0918.csv"), group("0922-id", "Sprint 0922", "0922.csv")],
    loadCases: async (groupId: string) => [
      groupId === "0918-id" ? testCase("case-0918", "管理员登录") : testCase("case-0922", "钱包绑定")
    ],
    loadProgress: async () => ZERO_PROGRESS,
    loadAttempts: async () => [],
    submit,
    ...overrides
  };
  render(<ExecutionView {...props} />);
  return { submit };
}

it("shows only the selected group's case and asks for a failure note", async () => {
  renderExecution({ initialGroupId: "0918-id" });

  expect(await screen.findByText("管理员登录")).toBeVisible();
  expect(screen.queryByText("钱包绑定")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "不通过" }));
  expect(screen.getByLabelText("失败说明")).toBeRequired();
});

it("counts the queue that is still waiting, not every local result, and re-reads the table once it drains", async () => {
  vi.useFakeTimers();
  try {
    const loadSync = vi.fn(async () => syncStatus({ queued: 1, synced: 0, pending_attempts: 3 }));
    const loadLegacyHistory = vi.fn(async () => EMPTY_LEGACY);
    renderExecution({ initialGroupId: "0918-id", loadSync, loadLegacyHistory });

    await settle();
    // Three saved local results are not three unsynced ones: the badge counts
    // the outbox queue, exactly like the Lark check page.
    expect(screen.getByText("Lark 目标已确认 · 待同步 1 条 · 已同步 0 条")).toBeVisible();
    const readsBeforeDrain = loadLegacyHistory.mock.calls.length;

    loadSync.mockResolvedValue(syncStatus({ queued: 0, synced: 1, pending_attempts: 3 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByText("Lark 目标已确认 · 待同步 0 条 · 已同步 1 条")).toBeVisible();
    // The row this page just wrote is only readable after the worker lands it.
    expect(loadLegacyHistory.mock.calls.length).toBe(readsBeforeDrain + 1);
  } finally {
    vi.useRealTimers();
  }
});

it("says a stalled queue has failures or parked rows instead of reading as slow", async () => {
  const loadSync = vi.fn(async () =>
    syncStatus({ queued: 3, synced: 0, failed: 1, parked: 3, pending_attempts: 4 })
  );
  renderExecution({
    initialGroupId: "0918-id",
    loadSync,
    loadLegacyHistory: vi.fn(async () => EMPTY_LEGACY)
  });

  await settle();
  expect(
    screen.getByText("Lark 目标已确认 · 待同步 3 条 · 已同步 0 条 · 失败 1 · 待管理员处理 3")
  ).toBeVisible();
});

it("keeps history aligned with the selected group even when B-001 exists twice", async () => {
  const firstHistory = deferred<Attempt[]>();
  const secondHistory = deferred<Attempt[]>();
  renderExecution({
    initialGroupId: "0918-id",
    loadAttempts: (groupId) => (groupId === "0918-id" ? firstHistory.promise : secondHistory.promise)
  });

  await screen.findByText("管理员登录");
  await userEvent.click(screen.getByText("Sprint 0922"));
  secondHistory.resolve([committed("attempt-0922", "B-001-R0922-01", "不通过", "钱包绑定失败")]);
  expect(await screen.findByText(/钱包绑定失败/)).toBeVisible();

  firstHistory.resolve([committed("attempt-0918", "B-001", "通过", "旧组结果")]);
  expect(screen.queryByText(/旧组结果/)).not.toBeInTheDocument();
});

it("keeps a long failed case readable and requires the note before saving", async () => {
  const longText = "步骤：".concat("打开登录页。".repeat(60));
  const { submit } = renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [{ ...testCase("case-0918", "长文本用例"), steps: longText }]
  });

  const submitButton = await screen.findByRole("button", { name: /保存结果/ });
  expect(screen.getByText(longText)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "不通过" }));
  expect(screen.getByLabelText("失败说明")).toBeRequired();
  await userEvent.click(submitButton);
  expect(submit).not.toHaveBeenCalled();

  await userEvent.type(screen.getByLabelText("失败说明"), "绑定未触发");
  await userEvent.click(submitButton);
  expect(await screen.findByText(/已保存到本地/)).toBeVisible();
});

it("retries an offline failure with the same idempotency key", async () => {
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockRejectedValueOnce(new Error("网络中断"));
  submit.mockResolvedValueOnce(committed("attempt-1", "B-001", "通过", null));
  renderExecution({ initialGroupId: "0918-id", submit });

  await userEvent.click(await screen.findByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));
  expect(await screen.findByText(/保存失败：网络中断/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));
  await screen.findByText(/已保存到本地/);

  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1][2].idempotency_key).toBe(submit.mock.calls[0][2].idempotency_key);
});

it("reserves a retest label before committing it", async () => {
  const reserved: Attempt = {
    id: "attempt-retest",
    label: "B-001-R0918-a1b2c3-01",
    sequence: 2,
    state: "started",
    result: null,
    note: null,
    console_text: null,
    source: "execution",
    created_at: "2026-09-16T10:00:00Z",
    screenshots: []
  };
  const reserveRetest = vi.fn().mockResolvedValue(reserved);
  const commitReserved = vi.fn().mockResolvedValue({ ...reserved, state: "committed", result: "通过" });
  renderExecution({
    initialGroupId: "0918-id",
    loadAttempts: async () => [committed("attempt-1", "B-001", "不通过", "首次失败")],
    reserveRetest,
    commitReserved
  });

  await screen.findByText(/首次失败/);
  await userEvent.click(await screen.findByRole("button", { name: /开始重测/ }));
  expect(await screen.findByText(/已预留重测 B-001-R0918-a1b2c3-01/)).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  expect(commitReserved).toHaveBeenCalledWith("attempt-retest", expect.objectContaining({ result: "通过" }));
});

it("drops a retest reservation that lands after the desk moved", async () => {
  const pendingReserve = deferred<Attempt>();
  const reserved: Attempt = {
    id: "attempt-retest",
    label: "B-001-R0918-a1b2c3-01",
    sequence: 2,
    state: "started",
    result: null,
    note: null,
    console_text: null,
    source: "execution",
    created_at: "2026-09-16T10:00:00Z",
    screenshots: []
  };
  const reserveRetest = vi.fn().mockReturnValue(pendingReserve.promise);
  const commitReserved = vi.fn().mockResolvedValue({ ...reserved, state: "committed", result: "通过" });
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockResolvedValue(committed("attempt-2", "B-002", "通过", null));
  renderExecution({
    initialGroupId: "0918-id",
    submit,
    reserveRetest,
    commitReserved,
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", null)
    ],
    loadAttempts: async (_groupId, code) =>
      code === "B-001" ? [committed("attempt-1", "B-001", "不通过", "首次失败")] : []
  });

  await screen.findByText(/首次失败/);
  await userEvent.click(await screen.findByRole("button", { name: /开始重测/ }));
  // The reserve is on the wire and the ←/→ stepper stays clickable while it is.
  await userEvent.click(screen.getByRole("button", { name: "下一条用例" }));
  expect(await screen.findByText("第二条")).toBeVisible();

  await act(async () => {
    pendingReserve.resolve(reserved);
    await pendingReserve.promise;
  });
  await settle();

  // A reservation for the case the operator left is dropped rather than adopted:
  // `save()` prefers `commitReserved(reserved.id, …)` while `reserved` is set, so
  // adopting it would commit 第二条's result into 第一条's attempt and store
  // nothing at all for 第二条.
  expect(screen.queryByText(/已预留重测/)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  expect(commitReserved).not.toHaveBeenCalled();
  expect(submit).toHaveBeenCalledWith("0918-id", "B-002", expect.anything());
});

it("keeps the saved result when a screenshot upload fails and offers a retry", async () => {
  const uploadScreenshot = vi.fn().mockRejectedValue(new Error("上传失败"));
  renderExecution({ initialGroupId: "0918-id", uploadScreenshot });

  await userEvent.click(await screen.findByRole("button", { name: "通过" }));
  await userEvent.upload(
    screen.getByLabelText("上传截图"),
    new File(["png"], "shot.png", { type: "image/png" })
  );
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  expect(await screen.findByText(/结果已保存到本地，但截图上传失败/)).toBeVisible();
  expect(screen.getByRole("button", { name: /重试上传截图/ })).toBeVisible();
});

it("stays on the case when the result saved but the screenshot did not", async () => {
  const uploadScreenshot = vi.fn().mockRejectedValue(new Error("上传失败"));
  renderExecution({
    initialGroupId: "0918-id",
    uploadScreenshot,
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  expect(await screen.findByText("第一条")).toBeVisible();
  // 不通过 on purpose: it forces a note into 失败说明, which is what makes the
  // reset observable. A 通过 save leaves the box empty either way, so it could
  // not tell whether the guard reset the form at all.
  await userEvent.click(screen.getByRole("button", { name: "不通过" }));
  await userEvent.type(screen.getByLabelText("失败说明"), "截图没有传上去");
  await userEvent.upload(
    screen.getByLabelText("上传截图"),
    new File(["png"], "shot.png", { type: "image/png" })
  );
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  expect(await screen.findByText(/结果已保存到本地，但截图上传失败/)).toBeVisible();
  // The advance runs after the spinner drops, so give its chain its turns before
  // deciding where the desk ended up.
  await settle();
  // The unrun next case is exactly where the unguarded advance would have gone.
  // Staying put is what keeps the screenshot attached to the attempt it belongs
  // to: `showCase` would clear `images` and hand this case's retry to the next.
  expect(screen.getByText("第一条")).toBeVisible();
  expect(screen.queryByText("第二条")).not.toBeInTheDocument();
  // The submit succeeded — only the upload failed — so the save must reset the
  // form regardless: the note is already stored server-side, and leaving it on
  // screen invites the operator to submit it again. This path never moves the
  // desk, so `showCase`'s own reset never runs and the guard's reset is the only
  // thing that can clear this box.
  expect(screen.getByLabelText("失败说明")).toHaveValue("");

  const retry = screen.getByRole("button", { name: /重试上传截图/ });
  expect(retry).toBeVisible();
  await userEvent.click(retry);
  expect(uploadScreenshot).toHaveBeenCalledWith(
    "attempt-1",
    expect.objectContaining({ name: "shot.png" })
  );
});

it("offers no retry that would upload this case's file into the previous case's attempt", async () => {
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockResolvedValueOnce(committed("attempt-1", "B-001", "通过", null));
  submit.mockRejectedValueOnce(new Error("网络中断"));
  const uploadScreenshot = vi
    .fn<(attemptId: string, file: File) => Promise<Screenshot>>()
    .mockResolvedValue({
      id: "shot-1",
      attempt_id: "attempt-1",
      storage_key: "shot-1.png",
      mime: "image/png",
      size_bytes: 3,
      created_at: "2026-09-16T09:00:00Z"
    });
  renderExecution({
    initialGroupId: "0918-id",
    submit,
    uploadScreenshot,
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  await screen.findByText("第一条");
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.upload(
    screen.getByLabelText("上传截图"),
    new File(["png"], "b001.png", { type: "image/png" })
  );
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // The upload succeeded, so the desk advances to the case that is still unrun —
  // which is exactly how "on a new case with the previous case's attempt id"
  // became the normal post-save state.
  expect(await screen.findByText("第二条")).toBeVisible();
  await waitFor(() =>
    expect(uploadScreenshot).toHaveBeenCalledWith(
      "attempt-1",
      expect.objectContaining({ name: "b001.png" })
    )
  );
  const uploadsBeforeRetry = uploadScreenshot.mock.calls.length;

  await userEvent.upload(
    screen.getByLabelText("上传截图"),
    new File(["png"], "b002.png", { type: "image/png" })
  );
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));
  expect(await screen.findByText(/保存失败：网络中断/)).toBeVisible();

  // Nothing of this case's own was stored, so there is no attempt here to retry.
  // The form still offers 重试上传截图 wherever an error status sits next to
  // pending attachments, so the click is what has to be inert: the id the button
  // would use belongs to the previous case's attempt.
  await userEvent.click(screen.getByRole("button", { name: /重试上传截图/ }));
  expect(uploadScreenshot).toHaveBeenCalledTimes(uploadsBeforeRetry);
  expect(uploadScreenshot).not.toHaveBeenCalledWith(
    "attempt-1",
    expect.objectContaining({ name: "b002.png" })
  );
});

it("marks a history row adopted from the table as table-sourced", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadAttempts: async () => [
      committed("attempt-1", "B-001", "不通过", "本地执行"),
      { ...committed("attempt-2", "B-001-R0918-01", "通过", null), source: "reconcile" }
    ]
  });

  await screen.findByText(/本地执行/);
  const badge = screen.getByText("来自表内对账");
  expect(badge).toBeVisible();
  expect(badge.closest("li")).toHaveTextContent("B-001-R0918-01");
  expect(screen.getAllByText("来自表内对账")).toHaveLength(1);
});

it("does not submit or switch cases while a prototype image is zoomed", async () => {
  const loadCases = vi.fn(async () => [
    { ...testCase("case-0918", "管理员登录"), reference_assets: [referenceAsset("a1")] },
    testCase("case-0922", "钱包绑定")
  ]);
  const { submit } = renderExecution({ initialGroupId: "0918-id", loadCases });

  await userEvent.click(
    await screen.findByRole("button", { name: "放大查看 节点发售" })
  );
  expect(screen.getByRole("dialog", { name: "节点发售" })).toBeVisible();

  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Backspace}");
  await userEvent.keyboard("{Control>}b{/Control}");

  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "节点发售" })).toBeVisible();
  expect(screen.getByText("管理员登录")).toBeVisible();
});

it("opens on the first case nobody has run, not on the first row", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null),
      testCase("c3", "第三条", null, "B-003", null)
    ]
  });

  expect(await screen.findByText("第二条")).toBeVisible();
  expect(screen.queryByText("第一条")).not.toBeInTheDocument();
});

it("returns to the case that was being looked at", async () => {
  window.localStorage.setItem(
    "testdeck.execution.cursor",
    JSON.stringify({ groupId: "0918-id", code: "B-003" })
  );
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", "通过"),
      testCase("c3", "第三条", null, "B-003", null)
    ]
  });

  expect(await screen.findByText("第三条")).toBeVisible();
});

it("says so when the whole group has been run", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", "未执行")
    ]
  });

  expect(await screen.findByText("本组已全部测过")).toBeVisible();
});

it("remembers the case once it is opened", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  await screen.findByText("第二条");
  expect(window.localStorage.getItem("testdeck.execution.cursor")).toBe(
    JSON.stringify({ groupId: "0918-id", code: "B-002" })
  );
});

it("announces the finish in the very session that finishes the group", async () => {
  // The cases are loaded once; without patching the saved case's own result the
  // banner cannot appear until a reload, which is the moment it is for.
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  await screen.findByText("第二条");
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(await screen.findByRole("button", { name: /保存结果/ }));

  expect(await screen.findByText("本组已全部测过")).toBeVisible();
});

it("keeps a save from repainting another group's list", async () => {
  const pendingSave = deferred<Attempt>();
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockReturnValue(pendingSave.promise);
  renderExecution({
    initialGroupId: "0918-id",
    submit,
    // Both groups carry a B-001 — this app re-imports the same casebook — so a
    // save can only match its own group's row.
    loadCases: async (groupId) =>
      groupId === "0918-id"
        ? [testCase("a1", "A 组待执行", null, "B-001", null)]
        : [
            testCase("b1", "B 组已完成", null, "B-002", "通过"),
            testCase("b2", "B 组待执行", null, "B-001", null)
          ],
    loadAttempts: async (groupId) =>
      groupId === "0918-id" ? [committed("attempt-a", "B-001", "通过", "A 组的历史结果")] : []
  });

  await screen.findByText("A 组待执行");
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // The save is still on the wire when the operator moves on; the group list
  // stays clickable while it is.
  await userEvent.click(screen.getByText("Sprint 0922"));
  expect(await screen.findByText("B 组待执行")).toBeVisible();

  pendingSave.resolve(committed("attempt-1", "B-001", "通过", null));
  await settle();

  // A's verdict and A's history must not follow the operator into B, whose own
  // B-001 is still the unrun case here.
  expect(screen.queryByText("本组已全部测过")).not.toBeInTheDocument();
  // A regex, not a string: the row renders as 说明：A 组的历史结果.
  expect(screen.queryByText(/A 组的历史结果/)).not.toBeInTheDocument();
  expect(screen.getByText("B 组待执行")).toBeVisible();
});

it("a save that outlives a group switch does not repaint the new group", async () => {
  const pendingSave = deferred<Attempt>();
  const pendingB = deferred<GroupCase[]>();
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockReturnValue(pendingSave.promise);
  renderExecution({
    initialGroupId: "0918-id",
    submit,
    loadGroups: async () => [
      group("0918-id", "Sprint 0918", "0918.csv"),
      group("0922-id", "Sprint 0922", "0922.csv")
    ],
    // A resolves at once; B's cases are held back so the save can land inside the
    // window where A's list is gone and B's has not arrived. A carries *two*
    // cases on purpose: with one, `nextUntestedIndex` returns null and the
    // advance arm of the guard never runs, which is how the group half of it
    // slips past the test above.
    loadCases: (groupId) =>
      groupId === "0918-id"
        ? Promise.resolve([
            testCase("a1", "A 组第一条", null, "B-001", null),
            testCase("a2", "A 组第二条", null, "B-002", null)
          ])
        : pendingB.promise
  });

  expect(await screen.findByText("A 组第一条")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // The group list stays clickable while the save is on the wire.
  await userEvent.click(screen.getByText("Sprint 0922"));
  expect(await screen.findByText("正在加载用例")).toBeVisible();

  // Resolve the save *first*: it completes while B's cases are still pending.
  await act(async () => {
    pendingSave.resolve(committed("attempt-1", "B-001", "通过", null));
    await pendingSave.promise;
  });
  await settle();
  // The window is real — if the save ever finished after B's cases, this test
  // would stop proving anything. And inside that window the save must leave the
  // desk alone: the cursor still names the case the operator left in A, not the
  // one an unguarded advance would have jumped to. That rewrite to A is exactly
  // what the operator saw before 26bb85d.
  expect(window.localStorage.getItem("testdeck.execution.cursor")).toBe(
    JSON.stringify({ groupId: "0918-id", code: "B-001" })
  );
  expect(screen.getByText("正在加载用例")).toBeVisible();

  await act(async () => {
    pendingB.resolve([testCase("b9", "B 组唯一", null, "B-009", null)]);
    await pendingB.promise;
  });
  await settle();

  // B's list and only B's. Unguarded, the save advances into A's *second* case,
  // which bumps `caseRequest`, aborts this very load and rewrites the cursor to A.
  expect(await screen.findByText("B 组唯一")).toBeVisible();
  expect(screen.queryByText("A 组第一条")).not.toBeInTheDocument();
  expect(screen.queryByText("A 组第二条")).not.toBeInTheDocument();

  expect(screen.getByText("Sprint 0922").closest("button")).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Sprint 0918").closest("button")).toHaveAttribute("aria-pressed", "false");

  expect(window.localStorage.getItem("testdeck.execution.cursor")).toBe(
    JSON.stringify({ groupId: "0922-id", code: "B-009" })
  );
});

it("remembers the case the operator walks to, not only the one it landed on", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  expect(await screen.findByText("第二条")).toBeVisible();
  expect(window.localStorage.getItem("testdeck.execution.cursor")).toBe(
    JSON.stringify({ groupId: "0918-id", code: "B-002" })
  );

  // Stepping back to re-read a finished case still moves the cursor: it is
  // written on every case change, finished or not. Reopening does not follow it
  // forward, though — startIndexFor refuses to resume a case that already has a
  // result, so the next open lands on the first unrun case instead.
  await userEvent.click(screen.getByRole("button", { name: "上一条用例" }));
  expect(await screen.findByText("第一条")).toBeVisible();
  expect(window.localStorage.getItem("testdeck.execution.cursor")).toBe(
    JSON.stringify({ groupId: "0918-id", code: "B-001" })
  );
});

it("opens the group the cursor names when the caller does not name one", async () => {
  // App.tsx mounts this view without initialGroupId, so the remembered group is
  // the branch production actually takes.
  window.localStorage.setItem(
    "testdeck.execution.cursor",
    JSON.stringify({ groupId: "0922-id", code: "B-001" })
  );
  renderExecution();

  expect(await screen.findByText("钱包绑定")).toBeVisible();
  expect(screen.queryByText("管理员登录")).not.toBeInTheDocument();
});

it("drops a cursor that names a group the server no longer lists", async () => {
  window.localStorage.setItem(
    "testdeck.execution.cursor",
    JSON.stringify({ groupId: "0917-id", code: "B-001" })
  );
  renderExecution({ loadGroups: async () => [] });

  expect(await screen.findByText("该测试组暂无用例")).toBeVisible();
  // The group is gone, so the cursor can never be honoured again: keeping it
  // would silently steer every later open.
  expect(window.localStorage.getItem("testdeck.execution.cursor")).toBeNull();
});

it("moves to the next unrun case after a save", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null),
      testCase("c3", "第三条", null, "B-003", null)
    ]
  });

  expect(await screen.findByText("第二条")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // The save's own case is done now, so the work that is left is the third one.
  expect(await screen.findByText("第三条")).toBeVisible();
  expect(screen.queryByText("第二条")).not.toBeInTheDocument();
});

it("keeps the save confirmation visible on the case it moved to", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null),
      testCase("c3", "第三条", null, "B-003", null)
    ]
  });

  expect(await screen.findByText("第二条")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // Moving on is exactly what clears the status on a manual switch; on a save it
  // has to survive, and name the case it is about, or the operator cannot tell
  // whether the note they just typed was stored.
  expect(await screen.findByText(/B-002 已保存到本地/)).toBeVisible();
});

it("drops the save confirmation when the operator walks away by hand", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  expect(await screen.findByText("第一条")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // The save carries its confirmation to the case it moved to — that is the
  // whole point of keeping it there.
  expect(await screen.findByText(/B-001 已保存到本地/)).toBeVisible();
  expect(await screen.findByText("第二条")).toBeVisible();

  // Walking back by hand is not the save moving the desk, so the message about a
  // save that did not happen here must not stay on screen claiming otherwise.
  await userEvent.click(screen.getByRole("button", { name: "上一条用例" }));
  expect(await screen.findByText("第一条")).toBeVisible();
  expect(screen.queryByText(/已保存到本地/)).not.toBeInTheDocument();
});

it("wraps to the earliest unrun case when the tail is finished", async () => {
  window.localStorage.setItem(
    "testdeck.execution.cursor",
    JSON.stringify({ groupId: "0918-id", code: "B-003" })
  );
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", "通过"),
      testCase("c3", "第三条", null, "B-003", null)
    ]
  });

  expect(await screen.findByText("第三条")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // The last unrun case was the one on screen; the only work left is above it.
  expect(await screen.findByText("第一条")).toBeVisible();
});

it("stays put and says the group is finished when nothing is left", async () => {
  renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", "通过"),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  expect(await screen.findByText("第二条")).toBeVisible();
  // 不通过 on purpose: it forces a note into 失败说明, which is what makes the
  // reset observable. On a save that moves the desk, `showCase` resets the form
  // itself and hides whether the guard did — no-move paths have no such cover.
  await userEvent.click(screen.getByRole("button", { name: "不通过" }));
  await userEvent.type(screen.getByLabelText("失败说明"), "最后一条也不通过");
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  expect(await screen.findByText("本组已全部测过")).toBeVisible();
  // No unrun case to move to: the desk stays where the operator left it instead
  // of walking off the end of the group.
  expect(screen.getByText("第二条")).toBeVisible();
  // The desk did not move, so `showCase` never ran and its reset never fired: the
  // only thing that can clear this note is the guard's own reset. The save landed
  // with the note stored server-side, so leaving it on screen would invite the
  // operator to submit it again under the next case.
  await settle();
  expect(screen.getByLabelText("失败说明")).toHaveValue("");
});

it("does not submit the previous case's note after moving on", async () => {
  const { submit } = renderExecution({
    initialGroupId: "0918-id",
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  expect(await screen.findByText("第一条")).toBeVisible();
  await userEvent.type(screen.getByLabelText("失败说明"), "第一条的失败说明");
  await userEvent.click(screen.getByRole("button", { name: "下一条用例" }));
  expect(await screen.findByText("第二条")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));
  await screen.findByText(/已保存到本地/);

  // A note written for 第一条 must not be stored as 第二条's.
  expect(submit).toHaveBeenCalledWith("0918-id", "B-002", expect.objectContaining({ note: null }));
});

it("leaves the case the operator moved to alone when the save lands", async () => {
  const pendingSave = deferred<Attempt>();
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockReturnValue(pendingSave.promise);
  // A distinct, non-empty history per case. An empty default could not tell the
  // save's own case's history apart from the history of the case on screen, so it
  // would let a group-only write paint the wrong one and still pass.
  const historyNotes: Record<string, string> = {
    "B-001": "第一条的历史",
    "B-002": "第二条的历史",
    "B-003": "第三条的历史"
  };
  renderExecution({
    initialGroupId: "0918-id",
    submit,
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", null),
      testCase("c3", "第三条", null, "B-003", null)
    ],
    loadAttempts: async (_groupId, code) => [
      committed(`attempt-${code}`, code, "不通过", historyNotes[code] ?? null)
    ]
  });

  await screen.findByText("第一条");
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // A save takes several awaits. The ←/→ buttons stay clickable throughout, so
  // the operator can leave the case the save belongs to and end up somewhere the
  // save has no business deciding about. Two steps, so the place they chose is
  // not also the place an unguarded auto-advance would pick.
  await userEvent.click(screen.getByRole("button", { name: "下一条用例" }));
  await userEvent.click(screen.getByRole("button", { name: "下一条用例" }));
  expect(await screen.findByText("第三条")).toBeVisible();

  // fireEvent, not userEvent.type: the form disables its fields while a save is
  // in flight, and userEvent honours the disabled attribute. The guard is about
  // a draft that exists when the save lands, however it got there.
  fireEvent.change(screen.getByLabelText("失败说明"), { target: { value: "给下一条的话" } });

  await act(async () => {
    pendingSave.resolve(committed("attempt-1", "B-001", "通过", null));
    await pendingSave.promise;
  });
  await waitFor(() => expect(screen.getByText(/已保存到本地/)).toBeVisible());

  // (a) Where the operator is, not where the save would have sent them: an
  // unguarded advance lands on 第二条, the earliest unrun case after B-001.
  expect(screen.getByText("第三条")).toBeVisible();
  expect(screen.queryByText("第二条")).not.toBeInTheDocument();
  // (b) And the draft belongs to the case on screen, not to the save.
  expect(screen.getByLabelText("失败说明")).toHaveValue("给下一条的话");
  // (c) And the panel under 第三条 shows *第三条's* history: the save's own
  // history for B-001 may not be painted over the case the operator is reading.
  await waitFor(() => expect(screen.getByText(/第三条的历史/)).toBeVisible());
  expect(screen.queryByText(/第一条的历史/)).not.toBeInTheDocument();
  expect(screen.queryByText(/第二条的历史/)).not.toBeInTheDocument();
});

it("leaves the desk alone when a save lands after the operator walked away and came back", async () => {
  const pendingSave = deferred<Attempt>();
  const submit = vi.fn<(groupId: string, code: string, payload: SubmitPayload) => Promise<Attempt>>();
  submit.mockReturnValue(pendingSave.promise);
  renderExecution({
    initialGroupId: "0918-id",
    submit,
    loadCases: async () => [
      testCase("c1", "第一条", null, "B-001", null),
      testCase("c2", "第二条", null, "B-002", null)
    ]
  });

  await screen.findByText("第一条");
  await userEvent.click(screen.getByRole("button", { name: "通过" }));
  await userEvent.click(screen.getByRole("button", { name: /保存结果/ }));

  // Away and back: the desk is on the same *case* again, but it is a different
  // visit, and the save has no business deciding anything about it. Comparing the
  // index cannot see this — that is the whole defect the visit token fixes.
  await userEvent.click(screen.getByRole("button", { name: "下一条用例" }));
  expect(await screen.findByText("第二条")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "上一条用例" }));
  expect(await screen.findByText("第一条")).toBeVisible();

  // fireEvent, not userEvent.type: the form disables its fields while a save is
  // in flight, and userEvent honours the disabled attribute.
  fireEvent.change(screen.getByLabelText("失败说明"), { target: { value: "回到第一条补的话" } });

  await act(async () => {
    pendingSave.resolve(committed("attempt-1", "B-001", "通过", null));
    await pendingSave.promise;
  });
  await waitFor(() => expect(screen.getByText(/已保存到本地/)).toBeVisible());

  // An index-shaped guard sees `caseIndex === savedIndex` here and both clears the
  // draft and jumps to 第二条, the earliest unrun case after B-001 — stealing the
  // operator's choice of where to be one round trip after they made it.
  expect(screen.getByText("第一条")).toBeVisible();
  expect(screen.queryByText("第二条")).not.toBeInTheDocument();
  expect(screen.getByLabelText("失败说明")).toHaveValue("回到第一条补的话");
});
