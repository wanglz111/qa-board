from pathlib import Path

from argon2 import PasswordHasher
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings, settings
from app.db import engine
from app.models import Admin


def ensure_upload_directory(config: Settings) -> Path:
    """Prepare the private screenshot volume before the API starts serving.

    Compose mounts a persistent volume for screenshots, so the directory has to
    exist and be writable on first start and survive every later restart.
    """

    directory = Path(config.upload_dir)
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise RuntimeError(
            f"Cannot prepare the upload directory {directory}: {error}"
        ) from error
    if not directory.is_dir():
        raise RuntimeError(f"The upload directory is not a directory: {directory}")
    return directory


def bootstrap(session: Session, config: Settings) -> Admin:
    ensure_upload_directory(config)

    # Restarting the container must never reset an existing administrator or
    # touch imported groups: the row is reused as-is.
    existing = session.scalar(select(Admin).where(Admin.singleton_key == 1))
    if existing is not None:
        return existing

    admin = Admin(
        email=config.admin_email,
        password_hash=PasswordHasher().hash(config.admin_password),
    )
    session.add(admin)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        concurrent_admin = session.scalar(
            select(Admin).where(Admin.singleton_key == 1)
        )
        if concurrent_admin is None:
            raise
        return concurrent_admin
    return admin


def main() -> None:
    with Session(engine) as session:
        bootstrap(session, settings)


if __name__ == "__main__":
    main()
