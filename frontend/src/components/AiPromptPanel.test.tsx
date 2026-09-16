import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { AiPromptPanel } from "./AiPromptPanel";

const prompts = [
  {
    id: "cases",
    title: "文本用例 → 可导入格式",
    summary: "把手上没有配图的用例整理成 CSV。",
    filename: "AI-CASE-PROMPT.md",
    markdown: "# 文本用例提示词"
  },
  {
    id: "casebook",
    title: "用例 + 原型图 → 带图用例包",
    summary: "把用例和设计稿整理成 casebook.json。",
    filename: "AI-CASEBOOK-PROMPT.md",
    markdown: "# 带图用例包提示词"
  }
];

it("lists both prompts with a copy action", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<AiPromptPanel prompts={prompts} />);

  expect(screen.getByText("文本用例 → 可导入格式")).toBeVisible();
  expect(screen.getByText("用例 + 原型图 → 带图用例包")).toBeVisible();

  await userEvent.click(screen.getAllByRole("button", { name: "复制提示词" })[1]);

  expect(writeText).toHaveBeenCalledWith("# 带图用例包提示词");
  expect(await screen.findByText("已复制")).toBeVisible();
});

it("renders a download action per prompt", () => {
  render(<AiPromptPanel prompts={prompts} />);

  expect(
    screen.getByRole("button", { name: "下载 AI-CASEBOOK-PROMPT.md" })
  ).toBeVisible();
});
