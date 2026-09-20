import { expect, test, type Page } from "@playwright/test";

// The three prompt filenames differ in length (AI-CASE-PROMPT.md is much
// shorter than AI-CASEBOOK-PROMPT.md). With `flex-wrap: wrap` the action row
// therefore wrapped for the long names and stayed on one line for the short
// one, so the three cards disagreed inside a single screen and flipped again
// when the viewport crossed the grid's column threshold.
// The summaries are copied verbatim from backend/app/prompts.py so the cards
// are the height they really are on the page.
const PROMPTS = [
  {
    id: "cases",
    title: "文本用例 → 可导入格式",
    summary: "把手上没有配图的用例整理成 CSV / JSON / Markdown，导入后直接执行。",
    filename: "AI-CASE-PROMPT.md",
    markdown: "# 文本用例提示词"
  },
  {
    id: "casebook",
    title: "用例 + 原型图 → 带图用例包",
    summary: "把已有用例和导出的设计稿图片整理成 casebook.json，导入后可以逐条核对原型。",
    filename: "AI-CASEBOOK-PROMPT.md",
    markdown: "# 带图用例包提示词"
  },
  {
    id: "case-results",
    title: "已有用例 + 实测结果 → 可导入格式",
    summary: "把已经跑过一轮的用例连同结果与实测过程一起转译成可导入文件，通过的带结果入库，没结论的留空。",
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
  actionsContentWidth: number;
  copyY: number;
  downloadY: number;
  copyWidth: number;
  downloadWidth: number;
  copyLines: number;
  downloadLines: number;
  cardWidth: number;
  cardTop: number;
};

// `clientWidth` is the action row's *content* box - the width a stretched flex
// item would be blown up to. Comparing the buttons against the card's
// border-box width instead let `align-items: stretch` (the rule the ticket
// forbids) pass unnoticed, because the card is 14px of padding wider than that.
function measureActionRows(page: Page) {
  return page.$$eval(".ai-prompt-actions", (nodes): ActionRow[] =>
    nodes.map((node) => {
      const row = node as HTMLElement;
      const [copy, download] = [...row.querySelectorAll("button")];
      const [copyBox, downloadBox] = [copy, download].map((button) => button.getBoundingClientRect());
      const card = (row.closest(".ai-prompt-card") as HTMLElement).getBoundingClientRect();

      // Counting the line boxes a button's text occupies says "the filename
      // still fits on one line" without pinning a pixel height that a font
      // change would break.
      const textLines = (button: Element) => {
        const text = [...button.childNodes].find((child) => child.nodeType === Node.TEXT_NODE);
        if (!text) return 0;
        const range = document.createRange();
        range.selectNodeContents(text);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      };

      return {
        actionsHeight: row.offsetHeight,
        actionsContentWidth: row.clientWidth,
        copyY: Math.round(copyBox.y),
        downloadY: Math.round(downloadBox.y),
        copyWidth: Math.round(copyBox.width),
        downloadWidth: Math.round(downloadBox.width),
        copyLines: textLines(copy),
        downloadLines: textLines(download),
        cardWidth: Math.round(card.width),
        cardTop: Math.round(card.top)
      };
    })
  );
}

// The four widths the ticket measured, plus 720 / 480 / 360 as regression
// widths: the bug was width-dependent (480 used to be 40/40/84), and 360 is the
// narrowest width the repo's own mobile e2e targets. 1920 / 1440 / 1280 share
// one layout - `.main-content` is capped at 1280px - but they are kept because
// they are the widths the ticket reported.
for (const width of [1920, 1440, 1280, 1024, 720, 480, 360]) {
  test(`AI prompt cards use one action layout at ${width}px`, async ({ page }) => {
    await openImportPage(page, width);
    const rows = await measureActionRows(page);
    const label = `@${width}px ${JSON.stringify(rows)}`;

    // 1. Every card's action row is exactly as tall as its siblings. Before the
    // fix this was 40 / 84 / 84 at 1440 and 40 / 40 / 40 at 1024.
    const heights = [...new Set(rows.map((row) => row.actionsHeight))];
    expect(heights, `action rows disagree in height ${label}`).toHaveLength(1);

    // 2. Every filename still fits on one line - otherwise all three rows could
    // grow to the same wrong height and pass assertion 1.
    for (const [index, row] of rows.entries()) {
      expect(row.copyLines, `copy label wrapped in card ${index + 1} ${label}`).toBe(1);
      expect(row.downloadLines, `filename wrapped in card ${index + 1} ${label}`).toBe(1);
    }

    // 3. Copy on top, filename below - in every card.
    for (const [index, row] of rows.entries()) {
      expect(row.downloadY, `card ${index + 1} is not stacked ${label}`).toBeGreaterThan(row.copyY);
    }

    // 4. Equal action-row heights put the copy buttons on one horizontal line -
    // for the cards that share a grid row. At some widths the third card wraps
    // to a grid row of its own, where a different y is the layout, not the bug.
    const rowsByTop = new Map<number, number[]>();
    for (const row of rows) rowsByTop.set(row.cardTop, [...(rowsByTop.get(row.cardTop) ?? []), row.copyY]);
    for (const [cardTop, copyTops] of rowsByTop) {
      expect(
        [...new Set(copyTops)],
        `copy buttons in the grid row at y=${cardTop} are not aligned ${label}`
      ).toHaveLength(1);
    }

    // 5. Buttons keep their natural width: `align-items: stretch` (forbidden by
    // the ticket) would blow them up to the action row's full content width.
    for (const [index, row] of rows.entries()) {
      expect(row.copyWidth, `copy button is stretched in card ${index + 1} ${label}`).toBeLessThan(
        row.actionsContentWidth
      );
      expect(row.downloadWidth, `filename button is stretched in card ${index + 1} ${label}`).toBeLessThan(
        row.actionsContentWidth
      );
    }
  });
}
