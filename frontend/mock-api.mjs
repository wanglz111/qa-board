// Dev-only mock of the TestDeck API.
//
//   node mock-api.mjs                     # answers on 127.0.0.1:8000, where vite proxies /api
//   npm run dev -- --host 0.0.0.0         # the app itself
//
// This is not a second implementation of the product. It answers the routes the
// pages read with fixed data, keeps what the operator submits in memory, and
// forgets everything on restart. 测试用例's rows are parsed out of
// docs/examples/ai-cases-template.csv so the fixture is the repo's own example
// book instead of a copy of it that can drift.
//
// Deliberately not mocked: /api/groups/:id/reports.xlsx (answers 501 with a
// readable reason), and Lark writes (the target stays unconfirmed, so the page
// shows its read-only state).

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const PORT = Number(process.env.MOCK_PORT ?? 8000);

// ---------------------------------------------------------------- png writer
// A screenshot the operator attaches and a 原型 reference have to be real
// decodable images, so the mock encodes its own: no dependency, no binary blob
// in the repo, and the two pictures are visibly different.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

function png(width, height, paint) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x / width, y / height);
      const at = rowStart + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const box = (x0, y0, x1, y1, colour) => (x, y) =>
  x >= x0 && x <= x1 && y >= y0 && y <= y1 ? colour : null;

function paint(layers, background) {
  return (x, y) => layers.reduce((hit, layer) => hit ?? layer(x, y), null) ?? background;
}

// 原型: a 后台登录 wireframe — header bar, a centred card, a filled button.
const PROTOTYPE_PNG = png(
  480,
  320,
  paint(
    [
      box(0, 0, 1, 0.12, [23, 107, 87]),
      box(0.18, 0.26, 0.82, 0.86, [255, 255, 255]),
      box(0.24, 0.36, 0.76, 0.41, [233, 236, 237]),
      box(0.24, 0.5, 0.76, 0.55, [233, 236, 237]),
      box(0.24, 0.64, 0.76, 0.72, [23, 107, 87])
    ],
    [244, 246, 247]
  )
);

// 执行截图: a dark console with a green pass band — what a run's evidence looks
// like, so a submitted row is not an empty frame either.
const SCREENSHOT_PNG = png(
  480,
  320,
  paint(
    [
      box(0, 0, 1, 0.09, [41, 45, 50]),
      box(0, 0.09, 1, 0.66, [30, 33, 36]),
      box(0.05, 0.16, 0.62, 0.2, [86, 180, 138]),
      box(0.05, 0.26, 0.83, 0.3, [86, 180, 138]),
      box(0.05, 0.36, 0.44, 0.4, [232, 168, 96]),
      box(0.05, 0.46, 0.72, 0.5, [86, 180, 138]),
      box(0, 0.66, 1, 1, [246, 248, 249]),
      box(0.05, 0.72, 0.3, 0.8, [28, 107, 69])
    ],
    [30, 33, 36]
  )
);

// ------------------------------------------------------------------- fixtures

const CSV_TEMPLATE = new URL("../docs/examples/ai-cases-template.csv", import.meta.url);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') (field += '"'), (i += 1);
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(field), (field = ""));
    else if (ch === "\n") (row.push(field), rows.push(row), (row = []), (field = ""));
    else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) (row.push(field), rows.push(row));
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

// The template's own columns, so a fixture built from it carries every field the
// detail pane reads instead of a hand-typed subset.
function casesFromTemplate() {
  const [header, ...rows] = parseCsv(readFileSync(CSV_TEMPLATE, "utf8"));
  return rows.map((cells, index) => {
    const value = (name) => cells[header.indexOf(name)]?.trim() || null;
    return mkCase({
      code: value("用例编号") ?? `LOGIN-${String(index + 1).padStart(3, "0")}`,
      position: Number(value("执行顺序")) || index + 1,
      title: value("用例标题") ?? "(未命名)",
      module: value("所属模块"),
      priority: value("优先级"),
      layer: value("执行分层"),
      preconditions: value("前置条件"),
      test_data: value("测试数据"),
      steps: value("执行步骤"),
      expected: value("预期结果"),
      result: null
    });
  });
}

