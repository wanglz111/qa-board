import app.lark.cache as lark_cache


def test_a_second_read_inside_the_ttl_does_not_call_lark_again():
    lark_cache.clear()
    calls = []

    def fetch():
        calls.append(1)
        return [{"record_id": "r1"}]

    first = lark_cache.read_records("app-exec", "tbl-runs", fetch)
    second = lark_cache.read_records("app-exec", "tbl-runs", fetch)

    assert first == second == [{"record_id": "r1"}]
    assert len(calls) == 1


def test_an_expired_snapshot_is_read_again(monkeypatch):
    lark_cache.clear()
    clock = {"now": 1000.0}
    monkeypatch.setattr(lark_cache.time, "monotonic", lambda: clock["now"])
    calls = []

    def fetch():
        calls.append(1)
        return []

    lark_cache.read_records("app-exec", "tbl-runs", fetch)
    clock["now"] += lark_cache.DEFAULT_TTL_SECONDS + 1
    lark_cache.read_records("app-exec", "tbl-runs", fetch)

    assert len(calls) == 2


def test_invalidate_drops_only_that_table():
    lark_cache.clear()
    calls = []

    def fetch_for(table):
        def fetch():
            calls.append(table)
            return []

        return fetch

    lark_cache.read_records("app-exec", "tbl-runs", fetch_for("runs"))
    lark_cache.read_records("app-exec", "tbl-defects", fetch_for("defects"))
    lark_cache.invalidate("app-exec", "tbl-runs")
    lark_cache.read_records("app-exec", "tbl-runs", fetch_for("runs"))
    lark_cache.read_records("app-exec", "tbl-defects", fetch_for("defects"))

    assert calls == ["runs", "defects", "runs"]


def test_the_cached_list_is_not_handed_out_for_mutation():
    lark_cache.clear()
    stored = [{"record_id": "r1"}]
    lark_cache.read_records("app-exec", "tbl-runs", lambda: stored)

    got = lark_cache.read_records("app-exec", "tbl-runs", lambda: [])
    got.append({"record_id": "injected"})

    assert lark_cache.read_records("app-exec", "tbl-runs", lambda: []) == stored


def test_an_expired_entry_is_dropped_by_a_later_read(monkeypatch):
    """A rebuilt table's snapshot must not stay resident for the process's life.

    Every rebuild mints a new table id, so the entry of the table it replaced
    is never read again — a read of that same key is exactly what does not
    happen. Nothing but a prune on the read path can release it.
    """

    lark_cache.clear()
    clock = {"now": 1000.0}
    monkeypatch.setattr(lark_cache.time, "monotonic", lambda: clock["now"])

    replaced = ("app-exec", "tbl-runs")
    lark_cache.read_records(*replaced, lambda: [{"record_id": "old"}])
    assert replaced in lark_cache._entries

    clock["now"] += lark_cache.DEFAULT_TTL_SECONDS + 1
    # Another table is read; the expired entry above is never asked for again.
    lark_cache.read_records("app-exec", "tbl-new", lambda: [{"record_id": "new"}])

    assert replaced not in lark_cache._entries
    assert ("app-exec", "tbl-new") in lark_cache._entries


def test_pruning_does_not_disturb_a_fresh_entry_of_another_table(monkeypatch):
    lark_cache.clear()
    clock = {"now": 1000.0}
    monkeypatch.setattr(lark_cache.time, "monotonic", lambda: clock["now"])
    calls: dict[str, int] = {"stale": 0, "fresh": 0}

    def fetch(name):
        def read():
            calls[name] += 1
            return []

        return read

    stale = ("app-exec", "tbl-runs")
    fresh = ("app-exec", "tbl-defects")
    lark_cache.read_records(*stale, fetch("stale"), ttl=10.0)
    lark_cache.read_records(*fresh, fetch("fresh"), ttl=600.0)

    # The stale entry's ttl has passed; the fresh one has a long way to go.
    clock["now"] += 20.0
    lark_cache.read_records("app-exec", "tbl-new", lambda: [])

    assert stale not in lark_cache._entries
    assert fresh in lark_cache._entries
    lark_cache.read_records(*fresh, fetch("fresh"))
    assert calls == {"stale": 1, "fresh": 1}
