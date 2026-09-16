from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import parse_qs, urlparse


# Only these tenants may be addressed, so a pasted URL can never become a
# request against an attacker-chosen host.
ALLOWED_SUFFIXES = ("larksuite.com", "feishu.cn")
CONTENT_KINDS = ("wiki", "base")
TABLE_ID = re.compile(r"^tbl[A-Za-z0-9]+$")
VIEW_ID = re.compile(r"^vew[A-Za-z0-9]+$")


class LarkLinkError(ValueError):
    """The pasted text is not a readable Lark Bitable link."""


@dataclass(frozen=True)
class LarkLink:
    host: str
    kind: str
    source_id: str
    table_id: str | None
    view_id: str | None


def _host_is_allowed(host: str) -> bool:
    return any(
        host == suffix or host.endswith(f".{suffix}") for suffix in ALLOWED_SUFFIXES
    )


def parse_lark_link(url: str) -> LarkLink:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise LarkLinkError("请粘贴 Lark 文档链接")
    host = parsed.hostname.lower()
    if not _host_is_allowed(host):
        raise LarkLinkError("只支持 larksuite.com 或 feishu.cn 的文档链接")

    segments = [part for part in parsed.path.split("/") if part]
    if len(segments) != 2 or segments[0] not in CONTENT_KINDS:
        raise LarkLinkError("链接不是多维表格（wiki 或 base），无法读取表头")

    query = parse_qs(parsed.query)
    table_id = (query.get("table") or [None])[0]
    view_id = (query.get("view") or [None])[0]
    if table_id is not None and not TABLE_ID.match(table_id):
        raise LarkLinkError("链接里的 table 参数不是多维表格数据表")
    if view_id is not None and not VIEW_ID.match(view_id):
        raise LarkLinkError("链接里的 view 参数不是多维表格视图")

    return LarkLink(
        host=host,
        kind=segments[0],
        source_id=segments[1],
        table_id=table_id,
        view_id=view_id,
    )
