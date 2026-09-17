import pytest

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


def test_an_expired_snapshot_does_not_stay_in_the_store(monkeypatch):
    lark_cache.clear()
    clock = {"now": 1000.0}
    monkeypatch.setattr(lark_cache.time, "monotonic", lambda: clock["now"])

    lark_cache.read_records("app-exec", "tbl-runs", lambda: [{"record_id": "r1"}])
    lark_cache.read_names(_Target(), lambda: {"execution_table_name": "执行记录"})

    clock["now"] += lark_cache.DEFAULT_TTL_SECONDS + 1
    # A miss on any key is where the aged-out snapshots are swept up.
    lark_cache.read_records("app-exec", "tbl-other", lambda: [])

    assert list(lark_cache._entries) == [("app-exec", "tbl-other")]
    assert lark_cache._names == {}


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


def test_the_names_key_uses_all_four_tokens():
    lark_cache.clear()
    fields = {
        "execution_base_token": "app-exec",
        "execution_table_id": "tbl-runs",
        "bug_base_token": "app-bug",
        "bug_table_id": "tbl-defects",
    }
    calls = []

    def fetch_for(role):
        def fetch():
            calls.append(role)
            return {"role": role}

        return fetch

    base = type("_BaseTarget", (), dict(fields))
    assert lark_cache.read_names(base, fetch_for("base")) == {"role": "base"}

    # A target differing in any one token shares three of its four, so a key
    # built from fewer than all four would serve it the base target's names.
    for field, value in fields.items():
        variant = type("_VariantTarget", (), {**fields, field: f"{value}-other"})
        assert lark_cache.read_names(variant, fetch_for(field)) == {"role": field}

    # The base target's own snapshot survived the four near-miss reads.
    assert lark_cache.read_names(base, fetch_for("base")) == {"role": "base"}
    assert calls == ["base", *fields]


class _OtherTarget:
    execution_base_token = "app-exec"
    execution_table_id = "tbl-other"
    bug_base_token = "app-bug-other"
    bug_table_id = "tbl-defects"


def test_invalidate_target_leaves_another_target_s_snapshots_alone():
    lark_cache.clear()
    names_calls = []
    record_calls = []

    def fetch_names(name):
        def fetch():
            names_calls.append(name)
            return {"execution_table_name": name}

        return fetch

    first = _Target()
    other = _OtherTarget()
    lark_cache.read_names(first, fetch_names("first"))
    lark_cache.read_names(other, fetch_names("other"))
    lark_cache.read_records(
        "app-exec", "tbl-other", lambda: record_calls.append("other") or []
    )

    lark_cache.invalidate_target(first)

    assert lark_cache.read_names(other, fetch_names("other")) == {
        "execution_table_name": "other"
    }
    # The other target's records still come from its own snapshot: a blanket
    # wipe would fetch here a second time.
    assert (
        lark_cache.read_records(
            "app-exec", "tbl-other", lambda: record_calls.append("other") or []
        )
        == []
    )
    # …while the invalidated target really did lose its own.
    assert lark_cache.read_names(first, fetch_names("first")) == {
        "execution_table_name": "first"
    }
    assert (
        lark_cache.read_records(
            "app-exec", "tbl-runs", lambda: record_calls.append("runs") or []
        )
        == []
    )
    assert names_calls == ["first", "other", "first"]
    assert record_calls == ["other", "runs"]


def test_a_raising_fetch_stores_nothing():
    lark_cache.clear()
    attempts = []

    def records_boom():
        attempts.append("records")
        raise RuntimeError("lark is unreachable")

    def names_boom():
        attempts.append("names")
        raise RuntimeError("lark is unreachable")

    with pytest.raises(RuntimeError):
        lark_cache.read_records("app-exec", "tbl-runs", records_boom)
    with pytest.raises(RuntimeError):
        lark_cache.read_names(_Target(), names_boom)

    # A failure must not leave a negative entry behind: the next open retries.
    assert lark_cache.read_records(
        "app-exec", "tbl-runs", lambda: [{"record_id": "r1"}]
    ) == [{"record_id": "r1"}]
    assert lark_cache.read_names(
        _Target(), lambda: {"execution_table_name": "执行记录"}
    ) == {"execution_table_name": "执行记录"}
    assert attempts == ["records", "names"]
