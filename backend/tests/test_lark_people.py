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


def test_saving_twice_keeps_one_row(db_session):
    people.save_people(db_session, reporter_open_id="ou_one", owner_open_id=None)
    people.save_people(db_session, reporter_open_id="ou_two", owner_open_id=None)

    rows = db_session.scalars(select(LarkPeople)).all()
    assert [row.reporter_open_id for row in rows] == ["ou_two"]