function mkCase({
  code,
  position,
  title,
  module = null,
  priority = "P1",
  layer = "服务层",
  preconditions = null,
  test_data = null,
  steps = null,
  expected = null,
  result = null,
  reference = null
}) {
  return {
    id: `case-${code}`,
    code,
    position,
    title,
    module,
    priority,
    layer,
    preconditions,
    test_data,
    steps,
    expected,
    expect_absent: [],
    visual_check: reference ? "text_and_visual" : "text_only",
    prototype_note: reference ? `${module} 原型 · 提测版本` : null,
    latest_result: result,
    reference_assets: reference
      ? [{
          id: `asset-${code}`,
          link_id: `link-${code}`,
          asset_key: `asset-${code}`,
          name: `${title}.png`,
          mime: "image/png",
          width: 480,
          height: 320,
          asset_type: "page",
          screen: module,
          state: "默认态",
          prototype_version: "v2.0",
          role: "expected",
          caption: `${title} — 期望界面`,
          focus: []
        }]
      : []
  };
}

// The scripts are shared so twenty cases read like a real book without twenty
// copies of the same three steps drifting apart.
const SCRIPT = {
  登录: {
    steps: "1. 打开后台登录页\n2. 输入账号与密码\n3. 点击登录",
    expected: "1. 页面: 跳转到工作台\n2. 接口: 返回登录态 token",
    data: "admin@example.test / Test@1234"
  },
  基础信息: {
    steps: "1. 进入「基础信息」页\n2. 修改门店名称与营业时间\n3. 点击保存并刷新页面",
    expected: "1. 页面: 提示保存成功\n2. 刷新后字段与提交值一致",
    data: "门店名称=Odyssey 测试门店"
  },
  权限: {
    steps: "1. 用只读账号登录\n2. 打开角色管理页\n3. 尝试编辑任意角色",
    expected: "1. 页面: 编辑按钮不可用\n2. 接口: 返回 403",
    data: "readonly@example.test / Test@1234"
  },
  订单: {
    steps: "1. 进入订单列表\n2. 按状态筛选并翻页\n3. 打开一笔订单详情",
    expected: "1. 列表: 筛选结果与条件一致\n2. 详情: 金额与列表一致",
    data: "订单号=ODY202609180001"
  },
  导出: {
    steps: "1. 勾选 3 条记录\n2. 点击导出\n3. 打开下载的文件",
    expected: "1. 文件: 仅含勾选的 3 条\n2. 列名与页面一致",
    data: "导出格式=CSV"
  },
  验证码: {
    steps: "1. 切换到验证码登录\n2. 输入手机号并获取验证码\n3. 输入错误验证码后提交",
    expected: "1. 页面: 提示验证码错误\n2. 接口: 返回 400，不建立登录态",
    data: "手机号=13800000000 / 验证码=000000"
  },
  会话: {
    steps: "1. 登录后停留在工作台\n2. 清空会话 cookie\n3. 点击任意菜单",
    expected: "1. 页面: 跳回登录页并提示会话已过期",
    data: "会话 TTL=8h"
  },
  弱网: {
    steps: "1. 打开登录页\n2. 打开弱网模拟（延迟 3000ms）\n3. 连续点击登录 5 次",
    expected: "1. 接口: 只发出一次请求\n2. 页面: 按钮在请求期间不可重复提交",
    data: "网络延迟=3000ms"
  }
};

