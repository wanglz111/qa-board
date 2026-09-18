from dataclasses import replace

import pytest
from sqlalchemy import select

from app.config import settings
from app.lark import people
from app.models import LarkPeople


@pytest.fixture
def env_reporter(monkeypatch):
    """The environment fallback, as a deployment that never opened the page has it.

    ``replace`` 是仓库里既有的造 settings 副本的写法（见 ``conftest.py`` 的
    ``upload_dir`` fixture）；``people`` 模块自己 import 了 ``settings``，
    所以要打在它身上，不能打全局那个。
    """

    monkeypatch.setattr(
        people, "settings", replace(settings, default_reporter_id="ou_from_env")
    )


@pytest.fixture
def no_env_reporter(monkeypatch):
    """A deployment with no environment fallback, whatever the shell exported.

    ``settings`` is built once at ``app.config``'s import from ``os.environ``, so
    deleting the variable here would not reach it — the copy is what the module
    actually reads.
    """

    monkeypatch.setattr(people, "settings", replace(settings, default_reporter_id=""))


def test_an_unset_row_falls_back_to_the_environment_reporter(env_reporter, db_session):
    """A deployment that never opened the page keeps writing what it always did."""

    assert people.resolved_reporter_open_id(db_session) == "ou_from_env"
    # 负责人 has no environment fallback: nothing ever configured one.
    assert people.resolved_owner_open_id(db_session) is None


def test_a_saved_reporter_wins_over_the_environment(env_reporter, db_session):
    people.save_people(
        db_session, reporter_open_id="ou_from_page", owner_open_id="ou_owner"
    )

    assert people.resolved_reporter_open_id(db_session) == "ou_from_page"
    assert people.resolved_owner_open_id(db_session) == "ou_owner"


def test_clearing_the_page_field_falls_back_to_the_environment_again(
    env_reporter, db_session
):
    people.save_people(
        db_session, reporter_open_id="ou_from_page", owner_open_id="ou_owner"
    )
    people.save_people(db_session, reporter_open_id="", owner_open_id="")

    assert people.resolved_reporter_open_id(db_session) == "ou_from_env"
    assert people.resolved_owner_open_id(db_session) is None

    # The fallback above passes for any falsy column value, "" included; this is
    # what pins the constraint that "not configured" is SQL NULL, not an empty
    # string (an unset id is omitted from the request, an empty one is sent).
    row = db_session.scalars(select(LarkPeople)).one()
    assert row.reporter_open_id is None
    assert row.owner_open_id is None


def test_saving_twice_keeps_one_row(db_session):
    people.save_people(db_session, reporter_open_id="ou_one", owner_open_id=None)
    people.save_people(db_session, reporter_open_id="ou_two", owner_open_id=None)

    rows = db_session.scalars(select(LarkPeople)).all()
    assert [row.reporter_open_id for row in rows] == ["ou_two"]


# ---------------------------------------------------------------------------
# The HTTP surface the settings page talks to. The route is registered in
# ``app.main``; the five keys below are the shape the page is written against.
# The first ``GET`` creates the row (``read_people`` flushes an INSERT and the
# endpoint commits), which is why ``effective_*`` is only meaningful after it.


def test_the_settings_page_reads_and_writes_both_ids(
    authenticated_client, db_session, no_env_reporter
):
    assert authenticated_client.get("/api/lark/people").json() == {
        "reporter_open_id": "",
        "owner_open_id": "",
        "env_reporter_open_id": "",
        "effective_reporter_open_id": "",
        "effective_owner_open_id": "",
    }

    saved = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_reporter", "owner_open_id": "ou_owner"},
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["reporter_open_id"] == "ou_reporter"
    assert saved.json()["owner_open_id"] == "ou_owner"
    assert saved.json()["effective_reporter_open_id"] == "ou_reporter"
    assert saved.json()["effective_owner_open_id"] == "ou_owner"


def test_a_name_where_an_open_id_belongs_is_refused(authenticated_client, db_session):
    """A person column refuses a display name, so the page must refuse it first."""

    response = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "Max", "owner_open_id": ""},
    )

    assert response.status_code == 422, response.text
    assert "ou_" in response.json()["detail"]


