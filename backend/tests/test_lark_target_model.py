import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.models import LarkTarget, LarkTargetRevision


def _target(group_id, execution_table_id: str) -> LarkTarget:
    return LarkTarget(
        group_id=group_id,
        source_url="https://tenant.larksuite.com/wiki/node1?table=tbl-a",
        execution_base_token="app-exec",
        execution_base_name="执行库",
        execution_table_id=execution_table_id,
        execution_table_name="执行记录",
        bug_base_token="app-bug",
        bug_base_name="缺陷库",
        bug_table_id="tbl-bugs",
        bug_table_name="缺陷记录",
        target_fingerprint=f"app-exec|{execution_table_id}|app-bug|tbl-bugs",
        schema_fingerprint=None,
    )


def _revision(group_id, fingerprint: str) -> LarkTargetRevision:
    return LarkTargetRevision(
        group_id=group_id,
        execution_base_token="app-exec",
        execution_table_id="tbl-runs",
        bug_base_token="app-bug",
        bug_table_id="tbl-defects",
        target_fingerprint=fingerprint,
    )


def test_one_target_row_per_group(db_session, imported_group):
    db_session.add(_target(imported_group.id, "tbl-a"))
    db_session.commit()
    db_session.add(_target(imported_group.id, "tbl-b"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_revisions_accumulate_per_group(db_session, imported_group):
    for fingerprint in ("f1", "f2"):
        db_session.add(_revision(imported_group.id, fingerprint))
    db_session.commit()
    count = db_session.scalar(
        select(func.count())
        .select_from(LarkTargetRevision)
        .where(LarkTargetRevision.group_id == imported_group.id)
    )
    assert count == 2


def test_one_revision_row_per_group_and_fingerprint(db_session, imported_group):
    db_session.add(_revision(imported_group.id, "f1"))
    db_session.commit()
    db_session.add(_revision(imported_group.id, "f1"))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_confirmation_starts_empty(db_session, imported_group):
    target = _target(imported_group.id, "tbl-a")
    db_session.add(target)
    db_session.commit()
    assert target.confirmed_at is None
    assert target.selected_at is not None
