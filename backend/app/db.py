from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from app.config import settings


DATABASE_CONNECT_TIMEOUT_SECONDS = 3
DATABASE_STATEMENT_TIMEOUT_MILLISECONDS = 3_000
DATABASE_POOL_TIMEOUT_SECONDS = 3


def create_database_engine(database_url: str) -> Engine:
    return create_engine(
        database_url,
        connect_args={
            "connect_timeout": DATABASE_CONNECT_TIMEOUT_SECONDS,
            "options": (
                f"-c statement_timeout={DATABASE_STATEMENT_TIMEOUT_MILLISECONDS}"
            ),
        },
        pool_pre_ping=True,
        pool_timeout=DATABASE_POOL_TIMEOUT_SECONDS,
    )


engine = create_database_engine(settings.database_url)


def database_is_ready() -> bool:
    with engine.connect() as connection:
        return connection.execute(text("SELECT 1")).scalar_one() == 1
