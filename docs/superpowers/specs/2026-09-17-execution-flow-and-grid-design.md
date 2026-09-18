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

读回：`history.match_bugs()` 在现有 `EXPLICIT_LINK_FIELDS` → `DESCRIPTION_FIELDS` 之后增加第三轮扫描 `REMARK_FIELDS = ("备注",)`，用**带标签**的解析：先找 `用例[:：]\s*`，再对标签后的子串跑现有的 `CASE_REFERENCE` + `RETEST_SUFFIX` 规则（保持「最长编号 + 可选 `-R…` 重测后缀」的边界，`B-001` 不得匹配 `B-0010`，`B-001_2` 保持不匹配）。`matched_by` 为 `"备注"`。 **实施期修正（整体复审，`8c80b7a`）**：最终落地的判据是「`备注` **第一行**的标签才具权威性；且描述那一趟一旦识别出编号，就否决松散的标签兜底（反之亦然）」——因为旧行会把控制台原文粘进 `备注`，里面可能带着别人的 `用例：X`；而新行的 `问题描述` 是自由文本，开头像编号纯属巧合。两条反例与取舍见附录 G 的 D1。标签解析只认 `用例[:：]` 之后紧跟的编号 token，所以备注里的其它文本（含旧格式遗留的「结果：不通过」）不会干扰。

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

### F. 实施期修正（Task 3 两段评审后生效的行为，以本节为准）

1. **守卫用「访问令牌」而不是下标**：`save()` 开头记 `savedVisit = caseRequest.current`（`caseRequest` 只在 `selectGroup` / `showCase` 里自增），所有**用例范围**的写入用 `loadedGroup.current === savedGroupId && caseRequest.current === savedVisit` 判定。下标比不出来「一直没走开」与「走开又回到同一下标」，后者会被强行拽走。`caseIndexRef` 因此整个删除。
2. **截图没传成功就不前进**：`advanceTo = uploaded ? nextUntestedIndex(updated, savedIndex) : null`。原规格没写这条，但前进会清空 `images`（证据被丢弃），而 `keepStatus` 留下的 error 状态 + 未失效的 `lastAttemptId` 会让下一条用例上的「重试上传截图」把**新用例的截图传到上一条的 attempt**。留在原用例才让附件与重试按钮都指向正确的记录。
3. **迟到的写入一律不许跨界**：`setAttempts` / `setLastAttemptId` / `setImages([])` / 表单复位 / 前进 都带同一对守卫；保存期间切走后落地的保存不再改动画面上那一条的任何东西。
4. **`setReserved` 收窄为「只清掉本次保存消费的那条预留」**（`setReserved(current => current?.id === reserved?.id ? null : current)`）：`LegacyHistory` 的「复测」按钮没有 `disabled`，操作员能在保存飞行期间预留，原写法会把它抹掉并孤儿化标签。**（2026-09-18 补记）**：该按钮现在带 `disabled`，操作员已无法在保存飞行期间预留，所以这条收窄在 UI 上不可达；它作为「预留归操作员所有」的语义声明保留，代码注释里声明了没有测试能钉住它。**退租的时机**也一并调整（`a9b227a`）：不再紧跟提交，而是挪到「提交后的整条读取链完成」时——否则读取失败后重试会铸出新 key 并多写一行（见附录 G 的 O10）。
5. **`startRetest` 丢弃迟到的预留**（捕获组与访问令牌，返回时比对）：预留落在已被离开的用例上时不写入 `reserved`。预留行仍是 `started` 且无结果，丢弃不丢数据。
6. **`setStatus` 刻意不门控**：它是「事件发生了」的通知、且文本自带用例编号（`{code} 已保存到本地 · …`）；门控掉等于静默吞掉「到底存进去没有」的反馈。
7. **`setCases` / `setSync` 只按组门控**（它们描述的是这个组的列表与徽标，不是某一次访问）。

8. **非数组的 `/cases` 载荷必须降级而不是炸页**：`asCaseList()` 在用例列表进入 state 的入口把非数组变成 `[]`，恢复「该测试组暂无用例」的旧行为（`622fb6b`；此前新加的计数循环 `for…of cases` 会让整页 React 卸载）。
9. **desk 进度行必须写出全部四个计数**：`{done}/{total} · 通过{p} 不通过{f} 跳过{s} 未测{u}`。原设计的 `✓/✗/○` 三符号版**没有「跳过」这一格**，而 PiP 窗口里看不到侧栏图例——恰恰是「画中画显示逻辑准确」这一约束落空的地方。
10. **`备注` 第一行标签的权威性**见第 C 节的实施期修正；D1 的两条反例同时被钉住（埋在第 2 行以后的标签失效；带第一行标签的行不会被自由文本里的巧合编号抢走）。

