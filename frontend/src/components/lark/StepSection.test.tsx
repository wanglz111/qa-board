import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { StepSection } from "./StepSection";

describe("StepSection", () => {
  it("collapses to the title row plus the summary", () => {
    const { container } = render(
      <StepSection index={1} title="选表" summary="两张表都已校验" state="todo" onOpen={vi.fn()}>
        <p>展开后才有</p>
      </StepSection>
    );

    const title = screen.getByRole("button", { name: /选表/ });
    expect(title).toHaveTextContent("第 1 步");
    expect(title).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("两张表都已校验")).toBeInTheDocument();
    expect(screen.queryByText("展开后才有")).toBeNull();
    expect(container.querySelector(".lark-step-body")).toBeNull();
  });

  it("renders the body and drops the summary while open", () => {
    render(
      <StepSection index={2} title="表头" summary="缺 2 列" state="open" onOpen={vi.fn()}>
        <p>展开后才有</p>
      </StepSection>
    );

    expect(screen.getByRole("button", { name: /表头/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("展开后才有")).toBeInTheDocument();
    expect(screen.queryByText("缺 2 列")).toBeNull();
  });

  it("gives a disabled step a title nobody can open", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <StepSection index={3} title="确认写入" summary="未确认" state="todo" disabled onOpen={onOpen}>
        <p>展开后才有</p>
      </StepSection>
    );

    const title = screen.getByRole("button", { name: /确认写入/ });
    expect(title).toBeDisabled();
    await user.click(title);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
