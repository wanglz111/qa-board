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
    # 负责人 and 报告人 are person columns in every run table this tool builds,
    # and a person column accepts nothing but an open id. A legacy table built by
    # hand may still carry them as text, so the writer decides per table from the
    # schema fingerprint stored with that group's target: a person column gets a
    # configured open id, a text column keeps the display name it always had.
    # DEFAULT_OWNER/DEFAULT_REPORTER only ever feed a text column — a person
    # column nobody holds an id for is left out of the request entirely, which
    # still writes the row.
    default_owner: str = "待指派"
    default_reporter: str = ""
    # The fallback for a deployment whose settings page has never been filled in.
    # What the page saves lives in the lark_people row and takes precedence over
    # this value, so it is no longer the only source of the reporter's open id.
    # Empty means "no id is known": a person-typed 报告人/反馈人 is then left
    # out, while a legacy text column still receives the display name.
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
