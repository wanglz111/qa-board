import json
import zipfile
from io import BytesIO

import pytest
from PIL import Image

from app.importers.casebook import parse_casebook
from app.importers.schema import ImportErrorDetail
from tests.casebook_fixture import casebook, casebook_zip, png_bytes, valid_case


UNSET = object()


def visual_case(*, position=UNSET, **reference_overrides):
    """One case with a single reference and a localised asset registry."""

    reference = {"asset": "sale-stage-selling", "role": "expected"}
    reference.update(reference_overrides)
    case = valid_case(visual={"check": "visual_only", "references": [reference]})
    if position is not UNSET:
        case["position"] = position
    return case


ONLY_ASSET = {"sale-stage-selling": {"name": "节点发售", "type": "page"}}


def test_casebook_loads_cases_assets_and_visual_checks():
    document = parse_casebook(casebook_zip())

    assert document.title == "Odyssey 节点发售回归"
    assert document.prototype_version == "v2.0"
    # Two cases reference three slots but only two unique images.
    assert sorted(document.assets) == ["sale-confirm-modal", "sale-stage-selling"]
    assert [case.code for case in document.cases] == ["C-05", "C-11"]

    first = document.cases[0]
    assert first.position == 1
    assert first.module == "二、节点认购与期次"
    assert first.steps == "选 A 档 ×1\n选 BOT Chain\n点确认购买"
    assert first.expected == "阶段信息条: 三行文案\n费用明细: 实付 = 原价 × 份数"
    assert first.expect_absent == ("已售罄",)
    assert first.visual_check == "text_and_visual"
    assert first.prototype_note is None
    assert [reference.asset_key for reference in first.references] == [
        "sale-stage-selling",
        "sale-confirm-modal",
    ]
    assert first.references[0].caption == "默认发售态"
    assert first.references[1].focus[0].label == "确认按钮"
    assert first.references[1].focus[0].box == (0.62, 0.78, 0.3, 0.08)

    second = document.cases[1]
    assert second.visual_check == "not_verifiable"
    assert second.prototype_note == "红色倒计时原型默认不展示，需要演示开关触发"
    assert second.references[0].role == "locator"
    assert second.expect_absent == ()

    asset = document.assets["sale-stage-selling"]
    assert asset.name == "节点发售 · 阶段1 发售中"
    assert asset.asset_type == "page"
    assert asset.screen == "节点发售"
    assert (asset.width, asset.height) == (4, 6)
    assert asset.mime == "image/png"
    assert asset.content == png_bytes()
    assert asset.prototype_version == "v2.0"


def test_unknown_document_fields_are_rejected():
    document = casebook()
    document["slices"] = ["s05"]

    with pytest.raises(ImportErrorDetail, match=r"casebook\.json: unknown field"):
        parse_casebook(casebook_zip(book=document))


def test_unknown_case_fields_are_rejected():
    broken = casebook(cases=[valid_case(refferences=[])])

    with pytest.raises(ImportErrorDetail, match=r"cases\[0\]: unknown field.*refferences"):
        parse_casebook(casebook_zip(book=broken))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"steps": "选 A 档 ×1"}, r"cases\[0\]\.steps: must be an array"),
        ({"position": "1"}, r"cases\[0\]\.position: must be an integer"),
        ({"priority": "p0"}, r"cases\[0\]\.priority: expected one of P0\|P1\|P2"),
        ({"title": ""}, r"cases\[0\]\.title: must not be empty"),
    ],
)
def test_types_and_enums_are_not_coerced(overrides, message):
    broken = casebook(cases=[valid_case(**overrides)])

    with pytest.raises(ImportErrorDetail, match=message):
        parse_casebook(casebook_zip(book=broken))


def test_reference_role_is_strict():
    case = valid_case(
        visual={
            "check": "visual_only",
            "references": [{"asset": "sale-stage-selling", "role": "Expected"}],
        }
    )

    with pytest.raises(ImportErrorDetail, match=r"references\[0\]\.role"):
        parse_casebook(casebook_zip(book=casebook(cases=[case])))


