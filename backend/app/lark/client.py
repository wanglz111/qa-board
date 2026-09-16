from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from app.config import Settings, settings as global_settings


TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal"
PAGE_SIZE = 500

# Only these methods are ever allowed to touch Lark records. The record audit in
# tests asserts that no legacy row is created, updated or deleted.
RECORD_MUTATION_METHODS = ("POST", "PUT", "PATCH", "DELETE")


class LarkError(RuntimeError):
    """A Lark read failed; the message never contains credentials or tokens."""


class LarkTimeout(LarkError):
    """The write may or may not have reached Lark: never retried blindly."""


@dataclass(frozen=True)
class LarkCall:
    method: str
    path: str


def _is_record_path(path: str) -> bool:
    return "/records" in path


def build_lark_client(
    config: Settings | None = None,
    transport: httpx.BaseTransport | None = None,
) -> LarkClient:
    resolved = config or global_settings
    return LarkClient(
        base_url=resolved.lark_base_url,
        app_id=resolved.lark_app_id,
        app_secret=resolved.lark_app_secret,
        transport=transport,
    )


def get_lark_client() -> LarkClient:
    return build_lark_client()


class LarkClient:
    """Thin, auditable HTTPS client for the legacy Lark tables.

    Every call is recorded so tests can prove the adapter only reads: the token
    exchange is the single POST, and no request ever targets a record mutation.
    """

    def __init__(
        self,
        *,
        base_url: str,
        app_id: str,
        app_secret: str,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.app_id = app_id
        self.app_secret = app_secret
        self.calls: list[LarkCall] = []
        self._token: str | None = None
        self._client = httpx.Client(
            base_url=self.base_url, transport=transport, timeout=timeout
        )

    @property
    def record_methods(self) -> list[str]:
        return [call.method for call in self.calls if _is_record_path(call.path)]

    def close(self) -> None:
        self._client.close()

    def _token_value(self) -> str:
        if not self.app_id or not self.app_secret:
            raise LarkError("Lark credentials are not configured")
        if self._token is None:
            payload = self._send(
                "POST",
                TOKEN_PATH,
                json={"app_id": self.app_id, "app_secret": self.app_secret},
                authenticated=False,
            )
            token = payload.get("tenant_access_token")
            if not token:
                raise LarkError("Lark token exchange returned no token")
            self._token = str(token)
        return self._token

    def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        authenticated: bool = True,
    ) -> dict[str, Any]:
        # The one-time token exchange is recorded first so the audit log reflects
        # the real request order rather than the nested helper call.
        headers = {"Authorization": f"Bearer {self._token_value()}"} if authenticated else {}
        self.calls.append(LarkCall(method=method, path=path))
        try:
            response = self._client.request(
                method, path, params=params, json=json, headers=headers
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            # urllib-style messages can embed the request URL; keep only the class.
            raise LarkError(f"Lark request failed: {type(error).__name__}") from None
        try:
            body = response.json()
        except ValueError:
            raise LarkError("Lark returned a non-JSON response") from None
        code = body.get("code")
        if code not in (0, None):
            raise LarkError(f"Lark rejected the read (code {code})")
        data = body.get("data")
        return data if isinstance(data, dict) else body

    def app_metadata(self, app_token: str) -> dict[str, Any]:
        return self._send("GET", f"/open-apis/bitable/v1/apps/{app_token}")

    def table_metadata(self, app_token: str, table_id: str) -> dict[str, Any]:
        return self._send(
            "GET", f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}"
        )

    def _paginate(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            query: dict[str, Any] = dict(params or {})
            query["page_size"] = PAGE_SIZE
            if page_token:
                query["page_token"] = page_token
            data = self._send("GET", path, params=query)
            items.extend(data.get("items") or [])
            if not data.get("has_more"):
                return items
            page_token = data.get("page_token")
            if not page_token:
                return items

    def list_fields(self, app_token: str, table_id: str) -> list[dict[str, Any]]:
        return self._paginate(f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields")

    def list_records(self, app_token: str, table_id: str) -> list[dict[str, Any]]:
        return self._paginate(f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records")

    def download_media(self, file_token: str) -> tuple[bytes, str]:
        """Fetch one Lark attachment by token, resolved server-side only."""

        path = f"/open-apis/drive/v1/medias/{file_token}/download"
        self.calls.append(LarkCall(method="GET", path=path))
        try:
            response = self._client.get(
                path, headers={"Authorization": f"Bearer {self._token_value()}"}
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise LarkError(f"Lark attachment download failed: {type(error).__name__}") from None
        return response.content, response.headers.get("content-type", "application/octet-stream")

    def create_record(
        self, app_token: str, table_id: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        """Create one brand-new record; no legacy record is ever touched."""

        path = f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records"
        headers = {"Authorization": f"Bearer {self._token_value()}"}
        self.calls.append(LarkCall(method="POST", path=path))
        try:
            response = self._client.post(path, json={"fields": fields}, headers=headers)
            response.raise_for_status()
        except httpx.TimeoutException as error:
            raise LarkTimeout(f"Lark create timed out: {type(error).__name__}") from None
        except httpx.HTTPError as error:
            raise LarkError(f"Lark create failed: {type(error).__name__}") from None
        try:
            body = response.json()
        except ValueError:
            raise LarkError("Lark returned a non-JSON response") from None
        code = body.get("code")
        if code not in (0, None):
            raise LarkError(f"Lark rejected the create (code {code})")
        data = body.get("data")
        record = (data or {}).get("record") if isinstance(data, dict) else None
        if not isinstance(record, dict) or not record.get("record_id"):
            raise LarkError("Lark create returned no record id")
        return record