const CHAIN = [
  ["B-001", "管理员账号密码登录", "登录", "P0", "Smoke", "通过"],
  ["B-002", "登录后进入工作台首页", "登录", "P0", "Smoke", "通过"],
  ["B-003", "验证码错误时禁止登录", "登录", "P0", "服务层", "不通过"],
  ["B-004", "连续 5 次失败后锁定账号", "登录", "P1", "服务层", "不通过"],
  ["B-005", "门店名称保存后立即生效", "基础信息", "P1", "服务层", "不通过"],
  ["B-006", "营业时间跨天配置保存", "基础信息", "P1", "服务层", "不通过"],
  ["B-007", "门店 logo 上传与预览", "基础信息", "P2", "UI", "未执行"],
  ["B-008", "只读账号不可编辑角色", "权限", "P0", "服务层", "未执行"],
  ["B-009", "管理员可新增角色", "权限", "P1", "服务层", null],
  ["B-010", "角色删除后成员权限回收", "权限", "P1", "服务层", null],
  ["B-011", "订单列表按状态筛选", "订单", "P0", "服务层", null],
  ["B-012", "订单列表分页与总数一致", "订单", "P1", "服务层", null],
  ["B-013", "订单详情金额与列表一致", "订单", "P0", "服务层", null],
  ["B-014", "退款单在列表中标记", "订单", "P1", "服务层", null],
  ["B-015", "导出选中订单为 CSV", "导出", "P1", "服务层", null],
  ["B-016", "导出超过 1 万条时分批下载", "导出", "P2", "服务层", null],
  ["B-017", "空结果页展示引导文案", "订单", "P2", "UI", null],
  ["B-018", "退出登录后回退页面失效", "登录", "P0", "服务层", null],
  ["B-019", "会话过期后跳回登录页", "登录", "P0", "服务层", null],
  ["B-020", "多标签页登录态同步", "登录", "P2", "UI", null]
];

function chainCases() {
  return CHAIN.map(([code, title, module, priority, layer, result], index) =>
    mkCase({
      code,
      position: index + 1,
      title,
      module,
      priority,
      layer,
      preconditions: module === "登录" ? "已存在可登录的管理员账号" : "已登录且有对应菜单权限",
      test_data: SCRIPT[module].data,
      steps: SCRIPT[module].steps,
      expected: SCRIPT[module].expected,
      result,
      // Three cases carry a 原型 so the detail pane's gallery and the case
      // table's 原型 column are both exercised.
      reference: index < 3 ? "prototype" : null
    })
  );
}

const LOGIN_TITLES = [
  ["L-001", "后台登录页元素与文案检查", "登录", "P1"],
  ["L-002", "账号密码登录成功", "登录", "P0"],
  ["L-003", "账号密码错误提示", "登录", "P0"],
  ["L-004", "手机号验证码登录", "登录", "P1"],
  ["L-005", "记住登录状态 7 天", "登录", "P2"]
];

function loginCases() {
  return LOGIN_TITLES.map(([code, title, module, priority], index) =>
    mkCase({
      code,
      position: index + 1,
      title,
      module,
      priority,
      layer: index % 2 === 0 ? "UI" : "服务层",
      preconditions: "已存在可登录的管理员账号",
      test_data: SCRIPT.登录.data,
      steps: SCRIPT.登录.steps,
      expected: SCRIPT.登录.expected,
      result: null
    })
  );
}

// The template carries three rows; the real board's 测试用例 group holds 14, so
// the rest are written here in the template's own columns. Cases named by hand
// share a script instead of repeating three steps apiece.
const MORE_CSV_CASES = [
  ["LOGIN-004", "邮箱验证码登录", "登录", "P1", "Smoke", "验证码"],
  ["LOGIN-005", "验证码错误登录", "登录", "P0", "服务层", "验证码"],
  ["LOGIN-006", "连续 5 次失败后锁定账号", "登录", "P0", "服务层", "登录"],
  ["LOGIN-007", "记住登录状态 7 天", "登录", "P2", "服务层", "登录"],
  ["LOGIN-008", "退出登录后回退页面失效", "登录", "P0", "服务层", "会话"],
  ["LOGIN-009", "会话过期后跳回登录页", "登录", "P0", "服务层", "会话"],
  ["LOGIN-010", "多标签页登录态同步", "登录", "P2", "UI", "会话"],
  ["LOGIN-011", "未勾选协议时禁止登录", "登录", "P1", "UI", "登录"],
  ["LOGIN-012", "登录页在 375px 宽度下不横向滚动", "登录", "P2", "UI", "登录"],
  ["LOGIN-013", "登录接口超时后重试提示", "登录", "P1", "服务层", "弱网"],
  ["LOGIN-014", "弱网下重复点击只发一次请求", "登录", "P1", "服务层", "弱网"]
];