def test_checks_require_the_right_reference_shape():
    without_note = valid_case(visual={"check": "not_verifiable", "references": []})
    with pytest.raises(ImportErrorDetail, match=r"visual\.note: required"):
        parse_casebook(casebook_zip(book=casebook(cases=[without_note])))

    no_images = valid_case(visual={"check": "text_and_visual", "references": []})
    with pytest.raises(ImportErrorDetail, match=r"references: needs at least one image"):
        parse_casebook(casebook_zip(book=casebook(cases=[no_images])))


def test_every_image_and_registry_entry_must_be_referenced():
    referenced = valid_case(
        visual={
            "check": "visual_only",
            "references": [{"asset": "sale-stage-selling", "role": "expected"}],
        }
    )
    unused_image = casebook_zip(
        book=casebook(
            cases=[referenced],
            assets={"sale-stage-selling": {"name": "节点发售", "type": "page"}},
        ),
        images={
            "sale-stage-selling.png": png_bytes(),
            "orphan-export.png": png_bytes(),
        },
    )
    with pytest.raises(ImportErrorDetail, match=r"never referenced: orphan-export"):
        parse_casebook(unused_image)

    # A registry entry with no exported file: the image set and the referenced
    # set agree, so only the registry check can reject this bundle.
    unused_registry = casebook_zip(
        book=casebook(
            cases=[referenced],
            assets={
                "sale-stage-selling": {"name": "节点发售", "type": "page"},
                "sale-confirm-modal": {"name": "确认弹框", "type": "modal"},
            },
        ),
        images={"sale-stage-selling.png": png_bytes()},
    )
    with pytest.raises(ImportErrorDetail, match=r"registry entries never referenced"):
        parse_casebook(unused_registry)


def test_unknown_asset_and_duplicate_reference_are_rejected():
    unknown = valid_case(
        visual={
            "check": "visual_only",
            "references": [{"asset": "not-exported", "role": "expected"}],
        }
    )
    with pytest.raises(ImportErrorDetail, match=r"unknown asset 'not-exported'"):
        parse_casebook(casebook_zip(book=casebook(cases=[unknown])))

    duplicated = valid_case(
        visual={
            "check": "visual_only",
            "references": [
                {"asset": "sale-stage-selling", "role": "expected"},
                {"asset": "sale-stage-selling", "role": "expected"},
            ],
        }
    )
    with pytest.raises(
        ImportErrorDetail, match=r"duplicate reference to sale-stage-selling"
    ):
        parse_casebook(casebook_zip(book=casebook(cases=[duplicated])))


def test_duplicate_codes_and_positions_are_rejected():
    duplicate_code = casebook(cases=[valid_case(), valid_case(title="另一条")])
    with pytest.raises(ImportErrorDetail, match=r"duplicate code C-05"):
        parse_casebook(casebook_zip(book=duplicate_code))

    duplicate_position = casebook(
        cases=[valid_case(), valid_case(code="C-06", position=1)]
    )
    with pytest.raises(ImportErrorDetail, match=r"duplicate position 1"):
        parse_casebook(casebook_zip(book=duplicate_position))


def test_invalid_codes_and_filenames_are_rejected():
    bad_code = valid_case(code="登录-001")
    with pytest.raises(ImportErrorDetail, match=r"must look like <MODULE>-<number>"):
        parse_casebook(casebook_zip(book=casebook(cases=[bad_code])))

    bad_filename = casebook_zip(
        book=casebook(
            cases=[valid_case()],
            assets={"Sale-Stage": {"name": "x", "type": "page"}},
        ),
        images={"Sale-Stage.png": png_bytes()},
    )
    with pytest.raises(ImportErrorDetail, match="kebab-case"):
        parse_casebook(bad_filename)


