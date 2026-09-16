import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import type { Attempt, Group, GroupCase, GroupProgress, SubmitPayload } from "../api";
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

function testCase(id: string, title: string, expected: string | null = null): GroupCase {
  return {
    id,
    code: "B-001",
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
    reference_assets: []
  };
}

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
    created_at: "2026-09-16T09:00:00Z"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    created_at: "2026-09-16T10:00:00Z"
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
