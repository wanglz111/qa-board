import { expect, test, type Page, type Route } from "@playwright/test";

const GROUP_ID = "0918-id";
const RESOLVE_URL = "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs";

const RESOLVED = {
  source_url: RESOLVE_URL,
  base_token: "app-exec",
  base_name: "旧版测试管理",
  tables: [
    { table_id: "tbl-runs", name: "执行记录" },
    { table_id: "tbl-bugs", name: "缺陷记录" }
  ],
  selected: { table_id: "tbl-runs", table_name: "执行记录", view_id: "vew-main" },
  execution_fields: { 用例: "text", 结果: "single_select", 截图: "attachment" },
  required_execution_fields: ["用例", "结果", "截图"],
  schema_errors: [],
  read_errors: []
};

const TARGET = {
  group_id: GROUP_ID,
  source_url: RESOLVE_URL,
  execution_base_token: "app-exec",
  execution_base_name: "旧版测试管理",
  execution_table_id: "tbl-runs",
  execution_table_name: "执行记录",
  bug_base_token: "app-exec",
  bug_base_name: "旧版测试管理",
  bug_table_id: "tbl-bugs",
  bug_table_name: "缺陷记录",
  schema_fingerprint: "schema-1",
  target_fingerprint: "app-exec|tbl-runs|app-exec|tbl-bugs",
  confirmed_at: null,
  confirmed: false
};

const LIVE = {
  execution_base_name: "旧版测试管理",
  execution_table_name: "执行记录",
  bug_base_name: "旧版测试管理",
  bug_table_name: "缺陷记录",
  execution_fields: { 用例: "text", 结果: "single_select", 截图: "attachment" },
  bug_fields: { 问题描述: "text", 进展状态: "single_select" },
  schema_errors: [],
  read_errors: []
};

const COMPLETE_PLAN = { roles: { execution: [], bug: [] } };

const MISSING_PLAN = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  }
};

type SavedTarget = { acknowledge_change?: boolean; execution_table_id?: string };
type CreatedHeaders = { role: string; field_names: string[]; acknowledge: boolean };

function tableName(tableId: string): string {
  return RESOLVED.tables.find((table) => table.table_id === tableId)?.name ?? tableId;
}

async function mockApi(
  page: Page,
  saved: SavedTarget[] = [],
  plan: unknown = COMPLETE_PLAN,
  created: CreatedHeaders[] = []
) {
  const target = { ...TARGET };
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
    if (pathname === "/api/lark/resolve") {
      return route.fulfill({ json: RESOLVED });
    }
    if (pathname === `/api/groups/${GROUP_ID}/lark/provision`) {
      return route.fulfill({ json: plan });
    }
    if (pathname === `/api/groups/${GROUP_ID}/lark/provision/fields` && method === "POST") {
      const body = request.postDataJSON() as CreatedHeaders;
      created.push(body);
      return route.fulfill({
        json: { created_fields: body.field_names, schema_errors: [], target }
      });
    }
    if (pathname === `/api/groups/${GROUP_ID}/lark/target` && method === "PUT") {
      const body = request.postDataJSON() as SavedTarget;
      saved.push(body);
      target.execution_table_id = body.execution_table_id ?? target.execution_table_id;
      target.execution_table_name = tableName(target.execution_table_id);
      target.target_fingerprint = `${target.execution_base_token}|${target.execution_table_id}|${target.bug_base_token}|${target.bug_table_id}`;
      return route.fulfill({
        json: { target, live: LIVE, diff: { changed: true }, confirmation_cleared: true }
      });
    }
    if (pathname === `/api/groups/${GROUP_ID}/lark/target`) {
      return route.fulfill({
        json: { target, live: { schema_errors: [], read_errors: [] }, read_errors: [] }
      });
    }
    if (pathname === `/api/groups/${GROUP_ID}/sync`) {
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

  test(`${viewport} switching the execution table waits for the change dialog`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    const saved: SavedTarget[] = [];
    await mockApi(page, saved);
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    await page.getByLabel("Lark 文档链接").fill(RESOLVE_URL);
    await page.getByRole("button", { name: "读取表格" }).click();
    await page.getByLabel("执行记录表").selectOption("tbl-bugs");
    await page.getByRole("button", { name: "保存选择" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("执行记录 → 缺陷记录");
    await expect(dialog).toContainText("tbl-runs → tbl-bugs");
    expect(saved).toHaveLength(0);

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task6-target-change-${viewport}.png`, fullPage: true });

    await dialog.getByRole("button", { name: "确认切换" }).click();
    await expect(dialog).toBeHidden();
    expect(saved).toHaveLength(1);
    expect(saved[0].acknowledge_change).toBe(true);
    await expect(page.getByText(/此前的写入确认已被清除/)).toBeVisible();
  });

  test(`${viewport} setting headers sends only the ticked names after a confirmation`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    const created: CreatedHeaders[] = [];
    await mockApi(page, [], MISSING_PLAN, created);
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    await expect(page.getByText(/缺少 2 个表头/)).toBeVisible();
    await page.getByRole("button", { name: "设置表头" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("结果");
    await expect(dialog).toContainText("日期");
    // Listing the missing headers must not create any of them.
    expect(created).toHaveLength(0);

    const openOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(openOverflow).toBe(true);
    const dialogOverflow = await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth);
    expect(dialogOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task3-header-setup-${viewport}.png`, fullPage: true });

    await dialog.getByRole("checkbox", { name: "创建表头「日期」" }).uncheck();
    await dialog.getByRole("button", { name: "创建这些表头" }).click();

    await expect(page.getByText("已创建 1 个表头，请重新确认写入")).toBeVisible();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      role: "execution",
      field_names: ["结果"],
      acknowledge: true
    });

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
  });
}
