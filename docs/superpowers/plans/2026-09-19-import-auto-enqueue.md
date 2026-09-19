# 导入结果「自动进 Lark 表」改进方案

> 起因：导入带「执行结果」的 CSV 后，本地有结果、Lark 执行表一行都没有。本文先给根因（带行号），再给今天可用的操作路径，最后给三处改动方案与验收。
> 基线：`f4a13c3`（`git status` 干净）。

## 1. 结论

**不是数据丢了，是没接线。** 两条"人以为会自动跑"的路径都是纯本地写入：

- **确认导入**只物化本地 `Attempt`，从不排 `SyncJob`；
- **确认目标表**只写 `confirmed_at` 就返回，不回填已经存在的本地结果。

把本地结果送进 Lark 的唯一入口是 **Lark 检查页第 4 步「同步」里的「把已保存的本地结果排入同步」按钮**（`POST /api/groups/{group_id}/sync/enqueue`）。它是一个**显式动作**，从来没有"自动"这回事。

> 页面只有四步：**选表 → 表头 → 确认写入 → 同步**（`frontend/src/views/LarkCheck.tsx:40-41` 的 `STEP_ORDER` / `STEP_LABELS`）。**没有第 5 步。**

## 2. 证据链

| 环节 | 代码位置 | 实际行为 |
|---|---|---|
| 确认导入 | `backend/app/groups.py:119` `_materialize_attempts`、`:205-217` | 只建 `Attempt(state='committed', source='import')`，无任何 enqueue |
| 手工录入结果 | `backend/app/execution.py:202`、`:257` | `enqueue_attempt_job`：**这条路径会自动排队**（对照组，说明"自动"本来可以有） |
| 排队门槛 | `backend/app/lark/outbox.py:123-141` | 目标未确认时 `enqueue_attempt_job` **静默 `return None`**，不报错 |
| 显式排队 | `backend/app/lark/outbox.py:174` | `enqueue_group_attempts`，**全仓库唯一调用点** `outbox.py:579`（即那个按钮） |
| 确认目标 | `backend/app/lark/target.py:610-650` | 只 `locked.confirmed_at = now` 后返回 `serialize_target(locked)`，响应里没有任何"你有 N 条本地结果可排"的信息 |

`read_sync`（`outbox.py:519`）其实**已经算好了** `pending_attempts`（`:523`）并给了一句文案（`:549` / `:551`），但前端没人用（见 §3）。

## 3. 为什么你完全看不出来（蓝军视角，四条可见性缺陷）

1. **徽标在说谎。** `frontend/src/views/Execution.tsx:731-733` 显示「待同步 {sync.queued} 条」，`queued` 是 **SyncJob 数**。41 条 import attempt + 0 个 job 时它显示**「待同步 0 条」**——看起来已经同步完了。真正该说的是 `pending_attempts`。
2. **控件整块隐身。** `frontend/src/components/lark/StepSync.tsx:19`：`if (!confirmed && parked === 0) return null;`。目标没确认时，连"本地还有结果没进 Lark"这句话都不渲染。
3. **文案被丢掉。** `outbox.py:549` 的 `detail`（"目标表已确认，可显式排入同步" / "尚未确认目标表，本地结果不会写入 Lark"）在 `StepSync.tsx` 里**一次都没被渲染**。
4. **按钮的可用性依赖一个看不见的数。** `StepSync.tsx:38` 的 `disabled` 条件是 `pending_attempts === 0`，而这个数只在这一页出现。

## 4. 现在就能导进去（不改代码）

1. 导入页确认导入（带勾选「一并写入执行结果」）→ 本地生成 N 条执行记录，`确认导入` 返回的 `attempt_count` 就是 N。
2. Lark 检查页：**先补齐表头**（含「实测过程」列）→ 勾选允许写入 → **确认目标**。
   > 顺序不能反：先同步后加列会让 provision 清掉写批准，已入队 job 全部 park。
3. Lark 检查页**第 4 步「同步」** → 点 **「把已保存的本地结果排入同步」**（第 4 步只有在这一组的写入确认存在、或队列里真有异常时才展开，`LarkCheck.tsx:138` 的 `enterable.sync`）。等价调用：
   ```bash
   curl -X POST -b cookies.txt https://<host>/api/groups/<group_id>/sync/enqueue
   # → {"queued": 41, "repointed": 0, "requeued": 0}
   ```
   重复点是安全的：插入语句带 `on_conflict_do_nothing`（`outbox.py:196`）。
