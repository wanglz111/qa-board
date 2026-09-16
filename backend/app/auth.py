from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
from typing import Annotated

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import get_db
from app.models import Admin, AdminSession


SESSION_COOKIE = "testdeck_session"
password_hasher = PasswordHasher()
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str


def _digest(value: str, secret: str) -> str:
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def _secure_cookie(request: Request) -> bool:
    return settings.session_cookie_secure or request.url.scheme == "https"


def _validate_login_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin is not None and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(status_code=403, detail="Invalid request origin")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(status_code=403, detail="Invalid request origin")


def current_session(
    db: Annotated[Session, Depends(get_db)],
    token: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> AdminSession:
    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")

    admin_session = db.scalar(
        select(AdminSession).where(
            AdminSession.token_hash == _digest(token, settings.session_secret)
        )
    )
    if admin_session is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if admin_session.expires_at <= datetime.now(timezone.utc):
        db.delete(admin_session)
        db.commit()
        raise HTTPException(status_code=401, detail="Session expired")
    return admin_session


def require_admin(
    admin_session: Annotated[AdminSession, Depends(current_session)],
) -> Admin:
    return admin_session.admin


def require_csrf(
    admin_session: Annotated[AdminSession, Depends(current_session)],
    csrf_token: Annotated[str | None, Header(alias="X-CSRF-Token")] = None,
) -> AdminSession:
    if csrf_token is None or not hmac.compare_digest(
        admin_session.csrf_token_hash,
        _digest(csrf_token, settings.csrf_secret),
    ):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
    return admin_session


@router.post("/login")
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    _validate_login_origin(request)
    admin = db.scalar(select(Admin).where(Admin.email == payload.email))
    try:
        if admin is None:
            raise VerificationError
        password_hasher.verify(admin.password_hash, payload.password)
    except VerificationError:
        raise HTTPException(status_code=401, detail="Invalid credentials") from None

    token = secrets.token_urlsafe(32)
    csrf_token = _digest(token, settings.csrf_secret)
    db.add(
        AdminSession(
            admin=admin,
            token_hash=_digest(token, settings.session_secret),
            csrf_token_hash=_digest(csrf_token, settings.csrf_secret),
            expires_at=datetime.now(timezone.utc)
            + timedelta(seconds=settings.session_ttl_seconds),
        )
    )
    db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=_secure_cookie(request),
        samesite="lax",
        max_age=settings.session_ttl_seconds,
        path="/",
    )
    return {"email": admin.email}


@router.get("/me")
def me(admin: Annotated[Admin, Depends(require_admin)]) -> dict[str, str]:
    return {"email": admin.email}


@router.get("/csrf")
def csrf(
    request: Request,
    admin_session: Annotated[AdminSession, Depends(current_session)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    raw_cookie = request.cookies.get(SESSION_COOKIE)
    if raw_cookie is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = _digest(raw_cookie, settings.csrf_secret)
    return {"csrf_token": token}


@router.post("/logout", status_code=204)
def logout(
    response: Response,
    request: Request,
    admin_session: Annotated[AdminSession, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    db.delete(admin_session)
    db.commit()
    response.delete_cookie(
        SESSION_COOKIE,
        httponly=True,
        secure=_secure_cookie(request),
        samesite="lax",
        path="/",
    )
