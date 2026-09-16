import pytest

from app.lark.link import LarkLinkError, parse_lark_link

WIKI_URL = (
    "https://test-dlfvy3y2svp1.jp.larksuite.com/wiki/FEQQwK3YtiJG9KkKbZrjm08upsg"
    "?table=tblTtOHN29SoDsWU&view=vewzrLrwRG"
)


def test_parses_wiki_link_with_table_and_view():
    link = parse_lark_link(WIKI_URL)
    assert link.kind == "wiki"
    assert link.source_id == "FEQQwK3YtiJG9KkKbZrjm08upsg"
    assert link.table_id == "tblTtOHN29SoDsWU"
    assert link.view_id == "vewzrLrwRG"
    assert link.host == "test-dlfvy3y2svp1.jp.larksuite.com"


def test_parses_base_link_without_query():
    link = parse_lark_link("https://tenant.larksuite.com/base/bascnAbc123")
    assert (link.kind, link.source_id, link.table_id, link.view_id) == (
        "base",
        "bascnAbc123",
        None,
        None,
    )


def test_lowercases_the_host_without_touching_the_document_id():
    link = parse_lark_link(
        "https://TENANT.LARKSUITE.COM/wiki/FEQQwK3YtiJG9KkKbZrjm08upsg"
    )
    assert link.host == "tenant.larksuite.com"
    assert link.source_id == "FEQQwK3YtiJG9KkKbZrjm08upsg"


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        ("https://tenant.larksuite.com/docx/doxcnAbc", "无法读取表头"),
        ("https://tenant.larksuite.com/sheets/shtcnAbc", "无法读取表头"),
        ("https://tenant.larksuite.com/wiki/", "无法读取表头"),
        ("https://evil.example.com/wiki/node1", "只支持 larksuite.com"),
        ("https://larksuite.com.evil.example.com/wiki/node1", "只支持 larksuite.com"),
        ("not-a-url", "请粘贴"),
        ("https://tenant.larksuite.com/wiki/node1?table=notatable", "table 参数"),
        ("https://tenant.larksuite.com/base/..", "文档 id"),
        ("https://tenant.larksuite.com/base/node%201", "文档 id"),
        ("https://tenant.larksuite.com/base/" + "a" * 65, "文档 id"),
    ],
)
def test_rejects_anything_that_is_not_a_bitable_link(url, reason):
    with pytest.raises(LarkLinkError, match=reason):
        parse_lark_link(url)
