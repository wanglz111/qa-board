import json
from pathlib import Path
import re

import pytest

from app.prompts import PROMPTS


BACKEND = Path(__file__).parents[1]
SCHEMA = BACKEND / "app" / "schemas" / "casebook.schema.json"
SCHEMA_BLOCK = re.compile(
    r"<!-- casebook-schema:start -->\s*```json\s*(?P<schema>.*?)\s*```\s*"
    r"<!-- casebook-schema:end -->",
    re.DOTALL,
)


def test_prompts_endpoint_serves_every_document(authenticated_client):
    response = authenticated_client.get("/api/ai-prompts")

    assert response.status_code == 200
    prompts = response.json()
    assert [prompt["id"] for prompt in prompts] == ["cases", "casebook", "case-results"]
    for prompt in prompts:
        assert prompt["title"]
        assert prompt["summary"]
        assert prompt["filename"].endswith(".md")
        assert len(prompt["markdown"]) > 500
        assert "【需求】" in prompt["markdown"]


def test_prompts_endpoint_requires_a_session(client):
    assert client.get("/api/ai-prompts").status_code == 401


def test_shipped_prompts_match_the_docs():
    docs = Path(__file__).parents[2] / "docs"
    if not docs.is_dir():
        pytest.skip("docs/ is not part of this checkout")

    for prompt in PROMPTS:
        source = docs / prompt["filename"]
        if not source.is_file():
            pytest.skip(f"{source} is not present in this checkout")
        assert prompt["path"].read_text(encoding="utf-8") == source.read_text(
            encoding="utf-8"
        ), f"{source} drifted from backend/app/prompts/{prompt['path'].name}"


def test_casebook_prompt_embeds_the_canonical_schema():
    canonical = json.loads(SCHEMA.read_text(encoding="utf-8"))
    prompt = (BACKEND / "app" / "prompts" / "ai-casebook.md").read_text(
        encoding="utf-8"
    )

    match = SCHEMA_BLOCK.search(prompt)

    assert match, "the casebook prompt must embed the schema between the markers"
    assert json.loads(match.group("schema")) == canonical
    assert canonical["properties"]["casebook"]["const"] == "1.0"
    assert canonical["additionalProperties"] is False


def test_format_doc_embeds_the_same_schema():
    spec = Path(__file__).parents[2] / "docs" / "CASEBOOK-FORMAT.md"
    if not spec.is_file():
        pytest.skip("docs/ is not part of this checkout")

    match = SCHEMA_BLOCK.search(spec.read_text(encoding="utf-8"))

    assert match, "CASEBOOK-FORMAT.md must embed the schema between the markers"
    assert json.loads(match.group("schema")) == json.loads(
        SCHEMA.read_text(encoding="utf-8")
    )


FENCE = re.compile(r"```(?:csv)?\n(?P<body>.*?)```", re.DOTALL)


def test_every_shipped_sample_in_the_prompt_still_parses():
    from app.importers.schema import parse_file

    prompt = next(entry for entry in PROMPTS if entry["id"] == "case-results")
    blocks = [
        match.group("body")
        for match in FENCE.finditer(prompt["path"].read_text(encoding="utf-8"))
        # 只认带数据行的围栏：第 32 行那个只有表头的围栏是「第一行必须是这个表头」
        # 的片段，不是样例文件（它解析出来 0 条，会报 "No test case boundaries"）。
        if match.group("body").lstrip().startswith("用例编号,")
        and len(match.group("body").strip().splitlines()) > 1
    ]
    assert len(blocks) == 2, "提示词里有两份样例，两份都要能被解析"
    for index, block in enumerate(blocks, start=1):
        cases = parse_file(f"sample-{index}.csv", block.encode("utf-8"))
        assert [case.code for case in cases] == ["LOGIN-001", "LOGIN-002", "LOGIN-003"]
        assert [case.result for case in cases] == ["通过", None, "不通过"]
