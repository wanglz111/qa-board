import { expect, test, type Page, type Route } from "@playwright/test";

const GROUP_ID = "0918-id";

// One conflict row: the local attempt and the table record disagree on 结果.
const DIFF = {
  source: "live",
  source_table_name: "执行记录",
  read_errors: [],
  counts: { same: 0, local_only: 0, remote_only: 0, conflict: 1, unmatched: 0 },
  unresolved: 1,
  rows: [
    {
      key: "B-001",
      case_code: "B-001",
      label: "B-001",
      status: "conflict",
      differing: ["result"],
      local: { attempt_id: "a-1", result: "通过", console_text: null },
      remote: { record_id: "r-1", result: "不通过", console_text: null },
      decision: null
    }
  ]
};

type Decision = { key: string; action: string };

async function mockApi(page: Page, decisions: Decision[]) {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    if (pathname === "/api/auth/me") {
      return route.fulfill({ json: { email: "admin@example.test" } });
    }
    if (pathname === "/api/auth/csrf") {
      return route.fulfill({ json: { csrf_token: "test-csrf" } });
    }
    if (pathname === "/api/groups") {
      return route.fulfill({
        json: [
          {
            id: GROUP_ID,
            name: "Sprint 0918",
            source_name: "0918.csv",
            source_version: "3",
            count: 14,
            created_at: "2026-09-16T08:00:00Z"
          }
        ]
      });
    }
    if (pathname === `/api/groups/${GROUP_ID}/reconcile` && method === "GET") {
      return route.fulfill({ json: DIFF });
    }
    if (pathname === `/api/groups/${GROUP_ID}/reconcile/apply` && method === "POST") {
      const body = request.postDataJSON() as { decisions: Decision[] };
      decisions.push(...body.decisions);
      return route.fulfill({ json: { pulled: 1, kept: 0, skipped: [] } });
    }
    return route.fulfill({ json: {} });
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
  test(`${viewport} reconcile adopts a table row behind the append confirmation`, async ({ page }) => {
    await page.setViewportSize(
      viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 }
    );
    const decisions: Decision[] = [];
    await mockApi(page, decisions);
    await page.goto("/");
    await page.getByRole("button", { name: "对账" }).click();

    await expect(page.getByText("冲突", { exact: true })).toBeVisible();
    await expect(page.getByText(/一致 0 · 仅本地 0 · 仅表里 0 · 冲突 1/)).toBeVisible();

    await page.getByLabel("选择 B-001").check();
    await page.getByRole("button", { name: "采用表内记录（1）" }).click();

    // The request waits for the confirmation: nothing is adopted before it.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("新增一条");
    await expect(dialog).toContainText("本地原始记录和截图会原样保留");
    expect(decisions).toHaveLength(0);

    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task5-reconcile-${viewport}.png`, fullPage: true });

    await dialog.getByRole("button", { name: "确认采用" }).click();
    await expect(page.getByText("已拉回 1 条 · 保留 0 条")).toBeVisible();
    expect(decisions).toEqual([{ key: "B-001", action: "use_remote" }]);
  });
}
