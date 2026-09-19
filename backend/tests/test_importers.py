import json
from pathlib import Path

import pytest

from app.importers.schema import ImportErrorDetail, ParsedCase, parse_file


FIXTURES = Path(__file__).parent / "fixtures"


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def test_csv_utf8_bom_is_one_ordered_group():
    cases = parse_file("group14.csv", fixture_bytes("group14.csv"))

    assert len(cases) == 14
    assert isinstance(cases[0], ParsedCase)
    assert cases[0].code == "B-001"
    assert cases[0].position == 1
    assert cases[0].title == "Login"
    assert cases[0].module == "Account"
    assert cases[0].steps == "Open login page"
    assert cases[-1].code == "B-014"


def test_old_json_cases_object_uses_canonical_keys():
    cases = parse_file("old14.json", fixture_bytes("old14.json"))

    assert len(cases) == 14
    assert cases[0].code == "J-001"
    assert cases[0].position == 1
    assert cases[0].expected == "Checkpoint 1"
    assert cases[0].raw["id"] == "J-001"


def test_json_also_accepts_top_level_array():
    content = json.dumps(
        [
            {
                "id": "J-101",
                "order": 7,
                "title": "Array case",
                "steps": ["Open", "Submit"],
                "checkpoints": [
                    {"label": "Storage", "text": "Saved", "raw": "Storage: Saved"},
                    {"label": "Page", "text": "Visible"},
                ],
            }
        ]
    ).encode()

    case = parse_file("array.json", content)[0]
    assert case.position == 7
    assert case.steps == "Open\nSubmit"
    assert case.expected == "Storage: Saved\nPage: Visible"


def test_markdown_h4_cases_decode_html_breaks():
    cases = parse_file("cases_book.md", fixture_bytes("cases_book.md"))

    assert [case.code for case in cases] == ["M-001", "M-002"]
    assert cases[0].title == "Create account"
    assert cases[0].steps == "Open form\nSubmit details"
    assert cases[0].expected == "Account page: Account created"
    assert cases[1].position == 2


def test_markdown_explicit_case_table():
    markdown = """\
| 编号 | 标题 | 步骤 | 预期 |
| --- | --- | --- | --- |
| T-001 | Search | Enter term<br>Submit | Results shown |
| T-002 | Clear | Click clear | Empty input |
"""

    cases = parse_file("table.md", markdown.encode())

    assert len(cases) == 2
    assert cases[0].steps == "Enter term\nSubmit"
    assert cases[1].expected == "Empty input"


def test_mapping_accepts_source_to_canonical_and_canonical_to_source():
    csv_content = "Case Key,Rank,Name,Checks\nC-001,4,Mapped,It works\n".encode()
    json_content = json.dumps(
        [{"caseKey": "C-002", "rank": 5, "name": "Reverse mapped"}]
    ).encode()

    csv_case = parse_file(
        "mapped.csv",
        csv_content,
        {"Case Key": "code", "Rank": "position", "Name": "title", "Checks": "expected"},
    )[0]
    json_case = parse_file(
        "mapped.json",
        json_content,
        {"code": "caseKey", "position": "rank", "title": "name"},
    )[0]

    assert (csv_case.code, csv_case.position, csv_case.expected) == ("C-001", 4, "It works")
    assert (json_case.code, json_case.position, json_case.title) == (
        "C-002",
        5,
        "Reverse mapped",
    )


@pytest.mark.parametrize(
    ("name", "content", "message"),
    [
        ("report.md", fixture_bytes("report.md"), "case boundaries"),
        ("empty.csv", b"", "empty"),
        ("bad.txt", b"anything", "unsupported"),
        ("bad.csv", b"\xff\xfe", "UTF-8"),
        ("missing.csv", "用例编号,用例标题\nX-1,\n".encode(), "title"),
        ("duplicate.csv", b"id,title\nX-1,One\nX-1,Two\n", "duplicate code"),
        (
            "positions.csv",
            b"id,order,title\nX-1,1,One\nX-2,1,Two\n",
            "duplicate position",
        ),
    ],
)
def test_invalid_imports_are_descriptive(name, content, message):
    with pytest.raises(ImportErrorDetail, match=message):
        parse_file(name, content)


def test_size_and_case_count_limits_are_enforced():
    with pytest.raises(ImportErrorDetail, match="10 MB"):
        parse_file("large.csv", b"x" * (10 * 1024 * 1024 + 1))

    rows = [f"X-{index},Case {index}" for index in range(1, 5002)]
    content = ("id,title\n" + "\n".join(rows)).encode()
    with pytest.raises(ImportErrorDetail, match="5000"):
        parse_file("many.csv", content)


