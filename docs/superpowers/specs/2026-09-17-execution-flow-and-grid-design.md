# 执行台续做：自动跳转 / 表单复位 / 缺陷备注 / 进度方格

状态：**已定稿（决策点已确认）**，待人工复核 → 之后才写实现计划与代码。
分支：`main`（当前干净）。日期：2026-09-17。

需求来源（原话）：
1. 选择「通过 / 不通过 / 跳过」后应该跳到下一个**未测**用例，现在不跳。
2. 填写的不通过或通过理由，点确认提交后没有消失，还留在输入框里。
3. Lark 的「问题描述」以 `测试用例编号 + 标题` 开头，读起来不方便；把「测试用例编号 + 标题」放到**备注**栏，问题描述只留失败说明。
4. 因为「测试 + 跳过 + 自动跳转」，看不出哪个用例测过哪个没测过。选中 `GROUPS 测试组` 后希望出现**日历样式的方格**（通过=绿、未通过=红、跳过=黄、未测=无颜色），默认光标落在第一个没颜色的方格上。页面不要太复杂臃肿。
约束（用户指定）：所有新样式都要保证**画中画（PiP）模式内的显示逻辑准确**。

## 已确认的决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | 自动前进边界 | **环绕式**：其后第一条未测 → 没有则回到本组最前一条未测 → 全组已测则停在原地并提示「本组已全部测过」。手动 ←/→ 仍逐条走，不跳过已测。 |
| 2 | 表单复位范围 | **提交成功后复位 + 切用例/切组时也复位**。 |
| 3 | 记忆光标 | **收紧**：只在记忆的那条**仍未测**时回到它，否则落到第一条未测。 |
| 4 | 方格位置 | **侧栏**：GROUPS 组列表保持现状，选中组下方展开方格 + 图例；另外在 desk 内加一行紧凑进度（随 PiP 搬进小窗）。 |
| 5 | 备注格式 | 「用例」行 +（可选）「步骤」行（决策 6）+（可选）「控制台」行（决策 8）；**不写「结果」**（缺陷行只在「不通过」时产生，重复）。已核实的同类冗余一律不写：`优先级` / `进展状态` / `反馈时间` / `反馈人` / `截图` 都有自己的列（`test_lark_provision.py:281`）。 |
| 6 | 步骤行 | **写，限 100 字**，截断时补 `…（完整步骤见用例 {code}）`；不截断就不补指针。控制台照常显示（全量，飞书文本列上限 10 万字符）。 |
| 7 | 不写入备注 | 测试数据（常含账号密码）、模块/分层、测试组/版本、执行次数、前置条件、`expect_absent`、【自动提】类来源标记（团队此前明确删过，不推翻）。 |
| 8 | 控制台前缀 | 保留 `控制台：` 标签（与「用例：」「步骤：」风格一致；用户跳过此题，按推荐处理，可随时去掉）。 |

---

## 一、调查结论（逐条代码证据）

### 需求 1：保存后不前进 —— 缺失功能，不是回归

- `frontend/src/views/Execution.tsx:263-328` `save()` 只做：提交 → 刷新 attempts → 刷新 progress → 就地更新 `latest_result` → 读 sync → 传截图 → 写状态。**没有调用 `showCase()`**，`caseIndex` 不变。
- `quickSave()`（`Execution.tsx:360-364`，Enter=通过 / Ctrl+B=跳过）同样只 save。
- 上一版计划明确决定不做自动前进：`docs/superpowers/plans/2026-09-17-execution-resume.md:549`。本次是**改需求**。
- 「未测」定义已统一：`latest_result === null`（`executionCursor.ts:46-48`），「未执行/跳过」也算已测。
- 现成可复用：`startIndexFor(cases, cursor, groupId)`（`executionCursor.ts:52-65`）已实现「上次看的那条 → 第一条未测 → 全测完落最后一条」。
- 相互影响的坑：
  - 前进时 `showCase()` 会 `setStatus(null)`（`Execution.tsx:232`），刚弹出的「已保存到本地 · …」会**当场消失**。
  - 表单不复位（需求 2）→ 自动前进后上一条的失败说明留在框里，接着点「保存结果」就会把 A 用例的说明提交到 B 用例上（错单）。
  - `save()` 里有多个 await；期间操作员仍可点 `CaseDetail` 的 ←/→（`CaseDetail.tsx:44-63` 的按钮在 `submitting` 时**没有 disabled**），所以前进必须以「保存前那一条的下标」为基准，不能读当时的实时下标。

