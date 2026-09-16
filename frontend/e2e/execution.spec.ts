import { expect, test, type Page } from "@playwright/test";

const LONG_STEPS = "1. 打开登录页并输入管理员凭据\n2. 提交后等待绑定回调\n3. ".padEnd(400, "检查钱包状态与账户余额。");

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    if (pathname === "/api/auth/me") return route.fulfill({ json: { email: "admin@example.test" } });
    if (pathname === "/api/auth/csrf") return route.fulfill({ json: { csrf_token: "test-csrf" } });
    if (pathname === "/api/groups") {
      return route.fulfill({
        json: [
          { id: "0918-id", name: "Sprint 0918", source_name: "0918.csv", source_version: "1", count: 2, created_at: "2026-09-16T08:00:00Z" },
          { id: "0922-id", name: "Sprint 0922", source_name: "0922.csv", source_version: "1", count: 1, created_at: "2026-09-16T08:00:00Z" }
        ]
      });
    }
    if (pathname === "/api/groups/0918-id/progress") {
      return route.fulfill({ json: { passed: 1, failed: 1, skipped: 0, untested: 0 } });
    }
    if (/\/api\/groups\/[^/]+\/progress$/.test(pathname)) {
      return route.fulfill({ json: { passed: 0, failed: 0, skipped: 0, untested: 1 } });
    }
    if (pathname === "/api/groups/0918-id/cases") {
      return route.fulfill({
        json: [
          {
            id: "case-1",
            code: "B-001",
            position: 1,
            title: "管理员登录后绑定钱包",
            module: "账户",
            layer: "服务层",
            priority: "P0",
            preconditions: "已存在可登录的管理员账号",
            test_data: "admin@example.test / test-password",
            steps: LONG_STEPS,
            expected: "钱包绑定成功且账户状态为已激活"
          }
        ]
      });
    }
    if (pathname === "/api/groups/0918-id/cases/B-001/attempts" && route.request().method() === "GET") {
      return route.fulfill({
        json: [
          {
            id: "attempt-1",
            label: "B-001",
            sequence: 1,
            state: "committed",
            result: "不通过",
            note: "绑定未触发，控制台没有回调日志",
            console_text: "wallet.bind -> timeout after 3000ms",
            created_at: "2026-09-16T09:00:00Z"
          }
        ]
      });
    }
    if (pathname === "/api/groups/0918-id/cases/B-001/lark-history") {
      return route.fulfill({
        json: {
          available: true,
          code: "B-001",
          read_errors: [],
          source_table_name: "执行记录",
          read_at: "2026-09-16T10:00:00Z",
          certainty: "verified",
          uncertainty: null,
          ambiguous: false,
          original: [],
          retests: [],
          bugs: [],
          unknown_count: 0
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
          pending_attempts: 0,
          detail: "尚未确认目标表，本地结果不会写入 Lark"
        }
      });
    }
    return route.fulfill({ json: {} });
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
  test(`${viewport} execution desk is readable without overflow`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    await page.goto("/");

    await expect(page.getByText("管理员登录后绑定钱包")).toBeVisible();
    await page.getByRole("button", { name: "不通过" }).click();
    await expect(page.getByLabel("失败说明")).toBeVisible();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task4-execution-${viewport}.png`, fullPage: true });
  });
}
