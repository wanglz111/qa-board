from argon2 import PasswordHasher
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.db import engine
from app.models import Admin


def bootstrap(session: Session, config: Settings) -> Admin:
    existing = session.scalar(select(Admin).limit(1))
    if existing is not None:
        return existing

    admin = Admin(
        email=config.admin_email,
        password_hash=PasswordHasher().hash(config.admin_password),
    )
    session.add(admin)
    session.commit()
    return admin


def main() -> None:
    with Session(engine) as session:
        bootstrap(session, settings)


if __name__ == "__main__":
    main()