### 需求 2：提交后输入框不清空 —— 根因确认

- `frontend/src/components/OutcomeForm.tsx:118-131`：`result` / `note` / `consoleText` 是组件内部 state，`useImperativeHandle` 只暴露 `setResult` 与 `focusNote`，**没有 reset 通道**。
- `frontend/src/views/Execution.tsx:322,340`：保存成功后只 `setImages([])`，`note` / `consoleText` / `result` 无清空路径。
- 同类未报告 bug：`showCase()`（`:223-242`）与 `selectGroup()`（`:184-221`）都不重置表单，且 `<OutcomeForm>` 没有 `key`，切用例时组件不重挂 → 「切到下一题 → 点保存结果」会把上一题的说明一起提交。`quickSave()` 因显式传 `note: null` 躲过（代价是丢弃刚写的说明）。

### 需求 3：Lark「问题描述」前缀 —— 位置与连带影响

- 写入：`backend/app/lark/write.py:105-148` `bug_fields()`：`问题描述 = "{code} {title}" + "\n" + note`（`:115-117`）；`备注 = "由用例 {code} 提交（结果：{result}）" + "\n" + console`（`:118-124`）。
- 受影响断言：`backend/tests/test_lark_outbox.py:126-128,157,308`；`backend/tests/test_lark_history.py:110-152`。
- **连带影响（关键）**：读回旧缺陷靠 `history.match_bugs()`（`history.py:191-231`），它只在 `DESCRIPTION_FIELDS = ("问题描述","缺陷描述","描述")`（`fields.py:77`）里用 `CASE_REFERENCE`（`history.py:34-36`）匹配**开头就是编号**的文本。编号不再出现在 `问题描述` 开头后，**本工具新写的缺陷行会读不回来**，执行页显示「未匹配到旧缺陷」。`备注` 在缺陷表里是已验证的文本列（`fields.py:69`、`provision.py:122`），可承载。
- 「不通过必须有说明」后端已强制（`execution.py:35-37`），缺陷行只在 `不通过` 时产生（`outbox.py:385`）→ 收窄后的 `问题描述` 不会为空。
- 缺陷表的列清单（`test_lark_provision.py:281` 断言的顺序）：`问题描述 / 进展状态 / 跟进人 / 优先级 / 截图 / 反馈人 / 反馈时间 / 备注`。所以写进 `备注` 的 `结果`、`优先级`、`进展状态`、`反馈时间`、`反馈人` 全是重复信息。
- 备注可写内容的数据来源已逐项核实：`case.steps` / `case.expected` / `case.preconditions` / `case.test_data` / `module` / `layer` 都在 `GroupCase`（`models.py:100-115`）；`case.group.name / source_name / source_version / short_code` 可经关系拿到（`models.py:117`），outbox 里 `case = attempt.group_case` 已在同一 session（`outbox.py:309`）；「第几次执行 / 是否重测」由 `attempt.sequence`（`>1` 即重测）与 `attempt.label`（`B-001-R{short_code}-{NN}`，`execution.py:124-128`）判定。经头脑风暴与你的选择，这些**不写入**备注（决策 7）。

### 需求 4：进度方格 —— 数据现成，位置已定