# 约束 1 的边界：open_id 只认 ``^ou_[A-Za-z0-9_-]{1,64}\Z``，姓名、邮箱、
# union_id 一律拒。每一类单独一条，红了就能看出漏的是哪一类。两个量词边界
# （``ou_`` 0 字符 / 65 字符）都在这里，上界 64 的"必须接受"在下面的
# ``test_an_open_id_at_the_upper_bound_is_accepted``。
REJECTED_OPEN_IDS = [
    "Max",  # 显示名
    "max@example.com",  # 邮箱
    "on_abc123",  # union_id 形状（不是 ou_ 前缀）
    "ou_",  # 0 字符：量词下界，必须拒
    "ou_" + "a" * 65,  # 超长（64 是上限）
    "ou_ab c",  # 内部空格
    "ou_名字",  # 非 ASCII
]


@pytest.mark.parametrize(
    "rejected",
    REJECTED_OPEN_IDS,
    ids=[
        "display_name",
        "email",
        "union_id",
        "too_short",
        "too_long",
        "inner_space",
        "non_ascii",
    ],
)
def test_anything_that_is_not_an_open_id_is_refused(authenticated_client, rejected):
    response = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": rejected, "owner_open_id": ""},
    )

    assert response.status_code == 422, response.text
    assert "ou_" in response.json()["detail"]


def test_an_open_id_at_the_upper_bound_is_accepted(authenticated_client, db_session):
    boundary = "ou_" + "a" * 64

    response = authenticated_client.put(
        "/api/lark/people", json={"reporter_open_id": boundary, "owner_open_id": ""}
    )

    assert response.status_code == 200, response.text
    assert response.json()["reporter_open_id"] == boundary


def test_the_pattern_refuses_a_trailing_newline_a_dollar_anchor_would_allow():
    r"""``\Z``, not ``$``: ``$`` also matches just before a trailing newline.

    The HTTP layer cannot see this difference — ``_checked`` strips before it
    validates, so the newline is gone by the time the pattern runs (next test).
    This one therefore pins the pattern itself, which is exactly the hole Task 4
    closed when it turned ``$`` into ``\Z``; with ``$`` the first assertion fails.
    """

    assert people.OPEN_ID.match("ou_abc\n") is None
    assert people.OPEN_ID.match("ou_abc") is not None


def test_a_valid_id_padded_with_whitespace_is_stripped_not_refused(
    authenticated_client,
):
    r"""A padded open id is cleaned, not refused: ``_checked`` strips first.

    Stripping is what 约束 2 (纯空白 = 清空) is built on, so by the time the
    pattern sees ``"ou_abc\n"`` it is already ``"ou_abc"``. That is why that
    shape is pinned here and in the pattern test above, and **not** in
    ``REJECTED_OPEN_IDS`` — over HTTP it is a 200, by design.
    """

    response = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_abc\n", "owner_open_id": "\t"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["reporter_open_id"] == "ou_abc"


def test_a_refused_id_leaves_the_saved_ones_untouched(authenticated_client):
    """A 422 refuses the whole request: the valid half must not half-apply."""

    authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_reporter", "owner_open_id": "ou_owner"},
    )

    refused = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_replacement", "owner_open_id": "Max"},
    )

    assert refused.status_code == 422, refused.text
    kept = authenticated_client.get("/api/lark/people").json()
    assert kept["reporter_open_id"] == "ou_reporter"
    assert kept["owner_open_id"] == "ou_owner"


def test_an_empty_box_clears_the_saved_id(
    authenticated_client, db_session, no_env_reporter
):
    authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_reporter", "owner_open_id": ""},
    )

    cleared = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "", "owner_open_id": ""},
    )

    assert cleared.json()["reporter_open_id"] == ""
    assert cleared.json()["effective_reporter_open_id"] == ""


def test_whitespace_only_clears_the_saved_id(authenticated_client, db_session):
    authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "ou_reporter", "owner_open_id": "ou_owner"},
    )

    cleared = authenticated_client.put(
        "/api/lark/people",
        json={"reporter_open_id": "   ", "owner_open_id": "\t"},
    )

    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["reporter_open_id"] == ""
    assert cleared.json()["owner_open_id"] == ""

    # 「清空」落库是 SQL NULL，不是空串：响应体里的 "" 是 ``_payload`` 用
    # ``or ""`` 折出来的，只看响应体分不出这两种落库形态。
    row = db_session.scalars(select(LarkPeople)).one()
    assert row.reporter_open_id is None
    assert row.owner_open_id is None


def test_the_page_needs_an_admin_session(client):
    assert client.get("/api/lark/people").status_code == 401


def test_saving_the_people_needs_an_admin_session(client):
    assert client.put("/api/lark/people", json={"reporter_open_id": "", "owner_open_id": ""}).status_code == 401
