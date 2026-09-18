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

为什么顺序不能颠倒：删掉一个还被人引用的选项会连带清空那些单元格的值，
所以错位行必须先走。
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

    if not args.apply:
        print("\n（dry-run：什么都没改。加 --apply 才执行。）")
        return 0

    for label, table, rows in (
        ("执行记录", EXEC_TABLE, plan["执行记录"]),
        ("缺陷记录", BUG_TABLE, plan["缺陷记录"]),
    ):
        ids = [row["record_id"] for row in rows]
        lark.request(
            "POST",
            f"/open-apis/bitable/v1/apps/{BASE_TOKEN}/tables/{table}/records/batch_delete",
            json={"records": ids},
        )
        print(f"已删 {label} {len(ids)} 行")

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
    for label, table in (("执行记录", EXEC_TABLE), ("缺陷记录", BUG_TABLE)):
        print(f"  {label} 剩余行数：{len(lark.records(table))}")
    print(f"  剩余表：{[t['name'] for t in lark.tables()]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