- `latest_result` 已在载荷里：`groups.py:212-230` 计算、`:248` 返回；前端 `GroupCase.latest_result`（`api.ts:78-81`）；`cases` 选组时全量加载。**不需要新接口**。
- 侧栏结构：`Execution.tsx:402-416`（`aside.execution-groups` + `GroupSelector`）。`GroupSelector.tsx:42-48` 已有 passed/failed/skipped 三色 `progress-pips`，方格是它的「逐条展开」版。
- **PiP 搬运逻辑**（`usePiP.ts:112-122`）：只把 `deskHost`（`div.execution-desk`，portal 全部内容）`append` 进小窗；`aside.execution-groups` 留在主窗口。**desk 里的东西随 PiP 搬走、主窗口看不到；侧栏里的东西 PiP 里看不到**——二者不可兼得，故决策 4 采用「方格在侧栏 + desk 内一行紧凑进度」。
- PiP 专属样式：`styles.css:57`；PiP 窗口固定 420×760（`usePiP.ts:100-104`）；`.pip-surface` 已隐藏 `.attempt-history` / `.legacy-history` 与 `.shortcut-hint`。
- 响应式：`styles.css:183` 窄屏并成一栏；e2e 有 `scrollWidth <= innerWidth` 硬断言，方格必须自适应列数。

---

## 二、行为规格（颗粒度到可写测试）

### A. 自动前进（需求 1）

1. 新增纯函数到 `frontend/src/executionCursor.ts`：

   ```ts
   // 从 from 之后找第一条未测；没有则从本组最前找（环绕）；全组已测（不含 from 自己以外无未测）
   // 返回 null 表示「无处可去」——调用方留在原地并让「本组已全部测过」提示生效。
   export function nextUntestedIndex(cases: GroupCase[], from: number): number | null
   ```

   规则，按顺序：
   1. 在 `from+1 .. length-1` 里找第一条 `latest_result === null` → 返回它；
   2. 否则在 `0 .. from-1`（**不含 `from`**）里找第一条未测 → 返回它（环绕）；
   3. 否则返回 `null`。
   `cases` 为空 → `null`；`from` 越界按 `from = -1` 处理（等价于从头找）。

2. `save()` 成功后（顺序固定，避免「保存中」的转圈盖在下一题上）：
   - `save()` 开头 `const savedIndex = caseIndex`；新增 `caseIndexRef`（每次渲染同步）用于在 await 之后读**实时**下标。
   - 用**同一份**更新后的数组同时驱动状态与前进判定（不依赖异步 `setState`）：
     `const updated = cases.map(item => item.code === saved.code ? { ...item, latest_result: attempt.result } : item)`；`setCases(updated)`（仍带 `loadedGroup.current === savedGroupId` 守卫）。
   - 在 `try` 内只**算出**目标，不跳转：`const canAdvance = loadedGroup.current === savedGroupId && caseIndexRef.current === savedIndex; const advanceTo = canAdvance ? nextUntestedIndex(updated, savedIndex) : null;`
   - `finally { setSubmitting(false); }` **之后**才执行：`if (advanceTo !== null) await showCase(advanceTo, { keepStatus: true });`
   - `advanceTo === null` → 留在原地，保存确认保持在屏幕上（`allTested(updated)` 为真时页面显示「本组已全部测过」）。
3. 保存确认文案带上用例编号，因为它会跟到下一题：`{code} 已保存到本地 · 将新增到 Lark 旧表` / `{code} 已保存到本地 · 尚未确认 Lark 目标表`（截图失败仍是 `{code} 结果已保存到本地，但截图上传失败`）。现有 e2e 断言 `/已保存到本地/` 不受影响。
4. `showCase(index, options?: { keepStatus?: boolean })`：`keepStatus` 为真时**不**清 `status`（保存确认跨到下一题仍然可见）；默认（手动 ←/→、点击方格跳转）仍清空。
5. 键盘：Enter=通过 / Ctrl+B=跳过 → `quickSave` → `save` → 同样自动前进。`不通过` 键盘路径只打开输入框，不提交、不前进（保持现状）。

### B. 表单复位（需求 2）

1. `OutcomeFormHandle` 增加 `reset: () => void`：`setResult(null)`、`setNote("")`、`setConsoleText("")`、`setValidation("")`。
2. `save()` 成功后调用 `formRef.current?.reset()`；`setImages([])` 保持。
3. `showCase()` 与 `selectGroup()` 开头也 `formRef.current?.reset()`（切用例/切组不留上一题的说明）。
4. 保存失败**不**复位：用户可以直接改一改重试。

