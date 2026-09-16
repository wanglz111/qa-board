import os
import subprocess
from unittest.mock import MagicMock

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.bootstrap import bootstrap
from app.config import Settings
from app.models import Admin


def config(*, email="admin@example.test", password="test-password") -> Settings:
    return Settings(
        database_url="postgresql+psycopg://unused",
        admin_email=email,
        admin_password=password,
        session_secret="test-session-secret",
        csrf_secret="test-csrf-secret",
    )


def test_bootstrap_creates_argon2id_admin(db_session):
    admin = bootstrap(db_session, config())

    assert admin.email == "admin@example.test"
    assert admin.password_hash.startswith("$argon2id$")
    assert PasswordHasher().verify(admin.password_hash, "test-password")


def test_second_bootstrap_preserves_existing_admin_and_password_hash(db_session):
    first = bootstrap(db_session, config())
    original_hash = first.password_hash

    second = bootstrap(
        db_session,
        config(email="replacement@example.test", password="replacement-password"),
    )

    assert second.id == first.id
    assert second.email == "admin@example.test"
    assert second.password_hash == original_hash
    assert PasswordHasher().verify(second.password_hash, "test-password")
    assert db_session.scalar(select(func.count()).select_from(Admin)) == 1


def test_bootstrap_module_uses_configured_database_and_exits_zero(migrated_database):
    environment = os.environ.copy()
    environment["DATABASE_URL"] = migrated_database.url.render_as_string(
        hide_password=False
    )

    result = subprocess.run(
        [".venv/bin/python", "-m", "app.bootstrap"],
        cwd=os.path.dirname(os.path.dirname(__file__)),
        env={**environment, "PYTHONPATH": "."},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    with migrated_database.connect() as connection:
        assert connection.scalar(select(func.count()).select_from(Admin)) == 1

def test_admin_has_singleton_constraint(db_session):
    bootstrap(db_session, config())
    db_session.add(Admin(email="other@example.test", password_hash="x"))
    with pytest.raises(IntegrityError):
        db_session.commit()


def test_bootstrap_reraises_unrelated_integrity_error():
    session = MagicMock()
    session.scalar.return_value = None
    original = IntegrityError("insert", {}, RuntimeError("unrelated constraint"))
    session.commit.side_effect = original

    with pytest.raises(IntegrityError) as raised:
        bootstrap(session, config())

    assert raised.value is original
    session.rollback.assert_called_once_with()
