import { expect, test, type Page } from "@playwright/test";

// The three prompt filenames differ in length (AI-CASE-PROMPT.md is much
// shorter than AI-CASEBOOK-PROMPT.md). With `flex-wrap: wrap` the action row
// therefore wrapped for the long names and stayed on one line for the short
// one, so the three cards disagreed inside a single screen and flipped again
// when the viewport crossed the grid's column threshold.
const PROMPTS = [
  {
    id: "cases",
    title: "文本用例 → 可导入格式",
    summary: "把手上没有配图的用例整理成 CSV / JSON / Markdown。",
    filename: "AI-CASE-PROMPT.md",
    markdown: "# 文本用例提示词"
  },
  {
    id: "casebook",
    title: "用例 + 原型图 → 带图用例包",
    summary: "把已有用例和导出的设计稿图片整理成 casebook.json。",
    filename: "AI-CASEBOOK-PROMPT.md",
    markdown: "# 带图用例包提示词"
  },
  {
    id: "case-results",
    title: "已有用例 + 实测结果 → 可导入格式",
    summary: "把已经跑过一轮的用例连同结果与实测过程一起转译成可导入文件。",
    filename: "AI-CASE-RESULT-PROMPT.md",
    markdown: "# 实测结果提示词"
  }
];

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { email: "admin@example.test" } });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrf_token: "test-csrf" } });
    if (url.pathname === "/api/groups") return route.fulfill({ json: [] });
    if (url.pathname === "/api/ai-prompts") return route.fulfill({ json: PROMPTS });
    return route.fulfill({ status: 404, json: { detail: "Not mocked" } });
  });
}

async function openImportPage(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.locator(".ai-prompt-card")).toHaveCount(PROMPTS.length);
}

type ActionRow = {
  actionsHeight: number;
  copyY: number;
  downloadY: number;
  copyWidth: number;
  downloadWidth: number;
  cardWidth: number;
  cardTop: number;
};

function measure(page: Page) {
  return page.$$eval(".ai-prompt-actions", (nodes) =>
    nodes.map((node) => {
      const [copy, download] = [...node.querySelectorAll("button")].map((button) =>
        button.getBoundingClientRect()
      );
      const card = (node.closest(".ai-prompt-card") as HTMLElement).getBoundingClientRect();
      return {
        actionsHeight: (node as HTMLElement).offsetHeight,
        copyY: Math.round(copy.y),
        downloadY: Math.round(download.y),
        copyWidth: Math.round(copy.width),
        downloadWidth: Math.round(download.width),
        cardWidth: Math.round(card.width),
        cardTop: Math.round(card.top)
      };
    })
  ) as Promise<ActionRow[]>;
}

// At 1024px the card grid drops to two columns, which makes the cards *wider*
// (387px -> 459px) - that is why the bug flipped as the window narrowed, so
// every width from 1920 down to 1024 is checked.
for (const width of [1920, 1440, 1280, 1024]) {
  test(`AI prompt cards use one action layout at ${width}px`, async ({ page }) => {
    await openImportPage(page, width);
    const rows = await measure(page);
    const label = `@${width}px ${JSON.stringify(rows)}`;

    // 1. Every card's action row is exactly as tall as its siblings. Before the
    // fix this was 40 / 84 / 84 at 1440 and 40 / 40 / 40 at 1024.
    const heights = [...new Set(rows.map((row) => row.actionsHeight))];
    expect(heights, `action rows disagree in height ${label}`).toHaveLength(1);

    // 2. Copy on top, filename below - in every card.
    for (const [index, row] of rows.entries()) {
      expect(row.downloadY, `card ${index + 1} is not stacked ${label}`).toBeGreaterThan(row.copyY);
    }

    // 3. Equal action-row heights put the copy buttons on one horizontal line -
    // for the cards that share a grid row. At 1024px the third card wraps to a
    // grid row of its own, where a different y is the layout, not the bug.
    const rowsByTop = new Map<number, number[]>();
    for (const row of rows) rowsByTop.set(row.cardTop, [...(rowsByTop.get(row.cardTop) ?? []), row.copyY]);
    for (const [cardTop, copyTops] of rowsByTop) {
      expect(
        [...new Set(copyTops)],
        `copy buttons in the grid row at y=${cardTop} are not aligned ${label}`
      ).toHaveLength(1);
    }

    // 4. Buttons keep their natural width: a column flex container with
    // `align-items: stretch` would blow them up to the full card width.
    for (const [index, row] of rows.entries()) {
      expect(row.copyWidth, `copy button is stretched in card ${index + 1} ${label}`).toBeLessThan(row.cardWidth);
      expect(row.downloadWidth, `filename button is stretched in card ${index + 1} ${label}`).toBeLessThan(
        row.cardWidth
      );
    }
  });
}
