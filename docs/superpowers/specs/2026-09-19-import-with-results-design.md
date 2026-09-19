# 用例 + 实测结果 · 一次导入（含第三份提示词）· 设计与需求确认单

- 日期：2026-09-19
- 状态：**待用户复核**（未开工改代码、未动线上）
- 触发：Odyssey C 端第一轮冒烟交付（50 条 / 41✅ / 9❌）要进 Lark。用户确认的流程是：「用例全部导入，pass 全部导入（含测试过程与结果）；失败用例不导入、留空当作未测试，我要亲自校验并把过程的图粘贴进去」，并要求新增一份「用例+结果」提示词。
- 涉及：`backend/app/importers/schema.py`、`backend/app/groups.py`、`backend/app/models.py`、`backend/alembic/versions/0017_attempt_evidence.py`、`backend/app/execution.py`、`backend/app/lark/{provision,write,outbox,reconcile}.py`、`backend/app/prompts.py`、`backend/app/prompts/ai-case-results.md`、`docs/AI-CASE-RESULT-PROMPT.md`、`frontend/src/{api.ts,views/Import.tsx,components/OutcomeForm.tsx,components/History.tsx}`

---

## 0. 一句话总览

把「导入」从**只写用例**扩成**用例 + 可选执行结果**：`执行结果` 非空的行在确认导入时物化为 attempt（`source='import'`），复用既有的 attempt→Lark 通道把结果写进执行表；`实测过程` 落到新增的 `attempts.evidence` 与执行表新列「实测过程」；结果为空的行**只建用例、不建任何执行记录** —— 这就是用户说的「留白」。同时交付第三份提示词，让 AI 把「已有用例 + 本轮实测」**转译**成这个 12 列格式。

---

## 1. 问题与证据（全部本机实测或源码事实，无推测）

### 1.1 这份交付文件今天导不进来（实测）

用仓库真实解析器跑 `Odyssey_测试用例_20260918_v3_冒烟交付.md`：**`PARSED: 0`**。

| # | 原因 | 证据 |
|---|---|---|
| 1 | 结构不被识别 | 文件是 `## 模块` + 6 列网格表。网格表判定要求表头**同时**命中 code/title/steps/expected 四组别名（`importers/markdown_file.py:98-116`），而 `测试项`（≠`标题`/`用例标题`）、`测试步骤`（≠`执行步骤`/`步骤`）都不在 `ALIASES`（`importers/schema.py:41-53`）；全文又没有 `####` H4 → 两条解析路径都空 → 报「未识别到用例边界」 |
| 2 | 结果不属于用例 | `FIELDS` 里没有结果维度，结果只活在 attempt 上；`本轮实测结果` 这列即使结构对上，也只落 `GroupCase.raw` |
| 3 | 两份必填元数据全缺 | `优先级`、`执行分层` 全文没有。按 `IMPORT-FORMAT.md` §2 二者须逐行填（漏写不报错、静默落空；优先级由 `DEFAULT_PRIORITY = "P2"` 兜底，`lark/write.py:16`） |
| 4 | 模块维度丢失 | `所属模块` 只以 `##` 标题存在，不是列 |

**数字是自洽的**（脚本计数，非阅读印象）：50 条用例行、`✅ 41 / ❌ 9`，与表头自述完全一致；编号唯一，`N-001..N-060` 有 10 个缺口，与「排除 10 条」对得上。内容颗粒度也够（每条带 `[UI]`/`[接口]` 口径标签 + 实测值）。**问题只在形状，不在内容。**

### 1.2 系统没有「结果随用例一起进来」的通道

