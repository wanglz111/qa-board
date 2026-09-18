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

it("posts a table-schema check with the role it is checking for", async () => {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/auth/csrf") return Response.json({ csrf_token: "token" });
    return Response.json({
      table_id: "tbl-runs",
      fields: { 用例: "text", 截图: "attachment" },
      required: ["用例", "截图"],
      schema_errors: ["缺少必填字段「结果」"]
    });
  }));

  const schema = await api.larkTableSchema("app-exec", "tbl-runs", "execution");

  const check = calls.find((call) => call.path === "/api/lark/table-schema");
  expect(check).toBeDefined();
  expect(check?.init?.method).toBe("POST");
  expect(new Headers(check?.init?.headers).get("X-CSRF-Token")).toBe("token");
  expect(JSON.parse(String(check?.init?.body))).toEqual({
    base_token: "app-exec",
    table_id: "tbl-runs",
    role: "execution"
  });
  expect(schema.schema_errors).toEqual(["缺少必填字段「结果」"]);
  vi.unstubAllGlobals();
});
