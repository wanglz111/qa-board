"""清掉「0918测试任务」里整块粘贴串列留下的垃圾行、垃圾选项和废表。

背景见 docs/superpowers/specs/2026-09-18-lark-header-alignment-requirements.md §4。

用法：

    # 只读，打印将要做什么，不发任何写请求
    backend/.venv/bin/python backend/scripts/lark_cleanup.py

    # 真干（顺序固定：先删行 → 再洗选项 → 最后删废表）
    backend/.venv/bin/python backend/scripts/lark_cleanup.py --apply

环境变量（凭证沿用部署里的那三个）：

    LARK_APP_ID / LARK_APP_SECRET
    LARK_BASE_URL         默认 https://open.larksuite.com
    CLEANUP_BASE_TOKEN    默认 NftVbjo6UamHsFseByPjXHU7pf7
    CLEANUP_EXEC_TABLE    默认 tblGMDjey2ufbUxd
    CLEANUP_BUG_TABLE     默认 tblUyjeopEHO8QVx

顺序：先删行 → 再洗选项 → 最后删废表。

**但顺序本身不足以保住数据。** 实测（一次真实事故的复盘）：

    `PUT .../tables/{tbl}/fields/{fld}` 带 `property.options` 会**重建整份选项表并重新
    分配 option id**，于是所有引用旧 option id 的单元格都被清空 —— 不只是被删掉的那些
    选项，**保留下来的选项所引用的值也一起没了**。4 个单选列洗完，13 行已有数据的值全空。

所以洗选项这一步实际是四段式：**快照 → 洗 → 写回 → 独立重读逐行核对**。
「我只删了没用的选项，所以其他值安全」这个推断只在**没有数据的探针表**上成立，
而探针表恰恰观察不到这件事（当初就是在一张空表上验的，所以误判为安全）。

同理：任何洗结构的操作之后都不要采信脚本自己的复查，必须另起一次独立读
（下面核对阶段会重新 GET records，而不是复用写回时的响应）。

**这四个阶段不是事务。** 任何中途失败（API 被拒、httpx 超时、进程被杀）都会在线上留下
半清理状态：可能行只删了一半，也可能选项洗掉了但值没写回。此时**不要重跑本脚本** ——
数量闸会因为错位行已经变少而直接中止，重跑救不回来；恢复要靠落盘的快照。

因此脚本会在**发第一个洗选项的 PUT 之前**，把要保留的值落盘成一个带时间戳的 JSON
（放在临时目录，路径会醒目打印，并附上可直接照抄的恢复命令）。任何中途失败都以非 0 退出。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from typing import Any

import httpx

BASE_URL = os.environ.get("LARK_BASE_URL", "https://open.larksuite.com").rstrip("/")
BASE_TOKEN = os.environ.get("CLEANUP_BASE_TOKEN", "NftVbjo6UamHsFseByPjXHU7pf7")
EXEC_TABLE = os.environ.get("CLEANUP_EXEC_TABLE", "tblGMDjey2ufbUxd")
BUG_TABLE = os.environ.get("CLEANUP_BUG_TABLE", "tblUyjeopEHO8QVx")

# 粘贴进来的行，其「错位」特征是某个文本列里躺着一串日期。
# 这比按行号删安全：行号会因为上次删了一半而漂移。
MISPLACED_DATE = re.compile(r"^\d{4}/\d{2}/\d{2}$")

# 每个角色该有几行错位数据。数量对不上就停下来让人看一眼——
# 一个删除脚本最不该做的事是在数据长得不一样时"尽力而为"。
EXPECTED_MISPLACED = 12

# 洗选项的目标词表一律取自产品代码，不在这里抄一份。
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
from app.lark.fields import (  # noqa: E402
    BUG_PRIORITY_OPTIONS,
    BUG_STATUS_OPTIONS,
    PASS_RESULT_OPTIONS,
    RUN_PRIORITY_OPTIONS,
)

WASHES: list[tuple[str, str, tuple[str, ...]]] = [
    (EXEC_TABLE, "结果", PASS_RESULT_OPTIONS),
    (EXEC_TABLE, "优先级", RUN_PRIORITY_OPTIONS),
    (BUG_TABLE, "进展状态", BUG_STATUS_OPTIONS),
    (BUG_TABLE, "优先级", BUG_PRIORITY_OPTIONS),
]

JUNK_TABLES = ("数据表", "Bug表", "测试流程表")

# 两个角色表（标签, 表 id）；删行、快照、写回、核对都按这个顺序走。
ROLE_TABLES: tuple[tuple[str, str], ...] = (("执行记录", EXEC_TABLE), ("缺陷记录", BUG_TABLE))


class Lark:
    def __init__(self) -> None:
        app_id = os.environ.get("LARK_APP_ID")
        app_secret = os.environ.get("LARK_APP_SECRET")
        if not app_id or not app_secret:
            raise SystemExit("需要 LARK_APP_ID 与 LARK_APP_SECRET")
        self.client = httpx.Client(base_url=BASE_URL, timeout=30.0)
        body = self.client.post(
            "/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
        ).json()
        if body.get("code") != 0:
            raise SystemExit(f"取 tenant_access_token 失败：{body.get('msg')}")
        self.headers = {"Authorization": f"Bearer {body['tenant_access_token']}"}

    def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = self.client.request(method, path, headers=self.headers, **kwargs)
        payload = response.json()
        if payload.get("code") != 0:
            raise SystemExit(f"{method} {path} 被拒：code {payload.get('code')} {payload.get('msg')}")
        return payload.get("data") or {}

    def records(self, table: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            params: dict[str, Any] = {"page_size": 500}
            if page_token:
                params["page_token"] = page_token
            data = self.request(
                "GET", f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/records", params=params
            )
            out.extend(data.get("items") or [])
            if not data.get("has_more"):
                return out
            page_token = data.get("page_token")

    def fields(self, table: str) -> list[dict[str, Any]]:
        data = self.request(
            "GET",
            f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/fields",
            params={"page_size": 100},
        )
        return data.get("items") or []

    def tables(self) -> list[dict[str, Any]]:
        data = self.request(
            "GET", f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables", params={"page_size": 100}
        )
        return data.get("items") or []


def _text(record: dict[str, Any], name: str) -> str:
    value = (record.get("fields") or {}).get(name)
    return value if isinstance(value, str) else ""


def misplaced(lark: Lark, table: str, column: str) -> list[dict[str, Any]]:
    return [
        record
        for record in lark.records(table)
        if MISPLACED_DATE.match(_text(record, column))
    ]


def wash_columns(table: str) -> list[str]:
    """这张表上即将被洗掉的单选列名。"""
    return [name for tbl, name, _ in WASHES if tbl == table]


def snapshot(
    lark: Lark, table: str, columns: list[str], skip_ids: set[str] | None = None
) -> dict[str, dict[str, Any]]:
    """洗选项前把要保留下来的值 dump 下来：{record_id: {列名: 原值}}。

    只记「即将被洗的那些列」，不整行 dump（截图/人员/日期等列不参与洗，写回时也不带，
    免得把无关字段一起回写）。只记确实有值的列，空值不落进来，这样写回时不会把
    None 覆盖上去。值按飞书返回的原样存（单选就是选项名字符串）。
    """
    skip = skip_ids or set()
    out: dict[str, dict[str, Any]] = {}
    for record in lark.records(table):
        record_id = record.get("record_id")
        if not record_id or record_id in skip:
            continue
        fields = record.get("fields") or {}
        kept = {
            name: fields[name] for name in columns if fields.get(name) not in (None, "", [])
        }
        if kept:
            out[record_id] = kept
    return out


def restore(lark: Lark, table: str, saved: dict[str, dict[str, Any]]) -> None:
    """按 record_id 把快照逐行写回。"""
    if not saved:
        return
    lark.request(
        "POST",
        f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/records/batch_update",
        json={
            "records": [
                {"record_id": record_id, "fields": values} for record_id, values in saved.items()
            ]
        },
    )


def check_restored(lark: Lark, table: str, saved: dict[str, dict[str, Any]]) -> int:
    """独立重读一次（不复用写回的响应），逐 record_id 与快照比对；返回不一致的行数。"""
    live = {r.get("record_id"): (r.get("fields") or {}) for r in lark.records(table)}
    bad = 0
    for record_id, values in saved.items():
        fields = live.get(record_id)
        if fields is None:
            print(f"    {record_id}  !! 写回后这一行不见了")
            bad += 1
            continue
        diffs = [
            f"{name}: 期望 {value!r} 实际 {fields.get(name)!r}"
            for name, value in values.items()
            if fields.get(name) != value
        ]
        if diffs:
            print(f"    {record_id}  !! {'; '.join(diffs)}")
            bad += 1
        else:
            print(f"    {record_id}  OK")
    return bad


def write_snapshot_file(saved: dict[str, dict[str, dict[str, Any]]]) -> str:
    """把快照落盘到仓库外的临时目录，返回文件路径。

    这是唯一的兜底：洗选项之后进程内的 saved 会随进程消失，而重跑会被 EXPECTED_MISPLACED
    数量闸挡住。所以文件必须在发第一个洗选项的 PUT **之前**就存在，路径也必须打印出来 ——
    否则洗到一半失败时，终端里没有任何能据以恢复的东西。
    """
    payload = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "base_url": BASE_URL,
        "base_token": BASE_TOKEN,
        "tables": {
            table: {"label": label, "values": saved[table]} for label, table in ROLE_TABLES
        },
    }
    path = os.path.join(
        tempfile.gettempdir(),
        f"lark_cleanup_snapshot_{datetime.now().strftime('%Y%m%dT%H%M%S%f')}.json",
    )
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    return path


# 恢复指引：快照落盘后立刻打印一次，失败路径上再打印一次。
# 里面的 {} 都是给控制者照抄的文本，不是本脚本的格式化占位符（所以用 replace 而不是 format）。
#
# 注意：下面这段代码**必须顶格写**，一个字都不能缩进 —— 打印出来的就是原样的字符串，
# 而 `<<'PY'` 要求终止符 PY 顶格，正文也不能带多余缩进（否则粘下去第一行就是
# IndentationError，终止符不顶格则 shell 会一直吞后续行）。这个"可直接照抄"是 Critical
# 要的产物，别为了好看缩进它。
RECOVERY_TEMPLATE = """\
恢复方法（把 <APP_ID>/<APP_SECRET> 换成部署里的值；下面从 cd 到最后那个 PY 整段原样照抄）：