| 环节 | 位置 | 事实 |
|---|---|---|
| 导入只写用例 | `groups.py:102-171` | `confirm_import` 只建 `GroupCase`，不建 attempt |
| 没有批量结果端点 | 路由表逐个核对 | 结果只能走 `POST /groups/{id}/cases/{code}/attempts` 或 `/attempts/{id}/submit`，一次一条 |
| 同步以 attempt 为唯一入口 | `lark/outbox.py:122-147, 173-210` | 只收 `state=committed` **且** `source='execution'` |
| 空行无处安放 | `models.py` `SyncJob` | `attempt_id` 是 `NOT NULL + UNIQUE`，模型注释写死 *"One outbound Lark create per local attempt"* → 与 attempt 无关的 Lark 行在本模型里**不可能存在**（这正是用户否掉「先建空行后补」的技术原因） |
| 写入只有 create | `lark/client.py` | 无 `update_record`；attempt 是 append-only（`allocate_attempt`，retest → `code-R…-nn`）→ 同一用例第二次提交 = Lark 第二行 |

用户据此拍板：**Lark 只收有结论的行（41 行）**，9 条留白、测完再出现；不做 update、不复测。

### 1.3 12 列契约前向兼容（实测）

`parse_file("golden12.csv", …)` → 12 个字段全部识别，`执行结果='通过'`、`实测过程` 的多行原文完整落 `raw`。表头不在别名表里的列只做留档，因此**今天用新提示词生成的文件，导入端上线后不用重做**。这也是允许「提示词先落、导入端随其后」的依据。

### 1.4 两个顺序陷阱（本方案必须守住，否则线上会卡住）

1. **`target_fingerprint` 包含 schema 指纹**：`lark/target.py:185-188` 把它算成 `schema_fingerprint(execution) || schema_fingerprint(bug)`；`run_job` 用 `job.target_fingerprint != target.target_fingerprint` 判定「目标被换过」并 park（`outbox.py:352-361`）。**给执行表加「实测过程」列会改变指纹** → 先入队再加列 = 41 个 job 全被 park，要人工 re-point。
   → 唯一正确顺序见 §6：**先 provision 加列 → 重读并重确认 target → 再导入 → 再同步**。
2. **`_group_case` 用 `GroupCase(**asdict(case))` 直通**（`groups.py:499-505`，另有 `:64`、`:494` 两处 `asdict`）。给 `ParsedCase` 加字段会**直接炸在建组这一步**，必须显式排除。

### 1.5 其他既有约束（设计要绕开的）

- 执行表 `结果` 单选的合法值含「阻塞」（`lark/fields.py:9`），但 `AttemptCreate` 只收 通过/不通过/未执行（`execution.py:33`），DB 有 CHECK 约束钉死 → 导入遇到「阻塞」**明文拒绝**，不静默映射成别的值。
- `不通过` 必须有 note（`execution.py:38-42`）→ 导入时用 `实测过程` 兜；两者都空则拒绝该行。
- `控制台` 是必填列且前端标签就是「控制台输出」（`lark/fields.py:50-59`、`components/OutcomeForm.tsx:184`）→ 过程文本不塞它，另开列（用户已拍）。

---

## 2. 已确认的决策（用户已拍，本单不再讨论）

| # | 决策 | 出处 |
|---|---|---|
| 1 | Lark 只收**有结论**的行（41 行）；9 条不建行，qa-board 网页端 50 条留白 | 本轮问答 |
| 2 | 不做 update / 不回写同一行；不复测 | 同上 |
| 3 | **新增「实测过程」列**，不塞进「控制台」 | 同上 |
| 4 | 交付第三份「用例 + 结果」提示词；**我不负责**转译这份 Odyssey 资料 | 同上 |
| 5 | `优先级` / `执行分层` 由用户按轮次自己补 | 同上 |

---

## 3. 目标与非目标

**目标**：一次导入，把 50 条用例 + 41 条通过（结果 + 实测过程原文）落进 qa-board 并同步到 Lark 执行表；9 条留白不产生执行记录；提示词能稳定产出这个文件。

