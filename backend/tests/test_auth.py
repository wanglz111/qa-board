from datetime import datetime, timedelta, timezone

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import get_db
from app.main import app
from app.models import Admin, AdminSession


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


def test_admin_login_cookie_and_no_registration(client, seeded_admin):
    login = client.post(
        "/api/auth/login",
        json={"email": "admin@example.test", "password": "test-password"},
    )
    assert login.status_code == 200
    assert "httponly" in login.headers["set-cookie"].lower()
    assert client.get("/api/auth/me").json() == {"email": "admin@example.test"}
    assert client.post("/api/auth/register", json={}).status_code == 404


def test_protected_access_requires_a_session(client):
    response = client.get("/api/auth/me")

    assert response.status_code == 401


def test_login_rejects_wrong_password_without_creating_session(
    client, seeded_admin, db_session
):
    response = client.post(
        "/api/auth/login",
        json={"email": seeded_admin.email, "password": "wrong-password"},
    )

    assert response.status_code == 401
    assert db_session.scalars(select(AdminSession)).all() == []


def test_login_rejects_cross_origin_request(client, seeded_admin):
    response = client.post(
        "/api/auth/login",
        headers={"Origin": "https://attacker.example"},
        json={"email": seeded_admin.email, "password": "test-password"},
    )

    assert response.status_code == 403


def test_https_login_cookie_has_security_flags(db_session, seeded_admin):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        with TestClient(app, base_url="https://testserver") as https_client:
            response = https_client.post(
                "/api/auth/login",
                json={"email": seeded_admin.email, "password": "test-password"},
            )
    finally:
        app.dependency_overrides.clear()

    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "secure" in cookie


def test_logout_requires_csrf_and_invalidates_server_session(
    client, seeded_admin, db_session
):
    login = client.post(
        "/api/auth/login",
        json={"email": seeded_admin.email, "password": "test-password"},
    )
    assert login.status_code == 200

    rejected = client.post("/api/auth/logout")
    assert rejected.status_code == 403
    assert client.get("/api/auth/me").status_code == 200

    csrf_token = client.get("/api/auth/csrf").json()["csrf_token"]
    logout = client.post(
        "/api/auth/logout", headers={"X-CSRF-Token": csrf_token}
    )

    assert logout.status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert db_session.scalars(select(AdminSession)).all() == []


def test_expired_session_is_rejected_and_deleted(client, seeded_admin, db_session):
    client.post(
        "/api/auth/login",
        json={"email": seeded_admin.email, "password": "test-password"},
    )
    admin_session = db_session.scalar(select(AdminSession))
    admin_session.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.commit()

    response = client.get("/api/auth/me")

    assert response.status_code == 401
    assert db_session.scalars(select(AdminSession)).all() == []
