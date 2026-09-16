import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { TargetChangeDialog, type TargetSide } from "./TargetChangeDialog";

const PREVIOUS: TargetSide = {
  execution_table_name: "执行记录",
  execution_table_id: "tbl-runs",
  bug_table_name: "缺陷记录",
  bug_table_id: "tbl-bugs"
};

const NEXT: TargetSide = {
  ...PREVIOUS,
  execution_table_name: "缺陷记录",
  execution_table_id: "tbl-bugs"
};

function renderDialog(overrides: Partial<Parameters<typeof TargetChangeDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <TargetChangeDialog
      previous={PREVIOUS}
      next={NEXT}
      pendingAttempts={3}
      busy={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />
  );
  return { onCancel, onConfirm };
}

it("is a modal dialog that lists the changed table as 旧 → 新 and the consequences", () => {
  renderDialog();

  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveTextContent("执行记录 → 缺陷记录");
  expect(dialog).toHaveTextContent("tbl-runs → tbl-bugs");
  expect(dialog).toHaveTextContent("已排队的同步任务");
  expect(dialog).toHaveTextContent("写入确认会被清除");
  expect(dialog).toHaveTextContent("3 条已保存的本地记录");
  // The defect role did not move, so it is not offered as a change.
  expect(dialog).not.toHaveTextContent("缺陷记录 → 缺陷记录");
  // The overlay styling belongs to this dialog alone, not to any future modal.
  expect(dialog.parentElement).toHaveClass("target-change-overlay");
});

it("cancels without confirming and blocks both buttons while saving", async () => {
  const { onCancel, onConfirm } = renderDialog();

  await userEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "确认切换" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("disables both commands while the acknowledged save is in flight", () => {
  renderDialog({ busy: true });

  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /确认切换/ })).toBeDisabled();
});

it("takes focus on mount and lets Escape cancel", async () => {
  const { onCancel, onConfirm } = renderDialog();

  expect(screen.getByRole("button", { name: /确认切换/ })).toHaveFocus();

  await userEvent.keyboard("{Escape}");

  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("keeps Tab inside the dialog instead of reaching the page behind it", async () => {
  renderDialog();
  const cancel = screen.getByRole("button", { name: "取消" });
  const confirm = screen.getByRole("button", { name: /确认切换/ });

  // The primary command is first, so Tab wraps to the start of the dialog.
  expect(confirm).toHaveFocus();
  await userEvent.tab();
  expect(cancel).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(confirm).toHaveFocus();
});

it("omits the record count when the page holds no sync status", () => {
  renderDialog({ pendingAttempts: null });

  expect(screen.getByRole("dialog")).not.toHaveTextContent("条已保存的本地记录");
});
