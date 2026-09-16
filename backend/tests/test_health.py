from unittest.mock import MagicMock, Mock

from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app import db
from app.main import app


def test_liveness_does_not_disclose_configuration():
    response = TestClient(app).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_database_engine_has_bounded_readiness_timeouts(monkeypatch):
    create_engine = Mock(return_value=object())
    monkeypatch.setattr(db, "create_engine", create_engine)

    created = db.create_database_engine(
        "postgresql+psycopg://user:password@database.example/testdeck"
    )

    assert created is create_engine.return_value
    create_engine.assert_called_once_with(
        "postgresql+psycopg://user:password@database.example/testdeck",
        connect_args={
            "connect_timeout": 3,
            "options": "-c statement_timeout=3000",
        },
        pool_pre_ping=True,
        pool_timeout=3,
    )


def test_database_readiness_executes_select_one(monkeypatch):
    connection = Mock()
    connection.execute.return_value.scalar_one.return_value = 1
    connection_context = MagicMock()
    connection_context.__enter__.return_value = connection
    isolated_engine = Mock()
    isolated_engine.connect.return_value = connection_context
    monkeypatch.setattr(db, "engine", isolated_engine)

    assert db.database_is_ready() is True
    assert str(connection.execute.call_args.args[0]) == "SELECT 1"


def test_readiness_success_has_exact_non_disclosing_response(monkeypatch):
    monkeypatch.setattr("app.main.database_is_ready", lambda: True)

    response = TestClient(app).get("/health/ready")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_readiness_database_error_has_exact_non_disclosing_response(monkeypatch):
    def database_error() -> bool:
        raise OperationalError(
            "SELECT 1",
            {},
            Exception("postgresql://admin:secret@database.example/testdeck"),
        )

    monkeypatch.setattr("app.main.database_is_ready", database_error)

    response = TestClient(app).get("/health/ready")

    assert response.status_code == 503
    assert response.json() == {"ok": False}
    assert "secret" not in response.text
    assert "database.example" not in response.text