function extraCsvCases() {
  return MORE_CSV_CASES.map(([code, title, module, priority, layer, script], index) => {
    const steps = SCRIPT[script];
    return mkCase({
      code,
      position: index + 4,
      title,
      module,
      priority,
      layer,
      preconditions: "已存在可登录的账号",
      test_data: steps.data,
      steps: steps.steps,
      expected: steps.expected,
      result: null
    });
  });
}

const STATE = {
  groups: [
    {
      id: "0918-id",
      name: "Odyssey_2026-09-18 基础链路提测",
      source_name: "Odyssey_2026-09-18 基础链路提测.zip",
      source_version: "dae6425e6b6",
      created_at: "2026-09-18T02:10:00Z",
      cases: chainCases()
    },
    {
      id: "0920-id",
      name: "Odyssey_2026-09-20_后台登录与基础信息提测",
      source_name: "Odyssey_2026-09-20_后台登录与基础信息提测.zip",
      source_version: "26d9151b6506",
      created_at: "2026-09-20T03:05:00Z",
      cases: loginCases()
    },
    {
      id: "csv-id",
      name: "测试用例",
      source_name: "测试用例.csv",
      source_version: "d875c40d3b10",
      created_at: "2026-09-21T06:40:00Z",
      cases: [...casesFromTemplate(), ...extraCsvCases()]
    }
  ]
};

const ATTEMPTS = new Map();
let attemptSeq = 0;
// Reconcile keys whose local row the operator deleted: the read stops showing
// them, so the page after a delete looks like the page after a real one.
const deletedInLark = new Set();

function attemptFor(code, result, note, consoleText, when) {
  attemptSeq += 1;
  return {
    id: `attempt-${attemptSeq}`,
    label: code,
    sequence: 1,
    state: "committed",
    result,
    note,
    console_text: consoleText,
    source: "execution",
    created_at: when,
    screenshots: result === "不通过"
      ? [{
          id: "shot-b003",
          attempt_id: `attempt-${attemptSeq}`,
          storage_key: "shot-b003",
          mime: "image/png",
          size_bytes: SCREENSHOT_PNG.length,
          created_at: when
        }]
      : []
  };
}

ATTEMPTS.set("0918-id:B-001", [
  attemptFor("B-001", "通过", null, null, "2026-09-18T06:12:00Z")
]);
ATTEMPTS.set("0918-id:B-003", [
  attemptFor("B-003", "不通过", "验证码输错后仍然登录成功", "POST /api/login -> 200 (expected 400)", "2026-09-18T06:31:00Z")
]);

function groupOf(id) {
  return STATE.groups.find((group) => group.id === id) ?? null;
}

function progressOf(group) {
  const progress = { passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const item of group.cases) {
    if (item.latest_result === "通过") progress.passed += 1;
    else if (item.latest_result === "不通过") progress.failed += 1;
    else if (item.latest_result === "未执行") progress.skipped += 1;
    else progress.untested += 1;
  }
  return progress;
}

function groupList() {
  return STATE.groups.map((group) => ({
    id: group.id,
    name: group.name,
    source_name: group.source_name,
    source_version: group.source_version,
    count: group.cases.length,
    created_at: group.created_at
  }));
}

