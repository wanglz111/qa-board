import os
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, inspect
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session
from sqlalchemy.schema import CreateSchema, DropSchema

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test",
)
os.environ.setdefault("ADMIN_EMAIL", "admin@example.test")
os.environ.setdefault("ADMIN_PASSWORD", "test-password")
os.environ.setdefault("SESSION_SECRET", "test-only-session-secret-32-characters")
os.environ.setdefault("CSRF_SECRET", "test-only-csrf-secret-32-characters")


from app.db import get_db
from app.main import app
from app import screenshots
from app.config import settings
from app.models import Admin, Attempt, Group, GroupCase


@pytest.fixture(scope="session")
def migrated_database() -> Engine:
    test_database_url = os.environ.get("TEST_DATABASE_URL")
    if not test_database_url:
        pytest.fail("TEST_DATABASE_URL is required for database integration tests")

    schema = f"testdeck_test_{uuid4().hex}"
    administrative_engine = create_engine(test_database_url)
    with administrative_engine.begin() as connection:
        connection.execute(CreateSchema(schema))

    isolated_engine = None

    try:
        isolated_url = make_url(test_database_url).update_query_dict(
            {"options": f"-csearch_path={schema}"}
        )
        isolated_database_url = isolated_url.render_as_string(hide_password=False)
        alembic_config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
        previous_database_url = os.environ.get("DATABASE_URL")
        isolated_engine = create_engine(isolated_url)

        with isolated_engine.connect() as connection:
            if inspect(connection).get_table_names():
                pytest.fail("isolated test schema must start empty")

        try:
            os.environ["DATABASE_URL"] = isolated_database_url
            command.upgrade(alembic_config, "head")
            command.upgrade(alembic_config, "head")
        finally:
            if previous_database_url is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = previous_database_url

        yield isolated_engine
    finally:
        if isolated_engine is not None:
            isolated_engine.dispose()
        try:
            with administrative_engine.begin() as connection:
                connection.execute(DropSchema(schema, cascade=True, if_exists=True))
        finally:
            administrative_engine.dispose()


@pytest.fixture
def db_session(migrated_database):
    connection = migrated_database.connect()
    transaction = connection.begin()
    session = Session(bind=connection, join_transaction_mode="create_savepoint")

    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        with TestClient(app) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def seeded_admin(db_session):
    admin = Admin(
        email="admin@example.test",
        password_hash=PasswordHasher().hash("test-password"),
    )
    db_session.add(admin)
    db_session.commit()
    return admin


@pytest.fixture
def authenticated_client(client, seeded_admin):
    login = client.post(
        "/api/auth/login",
        json={"email": seeded_admin.email, "password": "test-password"},
    )
    assert login.status_code == 200
    csrf_token = client.get("/api/auth/csrf").json()["csrf_token"]
    client.headers["X-CSRF-Token"] = csrf_token
    return client


@pytest.fixture
def csv_book():
    return (Path(__file__).parent / "fixtures" / "group14.csv").read_bytes()


@pytest.fixture
def make_group_case():
    def factory(session: Session, *, group_name: str, code: str) -> GroupCase:
        group_id = uuid4()
        group = Group(
            id=group_id,
            short_code=f"{group_name}-{group_id.hex[:6]}",
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


@pytest.fixture
def valid_png() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def upload_dir(tmp_path, monkeypatch) -> Path:
    directory = tmp_path / "uploads"
    directory.mkdir()
    monkeypatch.setattr(
        screenshots, "settings", replace(settings, upload_dir=str(directory))
    )
    return directory


@pytest.fixture
def local_attempt(db_session, make_group_case) -> Attempt:
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    attempt = Attempt(
        group_case=group_case,
        label="B-001",
        sequence=1,
        state="committed",
        result="不通过",
        note="binding failed",
        idempotency_key="fixture-attempt-1",
    )
    db_session.add(attempt)
    db_session.commit()
    return attempt


@pytest.fixture
def attempt_id(local_attempt) -> UUID:
    return local_attempt.id


@pytest.fixture
def anonymous_client(db_session) -> TestClient:
    previous_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        with TestClient(app) as test_client:
            test_client.cookies.clear()
            yield test_client
    finally:
        if previous_override is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous_override
