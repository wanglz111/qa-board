import { expect, test, type Page, type Route } from "@playwright/test";

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/auth/me") return route.fulfill({ json: { email: "admin@example.test" } });
    if (pathname === "/api/auth/csrf") return route.fulfill({ json: { csrf_token: "test-csrf" } });
    if (pathname === "/api/groups") {
      return route.fulfill({
        json: [
          { id: "0918-id", name: "Sprint 0918", source_name: "0918.csv", source_version: "3", count: 14, created_at: "2026-09-16T08:00:00Z" }
        ]
      });
    }
    if (pathname === "/api/lark/check") {
      return route.fulfill({
        json: {
          base_name: "旧版测试管理",
          execution_table_name: "执行记录",
          bug_table_name: "缺陷记录",
          execution_fields: { 用例: "text", 结果: "single_select", 截图: "attachment" },
          bug_fields: { 问题描述: "text", 进展状态: "single_select" },
          required_execution_fields: ["用例", "结果", "截图"],
          required_bug_fields: ["问题描述", "进展状态"],
          schema_errors: [],
          read_errors: [],
          schema_fingerprint: "schema-1",
          target_fingerprint: "target-1"
        }
      });
    }
    if (pathname === "/api/groups/0918-id/lark/confirmation") {
      return route.fulfill({
        json: {
          confirmed: false,
          confirmation: null,
          current: {
            base_token: "app-token",
            execution_table_id: "tbl-runs",
            bug_table_id: "tbl-defects",
            base_name: "旧版测试管理",
            execution_table_name: "执行记录",
            bug_table_name: "缺陷记录",
            schema_fingerprint: "schema-1",
            target_fingerprint: "target-1",
            schema_errors: [],
            read_errors: []
          }
        }
      });
    }
    if (pathname === "/api/groups/0918-id/sync") {
      return route.fulfill({
        json: {
          confirmed: false,
          queued: 0,
          synced: 0,
          failed: 0,
          uncertain: 0,
          last_error_kind: null,
          pending_attempts: 3,
          detail: "尚未确认目标表，本地结果不会写入 Lark"
        }
      });
    }
    return route.fulfill({ json: {} });
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
  test(`${viewport} Lark check shows real names and blocks writes until consent`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    await expect(page.getByText("旧版测试管理")).toBeVisible();
    await expect(page.getByText("执行记录", { exact: true })).toBeVisible();
    await expect(page.getByText("缺陷记录", { exact: true })).toBeVisible();
    await expect(page.getByText(/尚未确认：本地结果不会写入 Lark/)).toBeVisible();

    const confirmButton = page.getByRole("button", { name: /确认本组写入目标/ });
    await expect(confirmButton).toBeDisabled();
    await page.getByLabel("允许向上述旧表新增本组记录").check();
    await expect(confirmButton).toBeEnabled();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task2-lark-check-${viewport}.png`, fullPage: true });
  });
}
