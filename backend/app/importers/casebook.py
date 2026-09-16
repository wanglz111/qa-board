"""Parse a casebook v1 bundle in strict mode: reject, never coerce.

    casebook.json
    assets/sale-stage-selling.png

The image file name without its extension *is* the asset key, so a case names
an asset exactly once. Anything that does not match
``backend/app/schemas/casebook.schema.json`` is rejected with the JSON path that
failed, because the AI prompt embeds that same schema.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import json
import math
from pathlib import PurePosixPath
import re
from typing import Any
import zipfile

from PIL import Image, UnidentifiedImageError

from .schema import ImportErrorDetail, MAX_CASES, decode_utf8


CASEBOOK_VERSION = "1.0"
MAX_BUNDLE_BYTES = 100 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
MAX_ASSET_BYTES = 20 * 1024 * 1024
# GroupCase.position is a PostgreSQL int4; values beyond it would pass preview
# and then fail at confirm time.
MAX_POSITION = 2_147_483_647
# Well above any real prototype export (Odyssey's largest is a few megapixels)
# but low enough to reject a decompression bomb with a readable 422.
MAX_IMAGE_PIXELS = 50_000_000
ASSET_KEY = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CASE_CODE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-[0-9]+(-[A-Za-z0-9]+)*$")
ASSET_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp")
ASSET_TYPES = ("page", "modal", "state", "flow")
ROLES = ("expected", "locator")
CHECKS = ("text_and_visual", "visual_only", "not_verifiable")
LAYERS = ("Smoke", "Core", "Regression")
PRIORITIES = ("P0", "P1", "P2")
PILLOW_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
FORMAT_SUFFIX = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}

# Mirrors the schema: every object is closed and lists its required keys.
FIELDS: dict[str, frozenset[str]] = {
    "casebook.json": frozenset({"casebook", "doc", "assets", "cases"}),
    "doc": frozenset({"title", "prototype"}),
    "doc.prototype": frozenset({"version", "source", "exported_at"}),
    "assets.<key>": frozenset({"name", "type", "screen", "state"}),
    "cases[]": frozenset(
        {
            "code",
            "title",
            "position",
            "module",
            "layer",
            "priority",
            "preconditions",
            "test_data",
            "steps",
            "expected",
            "expect_absent",
            "visual",
        }
    ),
    "cases[].visual": frozenset({"check", "note", "references"}),
    "cases[].visual.references[]": frozenset({"asset", "role", "caption", "focus"}),
    "focus[]": frozenset({"label", "note", "box"}),
}
REQUIRED: dict[str, tuple[str, ...]] = {
    "casebook.json": ("casebook", "doc", "assets", "cases"),
    "doc": ("title", "prototype"),
    "doc.prototype": ("version",),
    "assets.<key>": ("name", "type"),
    "cases[]": ("code", "title", "steps", "expected", "visual"),
    "cases[].visual": ("check", "references"),
    "cases[].visual.references[]": ("asset", "role"),
    "focus[]": ("label",),
}


@dataclass(frozen=True, slots=True)
class BundleFocus:
    label: str
    note: str | None
    box: tuple[float, float, float, float] | None


@dataclass(frozen=True, slots=True)
class BundleAsset:
    asset_key: str
    name: str
    asset_type: str
    screen: str | None
    state: str | None
    source_path: str
    content: bytes
    mime: str
    width: int
    height: int
    prototype_version: str

    @property
    def suffix(self) -> str:
        return FORMAT_SUFFIX[self.mime]


@dataclass(frozen=True, slots=True)
class BundleReference:
    asset_key: str
    role: str
    caption: str | None
    focus: tuple[BundleFocus, ...]


@dataclass(frozen=True, slots=True)
class BundleCase:
    code: str
    position: int
    title: str
    module: str | None
    layer: str | None
    priority: str | None
    preconditions: str | None
    test_data: str | None
    steps: str
    expected: str
    expect_absent: tuple[str, ...]
    visual_check: str
    prototype_note: str | None
    raw: dict[str, Any]
    references: tuple[BundleReference, ...]


@dataclass(frozen=True, slots=True)
class CasebookDocument:
    title: str
    prototype_version: str
    assets: dict[str, BundleAsset]
    cases: tuple[BundleCase, ...]


def parse_casebook(content: bytes) -> CasebookDocument:
    if not content:
        raise ImportErrorDetail("The casebook bundle is empty")
    if len(content) > MAX_BUNDLE_BYTES:
        raise ImportErrorDetail("The casebook bundle exceeds the 100 MB limit")

    entries = _read_entries(content)
    document = _object(
        _read_json(entries, "casebook.json"), "casebook.json", "casebook.json"
    )
    if document["casebook"] != CASEBOOK_VERSION:
        raise ImportErrorDetail(
            f"Unsupported casebook version {document['casebook']!r}; "
            f"expected {CASEBOOK_VERSION!r}"
        )

    doc = _object(document["doc"], "doc", "doc")
    title = _text(doc["title"], "doc.title", maximum=200)
    prototype = _object(doc["prototype"], "doc.prototype", "doc.prototype")
    prototype_version = _text(
        prototype["version"], "doc.prototype.version", maximum=60
    )
    if "source" in prototype:
        _text(prototype["source"], "doc.prototype.source")
    if "exported_at" in prototype:
        _text(prototype["exported_at"], "doc.prototype.exported_at")

    files = _image_files(entries)
    registry = _asset_registry(document["assets"])

    listed = document["cases"]
    if not isinstance(listed, list) or not listed:
        raise ImportErrorDetail("cases: must be a non-empty array")
    if len(listed) > MAX_CASES:
        raise ImportErrorDetail(f"cases: contains more than {MAX_CASES} cases")

    codes: set[str] = set()
    positions: set[int] = set()
    cases: list[BundleCase] = []
    for index, raw_case in enumerate(listed):
        path = f"cases[{index}]"
        entry = _object(raw_case, path, "cases[]")
        code = _text(entry["code"], f"{path}.code")
        if not CASE_CODE.fullmatch(code):
            raise ImportErrorDetail(f"{path}.code: must look like <MODULE>-<number>")
        if code.casefold() in codes:
            raise ImportErrorDetail(f"{path}.code: duplicate code {code}")
        codes.add(code.casefold())

        case_title = _text(entry["title"], f"{path}.title", maximum=120)
        steps = _string_list(entry["steps"], f"{path}.steps", minimum=1)
        expected = _string_list(entry["expected"], f"{path}.expected", minimum=1)
        expect_absent = _string_list(
            entry.get("expect_absent", []), f"{path}.expect_absent"
        )

        position = (
            index + 1
            if "position" not in entry
            else _integer(entry["position"], f"{path}.position", maximum=MAX_POSITION)
        )
        if position in positions:
            raise ImportErrorDetail(f"{path}.position: duplicate position {position}")
        positions.add(position)

        visual = _object(entry["visual"], f"{path}.visual", "cases[].visual")
        check = _enum(visual["check"], f"{path}.visual.check", CHECKS)
        note = (
            _text(visual["note"], f"{path}.visual.note") if "note" in visual else None
        )
        references = _references(
            visual["references"], f"{path}.visual.references", files
        )
        if check != "not_verifiable" and not references:
            raise ImportErrorDetail(
                f"{path}.visual.references: needs at least one image when "
                f"check is {check!r}"
            )
        if check == "not_verifiable" and note is None:
            raise ImportErrorDetail(
                f"{path}.visual.note: required when check is 'not_verifiable'"
            )

        cases.append(
            BundleCase(
                code=code,
                position=position,
                title=case_title,
                module=_optional(entry, "module", f"{path}.module"),
                layer=_optional_enum(entry, "layer", f"{path}.layer", LAYERS),
                priority=_optional_enum(
                    entry, "priority", f"{path}.priority", PRIORITIES
                ),
                preconditions=_optional(entry, "preconditions", f"{path}.preconditions"),
                test_data=_optional(entry, "test_data", f"{path}.test_data"),
                steps="\n".join(steps),
                expected="\n".join(expected),
                expect_absent=tuple(expect_absent),
                visual_check=check,
                prototype_note=note,
                raw=dict(entry),
                references=references,
            )
        )

    referenced = {
        reference.asset_key for case in cases for reference in case.references
    }
    unused_images = sorted(set(files) - referenced)
    if unused_images:
        raise ImportErrorDetail(
            f"assets: image(s) never referenced: {', '.join(unused_images)}"
        )
    missing_registry = sorted(referenced - set(registry))
    if missing_registry:
        raise ImportErrorDetail(
            f"assets: missing registry entry for {', '.join(missing_registry)}"
        )
    unused_registry = sorted(set(registry) - referenced)
    if unused_registry:
        raise ImportErrorDetail(
            f"assets: registry entries never referenced: {', '.join(unused_registry)}"
        )

    assets = {
        key: _load_asset(key, entries, files[key], registry[key], prototype_version)
        for key in sorted(referenced)
    }
    return CasebookDocument(
        title=title,
        prototype_version=prototype_version,
        assets=assets,
        cases=tuple(cases),
    )


def _object(value: Any, path: str, kind: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ImportErrorDetail(f"{path}: must be an object")
    unknown = sorted(set(value) - FIELDS[kind])
    if unknown:
        raise ImportErrorDetail(f"{path}: unknown field(s) {', '.join(unknown)}")
    for name in REQUIRED[kind]:
        if name not in value:
            raise ImportErrorDetail(f"{path}: missing required field {name!r}")
    return value


def _text(value: Any, path: str, *, maximum: int | None = None) -> str:
    if not isinstance(value, str):
        raise ImportErrorDetail(f"{path}: must be a string")
    text = value.strip()
    if not text:
        raise ImportErrorDetail(f"{path}: must not be empty")
    if maximum is not None and len(text) > maximum:
        raise ImportErrorDetail(f"{path}: must be at most {maximum} characters")
    return text


def _optional(entry: dict[str, Any], name: str, path: str) -> str | None:
    return _text(entry[name], path) if name in entry else None


def _enum(value: Any, path: str, allowed: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in allowed:
        raise ImportErrorDetail(
            f"{path}: expected one of {'|'.join(allowed)}, got {value!r}"
        )
    return value


def _optional_enum(
    entry: dict[str, Any], name: str, path: str, allowed: tuple[str, ...]
) -> str | None:
    return _enum(entry[name], path, allowed) if name in entry else None


def _string_list(value: Any, path: str, *, minimum: int = 0) -> list[str]:
    if not isinstance(value, list):
        raise ImportErrorDetail(f"{path}: must be an array of strings")
    if len(value) < minimum:
        raise ImportErrorDetail(f"{path}: needs at least {minimum} item(s)")
    return [_text(item, f"{path}[{index}]") for index, item in enumerate(value)]


def _integer(
    value: Any, path: str, *, minimum: int = 1, maximum: int | None = None
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ImportErrorDetail(f"{path}: must be an integer >= {minimum}")
    if maximum is not None and value > maximum:
        raise ImportErrorDetail(
            f"{path}: must be an integer between {minimum} and {maximum}"
        )
    return value


def _number(value: Any, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ImportErrorDetail(f"{path}: must be a number")
    try:
        number = float(value)
    except (OverflowError, ValueError):
        # A JSON integer can exceed float's range and raise OverflowError.
        raise ImportErrorDetail(
            f"{path}: must be normalised between 0 and 1"
        ) from None
    # NaN slips past the comparisons below, so finiteness is checked explicitly.
    if not math.isfinite(number) or number < 0 or number > 1:
        raise ImportErrorDetail(f"{path}: must be normalised between 0 and 1")
    return number


def _references(
    value: Any, path: str, files: dict[str, str]
) -> tuple[BundleReference, ...]:
    if not isinstance(value, list):
        raise ImportErrorDetail(f"{path}: must be an array")
    references: list[BundleReference] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        item_path = f"{path}[{index}]"
        entry = _object(raw, item_path, "cases[].visual.references[]")
        key = _text(entry["asset"], f"{item_path}.asset")
        if not ASSET_KEY.fullmatch(key):
            raise ImportErrorDetail(
                f"{item_path}.asset: key must be kebab-case (^[a-z0-9][a-z0-9-]*$)"
            )
        if key not in files:
            raise ImportErrorDetail(f"{item_path}.asset: unknown asset {key!r}")
        if key in seen:
            raise ImportErrorDetail(f"{item_path}.asset: duplicate reference to {key}")
        seen.add(key)
        references.append(
            BundleReference(
                asset_key=key,
                role=_enum(entry["role"], f"{item_path}.role", ROLES),
                caption=(
                    _text(entry["caption"], f"{item_path}.caption")
                    if "caption" in entry
                    else None
                ),
                focus=(
                    _focus(entry["focus"], f"{item_path}.focus")
                    if "focus" in entry
                    else ()
                ),
            )
        )
    return tuple(references)


def _focus(value: Any, path: str) -> tuple[BundleFocus, ...]:
    if not isinstance(value, list):
        raise ImportErrorDetail(f"{path}: must be an array")
    result: list[BundleFocus] = []
    for index, raw in enumerate(value):
        item_path = f"{path}[{index}]"
        entry = _object(raw, item_path, "focus[]")
        box: tuple[float, float, float, float] | None = None
        if "box" in entry:
            box_value = entry["box"]
            if not isinstance(box_value, list) or len(box_value) != 4:
                raise ImportErrorDetail(f"{item_path}.box: must be [x, y, w, h]")
            box = (
                _number(box_value[0], f"{item_path}.box[0]"),
                _number(box_value[1], f"{item_path}.box[1]"),
                _number(box_value[2], f"{item_path}.box[2]"),
                _number(box_value[3], f"{item_path}.box[3]"),
            )
        result.append(
            BundleFocus(
                label=_text(entry["label"], f"{item_path}.label"),
                note=(
                    _text(entry["note"], f"{item_path}.note")
                    if "note" in entry
                    else None
                ),
                box=box,
            )
        )
    return tuple(result)


def _read_entries(content: bytes) -> dict[str, bytes]:
    try:
        archive = zipfile.ZipFile(BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise ImportErrorDetail("The bundle is not a readable ZIP file") from exc

    entries: dict[str, bytes] = {}
    total = 0
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = _normalize(info.filename)
            if name in entries:
                raise ImportErrorDetail(f"The bundle contains {name} twice")
            total += info.file_size
            if total > MAX_UNCOMPRESSED_BYTES:
                raise ImportErrorDetail("The bundle expands beyond the 250 MB limit")
            try:
                entries[name] = archive.read(info)
            except Exception as exc:
                # These bytes are untrusted: a damaged, truncated or encrypted
                # member is a user-visible import error, not a decode crash.
                raise ImportErrorDetail(
                    f"The bundle member {name} is damaged, truncated or encrypted"
                ) from exc
    return entries


def _normalize(name: str) -> str:
    candidate = name.replace("\\", "/").lstrip("/")
    path = PurePosixPath(candidate)
    # ``.``, ``/`` and ``assets/./`` collapse to no path segments; accessing
    # parts[0] below would otherwise raise an unhandled IndexError.
    if (
        not candidate
        or not path.parts
        or path.is_absolute()
        or ".." in path.parts
    ):
        raise ImportErrorDetail(f"The bundle entry {name!r} is not a safe path")
    if path.parts[0].endswith(":"):
        raise ImportErrorDetail(f"The bundle entry {name!r} is not a safe path")
    return path.as_posix()


def _read_json(entries: dict[str, bytes], filename: str) -> Any:
    matches = [name for name in entries if PurePosixPath(name).name == filename]
    if not matches:
        raise ImportErrorDetail(f"The bundle is missing {filename}")
    if len(matches) > 1:
        raise ImportErrorDetail(f"The bundle contains more than one {filename}")
    try:
        document = json.loads(decode_utf8(entries[matches[0]], bom=True))
    except json.JSONDecodeError as exc:
        raise ImportErrorDetail(f"{filename} is not valid JSON: {exc.msg}") from exc
    if not isinstance(document, dict):
        raise ImportErrorDetail(f"{filename} must be a JSON object")
    return document


def _image_files(entries: dict[str, bytes]) -> dict[str, str]:
    files: dict[str, str] = {}
    for name in entries:
        path = PurePosixPath(name)
        if path.parts[0] != "assets" or len(path.parts) < 2:
            continue
        if path.suffix.lower() not in ASSET_SUFFIXES:
            continue
        key = path.stem
        if not ASSET_KEY.fullmatch(key):
            raise ImportErrorDetail(
                f"The asset file {name} must be named <kebab-case-key>{path.suffix}"
            )
        if key in files:
            raise ImportErrorDetail(f"The bundle contains two files for asset {key!r}")
        files[key] = name
    if not files:
        raise ImportErrorDetail("The bundle contains no images under assets/")
    return files


def _asset_registry(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or not value:
        raise ImportErrorDetail("assets: must be a non-empty object")
    registry: dict[str, dict[str, Any]] = {}
    for key, entry in value.items():
        if not isinstance(key, str) or not ASSET_KEY.fullmatch(key):
            raise ImportErrorDetail(
                f"assets.{key}: key must be kebab-case (^[a-z0-9][a-z0-9-]*$)"
            )
        payload = _object(entry, f"assets.{key}", "assets.<key>")
        registry[key] = {
            "name": _text(payload["name"], f"assets.{key}.name"),
            "type": _enum(payload["type"], f"assets.{key}.type", ASSET_TYPES),
            "screen": _optional(payload, "screen", f"assets.{key}.screen"),
            "state": _optional(payload, "state", f"assets.{key}.state"),
        }
    return registry


def _load_asset(
    key: str,
    entries: dict[str, bytes],
    source_path: str,
    registry: dict[str, Any],
    prototype_version: str,
) -> BundleAsset:
    content = entries[source_path]
    if not content:
        raise ImportErrorDetail(f"Prototype image {source_path} is empty")
    if len(content) > MAX_ASSET_BYTES:
        raise ImportErrorDetail(f"Prototype image {source_path} exceeds the 20 MB limit")
    try:
        with Image.open(BytesIO(content)) as image:
            detected = image.format
            width, height = image.size
            if width * height > MAX_IMAGE_PIXELS:
                raise ImportErrorDetail(
                    f"Prototype image {source_path} exceeds the "
                    f"{MAX_IMAGE_PIXELS // 1_000_000} megapixel limit"
                )
            # load() decodes the pixel stream, so a corrupt IDAT is caught here
            # instead of by the tester's browser (verify() only reads headers).
            image.load()
    except ImportErrorDetail:
        raise
    except Image.DecompressionBombError:
        # Pillow refuses oversized canvases at open() time; report the same
        # limit we enforce ourselves so the tester gets one clear message.
        raise ImportErrorDetail(
            f"Prototype image {source_path} exceeds the "
            f"{MAX_IMAGE_PIXELS // 1_000_000} megapixel limit"
        ) from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise ImportErrorDetail(
            f"Prototype image {source_path} is not a readable image"
        ) from None
    mime = PILLOW_MIME.get(detected or "")
    if mime is None:
        raise ImportErrorDetail(
            f"Prototype image {source_path} uses an unsupported format"
        )
    return BundleAsset(
        asset_key=key,
        name=registry["name"],
        asset_type=registry["type"],
        screen=registry["screen"],
        state=registry["state"],
        source_path=source_path,
        content=content,
        mime=mime,
        width=width,
        height=height,
        prototype_version=prototype_version,
    )
