# One image serves the API, the migration/bootstrap one-shot and the sync
# worker; only the command differs.
FROM python:3.12-slim-bookworm

ARG UV_VERSION=0.12.15

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH="/srv/.venv/bin:$PATH"

RUN pip install --no-cache-dir "uv==${UV_VERSION}"

WORKDIR /srv

# Install the locked dependencies before copying the sources so a code change
# does not invalidate the dependency layer.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
RUN uv sync --locked --no-dev

# The screenshots land on a persistent volume; the directory has to exist and
# be writable by the unprivileged runtime user on the very first start.
RUN useradd --create-home --uid 10001 testdeck \
    && mkdir -p /data/screenshots \
    && chown -R testdeck:testdeck /srv /data

USER testdeck
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health/live').read()"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
