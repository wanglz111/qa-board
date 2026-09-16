from fastapi import FastAPI, Response, status
from sqlalchemy.exc import SQLAlchemyError

from app.db import database_is_ready


app = FastAPI(title="TestDeck")


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
