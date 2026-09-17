"""A short-lived snapshot of one Lark table's records.

The execution page re-reads a group's whole run table every time a case is
opened. One operator works through a group in a single sitting, so a snapshot
that lives for a minute answers every case in that sitting without asking Lark
again.

Two things keep the snapshot honest. This process drops it when it writes
(``POST /attempts`` and its siblings), and the sync queue emptying drops it too
— the worker runs in another container, so that is the one moment this process
learns that a row it queued has landed.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

# Long enough to cover a sitting, short enough that a missed invalidation heals
# by itself.
DEFAULT_TTL_SECONDS = 60.0

_lock = threading.Lock()
_entries: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}
# Base and table names change far less often than rows, but they ride the same
# snapshot and the same invalidation so a warm open costs no request at all.
_names: dict[tuple[str, str, str, str], tuple[float, dict[str, Any]]] = {}


def read_records(
    base_token: str,
    table_id: str,
    fetch: Callable[[], list[dict[str, Any]]],
    *,
    ttl: float | None = None,
) -> list[dict[str, Any]]:
    """The table's records, from the snapshot while it is still fresh."""

    key = (base_token, table_id)
    with _lock:
        entry = _entries.get(key)
        if entry is not None and time.monotonic() < entry[0]:
            # A reader must not be able to edit the snapshot through the list it
            # was handed, so every reader gets its own container.
            return list(entry[1])
    records = fetch()
    with _lock:
        _entries[key] = (
            time.monotonic() + (DEFAULT_TTL_SECONDS if ttl is None else ttl),
            list(records),
        )
    return list(records)


def invalidate(base_token: str, table_id: str) -> None:
    with _lock:
        _entries.pop((base_token, table_id), None)


def _names_key(target: Any) -> tuple[str, str, str, str]:
    return (
        target.execution_base_token,
        target.execution_table_id,
        target.bug_base_token,
        target.bug_table_id,
    )


def read_names(target: Any, fetch: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """The target's live base/table names, from the snapshot while it is fresh.

    Without this the panel still pays four name reads per case open (base
    metadata and table listing for each role) — the record snapshot alone only
    removes the two record reads.
    """

    key = _names_key(target)
    with _lock:
        entry = _names.get(key)
        if entry is not None and time.monotonic() < entry[0]:
            return dict(entry[1])
    names = fetch()
    with _lock:
        _names[key] = (time.monotonic() + DEFAULT_TTL_SECONDS, dict(names))
    return dict(names)


def invalidate_target(target: Any) -> None:
    """Drop both roles of one group's target, names included."""

    with _lock:
        _names.pop(_names_key(target), None)
    invalidate(target.execution_base_token, target.execution_table_id)
    invalidate(target.bug_base_token, target.bug_table_id)


def clear() -> None:
    with _lock:
        _entries.clear()
        _names.clear()
