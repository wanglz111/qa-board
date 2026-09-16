from fastapi import Depends, FastAPI, Response, status
from sqlalchemy.exc import SQLAlchemyError

from app.auth import require_csrf_for_mutation, router as auth_router
from app.case_assets import router as case_assets_router
from app.db import database_is_ready
from app.execution import router as execution_router
from app.groups import router as groups_router
from app.lark.history import router as lark_router
from app.lark.outbox import router as lark_outbox_router
from app.lark.provision import router as lark_provision_router
from app.lark.reconcile import router as lark_reconcile_router
from app.lark.target import router as lark_target_router
from app.prompts import router as prompts_router
from app.reports import router as reports_router
from app.screenshots import router as screenshots_router


app = FastAPI(title="TestDeck", dependencies=[Depends(require_csrf_for_mutation)])
app.include_router(auth_router)
app.include_router(case_assets_router)
app.include_router(groups_router)
app.include_router(execution_router)
app.include_router(screenshots_router)
app.include_router(reports_router)
app.include_router(lark_router)
app.include_router(lark_outbox_router)
app.include_router(lark_target_router)
app.include_router(lark_provision_router)
app.include_router(lark_reconcile_router)
app.include_router(prompts_router)


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
