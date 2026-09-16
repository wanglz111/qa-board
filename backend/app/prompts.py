"""Serve the AI prompt documents that the import page hands to the user."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends

from app.auth import require_admin


PROMPT_DIR = Path(__file__).parent / "prompts"

PROMPTS: tuple[dict[str, Any], ...] = (
    {
        "id": "cases",
        "title": "文本用例 → 可导入格式",
        "summary": "把手上没有配图的用例整理成 CSV / JSON / Markdown，导入后直接执行。",
        "filename": "AI-CASE-PROMPT.md",
        "path": PROMPT_DIR / "ai-cases.md",
    },
    {
        "id": "casebook",
        "title": "用例 + 原型图 → 带图用例包",
        "summary": "把已有用例和导出的设计稿图片整理成 casebook.json，导入后可以逐条核对原型。",
        "filename": "AI-CASEBOOK-PROMPT.md",
        "path": PROMPT_DIR / "ai-casebook.md",
    },
)

router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


@router.get("/ai-prompts")
def list_prompts() -> list[dict[str, Any]]:
    return [
        {
            "id": prompt["id"],
            "title": prompt["title"],
            "summary": prompt["summary"],
            "filename": prompt["filename"],
            "markdown": prompt["path"].read_text(encoding="utf-8"),
        }
        for prompt in PROMPTS
    ]
