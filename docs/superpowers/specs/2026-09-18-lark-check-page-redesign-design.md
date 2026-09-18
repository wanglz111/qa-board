# Lark 检查页重构 · 设计与需求确认单

- 日期：2026-09-18
- 状态：**待用户复核**（未开工改代码、未动线上）
- 触发：用户报「页面非常啰唆，从上到下信息密度太高」+「第一次选定的记录表表头不匹配时，红字会一直在不会销」
- 涉及：`frontend/src/views/LarkCheck.tsx`、`frontend/src/components/HeaderSetup.tsx`、`backend/app/lark/target.py`

---

## 0. 一句话总览

把「连接本组的 Lark 多维表格」从**三块 panel 全摊开**改成**一行状态条 + 4 步向导**；
把「判决」从**读取时的一次性快照**改成**按当前选中的表实时派生**。
前者解决啰嗦，后者根治那个红字不销的 bug —— 两者同一个病根：**页面一直在用"再加一行提示"的方式补救状态没跟上。**

## 1. 问题与证据

### 1.1 缺陷：红字不销（已复现，不是读代码猜的）

复现方式：临时组件测试驱动真实 `LarkCheckView`，`resolve` 返回「表头缺 `截图` 的 `tbl-runs` + 表头完好的 `tbl-bugs`」，读取后切下拉。输出：

```
REPRO 不匹配红字 after switching table: STILL SHOWN
REPRO field list text: 执行表字段：用例 · text
REPRO resolve call count: 1
AssertionError: expected <p class="inline-status error">缺少必填字段「截图」</p> to be null
```

（复现文件已在取证后删除，工作区无残留。证据：本会话 vitest 输出。）

| 环节 | 位置 | 事实 |
|---|---|---|
| 红字渲染 | `LarkCheck.tsx:638-642` | 直接 map `resolved.schema_errors`，**不读当前选中的表** |
| 错误由谁算 | `target.py:118-119,147` | 只对 `link.table_id`（或 `tables[0]`）**一张表**算 |
| 契约 | `target.py:219-229` | `POST /api/lark/resolve` 只接受 `{url}`，**没有按表校验的入口** |
| 切换动作 | `LarkCheck.tsx:618-628` | `onChange` 只 `setExecutionTableId(...)`，不重读、不重算、不清空 |

**根因**：`resolved` 这一个 state 把两种寿命不同的数据混在一起了 —— base 级（`tables`、`base_name`，切表后仍有效）与 table 级（`selected`、`execution_fields`、`schema_errors`，切表即失效）。table 级判决被存在 base 级作用域里，于是一条针对**已被丢弃的表**的判决，永久贴在**刚选中的表**头上。

**同根因的连带问题**：
- `LarkCheck.tsx:630-637`「执行表字段」是同一份快照 —— 切到 `tbl-bugs` 后仍显示 `tbl-runs` 的字段。
- `LarkCheck.tsx:696`「保存选择」不看任何 schema 状态 → **真实方向是反的**：选中的表一次没校验，丢掉的表一直在报错。

**边界（诚实划出）**：页面上有两处红字。`liveErrors`（`:205-209`，服务端对**已保存目标**的重读）是会正常更新的；不销的只有读取阶段的 `resolved.schema_errors`，其清除条件只有：重按「读取表格」、切「测试组」（`:181-190` 置 `null`）、刷新页面。

**覆盖缺口**：`LarkCheck.test.tsx` 只覆盖 `live.schema_errors`（:181-203、:637-654）；`e2e/lark-check.spec.ts` 的 fixture `schema_errors` 恒为 `[]` —— 这条路径零测试。

### 1.2 啰嗦（量化，不是观感）

- 单列 900px、三块 panel 顺序堆叠，**无任何折叠层**（`styles.css:109`）。
- 全页 **27 个 `inline-status` 独立 `<p>` 行**（`LarkCheck.tsx` 13 + `HeaderSetup.tsx` 14）。
- 「写入确认」单块面板满载时最多同屏 **12 个元素**：状态行、勾选框、按钮、队列统计、最近错误、最多 4 个 ghost 按钮、2–3 段灰字说明、notice、error。
- **最长一段说明 124 字**（`LarkCheck.tsx:822-827`，去标签后的可见字符；其中中文与中文标点 117 个），另一段 43 字（`:818-820`），常驻显示但只在极窄分支下有意义。
  - ⚠️ 初稿此处写的是「194 字 / 78 字」，**是错的**：当时的正则把 `) : null}` 这类 JSX 残渣一并计入了。由 Round 1 独立复审指出，已实测更正。