cd backend && LARK_APP_ID=<APP_ID> LARK_APP_SECRET=<APP_SECRET> .venv/bin/python - <<'PY'
import json, os, httpx
snap = json.load(open("<SNAPSHOT>", encoding="utf-8"))
cli = httpx.Client(base_url=snap["base_url"], timeout=30.0)
tok = cli.post("/open-apis/auth/v3/tenant_access_token/internal",
               json={"app_id": os.environ["LARK_APP_ID"],
                     "app_secret": os.environ["LARK_APP_SECRET"]}).json()["tenant_access_token"]
for tbl, entry in snap["tables"].items():
    recs = [{"record_id": rid, "fields": f} for rid, f in entry["values"].items()]
    if not recs:
        continue
    rsp = cli.post(f"/open-apis/bitable/v1/apps/{snap['base_token']}/tables/{tbl}/records/batch_update",
                   headers={"Authorization": f"Bearer {tok}"}, json={"records": recs})
    print(tbl, entry["label"], len(recs), rsp.json().get("code"))
PY

它对应的 batch_update 调用形态（说明用，不用抄）：
  POST /open-apis/bitable/v1/apps/<BASE_TOKEN>/tables/<TABLE_ID>/records/batch_update
  body {"records": [{"record_id": "<record_id>", "fields": {"<列名>": "<原值>"}}, ...]}