**非目标**（本轮明确不做）：
- 不做同一行的 update / 回写；不做「先建空行后补」（需要 `SyncJob` schema 变更，用户已否）
- 不做第二个「结果回填」入口（先把单文件闭环做对）
- `casebook` 带图包本轮不支持结果列（失败行要人工配图，与带图包职责不重叠）
- 不支持「阻塞」结果值（明文拒绝，见 §12）
- 导入文件不带图片
- 不回填历史执行日期（`日期` = 导入时刻，见 §12）
- 不动 reconcile 的读回/标记语义（只把「本地行」白名单从 1 个值扩到 2 个）

---

## 4. 列契约与物化规则

### 4.1 文件列（12 列，顺序固定；前 10 列不动，结果列追加在末尾）

```
用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程
```

| 新列 | 别名（进 `ALIASES`） | 取值 |
|---|---|---|
| `执行结果` | `执行结果` `实测结果` `本轮实测结果` `result` | `通过` / `不通过` / `未执行` / 空 |
| `实测过程` | `实测过程` `过程记录` `实测说明` `evidence` | 自由文本；多行用双引号包格换行 |

### 4.2 物化规则（**唯一判决出处**）

| `执行结果` | attempt | `note` | `evidence` | Lark 执行表 |
|---|---|---|---|---|
| 通过 | 建，`state=committed`，`source='import'` | 空 | 实测过程 | 1 行，结果=通过 |
| 不通过 | 建 | 实测过程（空则**拒绝该行**） | 实测过程 | 1 行 + bug 表 1 行（既有逻辑，`outbox.py:420`） |
| 未执行 | 建 | 空 | 实测过程 | 1 行，结果=未执行 |
| 空 | **不建** | — | 只留档 `GroupCase.raw` | 不出现 |

> 「9 条留白」= 提示词对不通过行**不写** `执行结果`。这是**提示词里的策略**，不是系统里的硬规则 —— 系统只认「结果为空 = 未测」。

### 4.3 新增数据

- `attempts.evidence`：`Text NULL`。迁移 `0017_attempt_evidence`，`down_revision = "0016_lark_people"`（写法与命名照 `0016_lark_people.py`）。
- `Attempt.source` 放开枚举：`ck_attempts_source` 改为 `IN ('execution','reconcile','import')`；新增**单处定义**的常量 `LOCAL_SOURCES = ("execution", "import")`，五个过滤点改用它：`lark/outbox.py:130`（单条入队）、`:187`（批量入队）、`:529`（待同步计数）、`lark/reconcile.py:243`（本地行选择）、`:426`（删除前锁定）。
  - **为什么不用 `execution` 冒充**：本仓库已有 `reconcile` 这个先例（`components/History.tsx:34` 给它打标），导入行必须在执行历史与导出报表里可辨认 —— 「哪 41 行是转译进来的」正是用户要的审计线。单条入队路径仍只从提交流到达（attempt 刚创建），所以放进白名单不会造成重复入队。
- `idempotency_key = f"import:{group_id}:{code}"`（**Task 3 实施期裁决修正**；本文档原先写的是文件哈希）：唯一约束**按组作用域**既防"一次确认里重复插入"，又让同一份文件再次导入合法地建新组 —— 既有契约就是"重复文件只 warning、由人决定"（`test_duplicate_file_warns_but_creates_a_distinct_group`）。文件哈希作键会让第二次确认撞 `attempts_idempotency_key_key` 并抛出未捕获的 500，这在本任务实施时被复现过。

### 4.4 Lark 执行表

- `RUN_SCHEMA` **末尾追加** `"实测过程": FieldSpec(1)`（文本型）。追加而**不**插在 `控制台` 之后：`RUN_SCHEMA` 的列顺序是与参考表对齐的承重约定（`provision.py:112-131` 注释），追加保证 8 列前缀与参考表**逐列一致**。
- `REQUIRED_RUN_FIELD_TYPES` 加 `"实测过程": (1,)` → 已有 target 会显示「缺列」，必须按 §6 顺序补齐（这是有意的破窗：不加进必填，写端就会往一张没有该列的表里写这个键，create 直接失败）。
- `lark/write.py:execution_fields` 增 `"实测过程": attempt.evidence or ""`；`控制台` 继续只写 `console_text`，两者不互相顶替。