- 重复信息：表名在「已保存的目标」（`:569-580`）、两个下拉、写入确认（`:730`）、切换弹窗里各出现一次。
- 内嵌 `HeaderSetup` 946 行的组件，含 3 个弹窗入口。

### 1.3 历史模式（本方案真正的动机）

`LarkCheck.tsx` 被 11 次提交改过，其中至少 4 次的标题是"让它诚实"：

```
3ca1bf9 fix(web): align the sync queue's buttons and say why rows are stuck   ← 那段 124 字说明的出处
c079178 fix: make the connection page honest about stale and second-base selections
c8fb147 fix: keep the header dialog reachable and its approval honest
5743bb7 fix: keep the defect base and the parked copy honest
```

每次发现状态没跟上，解法都是"再加一行提示"，从未给状态本身建模。本次报的 bug 是同一模式的复发。
**因此本方案的目标不是删文案，而是换机制。**

## 2. 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 使用节奏 | **每个测试组配一次，配完就走** → 向导优先，配完页面自然安静 |
| D2 | 什么情况必须主动提醒 | ① 表头失效/必填列缺失；② 同步失败/待人工确认。**目标表被别处改过不算**（保存时 409 已能拦截） |
| D3 | 信息架构 | **方案 1：状态条 + 4 步向导**（否决「三块折叠」与「双 Tab」） |
| D4 | 状态模型 | probes 按表缓存；判决渲染时派生；表未读即 `unread`；draft 判决与 `live` 判决分家 |
| D5 | 步骤边界 | 4 步：选表 / 表头 / 确认写入 / 同步；**收的是入口，不是确认**（3 个破坏性弹窗原样保留） |
| D6 | 后端契约 | 新增只读 `POST /api/lark/table-schema`；判决单一来源规则见 §7 |

## 3. 目标与非目标

**目标**
- 健康态首屏 = 1 行状态条 + 4 行步骤标题；无红字、无长文、无按钮堆叠。
- 任一处判决只描述"当前选中的那张表 / 已保存的那个目标"，且只渲染一次。
- 两条必吵醒的异常能定位到具体步骤，靠状态条 + 自动展开，而不是靠顶部堆红字。

**非目标**
- 不改 `App.tsx` 的视图切换模型、不加 URL 路由。
- 不改后端 `resolve` / `provision` / `retype` / `rebuild` / `save` 的现有行为与响应形状。
- 不做数据库迁移。
- 不动同步 worker、outbox、reconcile 的业务语义。

## 4. 状态模型

### 4.1 两层 state

```ts
// ① base 级：一次 url 读取的结果
type LarkBase = {
  base_token: string;
  base_name: string;
  source_url: string;
  tables: { table_id: string; name: string }[];
  read_errors: string[];
  // ② 表级结论挂在「表」上，不挂在「这次读取」上；key = `${table_id}:${role}`
  probes: Record<string, Probe | "loading">;
};

type Probe = {
  fields: Record<string, string>;   // 字段名 → 类型名（describe_fields 的输出）
  required: string[];
  schema_errors: string[];
  read_error?: string;              // 这张表读不到时的原因
};

type Draft = {
  execution: { base: LarkBase | null; tableId: string; viewId: string | null };
  // 缺陷库链接为空 = 与执行表同库（保留现有语义）
  bug: { base: LarkBase | null; tableId: string };
};

// 服务端已保存的事实，与 draft 无关
type TargetState = { target: LarkTarget | null; live: {...} | null; read_errors: string[] };
```

### 4.2 派生规则（**唯一判决出处**）

