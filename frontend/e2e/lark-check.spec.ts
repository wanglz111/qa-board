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

const RUNS_FIELDS = { 用例: "text", 结果: "single_select" };
const BUGS_FIELDS = { 用例: "text", 结果: "single_select", 截图: "attachment", 问题描述: "text", 进展状态: "single_select" };
// 判决在这里现算：字段缺了就进 schema_errors —— 与后端同一条口径，也与 mock-api 的
// schemaOf 同一条口径（两处各写一份就会出现「读取说缺、校验说不缺」的自相矛盾）。
const schema = (table_id: string, fields: Record<string, string>, required: string[]) => ({
  table_id,
  fields,
  required,
  schema_errors: required.filter((name) => !(name in fields)).map((name) => `缺少必填字段「${name}」`)
});

const SCHEMAS: Record<string, ReturnType<typeof schema>> = {
  "tbl-runs:execution": schema("tbl-runs", RUNS_FIELDS, ["用例", "结果", "截图"]),
  "tbl-runs:bug": schema("tbl-runs", RUNS_FIELDS, ["问题描述", "进展状态"]),
  "tbl-bugs:execution": schema("tbl-bugs", BUGS_FIELDS, ["用例", "结果", "截图"]),
  "tbl-bugs:bug": schema("tbl-bugs", BUGS_FIELDS, ["问题描述", "进展状态"])
};

