from app.lark.provision import PROVISION_FIELD_TYPES, provision_plan


def test_plan_lists_only_the_missing_required_fields():
    existing = [{"field_name": "用例", "type": 1}, {"field_name": "自定义列", "type": 1}]
    plan = provision_plan(existing, "execution")
    names = [field["name"] for field in plan]
    assert "用例" not in names
    assert "自定义列" not in names
    assert names == sorted(set(names))
    assert set(names) == {"结果", "优先级", "负责人", "报告人", "日期", "截图", "控制台"}


def test_plan_is_empty_when_every_header_exists():
    existing = [
        {"field_name": name, "type": PROVISION_FIELD_TYPES[name]}
        for name in PROVISION_FIELD_TYPES
    ]
    assert provision_plan(existing, "execution") == []
    assert provision_plan(existing, "bug") == []


def test_bug_plan_only_covers_the_defect_table():
    names = {field["name"] for field in provision_plan([], "bug")}
    assert names == {"问题描述", "进展状态", "优先级", "反馈时间", "备注", "反馈人"}


def test_plan_marks_date_and_attachment_types():
    plan = {field["name"]: field for field in provision_plan([], "execution")}
    assert plan["日期"]["type"] == 5
    assert plan["截图"]["type"] == 17
    assert plan["结果"]["type"] == 1