```ts
const key = `${draft.execution.tableId}:execution`;
const probe = draft.execution.base?.probes[key];
const verdict = verdictOf(probe);

function verdictOf(p: Probe | "loading" | undefined): Verdict {
  if (p === "loading") return "loading";
  if (!p) return "unread";                       // 这张表从没校验过
  if (p.read_error) return "unreadable";         // 读到了但读失败
  return p.schema_errors.length > 0 ? "bad" : "ok";
}
```

- 切表 = **换 key**，判决随之改变，不做任何快照 → **结构性根治**（不是加清除条件）。
- 表未读过 → `unread` → 显示「尚未校验这张表」+ 「校验」按钮，**绝不引用别的表的判决**。
- `bugBase = draft.bug.base ?? draft.execution.base` —— 显式派生，没有隐藏快照（取代现有 `bugReadApplies` / `bugReadUrl` 机制）。
- probes 的 key 含 `role`：同一张表既当执行表又当缺陷表时，两套 required 各自成立，不串味。
- 「缺陷库链接未读取」不再是全局红字，降级为第 ① 步下拉旁的一行说明。

**链接框与已读 base 必须同源（同类坑的第二个入口）**：`base` 只在它**确实由当前框里的那段链接读出来**时才有效，即
`baseIsCurrent(role) = draft[role].base?.source_url === draft[role].url.trim()`。
编辑链接框内容即视为未读取：该 role 回到「链接已改动，尚未读取」，下拉与判决一并作废。
旧页面对执行表链接框也缺少这条规则 —— 本设计一并收口，不留第二个 stale 入口。

### 4.3 与旧 state 的对应

| 旧 | 新 |
|---|---|
| `resolved` / `bugResolved` | `draft.execution.base` / `draft.bug.base` |
| `executionTableId` / `bugTableId` | `draft.*.tableId` |
| `resolved.execution_fields` / `schema_errors` | `probes[...]`（**不再复用为切换后的判决**） |
| `bugReadUrl` + `bugReadApplies` | `draft.bug.base ?? draft.execution.base` |
| `createdTables` | 保持不变（含 `base_token` 归属校验），创建后该表 probe 置 `unread` |
| `state` / `live` | `TargetState`，语义不变 |

### 4.4 保存

`saveSelection()` 仍以 draft 当前值构建 payload；`identityChanged()` = draft vs target 比较；
保存成功后由 PUT 响应更新 `TargetState`（保留「PUT 已返回 live、不再补一次 GET」的既有做法）。

## 5. 信息架构

### 5.1 状态条（常驻一行）

输入：`target` 是否存在 → `confirmed` → `live.schema_errors` 是否为空 → `sync.failed / sync.uncertain`。

```
健康     已确认 · 执行记录 / 缺陷记录 · 待同步 0 · 失败 0
未确认   未确认：本地结果不会写入 Lark
表头失效 已确认，但表头已失效（缺 2 列）→ 第 2 步        ← D2 的吵醒条件 ①
同步异常 同步失败 3 条 · 待人工确认 1 条 → 第 4 步        ← D2 的吵醒条件 ②
```

### 5.2 四步

| 步 | 内容 | 可达性 / 完成条件 |
|---|---|---|
| ① 选表 | 两个链接框 + 读取按钮 + 两个下拉 + **就地 verdict**（每张表自己的） | 两表都已校验并选中 |
| ② 表头 | 一行 plan 状态（`缺 2 列：结果、日期`）+ 三个动作 | 需已保存 `target`；否则提示回第 ① 步先保存 |
| ③ 确认写入 | 勾选 + 确认按钮；`invalidated` 时**一句话** | 两表 verdict 均 `ok` 才可勾选 |
| ④ 同步 | 统计 + 动作 + `last_error` | 仅 `confirmed` 可达 |

- 只有当前步展开；前置未完成的步显示为标题行且不可进入。
- 配完（4 步全 ✓）→ 全部收成标题行 + 状态条，页面安静。
- 异常（D2 两条）→ 状态条变红/黄 + 对应步自动展开。
- 长说明只在对应计数 > 0 时出现（如 `syncParked > 0` 才显示那段 194 字说明）；解释性内容降级为按钮 `title`。
- 360px 下纵向堆叠，不做横向 stepper。

## 6. 组件与文件边界

