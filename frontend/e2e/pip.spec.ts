import { expect, test, type Page, type Route } from "@playwright/test";

import type { ReferenceAsset } from "../src/api";
import { toneOf } from "../src/caseTone";

// A 480x1600 移动端 prototype: the long-screenshot shape the viewer exists for.
// Typed on purpose — a fixture missing a field should fail here, not as a blank
// page in the browser.
//
// The id deliberately climbs out of /api with `..`, which the browser resolves
// before sending, so the picture is served from the dev server's own static tree
// instead of the proxied backend. That matters for the PiP assertions: a
// picture-in-picture window is an `about:blank` document whose requests
// Playwright neither routes nor reports, so anything under /api would simply
// fail to load there.
const PROTOTYPE: ReferenceAsset[] = [
  {
    id: "../../e2e/fixtures/prototype-480x1600.svg",
    link_id: "link-b001",
    asset_key: "asset-b001",
    name: "登录页原型.png",
    mime: "image/svg+xml",
    width: 480,
    height: 1600,
    asset_type: "page",
    screen: "账户",
    state: "默认态",
    prototype_version: "v2.0",
    role: "expected",
    caption: "登录页 — 期望界面",
    focus: [{ label: "底部主按钮", note: "文案须与原型一致", box: [0.08, 0.9, 0.84, 0.06] }]
  }
];

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
  reference_assets: PROTOTYPE
};

// The PiP window carries the desk's progress line, so its expected text is
// derived from the same fixture the desk renders rather than typed by hand: one
// case, nobody has run it, so nothing is done and the one row is untested.
const PIP_CASES = [CASE];
const PIP_COUNTS = { passed: 0, failed: 0, skipped: 0, untested: 0 };
for (const item of PIP_CASES) PIP_COUNTS[toneOf(item.latest_result)] += 1;
const PIP_PROGRESS =
  `${PIP_COUNTS.passed + PIP_COUNTS.failed + PIP_COUNTS.skipped}/${PIP_CASES.length}` +
  ` · 通过${PIP_COUNTS.passed} 不通过${PIP_COUNTS.failed}` +
  ` 跳过${PIP_COUNTS.skipped} 未测${PIP_COUNTS.untested}`;

// A PiP window is its own page, so the routes have to be installed on whatever
// scope owns the pages under test — a Page for one window, the BrowserContext
// when a picture-in-picture window will open its own subresource requests.
async function mockApi(scope: Pick<Page, "route">) {
  await scope.route("**/api/**", async (route: Route) => {
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

// A long screenshot the tester pastes. Drawn in the page so the blob carries
// real pixel dimensions — and a blob is the one kind of picture a PiP window can
// load in this harness, because it never leaves the origin.
async function pasteLongScreenshot(page: Page, name: string) {
  await page.locator(".outcome-form").evaluate(async (form, filename) => {
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 1600;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#f4f6f7";
      context.fillRect(0, 0, 480, 1600);
      context.fillStyle = "#176b57";
      context.fillRect(29, 1440, 422, 96);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return;
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], filename, { type: "image/png" }));
    form.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  }, name);
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
  // The desk clips its own overflow in the small window, so a document-level
  // scrollWidth check cannot see a progress line wider than the surface — the
  // clipped half just disappears. Measure the line against the desk's padding
  // box, which is exactly the region `.pip-surface .execution-desk` lets the
  // reader see: this is what makes "still fits at 420px" an assertion rather
  // than a hope about how the words happen to wrap.
  const progressFits = await pipPage.locator(".desk-progress").evaluate((line) => {
    const desk = line.closest(".execution-desk");
    // Deliberately no `instanceof HTMLElement`: the desk node is created in the
    // opener's document and then adopted into the PiP one, so its prototype still
    // belongs to the opener's realm and that check is false inside this window.
    if (!desk) return { width: 0, room: -1, fits: false };
    const box = line.getBoundingClientRect();
    const clip = desk.getBoundingClientRect();
    const style = getComputedStyle(desk);
    const left = clip.left + parseFloat(style.borderLeftWidth);
    const right = clip.right - parseFloat(style.borderRightWidth);
    return { width: box.width, room: right - left, fits: box.left >= left && box.right <= right };
  });
  expect(progressFits.fits).toBe(true);
  expect(progressFits.width).toBeLessThanOrEqual(progressFits.room);
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

async function zoomPercent(page: Page) {
  const label = await page.getByRole("button", { name: /当前缩放/ }).getAttribute("aria-label");
  return Number.parseInt(label?.match(/当前缩放 (\d+)%/)?.[1] ?? "0", 10);
}

// What the viewer actually did to the picture: the rendered frame against the
// scrolling stage, plus where the stage is scrolled to.
async function viewer(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector(".image-zoom-stage");
    const frame = document.querySelector(".image-zoom-frame");
    return {
      stage: stage ? stage.clientWidth : 0,
      frame: frame ? frame.getBoundingClientRect().width : 0,
      scrollTop: stage ? stage.scrollTop : 0
    };
  });
}

