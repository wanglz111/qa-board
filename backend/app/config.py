import os
from dataclasses import dataclass


def _required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable is missing: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str
    admin_email: str
    admin_password: str
    session_secret: str
    csrf_secret: str
    upload_dir: str = "uploads"
    session_cookie_secure: bool = False
    session_ttl_seconds: int = 28_800
    lark_base_url: str = "https://open.feishu.cn"
    lark_app_id: str = ""
    lark_app_secret: str = ""
    # 负责人 and 报告人 are plain text columns in the verified run table, and the
    # hand-built rows carry the deployment's display names, not the sign-in
    # address the operator types at login. DEFAULT_OWNER/DEFAULT_REPORTER hold
    # those names so a generated row reads like a hand-run one.
    default_owner: str = "待指派"
    default_reporter: str = ""
    # The 反馈人 column of the verified defect table is a person column, and only
    # an open id is accepted there. Empty means "no id is known": the writer then
    # keeps 反馈人 as text so a legacy text column still receives the name.
    default_reporter_id: str = ""


def _environment_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


_ttl = int(os.environ.get("SESSION_TTL_SECONDS", "28800"))
if _ttl <= 0:
    raise RuntimeError("SESSION_TTL_SECONDS must be positive")


settings = Settings(
    database_url=_required_environment("DATABASE_URL"),
    admin_email=_required_environment("ADMIN_EMAIL"),
    admin_password=_required_environment("ADMIN_PASSWORD"),
    session_secret=_required_environment("SESSION_SECRET"),
    csrf_secret=_required_environment("CSRF_SECRET"),
    upload_dir=os.environ.get("UPLOAD_DIR") or "uploads",
    session_cookie_secure=_environment_flag("SESSION_COOKIE_SECURE"),
    session_ttl_seconds=_ttl,
    lark_base_url=os.environ.get("LARK_BASE_URL") or "https://open.larksuite.com",
    lark_app_id=os.environ.get("LARK_APP_ID") or "",
    lark_app_secret=os.environ.get("LARK_APP_SECRET") or "",
    default_owner=os.environ.get("DEFAULT_OWNER") or "待指派",
    default_reporter=os.environ.get("DEFAULT_REPORTER") or "",
    default_reporter_id=os.environ.get("DEFAULT_REPORTER_ID") or "",
)