| 文件 | 职责 | 目标规模 |
|---|---|---|
| `views/LarkCheck.tsx` | 编排、状态条、stepper 骨架，**以及 8 个从旧页面迁移过来的动作**（persist / saveSelection / confirmChange / approveWrites / queueSavedAttempts / retryQueuedJobs / 409 两分支 / refreshTarget） | **< 340 行**（含迁移动作） |
| `views/useLarkCheckActions.ts`（可选，二期） | 若要把上面 8 个动作从页面抽出来，使 `LarkCheck.tsx` 回落到 250 行以内 | 不在本轮范围 |
| `hooks/useLarkDraft.ts` | draft + probes + 校验/切表动作 | 新增 |
| `components/lark/StepTables.tsx` | 第 ① 步 | 新增 |
| `components/lark/StepHeaders.tsx` | 第 ② 步外壳 + plan 状态 | 新增 |
| `components/lark/StepApprove.tsx` | 第 ③ 步 | 新增 |
| `components/lark/StepSync.tsx` | 第 ④ 步 | 新增 |
| `components/lark/ProvisionDialog.tsx` / `RetypeDialog.tsx` / `RebuildDialog.tsx` | 三个破坏性动作；**确认流程原样保留**，文案范围见 §12 P1 | 从 `HeaderSetup.tsx` 拆出 |
| `components/TargetChangeDialog.tsx` | 不变 | — |

`HeaderSetup.tsx`（946 行）拆分后删除。三个弹窗的 `acknowledge` 语义、失败分支、`ProvisionFailureDetail` 处理全部保留。

> ⚠️ **一处口径更正**：本表初稿给 `LarkCheck.tsx` 写的是「< 250 行」。写实施计划时按真实代码块逐段计数，页面是 **328 行** —— 其中 8 个从旧页面迁移的动作约占 120 行、四步 props 与 `data-state` 约 45 行、Props 声明与 live 原因行约 25 行，纯排版最多再省 ~60 行。压到 250 只有两条路：删分支（触犯门 6）或把这 8 个动作抽成独立文件（`views/useLarkCheckActions.ts`，需改本表与计划）。**本轮选择如实修正数字**，把「抽出动作」列为二期可选项 —— 「250」是当初拍的目标，不是验收标准，不该为了凑它删代码。

## 7. 后端契约

```
POST /api/lark/table-schema          # 只读；与 /lark/resolve 同 router（admin + 归档组拦截）
  入 { base_token, table_id, role: "execution" | "bug" }
  出 { table_id, fields: {名→类型}, required: [...], schema_errors: [...] }
  422  该多维表格里没有这张表
  409  应用不是协作者
```

- **为什么单开接口**：`resolve` 是 url→base（一次）；表级校验必须能按 `table_id` 单独取。把 base 内每张表都读进来 = N 次请求。
- **请求预算**：happy path 只 1 次 Lark 请求（直接 `list_fields`）；失败时才补一次 `list_tables` 区分「表没了」与「没权限」。
- **实时性**：`list_fields` 不在 `cache.py` 的缓存范围内 → 「校验」永远拿到实时字段。
- **不返回表名**：前端已持有 `tables` 列表。
- **判决单一来源规则**：`resolve` 返回的 `schema_errors` **只允许给 `execution` role + `selected.table_id` 的首个 probe 播种**（同一份服务端计算）；role 或 table 不匹配一律 probe。
- **provision / retype / rebuild 之后**：其响应里的 `schema_errors` 是 execution+bug **合并**的（按字段名反推角色太脆）→ 作废受影响 role 的 probe 并重新校验，不解析合并结果。
- **前端集成面**：`api.ts` 新增 `readTableSchema(baseToken, tableId, role)`；`LarkCheckView` 的 `Props` 增加对应一项；`App.tsx` 只需多传这一个函数（**视图切换模型不变**，见 §3 非目标）。

## 8. 错误处理边界

