from __future__ import annotations

import json
from typing import Any

from .schema import ImportErrorDetail, decode_utf8


def parse_json(content: bytes) -> list[dict[str, Any]]:
    text = decode_utf8(content, bom=True)
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ImportErrorDetail(f"Invalid JSON file: {exc.msg}") from exc

    if isinstance(document, list):
        records = document
    elif isinstance(document, dict) and isinstance(document.get("cases"), list):
        records = document["cases"]
    else:
        raise ImportErrorDetail("JSON must be a top-level array or an object with a cases array")

    if any(not isinstance(record, dict) for record in records):
        raise ImportErrorDetail("Every JSON case must be an object")
    return records
