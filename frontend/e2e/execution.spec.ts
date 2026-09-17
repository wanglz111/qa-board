import { expect, test, type Page } from "@playwright/test";

import type { AttemptResult, GroupCase } from "../src/api";

const LONG_STEPS = "1. 打开登录页并输入管理员凭据\n2. 提交后等待绑定回调\n3. ".padEnd(400, "检查钱包状态与账户余额。");

const GROUP_ID = "0918-id";

type Seed = { code: string; title: string; latest_result: AttemptResult | null };

// `latest_result` is the only input the desk's counts and the sidebar grid read,
// so a fixture is built from those three fields instead of repeating the whole
// twenty-field literal per case.
function seedCase({ code, title, latest_result }: Seed, position: number): GroupCase {
  return {
    id: `case-${code}`,
    code,
    position,
    title,
    module: "账户",
    layer: "服务层",
    priority: "P0",
    preconditions: "已存在可登录的管理员账号",
    test_data: "admin@example.test / test-password",
    steps: LONG_STEPS,
    expected: "钱包绑定成功且账户状态为已激活",
    expect_absent: [],
    visual_check: "text_and_visual",
    prototype_note: null,
    latest_result,
    reference_assets: []
  };
}

const DEFAULT_CASES: GroupCase[] = [
  seedCase({ code: "B-001", title: "管理员登录后绑定钱包", latest_result: "不通过" }, 1)
];

// Pairwise-distinct counts — 1 通过, 2 不通过, 1 未执行, 1 未测 — because equal
// counts would let a swapped ✓/✗ mapping (label and all) render the same string.
const MIXED_CASES: GroupCase[] = [
  seedCase({ code: "B-001", title: "登录后绑定钱包", latest_result: "通过" }, 1),
  seedCase({ code: "B-002", title: "登录后解绑钱包", latest_result: "不通过" }, 2),
  seedCase({ code: "B-003", title: "登录后冻结钱包", latest_result: "不通过" }, 3),
  seedCase({ code: "B-004", title: "登录后注销钱包", latest_result: "未执行" }, 4),
  seedCase({ code: "B-005", title: "登录后更换钱包", latest_result: null }, 5)
];

// Nobody has run these, so the desk has somewhere to advance to.
const UNRUN_CASES: GroupCase[] = [
  seedCase({ code: "B-001", title: "登录后绑定钱包", latest_result: null }, 1),
  seedCase({ code: "B-002", title: "登录后解绑钱包", latest_result: null }, 2)
];

// The group badge is another rendering of the same rows, so it is derived from
// the fixture instead of being typed out a second time.
function progressOf(cases: GroupCase[]) {
  const progress = { passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const item of cases) {
    if (item.latest_result === "通过") progress.passed += 1;
    else if (item.latest_result === "不通过") progress.failed += 1;
    else if (item.latest_result === "未执行") progress.skipped += 1;
    else progress.untested += 1;
  }
  return progress;
}

// `Attempt.screenshots` is required by the API type and History reads
// `attempt.screenshots.length`, so a mocked run carries it: a response without
// it unmounts the whole page instead of showing one history row.
function committedAttempt(item: GroupCase) {
  const historicalFailure = item.code === "B-001" && item.latest_result === "不通过";
  return {
    id: `attempt-${item.code}`,
    label: item.code,
    sequence: 1,
    state: "committed",
    result: item.latest_result,
    note: historicalFailure ? "绑定未触发，控制台没有回调日志" : null,
    console_text: historicalFailure ? "wallet.bind -> timeout after 3000ms" : null,
    created_at: "2026-09-16T09:00:00Z",
    screenshots: []
  };
}

// Every case reads the legacy table, so the panel is answered for all of them.
function larkHistory(code: string) {
  return {
    available: true,
    code,
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
  };
}

// The stylesheet declares hex, the browser reports computed colours as
// `rgb(r, g, b)`. Deriving the expectation from the stylesheet's own hex keeps
// the assertion readable and stops a hand-typed triple from drifting.
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

const TONE_HEX = { passed: "#e2f2e9", failed: "#fbe7e5", skipped: "#fdf1d5", untested: "#ffffff" } as const;

async function mockApi(page: Page, cases: GroupCase[] = DEFAULT_CASES) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    if (pathname === "/api/auth/me") return route.fulfill({ json: { email: "admin@example.test" } });
    if (pathname === "/api/auth/csrf") return route.fulfill({ json: { csrf_token: "test-csrf" } });
    if (pathname === "/api/groups") {
      return route.fulfill({
        json: [
          { id: GROUP_ID, name: "Sprint 0918", source_name: "0918.csv", source_version: "1", count: cases.length, created_at: "2026-09-16T08:00:00Z" },
          { id: "0922-id", name: "Sprint 0922", source_name: "0922.csv", source_version: "1", count: 1, created_at: "2026-09-16T08:00:00Z" }
        ]
      });
    }
    if (pathname === `/api/groups/${GROUP_ID}/progress`) {
      return route.fulfill({ json: progressOf(cases) });
    }
    if (/\/api\/groups\/[^/]+\/progress$/.test(pathname)) {
      return route.fulfill({ json: { passed: 0, failed: 0, skipped: 0, untested: 1 } });
    }
    if (pathname === `/api/groups/${GROUP_ID}/cases`) {
      return route.fulfill({ json: cases });
    }
    const scoped = pathname.match(/^\/api\/groups\/[^/]+\/cases\/([^/]+)\/(attempts|lark-history)$/);
    if (scoped) {
      const code = decodeURIComponent(scoped[1]);
      if (scoped[2] === "lark-history") return route.fulfill({ json: larkHistory(code) });
      if (route.request().method() === "POST") {
        const payload = route.request().postDataJSON() as {
          result: AttemptResult;
          note: string | null;
          console_text: string | null;
        };
        // The response is the authority on the result: the advance and the
        // 本组已全部测过 banner both read it back from here rather than
        // assuming the submit landed.
        return route.fulfill({
          json: {
            id: `attempt-${code}-saved`,
            label: code,
            sequence: 1,
            state: "committed",
            result: payload.result,
            note: payload.note,
            console_text: payload.console_text,
            created_at: "2026-09-16T09:30:00Z",
            screenshots: []
          }
        });
      }
      const seeded = cases.find((item) => item.code === code);
      return route.fulfill({ json: seeded?.latest_result ? [committedAttempt(seeded)] : [] });
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
    // `exact` because the sidebar square for this failed case is labelled
    // 「B-001 不通过」 and role-name matching is a substring search by default.
    await page.getByRole("button", { name: "不通过", exact: true }).click();
    await expect(page.getByLabel("失败说明")).toBeVisible();

    const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `test-results/task4-execution-${viewport}.png`, fullPage: true });
  });
}

