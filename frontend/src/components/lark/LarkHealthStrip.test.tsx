import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Health } from "../../larkDraft";
import { LarkHealthStrip } from "./LarkHealthStrip";

const HEALTHY: Health = {
  tone: "ok",
  text: "已确认 · 执行记录 / 缺陷记录 · 待同步 0 · 失败 0",
  step: null
};

describe("LarkHealthStrip", () => {
  it("is exactly one line and not clickable when there is nowhere to jump", () => {
    const { container } = render(<LarkHealthStrip health={HEALTHY} onJump={vi.fn()} />);

    expect(container.children).toHaveLength(1);
    expect(screen.getByText(HEALTHY.text)).toBeInTheDocument();
    expect(container.querySelector("button")).toBeNull();
    // E2：这一行是 live region，且健康态下没有任何 alert（门 4 的组件层）
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("jumps to the step the health names", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(
      <LarkHealthStrip
        health={{ tone: "bad", text: "已确认，但表头已失效（需重新校验）", step: "headers" }}
        onJump={onJump}
      />
    );

    await user.click(screen.getByRole("button", { name: "已确认，但表头已失效（需重新校验）" }));
    expect(onJump).toHaveBeenCalledWith("headers");
  });

  it("carries the tone on the element so the colour never comes from the text", () => {
    const { container } = render(
      <LarkHealthStrip health={{ tone: "warn", text: "待管理员处理 2 条", step: "sync" }} onJump={vi.fn()} />
    );

    const strip = container.querySelector(".lark-health-strip");
    expect(strip).toHaveAttribute("data-tone", "warn");
    expect(strip).toHaveClass("warn");
  });
});
