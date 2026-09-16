from fastapi.testclient import TestClient

from app.main import app


def test_liveness_does_not_disclose_configuration():
    response = TestClient(app).get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