test("the desk advances to the next unrun case and the grid colours every result", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, MIXED_CASES);
  await page.goto("/");

  // 未执行 counts as done but as neither ✓ nor ✗, so this is 4/5. The counts are
  // pairwise distinct on purpose: `4/5 · ✓1 ✗2 ○1` is the only mapping of the
  // three marks onto these numbers, so a swapped ✓/✗ cannot render it.
  await expect(page.locator(".desk-progress")).toHaveText("4/5 · ✓1 ✗2 ○1");

  const squares = page.locator(".case-square");
  await expect(squares).toHaveCount(5);
  const expectedTones = ["passed", "failed", "failed", "skipped", "untested"] as const;
  const everyTone = ["passed", "failed", "skipped", "untested"];
  for (const [index, tone] of expectedTones.entries()) {
    await expect(squares.nth(index)).toHaveClass(new RegExp(`(^|\\s)${tone}(\\s|$)`));
    // A positive match alone is a subset assertion: without this, one square
    // could carry two tones and still satisfy the line above.
    const others = everyTone.filter((other) => other !== tone).join("|");
    await expect(squares.nth(index)).not.toHaveClass(new RegExp(`(^|\\s)(${others})(\\s|$)`));
  }
  // The desk opens on the first case nobody has run — the fifth row — so exactly
  // that square is the current one.
  await expect(squares.nth(4)).toHaveClass(/(^|\s)current(\s|$)/);
  await expect(page.locator(".case-square.current")).toHaveCount(1);

  await expect(page.locator(".case-grid-legend")).toHaveText("通过 1 · 不通过 2 · 跳过 1 · 未测 1");

  // The tones are only real if the stylesheet paints them: the unit suite never
  // loads styles.css, so these computed colours are the only honest pin on it.
  // Deleting a tone rule leaves the square on the base `#fff` and fails here.
  const backgrounds = await squares.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).backgroundColor)
  );
  expect(backgrounds).toEqual([
    rgb(TONE_HEX.passed),
    rgb(TONE_HEX.failed),
    rgb(TONE_HEX.failed),
    rgb(TONE_HEX.skipped),
    rgb(TONE_HEX.untested)
  ]);
  // Computed, not guessed: the four tones are distinct, so one rule copied over
  // another cannot satisfy both the row above and this one.
  expect([...new Set(backgrounds)].sort()).toEqual(
    [rgb(TONE_HEX.passed), rgb(TONE_HEX.failed), rgb(TONE_HEX.skipped), rgb(TONE_HEX.untested)].sort()
  );
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noOverflow).toBe(true);

  // 保存 the last unrun case: nothing unrun is left, so the desk must stay put
  // and say the group is finished instead of jumping somewhere arbitrary.
  await page.getByRole("button", { name: "通过", exact: true }).click();
  await page.getByRole("button", { name: "保存结果" }).click();
  await expect(page.getByText("本组已全部测过")).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录后更换钱包", exact: true })).toBeVisible();
  await expect(page.locator(".desk-progress")).toHaveText("5/5 · ✓2 ✗2 ○0");
});

test("a save moves the desk on and the confirmation names the case it is about", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page, UNRUN_CASES);
  await page.goto("/");

  const first = page.getByRole("heading", { name: "登录后绑定钱包", exact: true });
  const second = page.getByRole("heading", { name: "登录后解绑钱包", exact: true });
  await expect(first).toBeVisible();
  await expect(page.locator(".desk-progress")).toHaveText("0/2 · ✓0 ✗0 ○2");

  await page.getByRole("button", { name: "通过", exact: true }).click();
  await page.getByRole("button", { name: "保存结果" }).click();

  // The save moved on to the case nobody has run, and the confirmation travelled
  // with it carrying the code of the case it is actually about.
  await expect(second).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(page.getByText(/B-001 已保存到本地/)).toBeVisible();

  // Moving by hand abandons the confirmation. 上一条用例 is the direction that
  // can do it here: the desk sits on the last case, where 下一条用例 is disabled
  // and ArrowRight (the same handler) has no next case to move to.
  await page.getByRole("button", { name: "上一条用例" }).click();
  await expect(page.getByText(/B-001 已保存到本地/)).toHaveCount(0);
  await expect(first).toBeVisible();

  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noOverflow).toBe(true);
});
