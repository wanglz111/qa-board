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


# The prompt states the alias lists as hard constraints ("give two columns for the
# same field and the whole file is rejected"), but they are hand-maintained prose:
# `ALIASES` is the only authority. They have drifted once already (a doc listing
# three aliases while the importer accepted four), so the two lists are now
# cross-checked instead of eyeballed.
ALIAS_LIST = re.compile(
    r"`(?P<label>[^`]+)` 的(?P<count>[一二两三四五六七八九十])个别名"
    r"（(?P<aliases>[^）]*)）"
)
NUMERALS = {
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
}


def test_the_prompt_alias_lists_match_the_importer():
    from app.importers.schema import ALIASES

    prompt = next(entry for entry in PROMPTS if entry["id"] == "case-results")
    text = prompt["path"].read_text(encoding="utf-8")

    documented = {
        match.group("label").strip(): (
            NUMERALS[match.group("count")],
            set(re.findall(r"`([^`]+)`", match.group("aliases"))),
        )
        for match in ALIAS_LIST.finditer(text)
    }

    assert set(documented) == {"执行结果", "实测过程"}, (
        "the prompt no longer states the two alias lists in the expected shape — "
        f"rewording them means rewording this test, matched: {sorted(documented)}"
    )
    for label, canonical in (("执行结果", "result"), ("实测过程", "evidence")):
        stated_count, listed = documented[label]
        assert listed == set(ALIASES[canonical]), (
            f"the prompt's {label} aliases {sorted(listed)} disagree with "
            f"ALIASES[{canonical!r}] {sorted(ALIASES[canonical])}"
        )
        # "四个别名" must be true as well: the list can grow, the sentence cannot
        # silently keep claiming a count it no longer has.
        assert stated_count == len(listed)