// The reason the viewer exists: a long prototype used to arrive as a strip. It
// now has to open readable, scroll with a plain wheel, zoom under the pointer,
// land 1:1 exactly, and walk to a focus box — in the desk and in the
// picture-in-picture window, whose width is its own.
test("a long prototype is readable and zoomable, in the desk and in PiP", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  // The context, not just this page: the PiP window fetches the prototype for
  // itself, and an unrouted request would go to the real backend from there.
  await mockApi(page.context());
  await page.goto("/");
  await expect(page.getByText("管理员登录后绑定钱包")).toBeVisible();

  await page.getByRole("button", { name: "放大查看 登录页原型.png" }).click();
  const dialog = page.getByRole("dialog", { name: "登录页原型.png" });
  await expect(dialog).toBeVisible();

  // 适应宽度: the 480px wide prototype spans the stage. The tall content brings a
  // scrollbar with it and the refit follows, so the two settle into each other.
  await expect.poll(async () => {
    const now = await viewer(page);
    return Math.abs(now.frame - now.stage);
  }).toBeLessThan(2);
  expect(await zoomPercent(page)).toBeGreaterThan(100);

  // A plain wheel scrolls the picture and is left alone.
  const box = await page.locator(".image-zoom-stage").boundingBox();
  if (!box) throw new Error("the stage has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 400);
  await expect.poll(async () => (await viewer(page)).scrollTop).toBeGreaterThan(100);

  // 1:1 is the real pixel size, which is the whole point of opening the viewer.
  await dialog.getByRole("button", { name: "原始尺寸 1:1" }).click();
  expect(await zoomPercent(page)).toBe(100);
  expect((await viewer(page)).frame).toBeCloseTo(480, 0);

  // A pinch arrives as ctrl+wheel; it must zoom the picture, not the page.
  // `exact` on purpose: Playwright matches accessible names by substring, and
  // the readout's label mentions 适应宽度 too.
  await dialog.getByRole("button", { name: "适应宽度", exact: true }).click();
  await page.evaluate(() => {
    const scope = window as unknown as { wheelPrevented: boolean | null };
    scope.wheelPrevented = null;
    document.querySelector(".image-zoom-stage")?.addEventListener("wheel", (event) => {
      scope.wheelPrevented = event.defaultPrevented;
    });
  });
  const before = (await viewer(page)).frame;
  const spot = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(spot.x, spot.y);
  // Playwright's own mouse.wheel carries no modifier state, so the gesture goes
  // in over CDP — the same path a real trackpad pinch takes.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: spot.x,
    y: spot.y,
    deltaX: 0,
    deltaY: -120,
    modifiers: 2
  });
  await cdp.detach();
  await expect.poll(async () => (await viewer(page)).frame).toBeGreaterThan(before);
  expect(await page.evaluate(() => (window as unknown as { wheelPrevented: boolean | null }).wheelPrevented)).toBe(true);

  // A focus box takes the operator to the spot instead of naming a percentage.
  await page.getByRole("button", { name: "底部主按钮", exact: true }).click();
  await expect.poll(async () => (await viewer(page)).scrollTop).toBeGreaterThan(1000);
  await expect(page.locator(".image-focus-box.active")).toBeVisible();
  await page.screenshot({ path: "test-results/prototype-zoom-desk.png" });

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  const supported = await page.evaluate(() => "documentPictureInPicture" in window);
  if (!supported) return;

  const pipPagePromise = page.context().waitForEvent("page");
  await page.getByRole("button", { name: "画中画" }).click();
  const pipPage = await pipPagePromise;
  await pipPage.setViewportSize({ width: 420, height: 760 });

  await pipPage.getByRole("button", { name: "放大查看 登录页原型.png" }).click();
  const pipDialog = pipPage.getByRole("dialog", { name: "登录页原型.png" });
  await expect(pipDialog).toBeVisible();

  // The picture refits against the PiP window it now lives in, not against the
  // 1440px desk it came from. It is measured against the size the API declares:
  // a PiP window is an about:blank document whose network subresources are not
  // serviced in this harness, so these bytes never arrive there (a blob: one
  // does — the second half of this test uses exactly that).
  await expect.poll(async () => {
    const now = await viewer(pipPage);
    return Math.abs(now.frame - now.stage);
  }).toBeLessThan(2);
  const inner = await viewer(pipPage);
  expect(inner.stage).toBeLessThan(500);
  expect(inner.frame).toBeLessThan(500);

  const pipBefore = await zoomPercent(pipPage);
  await pipDialog.getByRole("button", { name: "放大" }).click();
  expect(await zoomPercent(pipPage)).toBeGreaterThan(pipBefore);
  await pipPage.keyboard.press("Escape");
  await expect(pipDialog).toHaveCount(0);

  // The same viewer, in the same window, with a long picture that really does
  // load there: a screenshot the tester pastes, drawn at 480x1600 so it has the
  // shape of a prototype rather than a thumbnail.
  await pasteLongScreenshot(pipPage, "long-failure.png");
  await expect(pipPage.getByRole("img", { name: "缺陷截图：long-failure.png" })).toBeVisible();
  await pipPage.getByRole("button", { name: "预览 long-failure.png" }).click();
  const shot = pipPage.getByRole("dialog", { name: "long-failure.png" });
  await expect(shot).toBeVisible();

  // 适应宽度 on a real 480x1600 picture inside a 420px window.
  await expect.poll(async () => {
    const now = await viewer(pipPage);
    return Math.abs(now.frame - now.stage);
  }).toBeLessThan(2);
  expect(await zoomPercent(pipPage)).toBeGreaterThan(50);

  // 1:1 is the screenshot's own pixel size, and it scrolls in this window too.
  await shot.getByRole("button", { name: "原始尺寸 1:1" }).click();
  expect(await zoomPercent(pipPage)).toBe(100);
  expect((await viewer(pipPage)).frame).toBeCloseTo(480, 0);
  const pipStage = await pipPage.locator(".image-zoom-stage").boundingBox();
  if (!pipStage) throw new Error("the PiP stage has no box");
  await pipPage.mouse.move(pipStage.x + pipStage.width / 2, pipStage.y + pipStage.height / 2);
  await pipPage.mouse.wheel(0, 400);
  await expect.poll(async () => (await viewer(pipPage)).scrollTop).toBeGreaterThan(100);
  await pipPage.screenshot({ path: "test-results/prototype-zoom-pip.png" });

  await pipPage.keyboard.press("Escape");
  await expect(shot).toHaveCount(0);
  await pipPage.getByRole("button", { name: "关闭画中画" }).click();
  await expect(page.getByRole("button", { name: "画中画" })).toBeVisible();

  // A viewer that works but shouts into the console is not done.
  expect(problems).toEqual([]);
});
