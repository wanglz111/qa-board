import os
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, func, inspect, select
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
from app.lark import client as lark_client_module
from app.lark.client import LarkClient, get_lark_client
from app.lark.fields import REQUIRED_BUG_FIELD_TYPES, REQUIRED_RUN_FIELD_TYPES
from app.lark.history import history_for
from app.models import Admin, Attempt, Group, GroupCase, LarkHistoryRef


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
def imported_group(db_session) -> Group:
    group_id = uuid4()
    group = Group(
        id=group_id,
        short_code=f"0918-{group_id.hex[:6]}",
        name="Sprint 0918",
        source_name="0918.csv",
        source_sha256="1" * 64,
        source_format="csv",
        source_version="3",
    )
    db_session.add(
        GroupCase(
            group=group,
            code="B-001",
            position=1,
            title="管理员登录",
            module="账户",
            priority="P0",
            raw={"code": "B-001"},
        )
    )
    db_session.commit()
    return group


@pytest.fixture
def add_case(db_session):
    def factory(group_id: UUID, *, code: str, title: str, **fields) -> GroupCase:
        last_position = db_session.scalar(
            select(func.max(GroupCase.position)).where(GroupCase.group_id == group_id)
        )
        group_case = GroupCase(
            group_id=group_id,
            code=code,
            position=(last_position or 0) + 1,
            title=title,
            raw={"code": code},
            **fields,
        )
        db_session.add(group_case)
        db_session.commit()
        return group_case

    return factory


class FakeLark:
    """In-process Lark API double that records every request it receives."""

    def __init__(self, *, page_size: int = 500) -> None:
        self.page_size = page_size
        self.records: list[dict[str, Any]] = []
        self.bug_records: list[dict[str, Any]] = []
        self.fields: list[dict[str, Any]] = [
            {"field_name": name, "type": types[0]}
            for name, types in REQUIRED_RUN_FIELD_TYPES.items()
        ]
        self.bug_fields: list[dict[str, Any]] = [
            {"field_name": name, "type": types[0]}
            for name, types in REQUIRED_BUG_FIELD_TYPES.items()
        ]
        self.base_name = "旧版测试管理"
        self.runs_table_name = "执行记录"
        self.defects_table_name = "缺陷记录"
        self.media: dict[str, tuple[bytes, str]] = {}
        self.requests: list[dict[str, str]] = []
        self.client = LarkClient(
            base_url="https://open.feishu.test",
            app_id="test-app-id",
            app_secret="test-app-secret",
            transport=httpx.MockTransport(self.handle),
        )

    @property
    def record_methods(self) -> list[str]:
        return [call.method for call in self.client.calls if "/records" in call.path]

    @property
    def record_requests(self) -> list[dict[str, str]]:
        return [request for request in self.requests if "/records" in request["path"]]

    def history_for(self, code: str):
        return history_for(self.records, code)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append({"method": request.method, "path": path})
        if path == "/open-apis/auth/v3/tenant_access_token/internal":
            return httpx.Response(200, json={"code": 0, "data": {"tenant_access_token": "fake-token"}})
        if "/medias/" in path and path.endswith("/download"):
            token = path.split("/medias/", 1)[1].removesuffix("/download")
            if token not in self.media:
                return httpx.Response(404, json={"code": 1, "msg": "not found"})
            content, mime = self.media[token]
            return httpx.Response(200, content=content, headers={"content-type": mime})
        if path.endswith("/fields"):
            fields = self.bug_fields if "tbl-defects" in path else self.fields
            return httpx.Response(200, json={"code": 0, "data": {"items": fields, "has_more": False}})
        if path.endswith("/records"):
            records = self.bug_records if "tbl-defects" in path else self.records
            offset = int(request.url.params.get("page_token") or 0)
            page = records[offset : offset + self.page_size]
            has_more = offset + self.page_size < len(records)
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": page,
                        "has_more": has_more,
                        "page_token": str(offset + self.page_size),
                    },
                },
            )
        if "/tables/" in path:
            table_id = path.rsplit("/", 1)[-1]
            name = self.defects_table_name if table_id == "tbl-defects" else self.runs_table_name
            return httpx.Response(200, json={"code": 0, "data": {"table": {"table_id": table_id, "name": name}}})
        if "/apps/" in path:
            return httpx.Response(200, json={"code": 0, "data": {"app": {"name": self.base_name}}})
        return httpx.Response(404, json={"code": 1, "msg": "unsupported path"})


@pytest.fixture
def lark_fake(monkeypatch) -> FakeLark:
    fake = FakeLark()
    configured = replace(
        settings,
        lark_base_url="https://open.feishu.test",
        lark_app_id="test-app-id",
        lark_app_secret="test-app-secret",
        lark_app_token="app-token",
        lark_bug_app_token="app-token",
        lark_table_runs="tbl-runs",
        lark_table_defects="tbl-defects",
    )
    monkeypatch.setattr(lark_client_module, "global_settings", configured)
    import app.lark.confirmation as lark_confirmation
    import app.lark.history as lark_history

    monkeypatch.setattr(lark_history, "settings", configured)
    monkeypatch.setattr(lark_confirmation, "settings", configured)
    previous = app.dependency_overrides.get(get_lark_client)
    app.dependency_overrides[get_lark_client] = lambda: fake.client
    try:
        yield fake
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_lark_client, None)
        else:
            app.dependency_overrides[get_lark_client] = previous


@pytest.fixture
def history_ref(db_session, imported_group) -> LarkHistoryRef:
    group_case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == imported_group.id)
    )
    reference = LarkHistoryRef(
        group_case_id=group_case.id,
        table_id="tbl-runs",
        old_record_id="old1",
        certainty="verified",
        snapshot={
            "用例": "B-001 Login",
            "结果": "不通过",
            "attachments": [
                {"file_token": "secret-file-token", "name": "../../old shot.png", "mime": "image/png"}
            ],
        },
    )
    db_session.add(reference)
    db_session.commit()
    return reference


@pytest.fixture
def known_table_names() -> dict[str, str]:
    return {
        "base_name": "旧版测试管理",
        "execution_table_name": "执行记录",
        "bug_table_name": "缺陷记录",
        "base_token": "app-token",
        "execution_table_id": "tbl-runs",
        "bug_table_id": "tbl-defects",
    }


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