function legacyHistory(code) {
  const failed = code === "B-003";
  const base = {
    available: true,
    code,
    read_errors: [],
    source_table_name: "执行记录",
    base_name: "Odyssey 冒烟测试",
    bug_table_name: "Odyssey 冒烟测试bug表",
    read_at: "2026-09-21T07:20:00Z",
    certainty: "verified",
    uncertainty: null,
    ambiguous: false,
    original: [],
    retests: [],
    bugs: [],
    unknown_count: 0
  };
  if (!failed) return base;
  return {
    ...base,
    original: [
      {
        record_id: "rec-b003",
        case_text: "B-003 验证码错误时禁止登录",
        result: "不通过",
        note: "验证码输错后仍然登录成功，后端没有校验 challenge 是否匹配。",
        console_text: "POST /api/login -> 200 (expected 400)",
        observed_at: 1789000000,
        ref_id: "ref-b003",
        attachments: [{ index: 0, name: "b003-fail.png", mime: "image/png" }]
      }
    ],
    bugs: [
      {
        record_id: "bug-0918-004",
        description: "【登录】验证码错误时仍然可以登录成功",
        status: "待修复",
        priority: "P0",
        matched_by: "case_text"
      }
    ]
  };
}

// ---------------------------------------------------------------- http layer

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...(Buffer.isBuffer(body) ? {} : JSON_HEADERS), ...headers });
  res.end(payload);
  console.log(`${status} ${res.req.method} ${res.req.url}`);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  const method = req.method ?? "GET";
  let match;

  if (path === "/api/auth/me") return send(res, 200, { email: "admin@example.test" });
  if (path === "/api/auth/login") return send(res, 200, { email: "admin@example.test" });
  if (path === "/api/auth/csrf") return send(res, 200, { csrf_token: "mock-csrf-token" });
  if (path === "/api/auth/logout") return send(res, 204);

  if (path === "/api/groups") return send(res, 200, groupList());

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/cases$/))) {
    const group = groupOf(decodeURIComponent(match[1]));
    if (!group) return send(res, 404, { detail: "Group not found" });
    return send(res, 200, group.cases);
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/progress$/))) {
    const group = groupOf(decodeURIComponent(match[1]));
    if (!group) return send(res, 404, { detail: "Group not found" });
    return send(res, 200, progressOf(group));
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/cases\/([^/]+)\/attempts$/))) {
    const groupId = decodeURIComponent(match[1]);
    const code = decodeURIComponent(match[2]);
    const group = groupOf(groupId);
    if (!group) return send(res, 404, { detail: "Group not found" });
    const key = `${groupId}:${code}`;
    if (method === "POST") {
      const payload = await body(req);
      const item = group.cases.find((entry) => entry.code === code);
      const attempt = attemptFor(
        code,
        payload.result ?? null,
        payload.note ?? null,
        payload.console_text ?? null,
        new Date().toISOString()
      );
      // The response is the authority the page reads the result back from, and
      // the fixture the grid counts is the same object the next GET returns.
      if (item) item.latest_result = attempt.result;
      ATTEMPTS.set(key, [...(ATTEMPTS.get(key) ?? []), attempt]);
      return send(res, 200, attempt);
    }
    return send(res, 200, ATTEMPTS.get(key) ?? []);
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/cases\/([^/]+)\/lark-history$/))) {
    return send(res, 200, legacyHistory(decodeURIComponent(match[2])));
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/cases\/([^/]+)\/retest$/))) {
    const code = decodeURIComponent(match[2]);
    attemptSeq += 1;
    return send(res, 200, {
      id: `attempt-${attemptSeq}`,
      label: code,
      sequence: (ATTEMPTS.get(`${decodeURIComponent(match[1])}:${code}`)?.length ?? 0) + 1,
      state: "started",
      result: null,
      note: null,
      console_text: null,
      source: "execution",
      created_at: new Date().toISOString(),
      screenshots: []
    });
  }

  if ((match = path.match(/^\/api\/attempts\/([^/]+)\/submit$/))) {
    const payload = await body(req);
    attemptSeq += 1;
    return send(res, 200, {
      id: decodeURIComponent(match[1]),
      label: "B-003",
      sequence: 2,
      state: "committed",
      result: payload.result ?? null,
      note: payload.note ?? null,
      console_text: payload.console_text ?? null,
      source: "execution",
      created_at: new Date().toISOString(),
      screenshots: []
    });
  }

  if ((match = path.match(/^\/api\/attempts\/([^/]+)\/screenshots$/))) {
    const attemptId = decodeURIComponent(match[1]);
    return send(res, 200, {
      id: `shot-${attemptId}`,
      attempt_id: attemptId,
      storage_key: `shot-${attemptId}`,
      mime: "image/png",
      size_bytes: SCREENSHOT_PNG.length,
      created_at: new Date().toISOString()
    });
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/sync$/))) {
    return send(res, 200, {
      confirmed: true,
      queued: 0,
      synced: 3,
      failed: 0,
      uncertain: 0,
      parked: 0,
      last_error_kind: null,
      last_error: null,
      pending_attempts: 0,
      detail: "mock：本组结果已全部写入 Lark"
    });
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/reconcile\/apply$/))) {
    const payload = await body(req);
    const decisions = Array.isArray(payload?.decisions) ? payload.decisions : [];
    // Answer what it did, like the server does, and forget it on restart like
    // everything else here: a deleted row is remembered only so the next read
    // does not show it again.
    for (const decision of decisions) {
      if (decision?.action === "delete_local") deletedInLark.add(decision.key);
    }
    return send(res, 200, {
      pulled: decisions.filter((item) => item?.action === "use_remote").length,
      kept: decisions.filter((item) => item?.action === "use_local").length,
      removed: decisions.filter((item) => item?.action === "delete_local").length,
      skipped: []
    });
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/reconcile$/))) {
    const same = { local: { attempt_id: "attempt-1", result: "通过", console_text: null }, remote: { record_id: "rec-1", result: "通过", console_text: null } };
    // B-013's record was deleted in Lark: remote_deleted is what lets the page
    // offer the one action that removes a local row.
    const rows = [
      { key: "B-001", case_code: "B-001", label: "B-001", status: "same", differing: [], remote_deleted: false, decision: null, ...same },
      { key: "B-003", case_code: "B-003", label: "B-003", status: "conflict", differing: ["result", "note"], remote_deleted: false, decision: null, local: { attempt_id: "attempt-2", result: "不通过", console_text: "POST /api/login -> 200 (expected 400)" }, remote: { record_id: "rec-2", result: "通过", console_text: null } },
      { key: "B-007", case_code: "B-007", label: "B-007", status: "local_only", differing: [], remote_deleted: false, decision: null, local: { attempt_id: "attempt-3", result: "未执行", console_text: null }, remote: null },
      { key: "B-011", case_code: "B-011", label: "B-011", status: "remote_only", differing: [], remote_deleted: false, decision: null, local: null, remote: { record_id: "rec-4", result: "通过", console_text: null } },
      { key: "B-013", case_code: "B-013", label: "B-013", status: "local_only", differing: [], remote_deleted: true, decision: null, local: { attempt_id: "attempt-6", result: "不通过", console_text: "wallet.bind timeout" }, remote: null },
      { key: "旧记录#12", case_code: "B-099", label: "旧记录#12", status: "unmatched", differing: [], remote_deleted: false, decision: null, local: null, remote: { record_id: "rec-5", result: "不通过", console_text: null } }
    ].filter((row) => !deletedInLark.has(row.key));
    const counts = { same: 0, local_only: 0, remote_only: 0, conflict: 0, unmatched: 0 };
    for (const row of rows) counts[row.status] += 1;
    return send(res, 200, {
      source: url.searchParams.get("source") === "stored" ? "stored" : "live",
      source_table_name: "执行记录",
      read_errors: [],
      rows,
      counts,
      unresolved: rows.filter((row) => row.status !== "same").length
    });
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/reports\.(csv|xlsx)$/))) {
    if (match[2] === "xlsx") return send(res, 501, { detail: "mock 只提供 CSV：这个端口不是真的报告服务" });
    const group = groupOf(decodeURIComponent(match[1]));
    const rows = (group?.cases ?? []).map((item) =>
      [item.code, item.title, item.module, item.priority, item.latest_result ?? "未测"].join(",")
    );
    return send(res, 200, Buffer.from(["用例编号,用例标题,所属模块,优先级,结果", ...rows].join("\n"), "utf8"), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-${match[1]}.csv"`
    });
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/lark\/target$/))) {
    return send(res, 200, { target: null, live: null, read_errors: [] });
  }

  if ((match = path.match(/^\/api\/groups\/([^/]+)\/lark\/provision$/))) {
    return send(res, 200, {
      roles: { execution: [], bug: [] },
      retype: { execution: [], bug: [] },
      views: { execution: { name: "执行视图", exists: false, view_id: null }, bug: { name: "缺陷视图", exists: false, view_id: null } },
      rebuild: { execution: 0, bug: 0 }
    });
  }

  if (path === "/api/lark/resolve") {
    return send(res, 200, {
      source_url: "https://example.larksuite.com/base/mockBaseToken",
      base_token: "mockBaseToken",
      base_name: "Odyssey 冒烟测试",
      tables: [
        { table_id: "tbl-exec", name: "执行记录" },
        { table_id: "tbl-bug", name: "冒烟测试bug表" }
      ],
      selected: { table_id: "tbl-exec", table_name: "执行记录", view_id: null },
      execution_fields: { 用例编号: "用例编号", 结果: "结果", 说明: "说明", 控制台输出: "控制台输出" },
      required_execution_fields: ["用例编号", "结果", "说明", "控制台输出"],
      schema_errors: [],
      read_errors: []
    });
  }

  if (path === "/api/ai-prompts") {
    return send(res, 200, [
      { id: "casebook", title: "用例书生成", summary: "把需求文档整理成可导入的用例书", filename: "AI-CASEBOOK-PROMPT.md", markdown: "# 用例书生成\n\nmock 提示词正文。" },
      { id: "cases", title: "补充用例", summary: "针对某个模块补充边界用例", filename: "AI-CASE-PROMPT.md", markdown: "# 补充用例\n\nmock 提示词正文。" }
    ]);
  }

  if (path === "/api/import/preview") {
    const cases = STATE.groups[2].cases.slice(0, 12);
    return send(res, 200, {
      ticket_id: "ticket-mock-1",
      detected_format: "ai-cases-csv",
      count: cases.length,
      cases: cases.map((item) => ({
        code: item.code,
        position: item.position,
        title: item.title,
        module: item.module,
        priority: item.priority,
        visual_check: item.visual_check,
        reference_asset_count: 0
      })),
      fields: ["用例编号", "执行顺序", "用例标题", "所属模块", "优先级", "执行分层", "前置条件", "测试数据", "执行步骤", "预期结果"],
      errors: [],
      warnings: ["第 4 行「优先级」为空，导入后按 P2 处理"],
      title: "测试用例",
      reference_asset_count: 0,
      reference_link_count: 0,
      prototype_version: null
    });
  }

  if (path === "/api/import/confirm") {
    const payload = await body(req);
    return send(res, 200, { id: `group-mock-${Date.now()}`, count: payload?.mapping ? 12 : 0 });
  }

  if ((match = path.match(/^\/api\/screenshots\/(.+)$/))) {
    return send(res, 200, SCREENSHOT_PNG, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  }

  if ((match = path.match(/^\/api\/case-reference-assets\/(.+)$/))) {
    return send(res, 200, PROTOTYPE_PNG, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  }

  if ((match = path.match(/^\/api\/lark\/history\/([^/]+)\/attachments\/(\d+)$/))) {
    return send(res, 200, SCREENSHOT_PNG, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  }

  if (path === "/health") return send(res, 200, { status: "ok", mock: true });

  return send(res, 404, { detail: `mock 没有实现这个路由：${method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock api on http://127.0.0.1:${PORT}`);
  for (const group of STATE.groups) {
    const progress = progressOf(group);
    console.log(
      `  ${group.id.padEnd(8)} ${group.cases.length} 条 · 通过 ${progress.passed} 不通过 ${progress.failed} 跳过 ${progress.skipped} 未测 ${progress.untested}`
    );
  }
});