---

## 5. 后端契约

### 5.1 `POST /api/import/preview`（响应新增）

- `result_count`：带 `执行结果` 的行数
- `evidence_only_count`：有 `实测过程` 但结果为空的行数（**必须显式暴露**，否则用户会以为过程导进去了）
- `cases[0..9]` 增 `result` / `evidence` 两个键：`ParsedCase` 加了字段后 `_case_payload` 的 `asdict` 会自动带上，**不要手写重复的键**
- `fields` 已自动含新列（`raw` 直通），无需改

### 5.2 `POST /api/import/confirm`

- 请求新增 `import_results: bool = True`；UI 在检出结果时给出勾选框，取消则只建用例。
- 物化时机：`db.add(group)` 之后、`db.commit()` 之前，对结果非空的行 `allocate_attempt` + 写 `result/note/evidence/console_text=None/idempotency_key`，与建组同一个事务（中途失败整体回滚、ticket 不消费，可重试）。
- **不在这里 enqueue**：新组 target 必然未确认，`enqueue_attempt_job` 会返回 `None`；同步仍走 Lark 检查页的既有按钮。
- 返回值增 `attempt_count`。

### 5.3 校验（硬性，逐条报错并带编号）

- `执行结果` 不在枚举（含「阻塞」）→ `Case N-033 has invalid result: 阻塞（只接受 通过/不通过/未执行）`
- `执行结果=不通过` 且 `实测过程` 为空 → `Case N-024 is a failure without 实测过程`
- 其余沿用既有规则（编号/顺序唯一、正整数、UTF-8）
- `import_results=False` 时忽略也不校验结果列（用户只要用例）

---

## 6. 线上操作顺序（关键，必须写进 Lark 检查页文案与提示词用法段）

1. 在 Lark 检查页为执行表补齐「实测过程」列（走既有 `修正表头` / `provision`）
2. 重新读取并确认 target（指纹随 schema 更新）
3. 导入 12 列文件（勾选「写入执行结果」）
4. 点「同步」把 41 个 job 入队

> 顺序颠倒（先同步、后加列）→ 全部 job 因指纹变化被 park，需人工 re-point。见 §1.4。

---

## 7. 前端改动

| 文件 | 改动 |
|---|---|
| `views/Import.tsx` | 预览区显示「检出 N 条执行结果（其中 M 条仅有过程，将只留档）」+ 勾选框 |
| `api.ts` | `ImportPreview` 加三个字段；confirm 请求体加 `import_results` |
| `components/OutcomeForm.tsx` | 新增「实测过程」文本域，与「控制台输出」并列（**不复用同一个框**） |
| `components/History.tsx` + 执行记录展示 | 显示 `evidence`；`source === 'import'` 打「导入」徽标 |
| `components/AiPromptPanel.tsx` | **零改动**：卡片是 `prompts.map`，注册后自动多一张 |

---

## 8. 第三份提示词

- 文件对：`backend/app/prompts/ai-case-results.md` ≡ `docs/AI-CASE-RESULT-PROMPT.md`，**逐字节相同**（`backend/tests/test_ai_prompts.py::test_shipped_prompts_match_the_docs` 会拿 `docs/<filename>` 比对，不一致直接测试失败）。
- `prompts.py` 的 `PROMPTS` 加第三条：`id="case-results"`、`title="已有用例 + 实测结果 → 可导入格式"`、`filename="AI-CASE-RESULT-PROMPT.md"`、`path=PROMPT_DIR/"ai-case-results.md"`。
- 定位：**转译型**（对照 `ai-cases.md` 的生成型）。输入三处占位符：`【已有用例】`、`【本轮实测结果】`、`【需求】`（最后这个同时被 `test_ai_prompts` 断言存在）。
- 纪律（这份提示词的失败模式不是格式，是 AI「顺手帮你优化文案」）：照抄不重写、不美化、不补没测过的用例；编号/标题/步骤/预期**逐字保留**；不得合并或拆分用例；不得删掉没通过的用例。
- 内容必须含：12 列硬约束、结果枚举、`不通过` 必须带 `实测过程`、`留空 = 未测（系统不会为它建执行记录）`、用法段写明「`优先级`/`执行分层` 按轮次自己补」「日期 = 导入时刻」、自检清单、黄金样例（**已用真实解析器验证**，见 §1.3）。
- 第三部分「常见错误写法」至少覆盖：结果写成 `✅/❌`（非枚举）、把过程写成「验证通过」这类判断词、删掉不通过的用例、把多张表拼成一份导致编号重排、过程文本里塞图片。

