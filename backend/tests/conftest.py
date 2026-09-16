import os


os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://testdeck:testdeck@127.0.0.1:5433/testdeck_test",
)
os.environ.setdefault("ADMIN_EMAIL", "admin@example.test")
os.environ.setdefault("ADMIN_PASSWORD", "test-password")
os.environ.setdefault("SESSION_SECRET", "test-only-session-secret-32-characters")
os.environ.setdefault("CSRF_SECRET", "test-only-csrf-secret-32-characters")
