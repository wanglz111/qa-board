import { expect, test, type Page, type Route } from "@playwright/test";

import { toneOf } from "../src/caseTone";

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
  expected: "钱包绑定成功",
  expect_absent: [],
  visual_check: "text_and_visual",
  prototype_note: null,
  // Left unrun on purpose: the desk must open on the first case nobody has run,
  // which is the branch a group of only-finished cases never reaches.
  latest_result: null,
  reference_assets: []
};

// The PiP window carries the desk's progress line, so its expected text is
// derived from the same fixture the desk renders rather than typed by hand: one
// case, nobody has run it, so nothing is done and the one row is untested.
const PIP_CASES = [CASE];
const PIP_COUNTS = { passed: 0, failed: 0, skipped: 0, untested: 0 };
for (const item of PIP_CASES) PIP_COUNTS[toneOf(item.latest_result)] += 1;
const PIP_PROGRESS =
  `${PIP_COUNTS.passed + PIP_COUNTS.failed + PIP_COUNTS.skipped}/${PIP_CASES.length}` +
  ` · ✓${PIP_COUNTS.passed} ✗${PIP_COUNTS.failed} ○${PIP_COUNTS.untested}`;

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

async function pasteDefectImage(page: Page) {
  await page.locator(".outcome-form").evaluate((form) => {
    const binary = atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "checkout-error.png", { type: "image/png" }));
    form.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
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

test("pasted defect screenshots render as removable image previews", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByText("管理员登录后绑定钱包")).toBeVisible();

  await pasteDefectImage(page);
  const preview = page.getByRole("img", { name: "缺陷截图：checkout-error.png" });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: "test-results/defect-image-preview-desktop.png", fullPage: true });

  await page.getByRole("button", { name: "预览 checkout-error.png" }).click();
  const dialog = page.getByRole("dialog", { name: "checkout-error.png" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  const fullImage = dialog.getByRole("img", { name: "checkout-error.png" });
  await expect.poll(() => fullImage.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: "test-results/defect-image-fullscreen-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "移除 checkout-error.png" }).click();
  await expect(preview).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await pasteDefectImage(page);
  await expect(page.getByRole("img", { name: "缺陷截图：checkout-error.png" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/defect-image-preview-mobile.png", fullPage: true });

  await page.getByRole("button", { name: "预览 checkout-error.png" }).click();
  await expect(page.getByRole("dialog", { name: "checkout-error.png" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/defect-image-fullscreen-mobile.png" });
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await expect(page.getByRole("dialog", { name: "checkout-error.png" })).toHaveCount(0);
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
  const pipPagePromise = page.context().waitForEvent("page");
  await pipButton.click();
  const pipPage = await pipPagePromise;
  await pipPage.setViewportSize({ width: 420, height: 760 });
  await expect(pipPage.getByRole("button", { name: "关闭画中画" })).toBeVisible();
  // The sidebar grid stays behind in the main window, so the counts have to
  // travel with the desk: the progress line is inside the surface that moved.
  await expect(pipPage.locator(".desk-progress")).toBeVisible();
  await expect(pipPage.locator(".desk-progress")).toHaveText(PIP_PROGRESS);
  expect(
    await pipPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);
  await pipPage.getByRole("button", { name: "通过", exact: true }).click();
  await expect(pipPage.getByRole("button", { name: "通过", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await pasteDefectImage(pipPage);
  const preview = pipPage.getByRole("img", { name: "缺陷截图：checkout-error.png" });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await pipPage.getByRole("button", { name: "预览 checkout-error.png" }).click();
  const dialog = pipPage.getByRole("dialog", { name: "checkout-error.png" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  expect(
    await pipPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  ).toBe(true);
  await pipPage.screenshot({ path: "test-results/task5-pip-open.png", fullPage: true });

  await pipPage.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await pipPage.getByRole("button", { name: "移除 checkout-error.png" }).click();
  await expect(preview).toHaveCount(0);

  await pipPage.getByRole("button", { name: "关闭画中画" }).click();
  await expect(page.getByRole("button", { name: "画中画" })).toBeVisible();
});
