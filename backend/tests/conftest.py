import os
import json
from dataclasses import replace
from datetime import datetime, timezone
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
from app import case_assets, screenshots
from app.config import settings
from app.lark import client as lark_client_module
from app.lark.client import LarkClient, get_lark_client
from app.lark.fields import REQUIRED_BUG_FIELD_TYPES, REQUIRED_RUN_FIELD_TYPES
from app.lark.history import history_for
from app.lark.target import TargetDraft
from app.lark.write import HttpLarkWriteGateway
from app.models import (
    Admin,
    Attempt,
    Group,
    GroupCase,
    LarkHistoryRef,
    LarkTarget,
)


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
        self.wiki_nodes: dict[str, dict[str, Any]] = {}
        self.wiki_error = False
        self.wiki_url = "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs&view=vew-main"
        # Every base the double knows: name plus its (table_id, table_name) pairs.
        # `app-token` is the legacy base the history and outbox suites read.
        self.bases = {
            "app-exec": ("执行库", [("tbl-runs", "执行记录"), ("tbl-bugs", "缺陷记录")]),
            "app-bug": ("缺陷库", [("tbl-defects", "缺陷记录")]),
            "app-token": ("旧版测试管理", [("tbl-runs", "执行记录"), ("tbl-defects", "缺陷记录")]),
        }
        # Which schema each (base, table) pair answers with, so a two-base
        # implementation that reads the wrong base's table cannot pass.
        self.field_roles = {
            ("app-exec", "tbl-runs"): "run",
            ("app-token", "tbl-runs"): "run",
            ("app-exec", "tbl-bugs"): "bug",
            ("app-bug", "tbl-defects"): "bug",
            ("app-token", "tbl-defects"): "bug",
        }
        self.media: dict[str, tuple[bytes, str]] = {}
        self.requests: list[dict[str, str]] = []
        self.created_records: list[dict[str, Any]] = []
        self.created_fields: list[dict[str, Any]] = []
        self.created_views: list[dict[str, Any]] = []
        self.created_tables: list[dict[str, Any]] = []
        # Created views per (base, table), so a later listing of that table shows
        # them exactly like the live API would.
        self.views: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self.main_view = {"view_id": "vew-main", "view_name": "主视图", "view_type": "grid"}
        self.created_execution = 0
        self.created_bug = 0
        self.put_calls: list[str] = []
        self.delete_calls: list[str] = []
        self.old_bug_status = "待修复"
        self.timeout_after_create = False
        self.create_error = False
        self.fail_bug_create = False
        # An HTTP-level refusal from Lark, as a document the app may only read
        # answers one; None means the fake keeps creating tables normally.
        self.table_create_http_status: int | None = None
        self.hide_created_records = False
        self.media_unauthorized = False
        self.fields_error = False
        self.field_create_error = False
        self.client = LarkClient(
            base_url="https://open.feishu.test",
            app_id="test-app-id",
            app_secret="test-app-secret",
            transport=httpx.MockTransport(self.handle),
        )
        self._gateway = HttpLarkWriteGateway(
            self.client,
            run_app_token="app-token",
            run_table_id="tbl-runs",
            bug_app_token="app-token",
            bug_table_id="tbl-defects",
        )

    @property
    def record_methods(self) -> list[str]:
        return [call.method for call in self.client.calls if "/records" in call.path]

    @property
    def record_requests(self) -> list[dict[str, str]]:
        return [request for request in self.requests if "/records" in request["path"]]

    def history_for(self, code: str):
        return history_for(self.records, code)

    def read_history(self, code: str):
        """Read record history through the real client so the audit sees it."""

        self.client.list_records("app-token", "tbl-runs")
        return history_for(self.records, code)

    def _base(self, path: str) -> tuple[str, list[tuple[str, str]]] | None:
        if "/apps/" not in path:
            return None
        token = path.split("/apps/", 1)[1].split("/", 1)[0]
        return self.bases.get(token)

    def _base_token_and_table(self, path: str) -> tuple[str, str] | None:
        """The (base, table) pair a table-scoped path names, if both exist."""

        if "/apps/" not in path or "/tables/" not in path:
            return None
        base_token = path.split("/apps/", 1)[1].split("/", 1)[0]
        table_id = path.split("/tables/", 1)[1].split("/", 1)[0]
        base = self.bases.get(base_token)
        if base is None or table_id not in {listed for listed, _ in base[1]}:
            return None
        return base_token, table_id

    # The worker only needs this create-only surface, so the double speaks it.
    def create_execution(self, fields: dict[str, Any]) -> str:
        return self._gateway.create_execution(fields)

    def create_bug(self, fields: dict[str, Any]) -> str:
        return self._gateway.create_bug(fields)

    def find_execution_ids(self, fields: dict[str, Any]) -> list[str]:
        return self._gateway.find_execution_ids(fields)

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append({"method": request.method, "path": path})
        if request.method in ("PUT", "PATCH", "DELETE"):
            if request.method == "DELETE":
                self.delete_calls.append(path)
            else:
                self.put_calls.append(path)
            return httpx.Response(405, json={"code": 1, "msg": "legacy rows are read-only"})
        if path == "/open-apis/auth/v3/tenant_access_token/internal":
            return httpx.Response(200, json={"code": 0, "data": {"tenant_access_token": "fake-token"}})
        if path == "/open-apis/wiki/v2/spaces/get_node":
            if self.wiki_error:
                return httpx.Response(200, json={"code": 1770003, "msg": "no permission"})
            node = self.wiki_nodes.get(request.url.params["token"])
            if node is None:
                return httpx.Response(200, json={"code": 1770002, "msg": "node not found"})
            return httpx.Response(200, json={"code": 0, "data": {"node": node}})
        if "/medias/" in path and path.endswith("/download"):
            token = path.split("/medias/", 1)[1].removesuffix("/download")
            if self.media_unauthorized:
                return httpx.Response(401, json={"code": 1, "msg": "unauthorized"})
            if token not in self.media:
                return httpx.Response(404, json={"code": 1, "msg": "not found"})
            content, mime = self.media[token]
            return httpx.Response(200, content=content, headers={"content-type": mime})
        if path.endswith("/records") and request.method == "POST":
            body = json.loads(request.content or b"{}")
            is_bug = "tbl-defects" in path
            if (is_bug and self.fail_bug_create) or (not is_bug and self.create_error):
                if is_bug:
                    self.fail_bug_create = False
                else:
                    self.create_error = False
                return httpx.Response(500, json={"code": 1, "msg": "create failed"})
            record = {
                "record_id": f"new-{len(self.created_records) + 1}",
                "fields": body.get("fields", {}),
            }
            self.created_records.append(record)
            if is_bug:
                self.created_bug += 1
            else:
                self.created_execution += 1
                if not self.hide_created_records:
                    self.records.append(record)
            if self.timeout_after_create:
                self.timeout_after_create = False
                raise httpx.ReadTimeout("create timed out")
            return httpx.Response(200, json={"code": 0, "data": {"record": record}})
        if request.method == "POST" and path.endswith("/fields"):
            if self.field_create_error:
                # Lark answers a refusal with its own message and a non-zero code.
                return httpx.Response(
                    200, json={"code": 1254302, "msg": "no permission to create fields"}
                )
            pair = self._base_token_and_table(path)
            role = self.field_roles.get(pair) if pair else None
            if role is None:
                return httpx.Response(404, json={"code": 1, "msg": "unsupported table"})
            body = json.loads(request.content or b"{}")
            self.created_fields.append(
                {**body, "base_token": pair[0], "table_id": pair[1], "path": path}
            )
            # The new header has to appear in the next read of this table, so it
            # joins the same schema store the /fields listing answers from.
            store = self.bug_fields if role == "bug" else self.fields
            store.append({"field_name": body.get("field_name"), "type": body.get("type")})
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "field": {
                            "field_id": f"fld-{len(self.created_fields)}",
                            **body,
                        }
                    },
                },
            )
        if request.method == "POST" and path.endswith("/views"):
            pair = self._base_token_and_table(path)
            if pair is None:
                return httpx.Response(404, json={"code": 1, "msg": "unsupported table"})
            body = json.loads(request.content or b"{}")
            self.created_views.append(
                {**body, "base_token": pair[0], "table_id": pair[1], "path": path}
            )
            view = {
                "view_id": f"vew-created-{len(self.created_views)}",
                "view_name": body.get("view_name"),
                "view_type": body.get("view_type") or "grid",
            }
            self.views.setdefault(pair, [dict(self.main_view)]).append(view)
            return httpx.Response(200, json={"code": 0, "data": {"view": view}})
        if request.method == "POST" and path.endswith("/tables"):
            base = self._base(path)
            if base is None:
                return httpx.Response(404, json={"code": 1, "msg": "unsupported base"})
            if self.table_create_http_status is not None:
                return httpx.Response(
                    self.table_create_http_status,
                    json={"code": 91403, "msg": "Forbidden"},
                )
            base_token = path.split("/apps/", 1)[1].split("/", 1)[0]
            body = json.loads(request.content or b"{}")
            table = body.get("table") or {}
            self.created_tables.append({**table, "base_token": base_token, "path": path})
            # A created table really does show up in the base's listing afterwards.
            base[1].append(("tbl-new", str(table.get("name") or "")))
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "table": {
                            "table_id": "tbl-new",
                            "name": str(table.get("name") or ""),
                        }
                    },
                },
            )
        if path.endswith("/fields"):
            if self.fields_error:
                return httpx.Response(500, json={"code": 1, "msg": "fields unavailable"})
            role = self.field_roles.get(self._base_token_and_table(path))
            if role is None:
                return httpx.Response(404, json={"code": 1, "msg": "unsupported table"})
            fields = self.bug_fields if role == "bug" else self.fields
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
        if path.endswith("/tables"):
            # The real tenant answers a bare 404 for the single-table metadata
            # route, so names are resolved from this listing instead.
            base = self._base(path)
            if base is None:
                return httpx.Response(404, json={"code": 1, "msg": "unsupported base"})
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": (
                            [
                                {"table_id": table_id, "name": name}
                                for table_id, name in base[1]
                            ]
                        ),
                        "has_more": False,
                    },
                },
            )
        if path.endswith("/views"):
            pair = self._base_token_and_table(path)
            if pair is None:
                return httpx.Response(404, json={"code": 1, "msg": "unsupported table"})
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "items": self.views.get(pair, [dict(self.main_view)]),
                        "has_more": False,
                    },
                },
            )
        if "/tables/" in path:
            return httpx.Response(404, text="404 page not found")
        if "/apps/" in path:
            base = self._base(path)
            if base is None:
                return httpx.Response(404, json={"code": 1, "msg": "unsupported base"})
            return httpx.Response(200, json={"code": 0, "data": {"app": {"name": base[0]}}})
        return httpx.Response(404, json={"code": 1, "msg": "unsupported path"})


