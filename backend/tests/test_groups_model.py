def test_same_case_number_is_allowed_in_different_groups(
    db_session, make_group_case
):
    first = make_group_case(db_session, group_name="0918", code="B-001")
    second = make_group_case(db_session, group_name="0922", code="B-001")
    db_session.commit()
    assert first.id != second.id
    assert first.group_id != second.group_id
