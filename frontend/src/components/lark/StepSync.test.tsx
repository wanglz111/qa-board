import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SyncStatus } from "../../api";
import { StepSync } from "./StepSync";

function sync(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    confirmed: true,
    queued: 0,
    synced: 0,
    failed: 0,
    uncertain: 0,
    parked: 0,
    last_error_kind: null,
    last_error: null,
    pending_attempts: 0,
    detail: "",
    ...overrides
  };
}

function renderSync(overrides: Partial<Parameters<typeof StepSync>[0]> = {}) {
  const onEnqueue = vi.fn();
  const onRetry = vi.fn();
  const view = render(
    <StepSync
      sync={sync()}
      confirmed
      queueing={false}
      retrying={false}
      onEnqueue={onEnqueue}
      onRetry={onRetry}
      {...overrides}
    />
  );
  return { ...view, onEnqueue, onRetry };
}

describe("StepSync", () => {
  it("keeps the healthy state to one stats row and one button (门 4)", () => {
    const { container } = renderSync({ sync: sync({ queued: 2, synced: 5, pending_attempts: 3 }) });

    const stats = container.querySelector(".lark-queue > .inline-status") as HTMLElement;
    expect(stats).toHaveTextContent("待同步 2 · 已同步 5 · 失败 0 · 待人工确认 0 · 待管理员处理 0");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(container.querySelectorAll(".attachment-hint")).toHaveLength(0);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    // 降级不是删除：那句「同步只新增执行记录…」现在住在按钮的 title 里
    expect(screen.getByRole("button", { name: /排入同步/ }).getAttribute("title")).toContain(
      "同步只新增执行记录"
    );
  });

  it("enqueues saved results and retries failures with the counts in the label", async () => {
    const user = userEvent.setup();
    const { onEnqueue, onRetry } = renderSync({ sync: sync({ failed: 3, pending_attempts: 2 }) });

    await user.click(screen.getByRole("button", { name: /排入同步/ }));
    expect(onEnqueue).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /重试失败的同步（3 条）/ }));
    expect(onRetry).toHaveBeenCalledWith(false);
  });

  it("shows the parked explanation only while rows are actually parked", () => {
    const { container } = renderSync({ sync: sync({ parked: 2, pending_attempts: 1 }) });

    const hints = Array.from(container.querySelectorAll<HTMLElement>(".attachment-hint"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent("2 条记录正在等待管理员处理，不会自行同步");
    expect(screen.getByRole("button", { name: /重新指向当前目标表（2 条）/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /释放待人工确认/ })).toBeNull();
  });

  it("still speaks up for parked rows when the group is unconfirmed", () => {
    const { container } = renderSync({ sync: sync({ parked: 2 }), confirmed: false });

    expect(container.querySelector(".lark-queue")).toHaveTextContent("2 条记录正在等待管理员处理，不会自行同步");
    expect(container.querySelector(".lark-queue")).toHaveTextContent("本组目前尚未确认写入目标，这些记录不会同步。");
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent("重新指向当前目标表（2 条）");
  });

  it("renders nothing when there is neither a confirmation nor a parked row", () => {
    const { container } = renderSync({ confirmed: false });

    expect(container.firstChild).toBeNull();
  });

  it("speaks up for local results it cannot queue yet, and never offers a button that would 409", () => {
    const { container } = renderSync({
      sync: sync({ confirmed: false, pending_attempts: 3 }),
      confirmed: false
    });

    expect(container.querySelector(".lark-queue")).toHaveTextContent(
      "本地已保存 3 条结果，但这一组还没有确认写入目标"
    );
    // 未确认时不给排队按钮：/sync/enqueue 对未确认的目标直接拒绝。
    expect(screen.queryByRole("button", { name: /排入同步/ })).toBeNull();
  });

  it("explains an empty queue instead of leaving a dead grey button", () => {
    const { container } = renderSync({ sync: sync({ pending_attempts: 0 }) });

    expect(container.querySelector(".lark-queue")).toHaveTextContent("没有可排入的本地结果");
    expect(screen.getByRole("button", { name: /排入同步/ })).toBeDisabled();
  });

  it("warns before releasing uncertain rows and shows last_error as an alert", async () => {
    const user = userEvent.setup();
    const { container, onRetry } = renderSync({
      sync: sync({
        failed: 1,
        uncertain: 1,
        last_error_kind: "create_execution_failed",
        last_error: "Lark 拒绝了这一行：字段「结果」不存在",
        pending_attempts: 1
      })
    });

    expect(screen.getByText(/释放待人工确认前/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /释放待人工确认（1 条）/ }));
    expect(onRetry).toHaveBeenCalledWith(true);

    expect(screen.getByRole("alert")).toHaveTextContent("Lark 拒绝了这一行：字段「结果」不存在");
    expect(container.querySelector(".lark-queue > .inline-status")).toHaveTextContent(
      "最近错误 create_execution_failed"
    );
  });
});
