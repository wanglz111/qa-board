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
    lark_app_token: str = ""
    lark_bug_app_token: str = ""
    lark_table_runs: str = ""
    lark_table_defects: str = ""

    @property
    def lark_table_records(self) -> str:
        return self.lark_table_runs

    @property
    def lark_table_bugs(self) -> str:
        return self.lark_table_defects


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
    lark_base_url=os.environ.get("LARK_BASE_URL") or "https://open.feishu.cn",
    lark_app_id=os.environ.get("LARK_APP_ID") or "",
    lark_app_secret=os.environ.get("LARK_APP_SECRET") or "",
    lark_app_token=os.environ.get("LARK_APP_TOKEN") or os.environ.get("LARK_BUG_APP_TOKEN") or "",
    lark_bug_app_token=os.environ.get("LARK_BUG_APP_TOKEN") or os.environ.get("LARK_APP_TOKEN") or "",
    lark_table_runs=os.environ.get("LARK_TABLE_RUNS") or os.environ.get("LARK_TABLE_RECORDS") or "",
    lark_table_defects=os.environ.get("LARK_TABLE_DEFECTS") or os.environ.get("LARK_TABLE_BUGS") or "",
)