### C. 缺陷行字段重排 + 读回匹配（需求 3）

写入 `bug_fields()`：

```
问题描述：
  {失败说明}                        ← 只有说明，编号与标题不再出现在这里

备注：
  用例：{code} {title}              ← 始终有这一行（也是读回匹配的锚点）
  步骤：{前 100 字}…（完整步骤见用例 {code}）   ← steps 为空则整行省略；未截断则不加指针、原样写
  控制台：{控制台输出}                ← console 为空则整行省略；多行时只有第一行带标签
```

`问题描述` 与 `备注` 都不再包含 `结果`：缺陷行只在 `attempt.result == "不通过"` 时产生（`outbox.py:385`），写「结果：不通过」是废话；同理不写 `优先级` / `进展状态` / `反馈时间` / `反馈人` / `截图`（各有独立列）。

**截断规则（纯函数，单独单测）** `_clip_steps(steps: str, code: str, limit: int = 100) -> str`：

1. `len(steps) <= limit` → 原样返回（不加指针）；
2. 否则取「按整行切分、总长 ≤ limit 的最长前缀」，拼接后加 `…（完整步骤见用例 {code}）`——避免把一句话从中间切断（这正是可读性诉求）；
3. 若第一行本身就超限（整行前缀为空）→ 硬切到 `limit` 字后加同一指针；
4. 步骤里已有的 `\n` 保留（多步分行读起来更清楚）。

读回：`history.match_bugs()` 在现有 `EXPLICIT_LINK_FIELDS` → `DESCRIPTION_FIELDS` 之后增加第三轮扫描 `REMARK_FIELDS = ("备注",)`，用**带标签**的解析：先找 `用例[:：]\s*`，再对标签后的子串跑现有的 `CASE_REFERENCE` + `RETEST_SUFFIX` 规则（保持「最长编号 + 可选 `-R…` 重测后缀」的边界，`B-001` 不得匹配 `B-0010`，`B-001_2` 保持不匹配）。`matched_by` 为 `"备注"`。标签解析只认 `用例[:：]` 之后紧跟的编号 token，所以备注里的其它文本（含旧格式遗留的「结果：不通过」）不会干扰。

同步：`test_lark_outbox.py:126-128,157,308`、`test_lark_history.py` 相关断言按新格式更新；新增「新写的缺陷行能按备注读回」「`B-001` 不匹配 `B-0010`」「步骤 100 字截断 + 指针」「短步骤不加指针」。

### D. 进度方格（需求 4）

新建 `frontend/src/components/CaseGrid.tsx`：

- 输入：`cases: GroupCase[]`、`caseIndex: number`、`onJump: (index: number) => void`。
- 方格：每条用例一个 `<button type="button">`，`title="{code} {title}"`，`aria-label` 形如 `B-001 通过` / `B-003 未测`；当前用例 `aria-current="true"` + 明显选中环。
- 颜色：通过=`passed`（复用 `#1c6b45/#e2f2e9`）、不通过=`failed`（`#a23b36/#fbe7e5`）、跳过(未执行)=`skipped`（`#7a6320/#fdf1d5`）、未测=`untested`（浅灰描边、无填充）。
- 图例：`通过 n · 不通过 n · 跳过 n · 未测 n`，**由 `cases` 现算**（与方格同源，保证永不打架）。
- 布局：`display:grid; grid-template-columns: repeat(auto-fill, minmax(20px, 1fr)); gap:4px`，360px/420px/1440px 三档都不横向溢出、不需要横向滚动。
- 键盘：方格是 `<button>`，`isEnterOwnedByControl`（`useCaseKeys.ts:27-34`）已保证其上的 Enter 不会被当成「通过」。
- 位置：`aside.execution-groups` 内、`<GroupSelector>` 之下，仅当已选中组且有 `cases` 时渲染。

desk 内紧凑进度行（PiP 可见）：

- 位置：`execution-toolbar` 内（跟随 desk 搬进 PiP），形如 `3/14 · ✓2 ✗1 ○11`，计数同样由 `cases` 现算。
- `.pip-surface` 下给出尺寸/换行规则，420px 宽不溢出。

