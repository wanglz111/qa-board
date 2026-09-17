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


# A write the app is not allowed to make is answered with HTTP 401/403 (or an
# HTTP 400 carrying a permission message). Only Lark can grant that permission,
# so the refusal names both places it lives. One constant keeps the table and
# field paths wording the remedy exactly the same way.
WRITE_PERMISSION_HINT = (
    "；请在 Lark 开放平台为应用开通「查看、评论、编辑和管理多维表格」权限并发布，"
    "同时把应用加为该多维表格的可编辑协作者"
)
_PERMISSION_WORDS = ("permission", "forbidden", "access denied", "权限")


@dataclass(frozen=True)
class LarkCall:
    method: str
    path: str


def _is_record_path(path: str) -> bool:
    return "/records" in path


def _error_body(response: httpx.Response) -> dict[str, Any]:
    """Lark's own code and message, when the refusal carries a JSON body."""

    try:
        parsed = response.json()
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _permission_hint(status: int | None, message: str) -> str:
    """The Lark-side remedy, but only for a refusal that looks like one.

    A parameter error must not send the administrator off to change document
    permissions, so an unclear refusal stays with Lark's own words.
    """

    if status in (401, 403):
        return WRITE_PERMISSION_HINT
    normalized = str(message).lower()
    if any(word in normalized for word in _PERMISSION_WORDS):
        return WRITE_PERMISSION_HINT
    return ""


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

    def _post(
        self,
        path: str,
        *,
        method: str = "POST",
        action: str = "create",
        json: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
        files: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Send one body and return Lark's ``data`` dict.

        Every create-only write goes through here, so the audit records one
        method and path per request. A timeout is reported as ``LarkTimeout``
        because the write may have landed anyway, and a refusal carries Lark's
        own ``msg``: the request body (which can hold record values) and the
        credentials never reach the message. A response that carries no ``data``
        object is returned as-is, exactly like ``_send`` does.
        """

        headers = {"Authorization": f"Bearer {self._token_value()}"}
        self.calls.append(LarkCall(method=method, path=path))
        try:
            response = self._client.request(
                method,
                path,
                json=json,
                data=data,
                files=files,
                headers=headers,
                timeout=timeout,
            )
            response.raise_for_status()
        except httpx.TimeoutException as error:
            raise LarkTimeout(
                f"Lark {action} timed out: {type(error).__name__}"
            ) from None
        except httpx.HTTPError as error:
            # Lark puts the actionable reason in the JSON body even for HTTP
            # errors (for example, a missing bitable permission). Preserve only
            # the status and server message; never include the URL, request
            # body, or credentials in the error shown to an administrator.
            status = getattr(response, "status_code", None)
            error_body = _error_body(response)
            code = error_body.get("code")
            message = str(error_body.get("msg") or "").strip().replace("\n", " ")
            detail = ""
            if code not in (None, ""):
                detail += f"，Lark code {code}"
            if message:
                detail += f"：{message}"
            suffix = f" HTTP {status}" if status is not None else ""
            raise LarkError(
                f"Lark {action} failed{suffix}: {type(error).__name__}{detail}"
                f"{_permission_hint(status, message)}"
            ) from None
        try:
            payload = response.json()
        except ValueError:
            raise LarkError("Lark returned a non-JSON response") from None
        code = payload.get("code")
        if code not in (0, None):
            message = str(payload.get("msg") or "").strip().replace("\n", " ")
            detail = f": {message}" if message else ""
            raise LarkError(
                f"Lark rejected the {action} (code {code}){detail}"
                f"{_permission_hint(None, message)}"
            )
        data = payload.get("data")
        return data if isinstance(data, dict) else payload

    def _post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST one JSON body; the create-only writes all speak through here."""

        return self._post(path, json=body)

    def app_metadata(self, app_token: str) -> dict[str, Any]:
        return self._send("GET", f"/open-apis/bitable/v1/apps/{app_token}")

    def wiki_node(self, node_token: str) -> dict[str, Any]:
        """Resolve one wiki node to the Bitable app token behind it."""

        data = self._send(
            "GET",
            "/open-apis/wiki/v2/spaces/get_node",
            params={"token": node_token, "obj_type": "wiki"},
        )
        node = data.get("node")
        if not isinstance(node, dict):
            raise LarkError("Lark 未返回 wiki 节点信息")
        return node

    def list_tables(self, app_token: str) -> list[dict[str, Any]]:
        """List a base's tables.

        The single-table metadata route does not exist for every tenant: it
        answers a bare 404, so the table name is resolved from this listing.
        """

        return self._paginate(f"/open-apis/bitable/v1/apps/{app_token}/tables")

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

    def list_views(self, app_token: str, table_id: str) -> list[dict[str, Any]]:
        return self._paginate(f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/views")

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

        data = self._post_json(
            f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records",
            {"fields": fields},
        )
        record = data.get("record")
        if not isinstance(record, dict) or not record.get("record_id"):
            raise LarkError("Lark create returned no record id")
        return record

    def upload_media(
        self,
        *,
        file_name: str,
        content: bytes,
        mime: str,
        parent_node: str,
        parent_type: str = "bitable_image",
    ) -> str:
        """Upload one file into a base and return the token a record can hold.

        A record's attachment column stores ``[{"file_token": ...}]``, and Lark
        mints that token here. ``parent_node`` is the base's app token, and
        ``parent_type`` is ``bitable_image`` for the pictures this tool writes.
        """

        # The upload path is not a record path, so the record audit still sees
        # only the create calls the outbox makes.
        data = self._post(
            "/open-apis/drive/v1/medias/upload_all",
            action="upload",
            data={
                "file_name": file_name,
                "parent_type": parent_type,
                "parent_node": parent_node,
                "size": str(len(content)),
            },
            files={"file": (file_name, content, mime)},
            # An image upload is slower than a metadata call; the default
            # request timeout would abort one that is still going.
            timeout=max(self._client.timeout.read or 15.0, 60.0),
        )
        file_token = data.get("file_token")
        if not file_token:
            raise LarkError("Lark upload returned no file token")
        return str(file_token)

    def update_field(
        self,
        app_token: str,
        table_id: str,
        field_id: str,
        *,
        name: str,
        type_id: int,
        properties: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Convert one existing column to the type the writer needs.

        Only a column the administrator explicitly approved is ever changed:
        this is a deliberate repair of a header this tool created wrongly, not a
        migration that runs on its own.
        """

        body: dict[str, Any] = {
            "field_name": name,
            "type": type_id,
            "property": properties or None,
        }
        return self._post(
            f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}"
            f"/fields/{field_id}",
            method="PUT",
            action="field update",
            json=body,
        )

    def create_field(
        self, app_token: str, table_id: str, name: str, type_id: int, properties: dict[str, Any]
    ) -> dict[str, Any]:
        # Text and attachment fields take a null property: Lark refuses an empty
        # object in its place (code 800074088), so the key is always sent.
        body: dict[str, Any] = {
            "field_name": name,
            "type": type_id,
            "property": properties or None,
        }
        return self._post_json(
            f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields", body
        )

    def create_view(self, app_token: str, table_id: str, name: str) -> dict[str, Any]:
        data = self._post_json(
            f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/views",
            {"view_name": name, "view_type": "grid"},
        )
        # Same tolerance as ``create_table``: the view may come back on its own or
        # wrapped under ``view``, and either shape reports the new view's id.
        view = data.get("view")
        return view if isinstance(view, dict) else data

    def create_table(
        self, app_token: str, name: str, fields: list[dict[str, Any]]
    ) -> dict[str, Any]:
        data = self._post_json(
            f"/open-apis/bitable/v1/apps/{app_token}/tables",
            {"table": {"name": name, "default_view_name": "主视图", "fields": fields}},
        )
        # The live API answers with the new table's own keys; a ``table``
        # envelope wrapping them is also accepted so either shape reports the
        # id and name of the table that was just created.
        table = data.get("table")
        return table if isinstance(table, dict) else data
