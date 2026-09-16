from sqlalchemy import create_engine, text

from app.config import settings


engine = create_engine(settings.database_url, pool_pre_ping=True)


def database_is_ready() -> bool:
    with engine.connect() as connection:
        return connection.execute(text("SELECT 1")).scalar_one() == 1