def test_ambiguous_markdown_boundaries_are_rejected():
    markdown = """\
#### A-001 · Heading case
| 字段 | 内容 |
| --- | --- |
| 用例编号 | A-001 |
| 用例标题 | Heading case |

| 编号 | 标题 | 步骤 | 预期 |
| --- | --- | --- | --- |
| A-002 | Table case | Do it | Done |
"""

    with pytest.raises(ImportErrorDetail, match="ambiguous"):
        parse_file("ambiguous.md", markdown.encode())


def test_markdown_heading_without_a_case_field_table_is_rejected():
    report = "#### R-001 · Failed case\nThis is a report narrative, not a case definition.\n"

    with pytest.raises(ImportErrorDetail, match="case boundaries"):
        parse_file("report.md", report.encode())


def test_csv_rejects_an_unclosed_quoted_field():
    content = b'id,title\nX-1,"First\nX-2,Second\n'

    with pytest.raises(ImportErrorDetail, match="Invalid CSV"):
        parse_file("broken.csv", content)


def test_json_rejects_fractional_positions_and_nonstandard_numbers():
    fractional = b'[{"id":"X-1","order":1.9,"title":"Fractional"}]'
    nonstandard = b'[{"id":"X-1","title":"Not finite","priority":NaN}]'

    with pytest.raises(ImportErrorDetail, match="invalid position"):
        parse_file("fractional.json", fractional)
    with pytest.raises(ImportErrorDetail, match="Invalid JSON"):
        parse_file("nan.json", nonstandard)


def test_markdown_table_preserves_escaped_pipes():
    markdown = """\
| 编号 | 标题 | 步骤 | 预期 |
| --- | --- | --- | --- |
| T-001 | Filter | Enter a \\| b | Shows a \\| b |
"""

    case = parse_file("pipes.md", markdown.encode())[0]

    assert case.steps == "Enter a | b"
    assert case.expected == "Shows a | b"


def test_markdown_unrecognized_h4_cannot_be_merged_into_previous_case():
    markdown = """\
#### M-001 · First
| 字段 | 内容 |
| --- | --- |
| 用例编号 | M-001 |
| 用例标题 | First |

#### 登录场景
| 字段 | 内容 |
| --- | --- |
| 用例编号 | M-002 |
| 用例标题 | Second |
"""

    with pytest.raises(ImportErrorDetail, match="case boundaries"):
        parse_file("merged.md", markdown.encode())


def test_markdown_heading_identity_cannot_be_overwritten_by_its_table():
    markdown = """\
#### M-001 · First
| 字段 | 内容 |
| --- | --- |
| 用例编号 | M-999 |
| 用例标题 | First |
"""

    with pytest.raises(ImportErrorDetail, match="conflicts with heading"):
        parse_file("conflict.md", markdown.encode())


def test_markdown_document_heading_with_field_table_is_not_a_case():
    markdown = """\
#### Feature overview
| Field | Value |
| --- | --- |
| Owner | QA |
"""

    with pytest.raises(ImportErrorDetail, match="case boundaries"):
        parse_file("guide.md", markdown.encode())


RESULT_CSV = (
    "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
    'LOGIN-001,1,账号密码登录,登录,P0,Smoke,存在已注册账号,user=qa01,"1. 打开登录页\n2. 点击登录",'
    '"1. 页面: 跳转到工作台",通过,"1. 实测跳转耗时 1.2s\n2. token 已写入"\n'
    "LOGIN-002,2,密码错误登录,登录,P1,Smoke,,,"
    '"1. 打开登录页\n2. 输入错误密码",'
    '"1. 提示: 账号或密码错误",,留档：本轮未复验\n'
)


def test_csv_reads_the_two_outcome_columns():
    cases = parse_file("result.csv", RESULT_CSV.encode("utf-8"))

    assert [case.result for case in cases] == ["通过", None]
    assert cases[0].evidence == "1. 实测跳转耗时 1.2s\n2. token 已写入"
    # 结果为空的行仍然带着留档文本：它只是没有结论，不是没有过程记录。
    assert cases[1].evidence == "留档：本轮未复验"
    assert cases[0].raw["执行结果"] == "通过"


def test_outcome_columns_are_optional():
    cases = parse_file("plain.csv", fixture_bytes("group14.csv"))

    assert cases[0].result is None
    assert cases[0].evidence is None
