import { vi } from "vitest";

import { api } from "./api";


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
