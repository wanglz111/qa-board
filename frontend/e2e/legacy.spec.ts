import { expect, test, type Page, type Route } from "@playwright/test";

const CASE = {
  id: "case-1",
  code: "B-001",
  position: 1,
  title: "管理员登录后绑定钱包",
  module: "账户",
  layer: "服务层",
  priority: "P0",
  preconditions: null,
  test_data: null,
  steps: "1. 打开登录页\n2. 绑定钱包",
  expected: "钱包绑定成功",
  expect_absent: [],
  visual_check: "text_and_visual",
  prototype_note: null,
  reference_assets: []
};

type LegacyState = "verified" | "ambiguous" | "unavailable";

function legacyBody(state: LegacyState) {
  const base = {
    available: true,
    code: "B-001",
    read_errors: [],
    source_table_name: "执行记录",
    base_name: "旧版测试管理",
    bug_table_name: "缺陷记录",
    read_at: "2026-09-16T10:00:00Z",
    certainty: "verified",
    uncertainty: null,
    ambiguous: false,
    original: [
      {
        record_id: "old1",
        case_text: "B-001 Login",
        result: "不通过",
        note: "绑定未触发，控制台没有回调日志",
        console_text: null,
        observed_at: 1700000000,
        ref_id: "11111111-1111-1111-1111-111111111111",
        attachments: [{ index: 0, name: "old shot.png", mime: "image/png" }]
      }
    ],
    retests: [
      {
        record_id: "new1",
        case_text: "B-001-R0918-01 Login",
        result: "通过",
        note: null,
        console_text: null,
        observed_at: 1700100000,
        ref_id: "22222222-2222-2222-2222-222222222222",
        attachments: []
      }
    ],
    bugs: [
      {
        record_id: "bug1",
        description: "B-001 绑定未触发（旧表缺陷）",
        status: "待修复",
        priority: "P0",
        matched_by: "问题描述"
      }
    ],
    unknown_count: 0
  };
  if (state === "ambiguous") {
    return { ...base, certainty: "uncertain", uncertainty: "缺少可验证的日期或修改时间", ambiguous: true };
  }
  if (state === "unavailable") {
    return {
      ...base,
      available: false,
      read_errors: ["Lark request failed: ConnectError"],
      original: [],
      retests: [],
      bugs: []
    };
  }
  return base;
}

async function mockApi(page: Page, state: LegacyState) {
  await page.route("**/api/**", async (route: Route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/api/auth/me") return route.fulfill({ json: { email: "admin@example.test" } });
    if (pathname === "/api/auth/csrf") return route.fulfill({ json: { csrf_token: "test-csrf" } });
    if (pathname === "/api/groups") {
      return route.fulfill({
        json: [
          { id: "0918-id", name: "Sprint 0918", source_name: "0918.csv", source_version: "3", count: 1, created_at: "2026-09-16T08:00:00Z" }
        ]
      });
    }
    if (pathname === "/api/groups/0918-id/progress") {
      return route.fulfill({ json: { passed: 0, failed: 1, skipped: 0, untested: 0 } });
    }
    if (pathname === "/api/groups/0918-id/sync") {
      return route.fulfill({
        json: {
          confirmed: true,
          queued: 1,
          synced: 0,
          failed: 0,
          uncertain: 0,
          last_error_kind: null,
          pending_attempts: 1,
          detail: "目标表已确认，可显式排入同步"
        }
      });
    }
    if (pathname === "/api/groups/0918-id/cases") return route.fulfill({ json: [CASE] });
    if (pathname === "/api/groups/0918-id/cases/B-001/lark-history") {
      return route.fulfill({ json: legacyBody(state) });
    }
    if (pathname.endsWith("/attachments/0")) {
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from([]) });
    }
    if (pathname === "/api/groups/0918-id/cases/B-001/attempts") {
      return route.fulfill({
        json: [
          {
            id: "attempt-1",
            label: "B-001-R0918-01",
            sequence: 2,
            state: "committed",
            result: "通过",
            note: null,
            console_text: null,
            created_at: "2026-09-16T11:00:00Z"
          }
        ]
      });
    }
    return route.fulfill({ json: {} });
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
  for (const state of ["verified", "ambiguous", "unavailable"] as const) {
    test(`${viewport} legacy view shows ${state} history without overflow`, async ({ page }) => {
      await page.setViewportSize(viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 });
      await mockApi(page, state);
      await page.goto("/");

      const legacy = page.getByRole("region", { name: "旧表只读记录" });
      await expect(legacy).toBeVisible();
      if (state === "verified") {
        await expect(legacy.getByText("上次失败：绑定未触发，控制台没有回调日志")).toBeVisible();
        await expect(legacy.getByText("旧缺陷 待修复")).toBeVisible();
      } else if (state === "ambiguous") {
        await expect(legacy.getByText(/旧表匹配不确定/)).toBeVisible();
        await expect(legacy.getByText(/上次失败：/)).toHaveCount(0);
      } else {
        await expect(legacy.getByText("旧表当前不可读，未显示历史结果")).toBeVisible();
      }

      const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(noOverflow).toBe(true);
      await page.screenshot({
        path: `test-results/task4-legacy-${state}-${viewport}.png`,
        fullPage: true
      });
    });
  }
}