def test_version_and_archive_guardrails():
    wrong_version = casebook()
    wrong_version["casebook"] = "2.0"
    with pytest.raises(ImportErrorDetail, match="Unsupported casebook version"):
        parse_casebook(casebook_zip(book=wrong_version))

    without_book = BytesIO()
    with zipfile.ZipFile(without_book, "w") as archive:
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
    with pytest.raises(ImportErrorDetail, match="casebook.json"):
        parse_casebook(without_book.getvalue())

    with pytest.raises(ImportErrorDetail, match="not a readable ZIP"):
        parse_casebook(b"not a zip")

    with pytest.raises(ImportErrorDetail, match="must be a JSON object"):
        parse_casebook(casebook_zip(book=[1, 2]))

    buffer = BytesIO()
    Image.new("RGB", (4, 4), (0, 0, 255)).save(buffer, format="GIF")
    gif = casebook_zip(
        images={
            "sale-stage-selling.png": buffer.getvalue(),
            "sale-confirm-modal.png": png_bytes(),
        }
    )
    with pytest.raises(ImportErrorDetail, match="unsupported format"):
        parse_casebook(gif)


def test_path_traversal_entries_are_rejected():
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "casebook.json", json.dumps(casebook(), ensure_ascii=False)
        )
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
        archive.writestr("../escape.png", png_bytes())

    with pytest.raises(ImportErrorDetail, match="not a safe path"):
        parse_casebook(buffer.getvalue())


def test_damaged_member_bytes_are_reported_not_raised():
    # A ZIP whose central directory still parses but whose member payload is
    # corrupt must surface as an import error, not as a zipfile decode crash.
    damaged = bytearray(casebook_zip())
    info = zipfile.ZipFile(BytesIO(bytes(damaged))).infolist()[0]
    payload = (
        info.header_offset + 30 + len(info.filename.encode()) + len(info.extra)
    )
    damaged[payload] ^= 0xFF

    with pytest.raises(ImportErrorDetail, match="damaged, truncated or encrypted"):
        parse_casebook(bytes(damaged))


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"position": None}, r"cases\[0\]\.position: must be an integer"),
        ({"focus": None}, r"references\[0\]\.focus: must be an array"),
        (
            {"focus": [{"label": "确认按钮", "box": None}]},
            r"focus\[0\]\.box: must be \[x, y, w, h\]",
        ),
    ],
)
def test_explicit_null_is_rejected_not_treated_as_missing(overrides, message):
    # An omitted optional field falls back to its default; an explicit null is a
    # type error and must not silently become "no position / no focus / no box".
    broken = casebook(cases=[visual_case(**overrides)], assets=ONLY_ASSET)

    with pytest.raises(ImportErrorDetail, match=message):
        parse_casebook(
            casebook_zip(
                book=broken, images={"sale-stage-selling.png": png_bytes()}
            )
        )


def test_missing_optional_fields_still_fall_back_to_defaults():
    # The counterpart of the null test: absence keeps the documented behaviour.
    document = parse_casebook(
        casebook_zip(
            book=casebook(cases=[visual_case()], assets=ONLY_ASSET),
            images={"sale-stage-selling.png": png_bytes()},
        )
    )

    assert document.cases[0].position == 1
    assert document.cases[0].references[0].focus == ()


def raw_casebook_zip(casebook_json: str) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("casebook.json", casebook_json)
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
    return buffer.getvalue()


def casebook_with_box(box_json: str) -> bytes:
    book = casebook(
        cases=[visual_case(focus=[{"label": "确认按钮", "box": [0, 0, 1, 1]}])],
        assets=ONLY_ASSET,
    )
    payload = json.dumps(book, ensure_ascii=False).replace("[0, 0, 1, 1]", box_json)
    return raw_casebook_zip(payload)


@pytest.mark.parametrize(
    ("box_json", "message"),
    [
        ("[NaN, 0, 1, 1]", r"box\[0\]: must be normalised between 0 and 1"),
        ("[Infinity, 0, 1, 1]", r"box\[0\]: must be normalised between 0 and 1"),
        ("[-Infinity, 0, 1, 1]", r"box\[0\]: must be normalised between 0 and 1"),
        (
            "[" + "9" * 400 + ", 0, 1, 1]",
            r"box\[0\]: must be normalised between 0 and 1",
        ),
        ("[-1, 0, 1, 1]", r"box\[0\]: must be normalised between 0 and 1"),
    ],
)
def test_non_finite_and_oversized_box_values_are_rejected(box_json, message):
    # NaN slips past <0/>1 comparisons and a huge JSON integer overflows
    # float(); both used to escape as an unhandled 500 instead of a 422.
    with pytest.raises(ImportErrorDetail, match=message):
        parse_casebook(casebook_with_box(box_json))


