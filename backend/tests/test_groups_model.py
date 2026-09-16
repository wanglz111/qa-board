import pytest
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

from app.models import Group, GroupCase


def test_same_case_number_is_allowed_in_different_groups(
    db_session, make_group_case
):
    first = make_group_case(db_session, group_name="0918", code="B-001")
    second = make_group_case(db_session, group_name="0922", code="B-001")
    db_session.commit()
    assert first.id != second.id
    assert first.group_id != second.group_id


def test_same_group_rejects_duplicate_case_code(db_session, make_group_case):
    first = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.flush()
    db_session.add(
        GroupCase(
            group=first.group,
            code="B-001",
            position=2,
            title="Duplicate code",
            raw={"code": "B-001"},
        )
    )

    with pytest.raises(IntegrityError):
        db_session.flush()


def test_same_group_rejects_duplicate_case_position(db_session, make_group_case):
    first = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.flush()
    db_session.add(
        GroupCase(
            group=first.group,
            code="B-002",
            position=first.position,
            title="Duplicate position",
            raw={"code": "B-002"},
        )
    )

    with pytest.raises(IntegrityError):
        db_session.flush()


def test_deleting_group_cascades_to_cases_at_database_level(
    db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    group_id = group_case.group_id
    group_case_id = group_case.id
    db_session.expunge_all()

    db_session.execute(delete(Group).where(Group.id == group_id))
    db_session.commit()

    assert db_session.get(GroupCase, group_case_id) is None
