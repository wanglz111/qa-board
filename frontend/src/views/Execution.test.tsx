import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type {
  Attempt,
  Group,
  GroupCase,
  GroupProgress,
  LegacyHistory as LegacyHistoryData,
  ReferenceAsset,
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

  // Stepping back to re-read a finished case is part of "where the operator
  // is"; reopening after that must not send them forward again.
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
