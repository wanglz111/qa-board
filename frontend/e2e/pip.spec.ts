import { expect, test, type Page, type Route } from "@playwright/test";

const CASE = {
  id: "case-1",
  code: "B-001",
  position: 1,
  title: "管理员登录后绑定钱包",
  module: "账户",
  layer: "服务层",
  priority: "P0",
  preconditions: "已存在可登录的管理员账号",
  test_data: "admin@example.test / test-password",
  steps: "1. 打开登录页\n2. 绑定钱包",
  expected: "钱包绑定成功"
};

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/auth/me") return route.fulfill({ json: { email: "admin@example.test" } });
    if (pathname === "/api/auth/csrf") return route.fulfill({ json: { csrf_token: "test-csrf" } });
    if (pathname === "/api/groups") {
      return route.fulfill({
        json: [
          { id: "0918-id", name: "Sprint 0918", source_name: "0918.csv", source_version: "1", count: 1, created_at: "2026-09-16T08:00:00Z" }
        ]
      });
    }
    if (pathname === "/api/groups/0918-id/progress") {
      return route.fulfill({ json: { passed: 0, failed: 0, skipped: 0, untested: 1 } });
    }
    if (pathname === "/api/groups/0918-id/cases") return route.fulfill({ json: [CASE] });
    if (pathname === "/api/groups/0918-id/cases/B-001/attempts") {
      if (route.request().method() === "POST") {
        return route.fulfill({
          json: {
            id: "attempt-1",
            label: "B-001",
            sequence: 1,
            state: "committed",
            result: "通过",
            note: null,
            console_text: null,
            created_at: "2026-09-16T09:00:00Z"
          }
        });
      }
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: {} });
  });
}

test("desktop keyboard flow keeps shortcuts away from the failure note", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await page.goto("/");

  await expect(page.getByText("管理员登录后绑定钱包")).toBeVisible();

  // Backspace must open the failure form instead of submitting an empty note.
  await page.keyboard.press("Backspace");
  await expect(page.getByLabel("失败说明")).toBeFocused();
  await page.keyboard.type("绑定未触发");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/已保存到本地/)).toHaveCount(0);
  // Enter stayed inside the textarea and inserted a newline instead of submitting.
  await expect(page.getByLabel("失败说明")).toHaveValue("绑定未触发\n");

  // Leaving the field re-enables the shortcuts and Enter stores a pass.
  await page.locator(".case-detail-heading h2").click();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/已保存到本地/)).toBeVisible();

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noOverflow).toBe(true);
  await page.screenshot({ path: "test-results/task5-shortcuts-desktop.png", fullPage: true });
});

test("picture-in-picture opens when supported and degrades visibly when not", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByText("管理员登录后绑定钱包")).toBeVisible();

  const supported = await page.evaluate(() => "documentPictureInPicture" in window);
  const pipButton = page.getByRole("button", { name: "画中画" });

  if (!supported) {
    await expect(pipButton).toBeDisabled();
    await expect(page.getByText("当前浏览器不支持画中画，执行工作台可继续使用。")).toBeVisible();
    await page.screenshot({ path: "test-results/task5-pip-unsupported.png", fullPage: true });
    return;
  }

  await expect(pipButton).toBeEnabled();
  await pipButton.click();
  await expect(page.getByRole("button", { name: "关闭画中画" })).toBeVisible();
  await page.screenshot({ path: "test-results/task5-pip-open.png", fullPage: true });

  await page.keyboard.press("Control+p");
  await expect(page.getByRole("button", { name: "画中画" })).toBeVisible();
});