### G. 实施期发现的待决缺陷（O1/O2/O3/O10 已修，其余仍待人类决定）

| # | 缺陷 | 证据 | 建议修法 |
|---|---|---|---|
| O1 **已修** | 幂等键签名不含 group（`save()` 的 `signature` 只有 code/result/note/console/reserved），而 `Attempt.idempotency_key` 全局唯一且服务端按 key 去重：两个组里的同编号用例提交**完全相同**的载荷时会复用同一个 key。**症状更正**：这不是「静默丢结果」——`_matching_attempt` 发现 key 属于别的用例时，`create_attempt` 直接答 **409 `Idempotency key conflict`**，而重试铸出的仍是同一个 key（签名没变），于是卡在报错循环里，直到操作员改结果/改说明或刷新页面 | `backend/app/models.py:157`（unique）、`backend/app/execution.py:75-93`（按 key 匹配）、`frontend/src/views/Execution.tsx` 的 `signature` | 已把 `savedGroupId` 放进签名数组（`22b621a`）；`Execution.test.tsx` 的「scopes the idempotency key to the group…」用两组同编号 B-001 钉住「两次提交的 key 不同」 |
| O2 **已修** | `submitting` 被「保存」与「预留重测」共用：预留流程的 `finally { setSubmitting(false) }` 会在保存仍在飞行时释放保存的 spinner（于是可能出现并发提交） | 复审探针（`LegacyHistory` 路径）复现 | 已改成**在飞计数器**（`inFlight`，`submitting = inFlight > 0`，`beginRequest`/`endRequest`，`22b621a`）。**没有测试能证伪它**：让两个请求重叠的唯一入口是 O3 那个按钮，O3 修好后已关死；代码注释里已声明这是「写在结构里的不变式」，不是测试钉住的行为 |
| O3 **已修** | `LegacyHistory.tsx:243` 的「复测（新标签，不覆盖旧结果）」按钮**没有 `disabled`**，保存期间仍可点（O2 的入口，也是 O3b 的入口） | 同上 | 新增 `retestDisabled` prop、执行台传 `submitting`（`22b621a`）；`LegacyHistory.test.tsx` 钉组件契约，`Execution.test.tsx` 的「refuses a retest while a save is in flight…」钉「飞行期间点不动、保存落地后按钮回来」 |
| O3b | 修正 4 只保护到「画面未移动」为止：保存期间预留、保存落地后自动前进，`showCase` 的 `setReserved(null)` 仍会把这条预留丢弃（整体复审用 2 用例组复现）。**附录里原先写的「预留本身已由修正 4 保护」是错的** | 复审探针 | 前进前先判断是否有本用例未消费的预留；或给预留加「随用例离开即释放」的语义。**（2026-09-18 补记）O3 修好后「保存飞行期间预留」这个入口已关死**；残留的是「先预留、再手动切用例/切组/刷新」——`reserved` 只活在内存里、服务端也不会把它读回来，于是预留被丢且留下一条永久 `started` 行（与 O8 同源） |
| O8 | `state == "started"` 的 attempt 行**全仓没有任何清理路径**（无 sweeper）：本分支的两条丢弃路径各会留下一条永久行并消耗一个 `sequence`/标签位（UI 不可见：`list_attempts` 过滤 committed，`latest_result` 排除 started） | 复审资源审计 | 加一个按时间清理陈旧 `started` 行的任务 |
| O9 | `setCases(updated)` 只按组门控：保存飞行期间切走再切回（同组 ABA、新访问），陈旧快照会覆盖刚取回的新列表（行数变化时可见） | 复审探针 | 这条写入也用访问令牌门控 |
| O10 **已修** | `save()` 的 `catch` 包住了提交**之后**的读取（attempts/progress/sync/上传），提交其实已入库时也会报「保存失败…可重试」；若操作员改了说明再重试，会多出一条 append 行（**原样重试不会**：同一 key 被服务端去重） | 复审探针 | 已按错误来源分别措辞（`22b621a`）：提交答上来就置 `stored = true`，catch 里 `stored` 为真时报「`{code} 结果已保存到本地，但执行记录读取失败（…）」；回归测试「says a stored save was stored when only reading it back fails」。**预留路径的重复行也一并堵上**（`a9b227a`）：预留原先在提交后立刻退租，读取失败后操作员再按保存会铸出新 key，`create_attempt` 便多写一行；现在退租挪到「提交后整条读取链完成」时（与表单复位同处），重试仍拿同一 key、服务端答回已存的那行，若重试时改了说明则响 409 `Attempt is already committed`（响亮报错，不再静默多行）。回归测试「keeps a reserved save retryable when a read after it fails」。**第三次修订（独立复审抓的，`d5a1433`）**：预留已提交后「改载荷再按保存」会响 409 `Attempt is already committed`，原先落回「保存失败…可重试」——一个永远不会成功的邀请（唯一出路是切走用例，而那会多写一行）；现在这一支单独措辞（「已经提交过，这次修改没有保存：刷新页面后可重新提交」），`可重试` 只留给真能重试的拒绝 |
| O11 **已修** | `retryUpload` 会**重传全部附件**，而 `screenshots.py` 每次都新插一行（uuid 主键、无去重）→ 部分失败后重试会留下重复的 Lark 附件与永久孤儿文件 | 复审审计（早于本分支）；真服务端探针也确认「同一张图传两次 = 两行 + 磁盘两个文件」 | 已按 attempt + 字节 hash 做成幂等：`screenshots.content_hash`（迁移 `0013_screenshot_content_hash`）+ `(attempt_id, content_hash)` 唯一索引；命中即返回已存的那行且**不再落文件**；两个上传撞上唯一索引时，输家回滚、删掉自己刚写的文件、答赢家那行。四条测试：同图两次 = 一行一文件、不同图并存、数据库本身拒绝同一 attempt 的第二行、致盲快路径后强制走约束分支（去掉 `except IntegrityError` 即变红）。前端未改：重传从「制造重复」变成「无害重放」 |
| O12 | `caseTone` 把未知结果算「未测」，而导航的 `isDone` 算「已测」：出现第四个结果值时会出现「本组已全部测过」+ 图例「未测 1」+ 无色方格（当前不可达：写路径被 `Literal` 与 CHECK 约束） | 复审探针（`latest_result:"阻塞"`） | 两处共用同一个「是否已测」判定 |

**本轮状态（2026-09-18，`22b621a` + `a9b227a` + `d5a1433`）**：O1 / O2 / O3 / O10 已修，共 6 条新回归测试，每条都做了「变异体失败 → 还原变绿」的验证。O10 分三半：措辞按来源分岔（`22b621a`）、预留路径的**原样**重试保持幂等（`a9b227a`，把预留退租挪到提交后读取链完成时）、预留路径的**改载荷**重试不再被「可重试」骗（`d5a1433`，识别 409 后单独措辞）。O3 的 `disabled` 顺带关掉了 O3b 的入口，也让「二、F」第 4 条的收窄写法在 UI 上不可达（代码保留为「预留归操作员所有」的语义声明，注释里已注明没有测试能钉住它）。同一次独立复审还带来两处加固（`d5a1433`）：`retryUpload` 用 `finally` 配平在飞计数（原先只靠 `uploadAll` 永不 reject，一次逃逸就会把保存按钮与键盘快捷键锁死整场），`endRequest` 加零下限；并删掉两处**不可能失败**的断言（`userEvent.click` 对 `disabled` 元素根本不派发，`toBeDisabled()` 才是判据）。门槛：vitest **206 passed / 18 files**、`npm run build` 干净、playwright **25 passed / 0 failed**、`git diff --check` 干净；backend 一行未改，但测试库 5433 起回来后仍在 HEAD 上重跑了 **441 passed**（27.5s）。此外用 `backend/scripts/integration_probe.py` 做了**真服务端验证**（真 uvicorn + 真 Postgres，一次性 schema 用完即 drop，9/9 探针通过）：跨组同 key 实测 **409 `Idempotency key conflict`**（把上面对 O1 症状的更正从读码变成实测）、已提交预留的同载荷重试幂等而改载荷重试 **409 `Attempt is already committed`**（证实 O10 第三次修订的前提）、同一张图传两次确实落两行 + 磁盘两个文件（O11）、弃用预留停在 `started` 且列表不可见（O8）。**仍开放**：O3b（手动移动/刷新仍会丢预留）、O8、O9、O12（与 `findings.md` 的 O5 同源，不可达）。上表 O1 行的症状描述本轮已按实际行为更正。

**O11 收口（2026-09-18 稍后一轮）**：附件上传改为按 attempt + 字节 hash 幂等（迁移 `0013_screenshot_content_hash`，`(attempt_id, content_hash)` 唯一索引；老行 hash 为 NULL，Postgres 视 NULL 互异，故不会被去重、也不需回填文件）。命中已存行时直接返回、不写文件；竞争撞唯一索引时输家回滚 + 删自己刚写的文件 + 答赢家。前端保持不变。backend **446 passed**。

**幂等键的边界（复审 F4，属设计取舍不是缺陷）**：同组、同用例、**同载荷**再存一次 → 同一 key → 服务端 `_matching_attempt` 命中同一 `group_case` 直接返回旧行，界面照旧显示「已保存到本地」而**不新增行**。这正是幂等键的用途（重试去重）；要追加一行得走「复测」入口。O1 那个 409 只发生在**跨组**复用同一 key 时。

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
