"""Strict-mode casebook fixtures shared by the import tests."""

import json
import zipfile
from io import BytesIO
from typing import Any

from PIL import Image


def png_bytes(width: int = 4, height: int = 6) -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (width, height), (12, 34, 56)).save(buffer, format="PNG")
    return buffer.getvalue()


def valid_case(**overrides: Any) -> dict[str, Any]:
    """A minimal case that passes strict validation; override one field per test."""

    case: dict[str, Any] = {
        "code": "C-05",
        "title": "认购主流程-准确",
        "steps": ["选 A 档 ×1"],
        "expected": ["确认按钮: 显示「确认购买」"],
        "visual": {
            "check": "not_verifiable",
            "note": "原型未覆盖该断言",
            "references": [],
        },
    }
    case.update(overrides)
    return case


def casebook(
    *,
    cases: list[dict[str, Any]] | None = None,
    assets: dict[str, Any] | None = None,
    prototype: dict[str, Any] | None = None,
    title: str = "Odyssey 节点发售回归",
) -> dict[str, Any]:
    return {
        "casebook": "1.0",
        "doc": {
            "title": title,
            "prototype": prototype
            if prototype is not None
            else {
                "version": "v2.0",
                "source": "https://www.figma.com/file/xxx",
                "exported_at": "2026-09-16",
            },
        },
        "assets": assets
        if assets is not None
        else {
            "sale-stage-selling": {
                "name": "节点发售 · 阶段1 发售中",
                "type": "page",
                "screen": "节点发售",
                "state": "发售中",
            },
            "sale-confirm-modal": {
                "name": "购买确认弹框",
                "type": "modal",
                "screen": "节点发售",
                "state": "确认购买",
            },
        },
        "cases": cases
        if cases is not None
        else [
            {
                "code": "C-05",
                "position": 1,
                "module": "二、节点认购与期次",
                "title": "认购主流程-准确",
                "preconditions": "期次发售中、余额充足",
                "steps": ["选 A 档 ×1", "选 BOT Chain", "点确认购买"],
                "expected": [
                    "阶段信息条: 三行文案",
                    "费用明细: 实付 = 原价 × 份数",
                ],
                "expect_absent": ["已售罄"],
                "visual": {
                    "check": "text_and_visual",
                    "references": [
                        {
                            "asset": "sale-stage-selling",
                            "role": "expected",
                            "caption": "默认发售态",
                        },
                        {
                            "asset": "sale-confirm-modal",
                            "role": "expected",
                            "focus": [
                                {
                                    "label": "确认按钮",
                                    "note": "文案应为「确认购买」",
                                    "box": [0.62, 0.78, 0.3, 0.08],
                                }
                            ],
                        },
                    ],
                },
            },
            {
                "code": "C-11",
                "title": "期次信息条与倒计时-准确",
                "steps": ["进入最后 24 小时", "观察倒计时"],
                "expected": ["倒计时: 切换为红色秒级"],
                "visual": {
                    "check": "not_verifiable",
                    "note": "红色倒计时原型默认不展示，需要演示开关触发",
                    "references": [
                        {"asset": "sale-stage-selling", "role": "locator"}
                    ],
                },
            },
        ],
    }


def casebook_zip(
    *,
    book: dict[str, Any] | None = None,
    images: dict[str, bytes] | None = None,
    prefix: str = "",
) -> bytes:
    document = book if book is not None else casebook()
    images = images if images is not None else {
        "sale-stage-selling.png": png_bytes(),
        "sale-confirm-modal.png": png_bytes(),
    }

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            f"{prefix}casebook.json", json.dumps(document, ensure_ascii=False)
        )
        for filename, content in images.items():
            archive.writestr(f"{prefix}assets/{filename}", content)
    return buffer.getvalue()
