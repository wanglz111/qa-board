import { expect, test, type Page, type Route } from "@playwright/test";

// A group the requirement moved on from: off the board, whole, and one click
// from coming back.

const GROUP = {
  id: "0918-id",
  name: "Sprint 0918",
  source_name: "0918.csv",
  source_version: "3",
  count: 14,
  created_at: "2026-09-16T08:00:00Z",
  archived_at: null as string | null
};

async function mockApi(page: Page, calls: string[]) {
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());

    if (pathname === "/api/auth/me") {
      return route.fulfill({ json: { email: "admin@example.test" } });
    }
    if (pathname === "/api/auth/csrf") {
      return route.fulfill({ json: { csrf_token: "test-csrf" } });
    }
    if (pathname === "/api/groups") {
      const includeArchived = searchParams.get("include_archived") === "true";
      return route.fulfill({
        json: includeArchived || GROUP.archived_at === null ? [GROUP] : []
      });
    }
    if (pathname === `/api/groups/${GROUP.id}/archive`) {
      calls.push("archive");
      GROUP.archived_at = "2026-09-18T00:00:00Z";
      return route.fulfill({ json: GROUP });
    }
    if (pathname === `/api/groups/${GROUP.id}/restore`) {
      calls.push("restore");
      GROUP.archived_at = null;
      return route.fulfill({ json: GROUP });
    }
    // Deliberately empty: the execution view is what loads first, and a case it
    // can open pulls in attempts, history and screenshots this spec is not
    // about. The archive flow does not need a case row.
    if (pathname === `/api/groups/${GROUP.id}/cases`) {
      return route.fulfill({ json: [] });
    }
    return route.fulfill({ json: {} });
  });
}

for (const viewport of ["desktop", "mobile"] as const) {
  test(`${viewport} retired group leaves the board and comes back`, async ({ page }) => {
    await page.setViewportSize(
      viewport === "desktop" ? { width: 1440, height: 900 } : { width: 360, height: 800 }
    );
    const calls: string[] = [];
    GROUP.archived_at = null;
    await mockApi(page, calls);
    await page.goto("/");
    // Exact: the groups page's own "刷新测试组" button contains the same word,
    // so a loose name match becomes ambiguous the moment the view switches.
    await page.getByRole("button", { name: "测试组", exact: true }).click();

    await expect(page.getByText("Sprint 0918")).toBeVisible();
    await page.getByRole("button", { name: "归档 Sprint 0918" }).click();

    // Retiring a group asks first, and says the thing an operator could get
    // wrong: the records already in Lark stay there.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("归档这个测试组？");
    await expect(dialog).toContainText("归档不动 Lark");
    expect(calls).toEqual([]);

    await dialog.getByRole("button", { name: "确认归档" }).click();

    await expect(page.getByText("板上没有测试组")).toBeVisible();
    expect(calls).toEqual(["archive"]);

    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(noOverflow).toBe(true);
    await page.screenshot({
      path: `test-results/groups-archived-${viewport}.png`,
      fullPage: true
    });

    // Kept, not gone: one toggle away, with a way back.
    await page.getByRole("button", { name: "显示已归档" }).click();
    await expect(page.getByText("已归档（1）")).toBeVisible();
    await page.getByRole("button", { name: "恢复 Sprint 0918" }).click();

    await expect(page.getByRole("button", { name: "归档 Sprint 0918" })).toBeVisible();
    expect(calls).toEqual(["archive", "restore"]);
  });
}
