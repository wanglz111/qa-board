from fastapi import FastAPI, Response, status
from app.config import settings
from sqlalchemy.exc import SQLAlchemyError

from app.auth import router as auth_router
from app.db import database_is_ready


app = FastAPI(title="TestDeck")
app.include_router(auth_router)
@app.middleware("http")
async def csrf_guard(request, call_next):
    if request.method in {"POST", "PUT", "DELETE", "PATCH"} and request.url.path not in {"/api/auth/login", "/api/auth/register"} and request.cookies.get("testdeck_session"):
        from fastapi.responses import JSONResponse
        import hmac
        from app.auth import _digest
        expected = _digest(request.cookies["testdeck_session"], settings.csrf_secret)
        supplied = request.headers.get("X-CSRF-Token")
        if supplied is None or not hmac.compare_digest(supplied, expected):
            return JSONResponse({"detail": "Invalid CSRF token"}, status_code=403)
    return await call_next(request)


@app.get("/health/live")
def live() -> dict[str, bool]:
    return {"ok": True}


@app.get("/health/ready")
def ready(response: Response) -> dict[str, bool]:
    try:
        is_ready = database_is_ready()
    except SQLAlchemyError:
        is_ready = False

    if not is_ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"ok": is_ready}