// 门 1 的起点：resolve 说 tbl-runs 缺「截图」。判决由 resolve 播种（零请求），
// 所以「旧红字」在第一次切表之前就在屏幕上。
const BAD_RESOLVE = {
  ...RESOLVED,
  execution_fields: { 用例: "text", 结果: "single_select" },
  schema_errors: ["缺少必填字段「截图」"]
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

const COMPLETE_PLAN = {
  roles: { execution: [], bug: [] },
  views: {
    execution: { name: "TestDeck", exists: true, view_id: "vew-testdeck" },
    bug: { name: "TestDeck", exists: true, view_id: "vew-testdeck" }
  }
};

const MISSING_PLAN = {
  roles: {
    execution: [
      { name: "结果", type: 1, type_name: "text", properties: {} },
      { name: "日期", type: 5, type_name: "date", properties: {} }
    ],
    bug: []
  },
  views: {
    execution: { name: "TestDeck", exists: false, view_id: null },
    bug: { name: "TestDeck", exists: true, view_id: "vew-testdeck" }
  }
};

type SavedTarget = { acknowledge_change?: boolean; execution_table_id?: string };
type CreatedHeaders = { role: string; field_names: string[]; acknowledge: boolean };

function tableName(tableId: string): string {
  return RESOLVED.tables.find((table) => table.table_id === tableId)?.name ?? tableId;
}

// 收起态没有 body：先点标题按钮展开。已经展开就不点（再点一次是收起）。
async function openStep(page: Page, index: number) {
  const toggle = page.getByRole("button", { name: new RegExp(`^第 ${index} 步`) });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
}

async function mockApi(
  page: Page,
  saved: SavedTarget[] = [],
  plan: unknown = COMPLETE_PLAN,
  created: CreatedHeaders[] = [],
  sync: Record<string, unknown> | null = null
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
    if (pathname === "/api/lark/table-schema" && method === "POST") {
      const payload = request.postDataJSON() as { table_id?: string; role?: string };
      const key = `${payload.table_id}:${payload.role}`;
      return route.fulfill({
        json:
          SCHEMAS[key] ??
          { table_id: payload.table_id ?? "", fields: {}, required: [], schema_errors: [] }
      });
    }
    if (pathname === `/api/groups/${GROUP_ID}/lark/provision`) {
      return route.fulfill({ json: plan });
    }
    if (pathname === `/api/groups/${GROUP_ID}/lark/provision/fields` && method === "POST") {
      const body = request.postDataJSON() as CreatedHeaders;
      created.push(body);
      return route.fulfill({
        json: {
          created_fields: body.field_names,
          view: { name: "TestDeck", exists: true, view_id: "vew-testdeck", created: false },
          schema_errors: [],
          target
        }
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
        json: sync ?? {
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

// One confirmed target whose rows are all stuck: three parked on a stale
// fingerprint and one refused by Lark. This is the panel the operator was
// looking at when the queue button answered "已排入 0 条" and nothing moved.
const STUCK_SYNC = {
  confirmed: true,
  queued: 3,
  synced: 0,
  failed: 1,
  uncertain: 0,
  parked: 3,
  last_error_kind: "create_execution_failed",
  last_error:
    "Lark create failed HTTP 403: HTTPStatusError，Lark code 91403：Forbidden；请在 Lark 开放平台为应用开通「查看、评论、编辑和管理多维表格」权限并发布",
  pending_attempts: 4,
  detail: "目标表已确认，可显式排入同步"
};

for (const viewport of ["desktop", "mobile"] as const) {
  test(`${viewport} the queue row aligns its buttons and prints why a row is stuck`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page, [], COMPLETE_PLAN, [], STUCK_SYNC);
    // The queue's own buttons are gated on the *target* being approved, not on
    // the counters, so this test needs a confirmed target of its own. Routes are
    // matched newest-first, so this one wins over the shared mock.
    await page.route(`**/api/groups/${GROUP_ID}/lark/target`, (route) =>
      route.fulfill({
        json: {
          target: { ...TARGET, confirmed: true, confirmed_at: "2026-09-17T08:35:17Z" },
          live: { schema_errors: [], read_errors: [] },
          read_errors: []
        }
      })
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    // 门 5：failed > 0 → 状态条变红 + 第 ④ 步自动展开（不需要点标题）。
    await expect(page.locator(".lark-health-strip")).toContainText("同步失败 1 条");
    await expect(page.locator(".lark-step").filter({ hasText: "第 4 步" })).toHaveAttribute("data-state", "open");
    await expect(page.locator(".lark-step").filter({ hasText: "第 4 步" })).toContainText("最近错误");
    await expect(page.getByText(/最近错误 create_execution_failed/)).toBeVisible();
    // The category alone was all the panel ever said; now the reason is there.
    await expect(page.getByText(/Lark create failed HTTP 403/)).toBeVisible();

    const boxes = await page
      .locator(".lark-queue-actions button")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
        })
      );
    expect(boxes.length).toBeGreaterThan(1);

    for (let index = 1; index < boxes.length; index += 1) {
      const previous = boxes[index - 1];
      const current = boxes[index];
      // Only a pair that shares a line has to share a top edge: the icon-led
      // button used to sit 2.5px above the text-only buttons beside it.
      const sameLine = current.top < previous.bottom && current.bottom > previous.top;
      if (!sameLine) continue;
      expect(current.top).toBeCloseTo(previous.top, 1);
      expect(current.left - previous.right).toBeGreaterThanOrEqual(8);
    }

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/lark-queue-${viewport}.png`, fullPage: true });
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
  test(`${viewport} a healthy page is one status line and four step titles`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    // 后注册的先命中：这一条 target 已确认，状态条走「健康」分支（骨架第 8 行）。
    await page.route(`**/api/groups/${GROUP_ID}/lark/target`, (route) =>
      route.fulfill({
        json: {
          target: { ...TARGET, confirmed: true, confirmed_at: "2026-09-17T08:35:17Z" },
          live: { schema_errors: [], read_errors: [] },
          read_errors: []
        }
      })
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    const strip = page.locator(".lark-health-strip");
    await expect(strip).toContainText("已确认 · 执行记录 / 缺陷记录");
    await expect(strip).toContainText("待同步 0 · 失败 0");
    // 验收门 4：健康态 = 1 行状态条 + 4 行步骤标题，且页面里没有 role="alert"。
    await expect(page.locator(".lark-step")).toHaveCount(4);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-lark-healthy-${viewport}.png`, fullPage: true });
  });

  test(`${viewport} writes stay blocked until both tables are checked and consent is given`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    // 未确认的状态条（骨架第 7 行）。
    await expect(page.locator(".lark-health-strip")).toContainText("未确认：本地结果不会写入 Lark");

    await openStep(page, 1);
    const stepOne = page.locator(".lark-step-tables");
    // 门 3：链接没读之前两个 role 谁都不下结论。这一版页面里「尚未校验这张表」只在 base 读到
    // 之后才渲染（收起态/未读态连 body 都没有），所以「不借用任何结论」在这里的等价证据是
    // 「一行判决都不存在」；真正的「尚未校验这张表 × 2」在下面切表那条用例里（两 role 各自
    // 指向没人校验过的表），那里它是可达且非空测的。
    await expect(stepOne.locator(".lark-verdict")).toHaveCount(0);
    // 两表都还没有 verdict → 第 ③ 步「两表都 ok 才可进」的前置条件不成立，标题按钮是禁用的，
    // 它 body 里的确认按钮此刻根本进不去（门 6：确认必须排在两表校验之后）。
    await expect(page.getByRole("button", { name: /^第 3 步/ })).toBeDisabled();

    // 读链接：执行表判决由 resolve 播种（零请求），同库缺陷表顺手校验一次。
    const link = page.getByLabel("Lark 文档链接");
    // 链接框由 draftFromTarget 异步预填：等它落地再读，否则这次读取会被 resetDraft 作废。
    await expect(link).toHaveValue(RESOLVE_URL);
    await link.fill(RESOLVE_URL);
    await page.getByRole("button", { name: "读取表格" }).click();
    // 两表各自 ok（门 2：判决不串味），第 ③ 步这时才进得去。
    await expect(stepOne.locator('.lark-verdict[data-verdict="ok"]')).toHaveCount(2);

    // 勾选框与确认按钮都渲染在第 ③ 步的 body 里，收起态不渲染 children —— 先展开它。
    // 顺序是契约的一部分：必须排在两表都校验完之后，否则这一步的标题按钮还是禁用的。
    await openStep(page, 3);
    const consent = page.getByLabel("允许向上述旧表新增本组记录");
    const confirmButton = page.getByRole("button", { name: /确认本组写入目标/ });
    await expect(consent).toBeEnabled();
    await expect(confirmButton).toBeDisabled();
    await consent.check();
    await expect(confirmButton).toBeEnabled();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-lark-consent-${viewport}.png`, fullPage: true });
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

    // plan 行与「设置表头」都在第 ② 步的 body 里：收起态不渲染 children（StepSection），先展开。
    await openStep(page, 2);
    await expect(page.getByText(/缺少 2 个表头/)).toBeVisible();
    await page.getByRole("button", { name: "设置表头" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("结果");
    await expect(dialog).toContainText("日期");
    // The execution table has no TestDeck view yet, the defect table does.
    await expect(dialog.getByRole("checkbox", { name: "同时创建 TestDeck 视图" })).toBeVisible();
    // Listing the missing headers must not create any of them.
    expect(created).toHaveLength(0);

    // The header rows are keyboard reachable, and Tab wraps inside the overlay
    // instead of walking out to the page behind it.
    await expect(dialog.getByRole("button", { name: "创建这些表头" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("checkbox", { name: "创建表头「结果」" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "创建这些表头" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("checkbox", { name: "创建表头「结果」" })).toBeFocused();

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

  test(`${viewport} switching the execution table clears the old table's red banner`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    const schemaCalls: string[] = [];
    await page.route("**/api/lark/resolve", (route) => route.fulfill({ json: BAD_RESOLVE }));
    await page.route("**/api/lark/table-schema", (route) => {
      const body = route.request().postDataJSON() as { table_id?: string; role?: string };
      const key = `${body.table_id}:${body.role}`;
      schemaCalls.push(key);
      return route.fulfill({
        json:
          SCHEMAS[key] ??
          { table_id: body.table_id ?? "", fields: {}, required: [], schema_errors: [] }
      });
    });
    await page.route(`**/api/groups/${GROUP_ID}/lark/target`, (route) =>
      route.fulfill({
        json: {
          target: { ...TARGET, confirmed: true, confirmed_at: "2026-09-17T08:35:17Z" },
          live: { schema_errors: [], read_errors: [] },
          read_errors: []
        }
      })
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();
    await openStep(page, 1);

    const link = page.getByLabel("Lark 文档链接");
    // 同前：等 draftFromTarget 的异步预填落地，再读。
    await expect(link).toHaveValue(RESOLVE_URL);
    await link.fill(RESOLVE_URL);
    await page.getByRole("button", { name: "读取表格" }).click();

    // 红字属于 tbl-runs，来自 resolve 的播种 —— 一次请求都没发。
    const execution = page.locator('.lark-role[data-role="execution"]');
    await expect(execution.getByText("缺少必填字段「截图」")).toBeVisible();
    expect(schemaCalls).not.toContain("tbl-runs:execution");
    // 同库缺陷表被顺手校验了一次（规格 §8），那是另一张表的判决。
    expect(schemaCalls).toContain("tbl-bugs:bug");

    // 本次 bug 的回归：切到另一张表，旧表的判决不许跟过来（验收门 1）。
    await page.getByLabel("执行记录表").selectOption("tbl-bugs");
    await expect(page.getByText("缺少必填字段「截图」")).toHaveCount(0);
    // 未校验就是未校验，也不借用 tbl-bugs:bug 的结论（验收门 3）。
    await expect(execution.getByText("尚未校验这张表")).toBeVisible();

    // 门 3 的另一半：两个 role 同时指向「没人校验过的表」时，各自都只说尚未校验 ——
    // 缺陷表这次指着 tbl-runs，也绝不借用 resolve 播种给 tbl-runs:execution 的那条 bad。
    await page.getByLabel("缺陷记录表").selectOption("tbl-runs");
    await expect(page.locator(".lark-step-tables").getByText("尚未校验这张表")).toHaveCount(2);
    await page.getByLabel("缺陷记录表").selectOption("tbl-bugs");

    // 校验当前选中的表：这张表自己 ok，红字不回来；同表不重复发请求（门 7）。
    await execution.getByRole("button", { name: "校验", exact: true }).click();
    await expect(execution.getByText("尚未校验这张表")).toHaveCount(0);
    await expect(page.getByText("缺少必填字段「截图」")).toHaveCount(0);
    expect(schemaCalls.filter((key) => key === "tbl-bugs:execution")).toHaveLength(1);

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-switch-table-${viewport}.png`, fullPage: true });
  });

  test(`${viewport} a stale header wakes the status line and opens the header step`, async ({ page }) => {
    await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
    await mockApi(page);
    // 门 5 的第一条：服务端对**已保存目标**的重读报表头失效（`live.schema_errors`）。
    // target 已确认 → 骨架 §describeHealth 第 3 行（task-02-03-draft.md:773 的实现用词）。
    await page.route(`**/api/groups/${GROUP_ID}/lark/target`, (route) =>
      route.fulfill({
        json: {
          target: { ...TARGET, confirmed: true, confirmed_at: "2026-09-17T08:35:17Z" },
          live: { schema_errors: ["缺少必填字段「截图」"], read_errors: [] },
          read_errors: []
        }
      })
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Lark 检查" }).click();

    // 状态条变红，并且说清是哪一步的事。
    const strip = page.locator(".lark-health-strip");
    await expect(strip).toHaveAttribute("data-tone", "bad");
    await expect(strip).toContainText("已确认，但表头已失效（需重新校验）");
    // 第 ② 步自动展开，不需要点标题 —— 与 Step 8 里第 ④ 步那条断言对称。
    await expect(page.locator(".lark-step").filter({ hasText: "第 2 步" })).toHaveAttribute("data-state", "open");

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task7-lark-stale-header-${viewport}.png`, fullPage: true });
  });
}
