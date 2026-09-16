from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session

from app.config import settings


DATABASE_CONNECT_TIMEOUT_SECONDS = 3
DATABASE_STATEMENT_TIMEOUT_MILLISECONDS = 3_000
DATABASE_POOL_TIMEOUT_SECONDS = 3


def create_database_engine(database_url: str) -> Engine:
    configured_options = make_url(database_url).query.get("options", "")
    statement_timeout = (
        f"-c statement_timeout={DATABASE_STATEMENT_TIMEOUT_MILLISECONDS}"
    )
    postgres_options = " ".join(
        option for option in (configured_options, statement_timeout) if option
    )
    return create_engine(
        database_url,
        connect_args={
            "connect_timeout": DATABASE_CONNECT_TIMEOUT_SECONDS,
            "options": postgres_options,
        },
        pool_pre_ping=True,
        pool_timeout=DATABASE_POOL_TIMEOUT_SECONDS,
    )


engine = create_database_engine(settings.database_url)


def get_db() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


def database_is_ready() -> bool:
    with engine.connect() as connection:
        return connection.execute(text("SELECT 1")).scalar_one() == 1