---

## 9. 错误处理边界

- 结果列有值但 `import_results=False` → 只建用例，预览已提示，不报错。
- 过程文本有值、结果为空 → 不报错，只留档；预览用 `evidence_only_count` 显式提示。
- 「阻塞」→ 明文拒绝，文案给出替代写法（写「未执行」并在实测过程说明阻塞原因）。
- 物化冲突（`idempotency_key` 撞车）→ 整体回滚、ticket 不消费。
- 图片：导入文件不带图；失败行的图由人工在执行页上传，走既有截图→Lark 附件通道。

---

## 10. 验收门（TDD，先红后绿）

后端（pytest）：
1. `parse_file` 认 `执行结果`/`实测过程` 到 `ParsedCase.result`/`evidence`；且 `_group_case` 不因新字段炸（现有导入测试保持全绿，红点先行）
2. confirm 物化：41 条带结果 → 41 个 attempt（`result`/`evidence`/`idempotency_key` 正确），9 条空 → 0 个 attempt
3. `不通过` 无 `实测过程` → 报错且文案含编号；`阻塞` → 报错
4. `import_results=False` → 0 个 attempt
5. `enqueue_group_attempts` 把 `source='import'` 一并入队（先写红：不加白名单时计数为 0）
6. `execution_fields` 输出 `实测过程`
7. `PROMPTS` ids == `["cases","casebook","case-results"]`；两份 markdown 逐字节一致
8. `REQUIRED_RUN_FIELD_TYPES` 含 `实测过程`，且 `schema_order("execution")` 的末位是它
9. 迁移 `0017` up/down 可跑

前端（vitest）：
10. 预览检出结果 → 显示 N/M + 勾选框；取消勾选 → 请求体 `import_results=false`
11. `OutcomeForm` 提交带 `evidence`
12. `AiPromptPanel` 渲染三张卡

端到端（人工一次）：按 §6 顺序跑 12 列样例 → Lark 出现 41 行、结果=通过、实测过程有原文；qa-board 进度显示 41 通过 / 9 未测。

---

## 11. 我不动的东西

- `ai-cases.md` / `ai-casebook.md` 正文与既有 10 列契约（新提示词是**第三份**，不改前两份）
- `casebook` ZIP 格式与它的严格校验
- reconcile 的读回/标记语义、outbox 的租约/退避/证据窗口（`EVIDENCE_SETTLE_SECONDS`）
- `Attempt.state` 状态机（仍是 `started`/`committed`）
- reports 的列（只是 `source` 多一个取值 `import`）

---

## 12. 待拍板 / 遗留

1. **`日期` 列 = 导入时刻**（`Attempt.created_at` 走 `server_default=now()`）。若你要 0918 的真实执行日期，办法是提示词加第 13 列 `实测时间`（可选，缺省用导入时刻）—— 本轮不做，等你一句话。
2. 9 条留白在 Lark 不可见（Lark 只有 41 行）。这是你拍的；若团队要求「一眼看到 9 条待复验」，回到 §3 非目标第 1/2 条，需要 schema 变更。
3. 「阻塞」本轮不支持。若真实数据里确有阻塞用例（`lark/fields.py:9` 的枚举里有它），需要单开一次改动：`AttemptCreate` + `ck_attempts_state_result` + 前端选项。