"""


def print_recovery(snapshot_path: str) -> None:
    print(RECOVERY_TEMPLATE.replace("<SNAPSHOT>", snapshot_path))


def print_snapshot_banner(snapshot_path: str) -> None:
    print("\n" + "=" * 72)
    print(f"快照已落盘（失败时的唯一恢复依据）：{snapshot_path}")
    print("=" * 72)
    print_recovery(snapshot_path)


def print_half_cleaned_no_snapshot() -> None:
    """在「已经动过线上、但还没洗过任何选项」的失败路径上给指引：没有值需要恢复。"""
    print("\n" + "!" * 72)
    print("已进入半清理状态，但**还没有动过任何选项**：单元格的值都还在，没有值需要恢复。")
    print("不要重跑本脚本：数量闸会因为错位行变少而直接中止，重跑救不回来。")
    print("请人工核对这两张表里特征是日期的行（执行记录.负责人 / 缺陷记录.优先级）后再决定下一步。")
    print("!" * 72)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="真的执行删除；默认只打印")
    args = parser.parse_args()

    lark = Lark()
    plan: dict[str, list[dict[str, Any]]] = {
        "执行记录": misplaced(lark, EXEC_TABLE, "负责人"),
        "缺陷记录": misplaced(lark, BUG_TABLE, "优先级"),
    }

    for label, rows in plan.items():
        print(f"\n=== {label} 错位行 {len(rows)} 条（预期 {EXPECTED_MISPLACED}）===")
        for row in rows[:3]:
            fields = row.get("fields") or {}
            print(f"  {row.get('record_id')}  {json.dumps(fields, ensure_ascii=False)[:150]}")
        if rows:
            print("  …")
        if len(rows) != EXPECTED_MISPLACED:
            print(f"  !! 数量与预期不符，停下来让人核对；本脚本不会「尽力而为」地删。")
            return 1

    print("\n=== 将被洗掉的垃圾选项 ===")
    for table, name, wanted in WASHES:
        live = next((f for f in lark.fields(table) if f.get("field_name") == name), None)
        if live is None:
            print(f"  !! 找不到 {table}.{name}")
            return 1
        current = [o.get("name") for o in (live.get("property") or {}).get("options", [])]
        junk = [option for option in current if option not in wanted]
        print(f"  {table}.{name}: 去掉 {junk} → 留 {list(wanted)}")

    print("\n=== 将被删除的废表 ===")
    junk_tables = [
        table
        for table in lark.tables()
        if table.get("name") in JUNK_TABLES
        and all(not (record.get("fields") or {}) for record in lark.records(table["table_id"]))
    ]
    for table in junk_tables:
        print(f"  {table['table_id']}  {table['name']}")

    # 将被删掉的错位行：快照要跳过它们（它们不保留，值也不需要救）。
    doomed = {row["record_id"] for _, rows in plan.items() for row in rows}

    if not args.apply:
        print("\n=== 洗选项前的快照计划（dry-run 预览）===")
        for label, table in ROLE_TABLES:
            preview = snapshot(lark, table, wash_columns(table), doomed)
            print(f"  {label}（{table}）：快照 {len(preview)} 行 → 洗完写回 {len(preview)} 行")
        print("\n（dry-run：什么都没改。加 --apply 才执行。）")
        return 0

    for label, table in ROLE_TABLES:
        ids = [row["record_id"] for row in plan[label]]
        try:
            lark.request(
                "POST",
                f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/records/batch_delete",
                json={"records": ids},
            )
        except (SystemExit, Exception) as exc:
            print(f"  !! 删 {label} 的 {len(ids)} 行失败：{exc}")
            print_half_cleaned_no_snapshot()
            return 1
        print(f"已删 {label} {len(ids)} 行")

    # 洗选项会重建整份选项表，连保留下来的选项所引用的值也一起清空（见文件头）。
    # 所以删完错位行、动选项之前，先把要保留的值按 record_id 快照下来。
    print("\n=== 洗选项前快照要保留的值 ===")
    saved: dict[str, dict[str, dict[str, Any]]] = {}
    try:
        for label, table in ROLE_TABLES:
            saved[table] = snapshot(lark, table, wash_columns(table), doomed)
            print(f"  {label}（{table}）：快照 {len(saved[table])} 行")
    except (SystemExit, Exception) as exc:
        print(f"  !! 快照阶段失败：{exc}")
        print_half_cleaned_no_snapshot()
        return 1

    # 兜底必须在下第一个 PUT 之前落盘：洗到一半失败时进程内的 saved 随进程消失，
    # 而重跑会被 EXPECTED_MISPLACED 挡住 —— 终端里必须留下能据以恢复的东西。
    try:
        snapshot_path = os.path.abspath(write_snapshot_file(saved))
    except (OSError, TypeError, ValueError) as exc:
        print(f"  !! 快照落盘失败：{exc}")
        print("  !! 没有兜底文件就不动线上数据：本次不洗任何选项。")
        print_half_cleaned_no_snapshot()
        return 1
    print_snapshot_banner(snapshot_path)

    wash_failure: str | None = None
    for table, name, wanted in WASHES:
        try:
            live = next(f for f in lark.fields(table) if f.get("field_name") == name)
            lark.request(
                "PUT",
                f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/fields/{live['field_id']}",
                json={
                    "field_name": name,
                    "type": 3,
                    "property": {"options": [{"name": option} for option in wanted]},
                },
            )
        except (SystemExit, Exception) as exc:
            wash_failure = f"{table}.{name}：{exc}"
            print(f"  !! 洗 {table}.{name} 失败：{exc}")
            print("  !! 停止继续洗，立刻走写回，把快照里的值补回去。")
            break
        print(f"已洗 {table}.{name}")

    # 一张表写回失败不许取消另一张：两张表各自隔离，成败最后一起汇报。
    print("\n=== 按 record_id 写回快照 ===")
    writeback_failed: list[str] = []
    for label, table in ROLE_TABLES:
        if not saved[table]:
            print(f"  {label}（{table}）：无值需要写回")
            continue
        try:
            restore(lark, table, saved[table])
        except (SystemExit, Exception) as exc:
            writeback_failed.append(f"{label}（{table}）")
            print(f"  {label}（{table}）：!! 写回失败：{exc}")
            continue
        print(f"  {label}（{table}）：已写回 {len(saved[table])} 行")

    print("\n=== 独立重读核对写回结果 ===")
    mismatched = 0
    for label, table in ROLE_TABLES:
        print(f"  {label}（{table}）：")
        try:
            mismatched += check_restored(lark, table, saved[table])
        except (SystemExit, Exception) as exc:
            mismatched += len(saved[table])
            print(f"    !! 核对本身失败，这 {len(saved[table])} 行无法确认：{exc}")

    junk_failed: list[str] = []
    for table in junk_tables:
        try:
            lark.request(
                "DELETE", f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table['table_id']}"
            )
        except (SystemExit, Exception) as exc:
            junk_failed.append(table["name"])
            print(f"  !! 删废表 {table['name']} 失败：{exc}")
            continue
        print(f"已删废表 {table['name']}")

    # 选项复查的不一致也进判据：自查的输出必须真的影响出厂码（这与本次事故是同族错误）。
    print("\n=== 复查 ===")
    option_diffs: list[str] = []
    for table, name, wanted in WASHES:
        try:
            live = next((f for f in lark.fields(table) if f.get("field_name") == name), None)
            current = [
                o.get("name") for o in ((live or {}).get("property") or {}).get("options", [])
            ]
            ok = live is not None and current == list(wanted)
        except (SystemExit, Exception) as exc:
            current, ok = [f"读取失败：{exc}"], False
        if not ok:
            option_diffs.append(f"{table}.{name}")
        print(f"  {table}.{name}: {'OK' if ok else '!! 仍有差异'} {current}")
    # 收尾这两次读取同样是自查输出，失败也要成为判据：不能出现「结论说全 OK、验收行却写着读取失败」。
    read_failed: list[str] = []
    for label, table in ROLE_TABLES:
        try:
            count: Any = len(lark.records(table))
        except (SystemExit, Exception) as exc:
            count = f"读取失败：{exc}"
            read_failed.append(f"{label} 剩余行数")
        print(f"  {label} 剩余行数：{count}")
    try:
        remaining: Any = [t["name"] for t in lark.tables()]
    except (SystemExit, Exception) as exc:
        remaining = f"读取失败：{exc}"
        read_failed.append("剩余表")
    print(f"  剩余表：{remaining}")

    print("\n=== 结论 ===")
    if not (
        wash_failure
        or writeback_failed
        or mismatched
        or option_diffs
        or junk_failed
        or read_failed
    ):
        print("  洗选项 / 写回 / 核对 / 删废表 全部 OK。")
        return 0
    if wash_failure:
        print(f"  !! 洗选项失败：{wash_failure}")
    if writeback_failed:
        print(f"  !! 写回失败的表：{writeback_failed}")
    if mismatched:
        print(f"  !! 写回后有 {mismatched} 行与快照不一致（见上面的 !! 行）")
    if option_diffs:
        print(f"  !! 选项复查仍有差异：{option_diffs}")
    if junk_failed:
        print(f"  !! 删废表失败：{junk_failed}")
    if read_failed:
        print(f"  !! 收尾读取失败：{read_failed}")
    print("  !! 本次没有全绿，以非 0 退出。不要重跑本脚本。")
    print(f"  快照文件：{snapshot_path}")
    print_recovery(snapshot_path)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
