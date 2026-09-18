import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { LarkTarget } from "../../api";
import { StepApprove } from "./StepApprove";

const TARGET: LarkTarget = {
  group_id: "grp-1",
  source_url: "https://example.larksuite.com/base/app-exec",
  execution_base_token: "app-exec",
  execution_base_name: "执行库",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-exec",
  bug_base_name: "执行库",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: null,
  target_fingerprint: "fp-1",
  confirmed_at: "2026-09-18T00:00:00Z",
  confirmed: true
};

// 勾选由 props 持有，所以这里必须有一个真的会变的 allowWrites，否则「勾选后按钮变可用」测不出来。
function renderApprove(overrides: Partial<Parameters<typeof StepApprove>[0]> = {}) {
  const onAllowWrites = vi.fn();
  const onConfirm = vi.fn();
  function Wrapper() {
    const [allowWrites, setAllowWrites] = useState(overrides.allowWrites ?? false);
    return (
      <StepApprove
        target={TARGET}
        confirmed
        invalidated={false}
        blocked={false}
        busy={false}
        {...overrides}
        allowWrites={allowWrites}
        onAllowWrites={(value) => {
          onAllowWrites(value);
          setAllowWrites(value);
        }}
        onConfirm={onConfirm}
      />
    );
  }
  const view = render(<Wrapper />);
  return { ...view, onAllowWrites, onConfirm };
}

const CONSENT = "允许向上述旧表新增本组记录";
const CONFIRM = "确认本组写入目标";

describe("StepApprove", () => {
  it("says what is confirmed and only arms the confirm button after the consent box", async () => {
    const user = userEvent.setup();
    const { onAllowWrites, onConfirm } = renderApprove();

    expect(screen.getByRole("status")).toHaveTextContent("已确认 执行记录 / 缺陷记录");
    expect(screen.getByRole("button", { name: CONFIRM })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: CONSENT }));
    expect(onAllowWrites).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole("button", { name: CONFIRM }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables both controls when the confirmation was invalidated", () => {
    renderApprove({ invalidated: true, blocked: true, allowWrites: true });

    expect(screen.getByRole("status")).toHaveTextContent("目标表字段已变化，此前的确认已失效，需要重新确认");
    expect(screen.getByRole("checkbox", { name: CONSENT })).toBeDisabled();
    expect(screen.getByRole("button", { name: CONFIRM })).toBeDisabled();
  });

  it("disables both controls while the target is blocked, and never calls it confirmed", () => {
    renderApprove({ confirmed: false, blocked: true, allowWrites: true });

    expect(screen.getByRole("status")).toHaveTextContent("尚未确认：本地结果不会写入 Lark");
    expect(screen.getByRole("checkbox", { name: CONSENT })).toBeDisabled();
    expect(screen.getByRole("button", { name: CONFIRM })).toBeDisabled();
  });

  it("shows the busy spinner and refuses a second confirm while one is in flight", () => {
    const { onConfirm } = renderApprove({ allowWrites: true, busy: true });

    const confirm = screen.getByRole("button", { name: CONFIRM });
    expect(confirm).toBeDisabled();
    expect(confirm.querySelector("svg")).not.toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
