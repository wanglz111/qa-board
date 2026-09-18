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
      remote_deleted: false,
      local: { attempt_id: "a-1", result: "通过", console_text: null },
      remote: { record_id: "r-1", result: "不通过", console_text: null },
      decision: null
    }
  ]
};

// The administrator deleted this record in Lark: only the local row is left.
const RECORD_DELETED = {
  source: "live",
  source_table_name: "执行记录",
  read_errors: [],
  counts: { same: 0, local_only: 1, remote_only: 0, conflict: 0, unmatched: 0 },
  unresolved: 1,
  rows: [
    {
      key: "B-013",
      case_code: "B-013",
      label: "B-013",
      status: "local_only",
      differing: [],
      remote_deleted: true,
      local: { attempt_id: "a-2", result: "不通过", console_text: "wallet.bind timeout" },
      remote: null,
      decision: null
    }
  ]
};

type Decision = { key: string; action: string };

async function mockApi(page: Page, decisions: Decision[], diff: unknown = DIFF) {
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
      return route.fulfill({ json: diff });
    }
    if (pathname === `/api/groups/${GROUP_ID}/reconcile/apply` && method === "POST") {
      const body = request.postDataJSON() as { decisions: Decision[] };
      decisions.push(...body.decisions);
      // Answer what it did, like the server does, so the receipt the page shows
      // is the one this fixture actually asked for.
      const count = (action: string) =>
        body.decisions.filter((decision) => decision.action === action).length;
      return route.fulfill({
        json: {
          pulled: count("use_remote"),
          kept: count("use_local"),
          removed: count("delete_local"),
          skipped: []
        }
      });
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

  test(`${viewport} reconcile deletes a local row whose record left the table`, async ({ page }) => {
    await page.setViewportSize(
      viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 }
    );
    const decisions: Decision[] = [];
    await mockApi(page, decisions, RECORD_DELETED);
    await page.goto("/");
    await page.getByRole("button", { name: "对账" }).click();

    // "仅本地" would read as "this tool never filed it" — the opposite
    // situation, and the one that cannot be deleted.
    await expect(page.getByText("表里已删除", { exact: true })).toBeVisible();
    await expect(page.getByText("仅本地", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "删除本地记录（0）" })).toBeDisabled();

    await page.getByLabel("选择 B-013").check();
    await page.getByRole("button", { name: "删除本地记录（1）" }).click();

    // Deleting waits for the confirmation, and the confirmation says what goes.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("删除本地记录？");
    await expect(dialog).toContainText("截图");
    await expect(dialog).toContainText("无法撤销");
    expect(decisions).toHaveLength(0);

    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(noOverflow).toBe(true);
    await page.screenshot({
      path: `test-results/reconcile-delete-${viewport}.png`,
      fullPage: true
    });

    await dialog.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("已拉回 0 条 · 保留 0 条 · 删除 1 条")).toBeVisible();
    expect(decisions).toEqual([{ key: "B-013", action: "delete_local" }]);
  });
}
