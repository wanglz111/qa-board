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
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
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
        lark.request(
            "POST",
            f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/records/batch_delete",
            json={"records": ids},
        )
        print(f"已删 {label} {len(ids)} 行")

    # 洗选项会重建整份选项表，连保留下来的选项所引用的值也一起清空（见文件头）。
    # 所以删完错位行、动选项之前，先把要保留的值按 record_id 快照下来。
    print("\n=== 洗选项前快照要保留的值 ===")
    saved: dict[str, dict[str, dict[str, Any]]] = {}
    for label, table in ROLE_TABLES:
        saved[table] = snapshot(lark, table, wash_columns(table), doomed)
        print(f"  {label}（{table}）：快照 {len(saved[table])} 行")

    for table, name, wanted in WASHES:
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
        print(f"已洗 {table}.{name}")

    print("\n=== 按 record_id 写回快照 ===")
    for label, table in ROLE_TABLES:
        if not saved[table]:
            print(f"  {label}（{table}）：无值需要写回")
            continue
        restore(lark, table, saved[table])
        print(f"  {label}（{table}）：已写回 {len(saved[table])} 行")

    print("\n=== 独立重读核对写回结果 ===")
    mismatched = 0
    for label, table in ROLE_TABLES:
        print(f"  {label}（{table}）：")
        mismatched += check_restored(lark, table, saved[table])

    for table in junk_tables:
        lark.request(
            "DELETE", f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table['table_id']}"
        )
        print(f"已删废表 {table['name']}")

    print("\n=== 复查 ===")
    for table, name, wanted in WASHES:
        live = next(f for f in lark.fields(table) if f.get("field_name") == name)
        current = [o.get("name") for o in (live.get("property") or {}).get("options", [])]
        ok = current == list(wanted)
        print(f"  {table}.{name}: {'OK' if ok else '!! 仍有差异'} {current}")
    for label, table in ROLE_TABLES:
        print(f"  {label} 剩余行数：{len(lark.records(table))}")
    print(f"  剩余表：{[t['name'] for t in lark.tables()]}")
    if mismatched:
        print(f"\n!! 写回后有 {mismatched} 行与快照不一致（见上面的 !! 行）：值没救回来。")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
