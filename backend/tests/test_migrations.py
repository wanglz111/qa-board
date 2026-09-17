import os
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema


EXPECTED_TABLES = {
    "admin_sessions",
    "admins",
    "alembic_version",
    "attempts",
    "case_reference_assets",
    "case_reference_links",
    "group_cases",
    "groups",
    "import_tickets",
    "lark_history_refs",
    "lark_target_revisions",
    "lark_targets",
    "reconcile_marks",
    "screenshots",
    "sync_jobs",
}


def test_empty_test_schema_upgrades_to_head_twice(migrated_database):
    with migrated_database.connect() as connection:
        assert set(inspect(connection).get_table_names()) == EXPECTED_TABLES
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            "0012_sync_job_last_error"
        )
        assert "target_fingerprint" in {
            column["name"] for column in inspect(connection).get_columns("sync_jobs")
        }
        # The reason a job failed has to survive a restart, so it is a column of
        # the row and not a log line.
        assert "last_error" in {
            column["name"] for column in inspect(connection).get_columns("sync_jobs")
        }
        assert "source" in {
            column["name"] for column in inspect(connection).get_columns("attempts")
        }
        assert "ck_attempts_source" in {
            constraint["name"]
            for constraint in inspect(connection).get_check_constraints("attempts")
        }


def test_alembic_revision_template_is_available():
    template = Path(__file__).parents[1] / "alembic" / "script.py.mako"

    assert template.is_file()


@contextmanager
def _database_at(revision: str):
    test_database_url = os.environ["TEST_DATABASE_URL"]
    schema = f"testdeck_migration_{uuid4().hex}"
    administrative_engine = create_engine(test_database_url)
    isolated_engine = None
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))

    with administrative_engine.begin() as connection:
        connection.execute(CreateSchema(schema))
    try:
        isolated_url = make_url(test_database_url).update_query_dict(
            {"options": f"-csearch_path={schema}"}
        )
        isolated_engine = create_engine(isolated_url)
        previous_database_url = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = isolated_url.render_as_string(hide_password=False)
        try:
            command.upgrade(config, revision)
            yield isolated_engine
        finally:
            if previous_database_url is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = previous_database_url
    finally:
        if isolated_engine is not None:
            isolated_engine.dispose()
        with administrative_engine.begin() as connection:
            connection.execute(DropSchema(schema, cascade=True, if_exists=True))
        administrative_engine.dispose()


@pytest.fixture
def database_at_0002():
    with _database_at("0002_admin_sessions") as engine:
        yield engine


@pytest.fixture
def database_at_0004():
    with _database_at("0004_attempts") as engine:
        yield engine


def _upgrade_to_head(engine) -> None:
    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    previous_database_url = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = engine.url.render_as_string(hide_password=False)
    try:
        command.upgrade(config, "head")
    finally:
        if previous_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_database_url


def test_singleton_migration_rejects_multiple_admins_without_schema_change(
    database_at_0002,
):
    with database_at_0002.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO admins (id, email, password_hash) "
                "VALUES (:id, :email, :password)"
            ),
            [
                {"id": uuid4(), "email": "one@example.test", "password": "hash"},
                {"id": uuid4(), "email": "two@example.test", "password": "hash"},
            ],
        )

    with pytest.raises(RuntimeError, match="singleton migration requires <=1 admin"):
        _upgrade_to_head(database_at_0002)

    with database_at_0002.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            "0002_admin_sessions"
        )
        assert "singleton_key" not in {
            column["name"] for column in inspect(connection).get_columns("admins")
        }


def test_short_code_backfill_keeps_existing_groups_addressable(database_at_0004):
    group_id = uuid4()
    with database_at_0004.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO groups "
                "(id, name, source_name, source_sha256, source_format, source_version) "
                "VALUES (:id, :name, :source_name, :sha256, 'csv', '1')"
            ),
            {
                "id": group_id,
                "name": "0918 登录回归",
                "source_name": "0918.csv",
                "sha256": "0" * 64,
            },
        )

    _upgrade_to_head(database_at_0004)

    with database_at_0004.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            "0012_sync_job_last_error"
        )
        assert connection.scalar(
            text("SELECT short_code FROM groups WHERE id = :id"), {"id": group_id}
        ) == f"0918-{group_id.hex[:6]}"
        assert "uq_groups_short_code" in {
            constraint["name"]
            for constraint in inspect(connection).get_unique_constraints("groups")
        }


def test_reference_asset_tables_are_created(migrated_database):
    with migrated_database.connect() as connection:
        assets = {
            column["name"]
            for column in inspect(connection).get_columns("case_reference_assets")
        }
        assert assets == {
            "id",
            "group_id",
            "asset_key",
            "name",
            "storage_key",
            "mime",
            "size_bytes",
            "width",
            "height",
            "asset_type",
            "screen",
            "state",
            "source_path",
            "prototype_version",
            "created_at",
        }
        links = {
            column["name"]
            for column in inspect(connection).get_columns("case_reference_links")
        }
        assert links == {
            "id",
            "group_case_id",
            "asset_id",
            "role",
            "caption",
            "focus",
            "sort_order",
            "created_at",
        }
        assert "uq_case_reference_asset_key" in {
            constraint["name"]
            for constraint in inspect(connection).get_unique_constraints(
                "case_reference_assets"
            )
        }
        case_columns = {
            column["name"]
            for column in inspect(connection).get_columns("group_cases")
        }
        assert {"prototype_note", "expect_absent", "visual_check"} <= case_columns