4. 确认 worker 活着（它是唯一处理 job 的进程）：
   ```bash
   docker compose ps worker      # 期望 Up；报错看 docker compose logs worker
   ```
5. 验证（把 <group_id> 换成你的组）：
   ```sql
   -- 本地有结果、有没有排队
   SELECT a.source, a.state, count(*) FROM attempts a
     JOIN group_cases gc ON gc.id = a.group_case_id
    WHERE gc.group_id = '<group_id>' GROUP BY 1,2;
   -- 队列状态
   SELECT j.state, count(*) FROM sync_jobs j
     JOIN attempts a ON a.id = j.attempt_id
     JOIN group_cases gc ON gc.id = a.group_case_id
    WHERE gc.group_id = '<group_id>' GROUP BY 1;
   ```
   期望：`sync_jobs` 出现 41 条 `pending → synced`；若 `queued>0` 长期不动，就是 worker 没跑。

## 5. 改进方案

### P0-A：确认目标后自动回填（一处改动，收益最大）

`confirm_target`（`target.py:649`）写 `confirmed_at` 之后，调用 `enqueue_group_attempts(db, group_id)`，并把计数放进响应（新增 `"queued_local_attempts": int`）；前端 `StepApprove` 确认成功后提示「已自动排入 N 条本地结果」。

**为什么在这里自动是安全的**：`confirm_target` 在 `read_errors`/`schema_errors` 非空时直接 409（`target.py:634-643`），且 `target_fingerprint` 在行锁内复核（`:645-648`）。也就是说"自动排队"发生的那一刻，目标表一定是刚验过表头、指纹刚核对过的表——不会造出 park 行。这正是文档 §10 要求的顺序（先补列 → 再确认 → 再同步）。

**风险**：只改变"确认那一刻"的行为；确认之后 target 再被 provision 清批准，job 照样 park，语义不变。

### P0-B：徽标说真话（`Execution.tsx:731-733`）

`sync.pending_attempts > 0 && sync.queued === 0` 时追加「· 本地待排入 {pending_attempts} 条」，可点击跳到 Lark 检查页。**没有这一步，P0-A 之外的老组仍然会看到"待同步 0 条"的假象。**

### P0-C：`StepSync` 不再整块隐身（`StepSync.tsx:19`）

渲染条件改成 `sync !== null && (confirmed || parked > 0 || pending_attempts > 0)`，并把 `sync.detail` 渲染出来；未确认时按钮 disabled，文案改成"先确认目标表"。顺手把"按钮 disabled 的原因"写成可见文字，而不是只挂在 `title` 上。

### P1：导入成功后的交接提示（`Import.tsx:93`）

`onImported()` 之后给一条「已写入 N 条执行记录；确认 Lark 目标后在 Lark 检查页排入同步」——这次踩坑的直接原因就是这条提示不存在。

## 6. 验收（每条都要有可跑的测试）

- **backend / `tests/test_lark_target.py`**：确认目标后响应 `queued_local_attempts` 等于该组已有 committed 本地行数；未确认目标前调用不产生任何 `SyncJob`（防"假接线"）。
- **backend / `tests/test_lark_outbox.py`**：既有 `test_a_results_file_reaches_lark_and_a_blank_row_does_not` 覆盖 file → attempt → queue → 执行表；补一条"未确认时 enqueue 抛 409 而不是静默 0"。
- **frontend / `StepSync.test.tsx`**：未确认 + `pending_attempts > 0` 时必须渲染，且 `detail` 文本可见、按钮 disabled。
- **frontend / `Execution.test.tsx`**：`pending_attempts=41, queued=0` 时徽标出现「本地待排入 41 条」。
- **e2e / `frontend/e2e/import.spec.ts`**：确认目标后出现"已自动排入 N 条"。**e2e 不在 CI 里**，是发版前手跑的门。
- **人工门**：真表写入不由任何自动化覆盖，交付说明里写明。

## 7. 明确不做 / 边界

- **不在确认导入时直接 enqueue**。确认导入时目标表通常还没确认，`enqueue_attempt_job` 会静默返回 `None`（`outbox.py:123-141`），那是"假接线"；而且导入后立刻写会把没有截图的行写在证据落地之前。
- **不自动 retry / 不自动释放 park 与 uncertain**。这两类必须由管理员看过远端再决定，`/sync/enqueue` 现在的行为（repoint + requeue failed，永不释放 uncertain）保持不变。
- 不碰 reconcile / 删除路径。
