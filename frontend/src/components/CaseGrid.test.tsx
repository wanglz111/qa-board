import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { GroupCase } from "../api";
import { CaseGrid } from "./CaseGrid";

// Same shape the Execution suite builds; latest_result is the field this
// component reads, so it is a parameter instead of a fixed value.
function testCase(
  code: string,
  title: string,
  latestResult: GroupCase["latest_result"]
): GroupCase {
  return {
    id: `case-${code}`,
    code,
    position: 1,
    title,
    module: "账户",
    layer: "服务层",
    priority: "P0",
    preconditions: null,
    test_data: null,
    steps: "打开登录页并提交凭据",
    expected: null,
    expect_absent: [],
    visual_check: "text_and_visual",
    prototype_note: null,
    reference_assets: [],
    latest_result: latestResult
  };
}

// One case per tone, in legend order.
function fourTones(): GroupCase[] {
  return [
    testCase("B-001", "登录成功", "通过"),
    testCase("B-002", "登录失败", "不通过"),
    testCase("B-003", "跳过登录", "未执行"),
    testCase("B-004", "没跑过登录", null)
  ];
}

// Deliberately NOT in legend order, and not one of each: a square coloured by
// its array position, or a legend written as a constant, would still match a
// fixture laid out in tone order.
function shuffledTones(): GroupCase[] {
  return [
    testCase("B-004", "没跑过登录", null),
    testCase("B-005", "也没跑过登录", null),
    testCase("B-002", "登录失败", "不通过"),
    testCase("B-001", "登录成功", "通过"),
    testCase("B-006", "又通过", "通过"),
    testCase("B-003", "跳过登录", "未执行")
  ];
}

const TONES = ["passed", "failed", "skipped", "untested"] as const;

// toHaveClass only checks a subset, so "has passed" must be paired with the
// negatives before it means "this square is green and nothing else".
function expectOnlyTone(square: HTMLElement, tone: (typeof TONES)[number]) {
  for (const other of TONES) {
    if (other === tone) {
      expect(square).toHaveClass(other);
    } else {
      expect(square).not.toHaveClass(other);
    }
  }
}

function legendFor(squares: HTMLElement[]): string {
  const count = (tone: (typeof TONES)[number]) =>
    squares.filter((square) => square.classList.contains(tone)).length;
  return `通过 ${count("passed")} · 不通过 ${count("failed")} · 跳过 ${count("skipped")} · 未测 ${count("untested")}`;
}

function renderGrid(cases: GroupCase[], caseIndex = 0) {
  const onJump = vi.fn<(index: number) => void>();
  render(<CaseGrid cases={cases} caseIndex={caseIndex} onJump={onJump} />);
  return { onJump };
}

describe("CaseGrid", () => {
  it("gives each result its own square colour", () => {
    renderGrid(fourTones());

    const squares = screen.getAllByRole("button");
    expect(squares).toHaveLength(4);
    expectOnlyTone(squares[0], "passed");
    expectOnlyTone(squares[1], "failed");
    expectOnlyTone(squares[2], "skipped");
    expectOnlyTone(squares[3], "untested");
  });

  it("colours a square by its result, not by its position", () => {
    renderGrid(shuffledTones());

    const squares = screen.getAllByRole("button");
    expectOnlyTone(squares[0], "untested");
    expectOnlyTone(squares[1], "untested");
    expectOnlyTone(squares[2], "failed");
    expectOnlyTone(squares[3], "passed");
    expectOnlyTone(squares[4], "passed");
    expectOnlyTone(squares[5], "skipped");
  });

  it("marks only the current case", () => {
    renderGrid(fourTones(), 1);

    const squares = screen.getAllByRole("button");
    expect(squares[1]).toHaveAttribute("aria-current", "true");
    expect(squares[1]).toHaveClass("current");
    for (const index of [0, 2, 3]) {
      expect(squares[index]).not.toHaveAttribute("aria-current");
      expect(squares[index]).not.toHaveClass("current");
    }
  });

  it("jumps to the index of the clicked square", async () => {
    const user = userEvent.setup();
    const { onJump } = renderGrid(fourTones());

    const squares = screen.getAllByRole("button");
    await user.click(squares[2]);
    await user.click(squares[0]);

    expect(onJump).toHaveBeenNthCalledWith(1, 2);
    expect(onJump).toHaveBeenNthCalledWith(2, 0);
  });

  it("counts the legend from the same squares", () => {
    renderGrid(fourTones());

    expect(screen.getByText("通过 1 · 不通过 1 · 跳过 1 · 未测 1")).toBeInTheDocument();
  });

  it("keeps the legend agreeing with the squares it was given", () => {
    renderGrid(shuffledTones());

    const squares = screen.getAllByRole("button");
    expect(screen.getByText("通过 2 · 不通过 1 · 跳过 1 · 未测 2")).toBeInTheDocument();
    expect(screen.getByText(legendFor(squares))).toBeInTheDocument();
  });

  it("names each square with its code and state, and titles it with the case", () => {
    renderGrid(fourTones());

    expect(screen.getByRole("button", { name: "B-001 通过" })).toHaveAttribute(
      "title",
      "B-001 登录成功"
    );
    expect(screen.getByRole("button", { name: "B-003 未执行" })).toHaveAttribute(
      "title",
      "B-003 跳过登录"
    );
    // A case nobody has run has no result to name, so it reads as 未测.
    expect(screen.getByRole("button", { name: "B-004 未测" })).toHaveAttribute(
      "title",
      "B-004 没跑过登录"
    );
    expect(screen.getByRole("button", { name: "B-002 不通过" })).toHaveAttribute(
      "title",
      "B-002 登录失败"
    );
  });
});