@pytest.fixture
def lark_fake(monkeypatch) -> FakeLark:
    fake = FakeLark()
    configured = replace(
        settings,
        lark_base_url="https://open.feishu.test",
        lark_app_id="test-app-id",
        lark_app_secret="test-app-secret",
    )
    monkeypatch.setattr(lark_client_module, "global_settings", configured)
    import app.lark.target as lark_target

    monkeypatch.setattr(lark_target, "settings", configured)
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
def fake_lark(lark_fake) -> FakeLark:
    """Alias used by the outbox tests for the same recording Lark double."""

    return lark_fake


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
def confirmed_group(db_session, imported_group) -> Group:
    draft = TargetDraft("app-exec", "tbl-runs", None, "app-bug", "tbl-defects")
    db_session.add(
        LarkTarget(
            group_id=imported_group.id,
            source_url="https://tenant.larksuite.com/wiki/node-1",
            execution_base_token="app-exec",
            execution_base_name="执行库",
            execution_table_id="tbl-runs",
            execution_table_name="执行记录",
            bug_base_token="app-bug",
            bug_base_name="缺陷库",
            bug_table_id="tbl-defects",
            bug_table_name="缺陷记录",
            schema_fingerprint="schema-fixture",
            target_fingerprint=draft.fingerprint,
            confirmed_at=datetime.now(timezone.utc),
        )
    )
    db_session.commit()
    return imported_group


