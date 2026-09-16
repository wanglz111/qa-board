from pathlib import Path

from sqlalchemy import inspect, text


EXPECTED_TABLES = {
    "admin_sessions",
    "admins",
    "alembic_version",
    "group_cases",
    "groups",
    "import_tickets",
}


def test_empty_test_schema_upgrades_to_head_twice(migrated_database):
    with migrated_database.connect() as connection:
        assert set(inspect(connection).get_table_names()) == EXPECTED_TABLES
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == (
            "0003_admin_singleton"
        )


def test_alembic_revision_template_is_available():
    template = Path(__file__).parents[1] / "alembic" / "script.py.mako"

    assert template.is_file()
