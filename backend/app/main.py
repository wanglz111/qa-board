from fastapi import Depends, FastAPI, Response, status
from sqlalchemy.exc import SQLAlchemyError

from app.auth import require_csrf_for_mutation, router as auth_router
from app.db import database_is_ready
from app.execution import router as execution_router
from app.groups import router as groups_router
from app.screenshots import router as screenshots_router


app = FastAPI(title="TestDeck", dependencies=[Depends(require_csrf_for_mutation)])
app.include_router(auth_router)
app.include_router(groups_router)
app.include_router(execution_router)
app.include_router(screenshots_router)


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
