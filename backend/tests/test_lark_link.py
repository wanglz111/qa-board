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


@pytest.mark.parametrize(
    "url",
    [
        "https://tenant.larksuite.com/docx/doxcnAbc",
        "https://tenant.larksuite.com/sheets/shtcnAbc",
        "https://tenant.larksuite.com/wiki/",
        "https://evil.example.com/wiki/node1",
        "https://larksuite.com.evil.example.com/wiki/node1",
        "not-a-url",
        "https://tenant.larksuite.com/wiki/node1?table=notatable",
    ],
)
def test_rejects_anything_that_is_not_a_bitable_link(url):
    with pytest.raises(LarkLinkError):
        parse_lark_link(url)
