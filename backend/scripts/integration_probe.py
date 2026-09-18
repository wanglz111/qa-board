"""端到端集成探针：真 uvicorn + 真 Postgres，全部走 HTTP。

跑在一个一次性的 schema 里（用完即 drop），所以它检的是**服务端真实代码**，
不是 mock。用来把几条只靠读码得出的结论钉成实测：

  F4  同组 + 同载荷 + 同 key        -> 返回已存的那一行，不新增（幂等键的设计意图）
  O1  同一个 key 换到另一个组        -> 409 `Idempotency key conflict`（不是静默无操作）
  O1  带上 group 的 key             -> 第二个组正常落库
  O10 已提交的预留 + 同载荷重试      -> 幂等，返回同一条
  O10 已提交的预留 + 改载荷重试      -> 409 `Attempt is already committed`（UI 不该邀请这种重试）
  O10 该用例的 committed 行数        -> 仍为 1，没有多写一行
  O8  没人提交的预留                -> 停在 `started` 且列表里看不到（没有清理路径）
  O11 同一张图上传两次              -> 只留一行一个文件（重传是重放，不是重复）

用法（本地测试库必须先起来）：

    docker start testdeck-task2-postgres
    backend/.venv/bin/python backend/scripts/integration_probe.py

环境变量：`ITEST_DATABASE_URL`（默认本地 testdeck_test）、`ITEST_PORT`（默认 8899）。
脚本不会碰生产库、不发任何 Lark 请求（探针里的测试组从未确认过 Lark 目标，
`enqueue_attempt_job` 对未确认的组直接返回 None）。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import uuid
from io import BytesIO
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
BASE_DB = os.environ.get(
    "ITEST_DATABASE_URL",
    "postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test",
)
SCHEMA = f"itest_{uuid.uuid4().hex[:10]}"
PORT = int(os.environ.get("ITEST_PORT", "8899"))
API = f"http://127.0.0.1:{PORT}"
UPLOADS = Path("/tmp/itest-uploads")
ADMIN_EMAIL = "itest-admin@example.test"
ADMIN_PASSWORD = "itest-password"

os.chdir(BACKEND)
sys.path.insert(0, str(BACKEND))

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}\n      {detail}", flush=True)


def png_bytes() -> bytes:
    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (12, 12), (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


isolated = make_url(BASE_DB).update_query_dict({"options": f"-csearch_path={SCHEMA}"})
ISOLATED_DB = isolated.render_as_string(hide_password=False)

os.environ["DATABASE_URL"] = ISOLATED_DB
os.environ["ADMIN_EMAIL"] = ADMIN_EMAIL
os.environ["ADMIN_PASSWORD"] = ADMIN_PASSWORD
os.environ["SESSION_SECRET"] = "itest-session-secret-32-characters-ok"
os.environ["CSRF_SECRET"] = "itest-csrf-secret-32-characters-okay"
os.environ["UPLOAD_DIR"] = str(UPLOADS)
os.environ.setdefault("SESSION_COOKIE_SECURE", "false")

admin_engine = create_engine(BASE_DB, isolation_level="AUTOCOMMIT")
with admin_engine.connect() as connection:
    connection.execute(text(f'CREATE SCHEMA "{SCHEMA}"'))
print(f"schema {SCHEMA} created in {BASE_DB.rsplit('/', 1)[-1]}", flush=True)

server: subprocess.Popen[bytes] | None = None
try:
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config(str(BACKEND / "alembic.ini")), "head")
    print("alembic upgrade head: ok", flush=True)

    from app.bootstrap import bootstrap
    from app.config import settings
    from app.db import engine
    from app.models import Attempt, Group, GroupCase

    with Session(engine) as session:
        bootstrap(session, settings)
        group_one = Group(
            id=uuid.uuid4(),
            short_code=f"IT1-{uuid.uuid4().hex[:6]}",
            name="itest-group-1",
            source_name="itest1.csv",
            source_sha256="0" * 64,
            source_format="test",
            source_version="1",
        )
        group_two = Group(
            id=uuid.uuid4(),
            short_code=f"IT2-{uuid.uuid4().hex[:6]}",
            name="itest-group-2",
            source_name="itest2.csv",
            source_sha256="0" * 64,
            source_format="test",
            source_version="1",
        )
        session.add_all([group_one, group_two])
        session.flush()
        session.add_all(
            [
                GroupCase(group=group_one, code="B-001", position=1, title="组一 B-001", raw={"code": "B-001"}),
                GroupCase(group=group_one, code="B-002", position=2, title="组一 B-002", raw={"code": "B-002"}),
                GroupCase(group=group_two, code="B-001", position=1, title="组二 B-001", raw={"code": "B-001"}),
            ]
        )
        session.commit()
        G1, G2 = str(group_one.id), str(group_two.id)
    print("seeded admin + 2 groups (both holding B-001) + B-002 in group 1", flush=True)

    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(PORT),
            "--log-level",
            "warning",
        ],
        cwd=BACKEND,
        env=dict(os.environ),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    import httpx

    ready = False
    for _ in range(60):
        if server.poll() is not None:
            break
        try:
            if httpx.get(f"{API}/health/ready", timeout=2.0).status_code == 200:
                ready = True
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    if not ready:
        output = server.stdout.read().decode()[-2000:] if server.stdout else ""
        print("server did not become ready:\n" + output, flush=True)
        raise SystemExit(2)
    print(f"uvicorn ready on {API}\n", flush=True)

    def new_key() -> str:
        return uuid.uuid4().hex

    with httpx.Client(base_url=API, timeout=20.0) as client:
        login = client.post(
            "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
        )
        check("login", login.status_code == 200, f"status={login.status_code} {login.text[:120]}")
        client.headers["X-CSRF-Token"] = client.get("/api/auth/csrf").json()["csrf_token"]

        # --- F4: replaying the identical save inside one group
        replay = {"result": "未执行", "note": None, "console_text": None, "idempotency_key": new_key()}
        first = client.post(f"/api/groups/{G1}/cases/B-001/attempts", json=replay)
        second = client.post(f"/api/groups/{G1}/cases/B-001/attempts", json=replay)
        check(
            "F4 / same group + same payload + same key returns the stored row",
            first.status_code == 201
            and second.status_code == 201
            and first.json()["id"] == second.json()["id"],
            f"first={first.status_code}:{first.json().get('id')} "
            f"second={second.status_code}:{second.json().get('id')}",
        )

        # --- O1: that key reused by another group
        cross = client.post(f"/api/groups/{G2}/cases/B-001/attempts", json=replay)
        check(
            "O1 / the same key in another group answers 409, not a silent no-op",
            cross.status_code == 409,
            f"status={cross.status_code} body={cross.text[:140]}",
        )

        scoped = client.post(
            f"/api/groups/{G2}/cases/B-001/attempts",
            json={**replay, "idempotency_key": new_key()},
        )
        check(
            "O1 / a group-scoped key stores in the second group",
            scoped.status_code == 201,
            f"status={scoped.status_code} body={scoped.text[:100]}",
        )

        # --- O10: a reservation that is submitted, then retried
        reserved = client.post(f"/api/groups/{G1}/cases/B-002/retest").json()
        attempt_id = reserved["id"]
        resume = {"result": "通过", "note": None, "console_text": None, "idempotency_key": new_key()}
        commit_one = client.post(f"/api/attempts/{attempt_id}/submit", json=resume)
        commit_two = client.post(f"/api/attempts/{attempt_id}/submit", json=resume)
        check(
            "O10 / same payload retry on a committed reservation is idempotent",
            commit_one.status_code == 200
            and commit_two.status_code == 200
            and commit_one.json()["id"] == commit_two.json()["id"],
            f"first={commit_one.status_code} second={commit_two.status_code} "
            f"same_id={commit_one.json().get('id') == commit_two.json().get('id')}",
        )

        edited = {**resume, "note": "改了说明", "idempotency_key": new_key()}
        commit_three = client.post(f"/api/attempts/{attempt_id}/submit", json=edited)
        check(
            "O10 / an edited payload retry answers 409 (never a success)",
            commit_three.status_code == 409,
            f"status={commit_three.status_code} body={commit_three.text[:140]}",
        )

        listed = client.get(f"/api/groups/{G1}/cases/B-002/attempts").json()
        check(
            "O10 / no duplicate row was appended for the reservation",
            len(listed) == 1,
            f"committed rows for B-002 = {len(listed)}",
        )

        # --- O11: the same image twice (a replay now, not a duplicate)
        image = png_bytes()
        upload_one = client.post(
            f"/api/attempts/{attempt_id}/screenshots",
            files={"image": ("same.png", image, "image/png")},
        )
        upload_two = client.post(
            f"/api/attempts/{attempt_id}/screenshots",
            files={"image": ("same.png", image, "image/png")},
        )
        files_on_disk = sorted(p.name for p in UPLOADS.iterdir()) if UPLOADS.exists() else []
        check(
            "O11 / the same bytes uploaded twice for one attempt are stored once",
            upload_one.status_code == 201
            and upload_two.status_code == 201
            and upload_one.json()["id"] == upload_two.json()["id"]
            and len(files_on_disk) == 1,
            f"first={upload_one.status_code} second={upload_two.status_code} "
            f"same_row={upload_one.json().get('id') == upload_two.json().get('id')} "
            f"files={len(files_on_disk)}",
        )

        # --- O8: a reservation nobody ever submits
        orphan = client.post(f"/api/groups/{G1}/cases/B-002/retest").json()
        with Session(engine) as session:
            orphan_row = session.scalar(select(Attempt).where(Attempt.id == uuid.UUID(orphan["id"])))
            state = orphan_row.state
        visible = [row["id"] for row in client.get(f"/api/groups/{G1}/cases/B-002/attempts").json()]
        check(
            "O8 / an abandoned reservation stays started and is invisible to the list",
            state == "started" and orphan["id"] not in visible,
            f"state={state} listed={orphan['id'] in visible}",
        )
finally:
    if server is not None:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
    with admin_engine.connect() as connection:
        connection.execute(text(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))
    admin_engine.dispose()
    shutil.rmtree(UPLOADS, ignore_errors=True)
    print(f"\nschema {SCHEMA} dropped, uploads removed", flush=True)

failed = [name for name, ok, _ in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} probes passed", flush=True)
for name in failed:
    print(f"  FAILED: {name}", flush=True)
raise SystemExit(1 if failed else 0)
