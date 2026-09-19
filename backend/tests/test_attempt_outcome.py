from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

import pytest

from app.models import Attempt, LOCAL_SOURCES


def test_an_imported_attempt_keeps_its_evidence(db_session, make_group_case):
    case = make_group_case(db_session, group_name="0918", code="B-001")
    attempt = Attempt(
        group_case=case,
        label="B-001",
        sequence=1,
        state="committed",
        result="通过",
        evidence="1. 实测底色 rgb(19,23,30)",
        source="import",
        idempotency_key="import:abc:B-001",
    )
    db_session.add(attempt)
    db_session.commit()

    stored = db_session.scalar(select(Attempt).where(Attempt.id == attempt.id))
    assert stored.evidence == "1. 实测底色 rgb(19,23,30)"
    assert stored.source == "import"


def test_the_local_sources_are_the_two_rows_we_own():
    assert LOCAL_SOURCES == ("execution", "import")


def test_an_unknown_source_is_refused_by_the_database(db_session, make_group_case):
    case = make_group_case(db_session, group_name="0918", code="B-002")
    db_session.add(
        Attempt(
            group_case=case,
            label="B-002",
            sequence=1,
            state="committed",
            result="通过",
            source="borrowed",
            idempotency_key="borrowed-1",
        )
    )
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()