| 场景 | 行为 |
|---|---|
| 表未校验 | probe `unread` → 「尚未校验这张表」+ 校验按钮 |
| 校验中 | probe `loading` → 该步内联 loading，不阻塞其它步 |
| 表读不到 | probe `unreadable` + 原因；不阻塞其它步；不冒充 `ok` |
| 切 base / 清空缺陷库链接 | 按 `base_token` 归属作废该 role 的 probe |
| 保存 409 `stale_page` | 保留现行为：重读 + 保留本次选择 + 提示再次保存 |
| 保存 409 `target_changed` | 保留 `TargetChangeDialog` 流程 |
| 创建表后 | `createdTables` 语义保留（含 `base_token` 归属校验）；新表 probe = `unread`，随后校验 |
| 重建表后 | 重建**在服务端换掉了目标表**：响应里的 `target` 更新 `TargetState`，同时把 `draft[role].tableId` 指向新表、旧表从 `createdTables` 移除、新表 probe = `unread`。**若不跟随，下一次「保存选择」会把组重新指回被替换掉的旧表** |
| provision / retype 后 | 作废受影响 role 的 probe 并重新校验（响应里的 `schema_errors` 是两角色合并值，不解析） |
| 链接框内容被编辑 | 该 role 回到「链接已改动，尚未读取」，base 与判决一并作废（见 §4.2） |

## 9. 验收门（TDD，先红后绿）

| # | 门 | 断言 |
|---|---|---|
| 1 | **本次 bug 回归** | 切换执行表后旧表红字消失、显示新表 verdict。**改动前该用例必须是红的** |
| 2 | 不串味 | 两表 verdict 不同时，各自只显示自己的 |
| 3 | unread 诚实 | 未校验的表显示「尚未校验」，不借用他表结论、不显示空白；**编辑链接框后该 role 的 base 与判决一并作废** |
| 4 | 健康态预算 | **健康态下**状态条 1 行 + 4 个步骤标题，且页面无 `role="alert"`（异常态允许有） |
| 5 | 两个吵醒条件 | 表头失效 → 状态条红 + 第②步展开；同步失败/待人工确认 → 第④步展开 |
| 6 | 安全确认不被吃掉 | 三个破坏性动作各自的确认弹窗与 `acknowledge` 流程仍在 |
| 7 | probe 缓存 | 同表来回切不重复请求（mock 调用计数断言） |
| 8 | e2e | 360 / 1440 两档 + 无横向溢出 + 选择器更新 |
| 9 | 全绿 | `tsc -b` + 全量 vitest + 后端 pytest |

## 10. 我不动的东西

- 同步 worker / outbox / reconcile / history 的业务语义。
- `resolve` / `provision` / `retype` / `rebuild` / `lark/target` 保存接口的行为与响应形状。
- `TargetChangeDialog` 的确认文案与分支。
- 三个破坏性动作的确认文案里，**安全相关的句子**保持原文（非安全说明的取舍见 §12 P1）。
- 数据库 schema（无迁移）。
- 线上现网数据与部署（本设计只到代码与本地验证）。

## 11. 落地顺序

```
1) 后端：新增 /lark/table-schema + pytest（先写失败测试）
2) 前端：useLarkDraft + probes（含验收门 1–3、7 的失败测试先红）
3) 前端：拆三个对话框，从 HeaderSetup.tsx 迁出（门 6）
4) 前端：状态条 + 4 步向导重写 LarkCheck.tsx（门 4–5）
5) 清理：删除 HeaderSetup.tsx、旧样式、旧测试
6) e2e 选择器更新 + 两档视口（门 8）
7) tsc -b + 全量测试（门 9）+ 本地浏览器实测
```

## 12. 待拍板

| # | 问题 | 我的默认 |
|---|---|---|
| P1 | 三个破坏性动作的确认文案：**安全相关的句子保持原文**（§10 已划为边界）；其余非安全的说明句是否一并精简？ | **一并精简非安全说明**，安全句不动 |
| P2 | 第 ② 步在 draft 尚未保存时：显示「先去第①步保存」提示，还是干脆禁止进入直到保存？ | **显示提示**，允许进入看 plan（只读） |
| P3 | 已存在的 e2e 截图基线（`test-results/*.png`）会被新页面覆盖 | **接受覆盖**，不额外保留旧图 |

---

**证据交代**：本设计基于本会话的只读代码阅读 + 一次已删除的临时复现测试，未修改任何产品代码。
