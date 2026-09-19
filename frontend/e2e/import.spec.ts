import { expect, test, type Page } from "@playwright/test";

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { email: "admin@example.test" } });
    if (url.pathname === "/api/groups") return route.fulfill({ json: [] });
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { csrf_token: "test-csrf" } });
    if (url.pathname === "/api/import/preview") return route.fulfill({
      json: {
        ticket_id: "11111111-1111-1111-1111-111111111111",
        detected_format: "csv",
        count: 14,
        result_count: 2,
        evidence_only_count: 1,
        cases: [
          { code: "B-001", position: 1, title: "管理员登录", module: "账户", priority: "P0" },
          { code: "B-002", position: 2, title: "绑定钱包并检查账户状态", module: "钱包", priority: "P1" }
        ],
        fields: ["用例编号", "执行顺序", "用例标题", "执行步骤", "预期结果"],
        errors: [],
        warnings: []
      }
    });
    return route.fulfill({ status: 404, json: { detail: "Not mocked" } });
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
  test(`${viewport} import preview is framed without overflow`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await page.getByLabel("选择用例文件").setInputFiles({
      name: "0918.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("用例编号,用例标题\nB-001,管理员登录")
    });

    await expect(page.getByText("14")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认导入" })).toBeVisible();
    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    const checkbox = page.getByLabel("一并写入执行结果");
    const box = await checkbox.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(24); // 全局 input 规则会把它撑成 42px 满宽方块
    expect(await page.getByText(/检出 2 条执行结果/).isVisible()).toBe(true);
    await page.screenshot({ path: `test-results/task6-${viewport}.png`, fullPage: true });
  });
}
