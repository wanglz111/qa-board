import { vi } from "vitest";

import { ApiError, api } from "./api";


it("shares one csrf request across concurrent mutations", async () => {
  let csrfRequests = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/auth/csrf") {
      csrfRequests += 1;
      await Promise.resolve();
      return Response.json({ csrf_token: "token" });
    }
    return Response.json({
      ticket_id: crypto.randomUUID(), detected_format: "csv", count: 1,
      cases: [], fields: [], errors: [], warnings: []
    });
  }));

  const file = new File(["id,title\nA-1,One"], "cases.csv");
  await Promise.all([api.preview(file), api.preview(file)]);

  expect(csrfRequests).toBe(1);
  vi.unstubAllGlobals();
});

it("turns a refused connection into a message an administrator can act on", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  }));

  const failure = await api.resolveLark("https://tenant.larksuite.com/base/app1").catch((error) => error);

  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).message).toBe("无法连接服务器，请重试");
  vi.unstubAllGlobals();
});
