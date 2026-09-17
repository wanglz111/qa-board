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


def _prune_expired(now: float) -> None:
    """Drop every entry whose ttl has passed. The caller holds ``_lock``.

    An entry whose key is never read again — the table a rebuild just replaced,
    for instance — would otherwise stay resident for the process's life, and a
    rebuild mints a new table id every time. Pruning on the read path is what
    keeps the store bounded by the tables this process still reads.
    """

    expired = [key for key, entry in _entries.items() if now >= entry[0]]
    for key in expired:
        del _entries[key]


def read_records(
    base_token: str,
    table_id: str,
    fetch: Callable[[], list[dict[str, Any]]],
    *,
    ttl: float | None = None,
) -> list[dict[str, Any]]:
    """The table's records, from the snapshot while it is still fresh."""

    key = (base_token, table_id)
    now = time.monotonic()
    with _lock:
        _prune_expired(now)
        entry = _entries.get(key)
        if entry is not None and now < entry[0]:
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


def invalidate_target(target: Any) -> None:
    """Drop both roles of one group's target."""

    invalidate(target.execution_base_token, target.execution_table_id)
    invalidate(target.bug_base_token, target.bug_table_id)


def clear() -> None:
    with _lock:
        _entries.clear()
