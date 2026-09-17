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