@pytest.fixture
def unconfirmed_group(db_session) -> Group:
    group_id = uuid4()
    group = Group(
        id=group_id,
        short_code=f"0922-{group_id.hex[:6]}",
        name="Sprint 0922",
        source_name="0922.csv",
        source_sha256="2" * 64,
        source_format="csv",
        source_version="2",
    )
    db_session.add(
        GroupCase(
            group=group,
            code="B-001",
            position=1,
            title="钱包绑定",
            raw={"code": "B-001"},
        )
    )
    db_session.commit()
    return group


@pytest.fixture
def failed_attempt(db_session, confirmed_group) -> Attempt:
    group_case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == confirmed_group.id)
    )
    attempt = Attempt(
        group_case=group_case,
        label="B-001",
        sequence=1,
        state="committed",
        result="不通过",
        note="绑定未触发",
        console_text="wallet.bind timeout",
        idempotency_key="fixture-failed-1",
    )
    db_session.add(attempt)
    db_session.commit()
    return attempt


@pytest.fixture
def valid_png() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def upload_dir(tmp_path, monkeypatch) -> Path:
    directory = tmp_path / "uploads"
    directory.mkdir()
    patched = replace(settings, upload_dir=str(directory))
    monkeypatch.setattr(screenshots, "settings", patched)
    monkeypatch.setattr(case_assets, "settings", patched)
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