@pytest.mark.parametrize("position", [0, -1])
def test_position_below_one_is_rejected(position):
    broken = casebook(cases=[visual_case(position=position)], assets=ONLY_ASSET)
    with pytest.raises(
        ImportErrorDetail, match=r"cases\[0\]\.position: must be an integer >= 1"
    ):
        parse_casebook(
            casebook_zip(
                book=broken, images={"sale-stage-selling.png": png_bytes()}
            )
        )


@pytest.mark.parametrize("position", [2**31, 2**63])
def test_position_outside_the_storage_range_is_rejected(position):
    # GroupCase.position is a PostgreSQL int4, so anything above 2**31 - 1 would
    # pass preview and then fail at confirm time with a 500.
    broken = casebook(cases=[visual_case(position=position)], assets=ONLY_ASSET)
    with pytest.raises(
        ImportErrorDetail,
        match=r"cases\[0\]\.position: must be an integer between 1 and 2147483647",
    ):
        parse_casebook(
            casebook_zip(
                book=broken, images={"sale-stage-selling.png": png_bytes()}
            )
        )


def test_corrupt_image_payload_is_rejected():
    # Image.verify() only checks the container; a PNG whose IDAT stream is
    # broken still passed and later failed to render for the tester.
    buffer = BytesIO()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(buffer, format="PNG")
    data = buffer.getvalue()
    marker = data.index(b"IDAT")
    length = int.from_bytes(data[marker - 4 : marker], "big")
    payload = b"\x00\x00\x00\x00"
    import zlib

    crc = zlib.crc32(b"IDAT" + payload) & 0xFFFFFFFF
    broken = (
        data[: marker - 4]
        + len(payload).to_bytes(4, "big")
        + b"IDAT"
        + payload
        + crc.to_bytes(4, "big")
        + data[marker + 4 + length + 4 :]
    )

    with pytest.raises(ImportErrorDetail, match=r"not a readable image"):
        parse_casebook(
            casebook_zip(
                book=casebook(cases=[visual_case()], assets=ONLY_ASSET),
                images={"sale-stage-selling.png": broken},
            )
        )


def test_oversized_pixel_image_is_reported_not_raised():
    # A tiny file can declare a huge canvas; Pillow raises DecompressionBombError
    # which is not an OSError subclass and used to escape as a 500.
    buffer = BytesIO()
    Image.new("RGB", (4, 6), (1, 2, 3)).save(buffer, format="PNG")
    data = bytearray(buffer.getvalue())
    data[16:20] = (20000).to_bytes(4, "big")
    data[20:24] = (20000).to_bytes(4, "big")
    import zlib

    crc = zlib.crc32(bytes(data[12:29])) & 0xFFFFFFFF
    data[29:33] = crc.to_bytes(4, "big")

    with pytest.raises(ImportErrorDetail, match=r"megapixel limit"):
        parse_casebook(
            casebook_zip(
                book=casebook(cases=[visual_case()], assets=ONLY_ASSET),
                images={"sale-stage-selling.png": bytes(data)},
            )
        )


@pytest.mark.parametrize("member", [".", "\\"])
def test_empty_and_dot_zip_member_names_are_rejected(member):
    # PurePosixPath('.').parts is empty, so the old code raised IndexError
    # instead of a readable import error.
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("casebook.json", json.dumps(casebook(), ensure_ascii=False))
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
        archive.writestr("assets/sale-confirm-modal.png", png_bytes())
        archive.writestr(member, b"x")

    with pytest.raises(ImportErrorDetail, match="not a safe path"):
        parse_casebook(buffer.getvalue())


@pytest.mark.parametrize("member", ["./", "/", "assets/./", "assets//"])
def test_directory_like_zip_entries_are_ignored(member):
    # Directory entries are skipped before path validation; they must not crash
    # the import even though they carry no asset bytes.
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("casebook.json", json.dumps(casebook(), ensure_ascii=False))
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
        archive.writestr("assets/sale-confirm-modal.png", png_bytes())
        archive.writestr(member, b"x")

    document = parse_casebook(buffer.getvalue())

    assert len(document.cases) == 2
