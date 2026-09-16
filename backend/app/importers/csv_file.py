from __future__ import annotations

import csv
import io
from typing import Any

from .schema import ImportErrorDetail, decode_utf8


def parse_csv(content: bytes) -> list[dict[str, Any]]:
    text = decode_utf8(content, bom=True)
    try:
        reader = csv.DictReader(io.StringIO(text), strict=True)
        if not reader.fieldnames or not any(name and name.strip() for name in reader.fieldnames):
            raise ImportErrorDetail("The CSV file is missing a header row")
        records = list(reader)
    except csv.Error as exc:
        raise ImportErrorDetail(f"Invalid CSV file: {exc}") from exc

    return [record for record in records if any(_has_value(value) for value in record.values())]


def _has_value(value: Any) -> bool:
    if isinstance(value, list):
        return any(item and item.strip() for item in value)
    return value is not None and bool(value.strip())
