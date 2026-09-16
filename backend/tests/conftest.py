import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Group, GroupCase


os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test",
)
os.environ.setdefault("ADMIN_EMAIL", "admin@example.test")
os.environ.setdefault("ADMIN_PASSWORD", "test-password")
os.environ.setdefault("SESSION_SECRET", "test-only-session-secret-32-characters")
os.environ.setdefault("CSRF_SECRET", "test-only-csrf-secret-32-characters")


@pytest.fixture
def db_session():
    test_database_url = os.environ.get("TEST_DATABASE_URL")
    if not test_database_url:
        pytest.fail("TEST_DATABASE_URL is required for database integration tests")

    engine = create_engine(test_database_url)
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")

    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()
        engine.dispose()


@pytest.fixture
def make_group_case():
    def factory(session: Session, *, group_name: str, code: str) -> GroupCase:
        group = Group(
            name=group_name,
            source_name=f"{group_name}.test",
            source_sha256="0" * 64,
            source_format="test",
            source_version="1",
        )
        group_case = GroupCase(
            group=group,
            code=code,
            position=1,
            title=code,
            raw={"code": code},
        )
        session.add(group_case)
        return group_case

    return factory
