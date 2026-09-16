import os
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
    "group_cases",
    "groups",
    "import_tickets",
    "screenshots",
}


def test_empty_test_schema_upgrades_to_head_twice(migrated_database):
    with migrated_database.connect() as connection:
        assert set(inspect(connection).get_table_names()) == EXPECTED_TABLES
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            "0004_attempts"
        )


def test_alembic_revision_template_is_available():
    template = Path(__file__).parents[1] / "alembic" / "script.py.mako"

    assert template.is_file()


@pytest.fixture
def database_at_0002():
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
            command.upgrade(config, "0002_admin_sessions")
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

    config = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    previous_database_url = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = database_at_0002.url.render_as_string(
        hide_password=False
    )
    try:
        with pytest.raises(RuntimeError, match="singleton migration requires <=1 admin"):
            command.upgrade(config, "head")
    finally:
        if previous_database_url is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous_database_url

    with database_at_0002.connect() as connection:
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            "0002_admin_sessions"
        )
        assert "singleton_key" not in {
            column["name"] for column in inspect(connection).get_columns("admins")
        }
