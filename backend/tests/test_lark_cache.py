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


class _Target:
    execution_base_token = "app-exec"
    execution_table_id = "tbl-runs"
    bug_base_token = "app-bug"
    bug_table_id = "tbl-defects"


def test_the_table_names_are_snapshotted_too():
    lark_cache.clear()
    calls = []

    def fetch():
        calls.append(1)
        return {"execution_table_name": "执行记录"}

    first = lark_cache.read_names(_Target(), fetch)
    second = lark_cache.read_names(_Target(), fetch)

    assert first == {"execution_table_name": "执行记录"}
    assert second == first
    assert len(calls) == 1
    # A caller must not be able to edit the snapshot through what it was handed.
    second["execution_table_name"] = "tampered"
    assert lark_cache.read_names(_Target(), fetch)["execution_table_name"] == "执行记录"


def test_invalidate_target_drops_the_names_with_the_records():
    lark_cache.clear()
    names_calls = []
    record_calls = []

    def fetch_names():
        names_calls.append(1)
        return {}

    target = _Target()
    lark_cache.read_names(target, fetch_names)
    lark_cache.read_records("app-exec", "tbl-runs", lambda: record_calls.append(1) or [])
    lark_cache.invalidate_target(target)
    lark_cache.read_names(target, fetch_names)
    lark_cache.read_records("app-exec", "tbl-runs", lambda: record_calls.append(1) or [])

    assert len(names_calls) == 2
    assert len(record_calls) == 2