### E. 画中画显示逻辑（硬规则）

1. 只有 desk 会搬进 PiP；放进 desk 的元素必须写 `.pip-surface` 规则；侧栏元素 PiP 里不可见（本方案的方格即如此，进度行补足信息）。
2. 计数与颜色口径在方格与进度行之间**必须同源**（都从 `cases` 现算），避免「侧栏说 3/14、PiP 说 4/14」。
3. `.pip-surface` 已隐藏历史区与快捷键提示；新增元素不要依赖这两处的可见性。
4. PiP 关闭后（`pagehide` 或按钮）元素搬回主窗口原位（`usePiP.ts:63-85`），新元素无需额外处理。

---

## 三、影响面与验证策略

| 层 | 文件 | 验证 |
|---|---|---|
| 前端纯函数 | `executionCursor.ts` / `.test.ts` | `nextUntestedIndex`：其后命中 / 环绕 / 全测完 null / 空数组 null / from 越界；`startIndexFor`：记忆条目仍未测→回去、已测→第一条未测 |
| 前端组件 | `OutcomeForm.tsx` / `.test.tsx` | `reset()` 清四个字段；提交成功由调用方触发 |
| 前端视图 | `Execution.tsx` / `.test.tsx` | 自动前进 / 环绕 / 全测完提示 / 保存确认保留 / 保存期间点箭头不抢焦点 / 切用例后旧说明不提交 |
| 前端新组件 | `CaseGrid.tsx` + 新测试 | 四色、`aria-current`、点击跳转、图例计数与方格一致 |
| 样式 | `styles.css` | 360 / 420(PiP) / 1440 三档不横向溢出 |
| 后端写入 | `lark/write.py` / `test_lark_outbox.py` | `问题描述` 只有失败说明；`备注` = 用例行 +（可选的）步骤行 +（可选的）控制台行；`结果` 不出现在两者中；`_clip_steps` 四条分支 |
| 后端读回 | `lark/history.py` / `test_lark_history.py` | 备注标签匹配、编号边界、`matched_by == "备注"` |
| 端到端 | `frontend/e2e/*.spec.ts` | 多用例自动前进；PiP 内进度行可见；无横向溢出 |

回归门槛：`backend pytest` 全绿、`frontend npx vitest run` 全绿、`npm run build` 干净、`npx playwright test` 全绿、`git diff --check` 干净。

## 四、非目标

- 不改 Lark 表结构、不新增列、不改 provision（`备注` 已是文本列）。
- 不改重测（-R…）与对账（reconcile）逻辑。
- 不做方格分页/虚拟滚动/自动滚动到当前方格（用例组规模是几十条）。
- 不引入新的全局状态库、路由或弹窗。
- 不改 PiP 的 `requestWindow` 尺寸与 `disallowReturnToOpener`。

## 五、已知取舍

- 决策 3 后，「复核一条已测用例时刷新页面」会跳到第一条未测而不是停在原处。这是「默认光标=第一个没颜色」的直接代价，已在 `docs/superpowers/plans/2026-09-17-execution-resume.md:549` 的行为描述上留变更说明。
- `history.match_bugs()` 的 `description` 字段在新格式下返回的是失败说明（旧行仍是「编号 标题\n说明」）。前端 `LegacyHistory.tsx:210-217` 直接展示 `bug.description`，新旧行会有轻微格式差异；本方案接受，不为此改载荷结构。
- `备注` 只放 100 字步骤 + 指针，**完整步骤要回工具里按用例编号看**；`测试数据` 与前置条件刻意不写（账号密码不外泄到缺陷表）。开发拿到的复现信息以「100 字步骤 + 截图 + 控制台」为准，够定位、不足以免去回查。
- 备注变长后，`match_bugs` 的 `备注` 扫描依赖 `用例：` 这个标签。若有人手工编辑掉标签，该行会退化成「未匹配到旧缺陷」（与今天「问题描述被改掉编号」的表现一致，不是新引入的脆弱点）。
