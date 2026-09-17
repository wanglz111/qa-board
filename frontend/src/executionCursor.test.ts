import { startIndexFor, allTested } from "./executionCursor";
import type { GroupCase } from "./api";

function caseWith(code: string, latest: GroupCase["latest_result"]): GroupCase {
  return {
    id: code,
    code,
    position: 1,
    title: code,
    module: null,
    layer: null,
    priority: null,
    preconditions: null,
    test_data: null,
    steps: null,
    expected: null,
    expect_absent: [],
    visual_check: "text_and_visual",
    prototype_note: null,
    reference_assets: [],
    latest_result: latest
  };
}

const CASES = [
  caseWith("B-001", "通过"),
  caseWith("B-002", "不通过"),
  caseWith("B-003", null),
  caseWith("B-004", null)
];

it("opens on the first case nobody has run", () => {
  expect(startIndexFor(CASES, null, "g1")).toBe(2);
});

it("counts a skipped case as done", () => {
  const cases = [caseWith("B-001", "未执行"), caseWith("B-002", null)];
  expect(startIndexFor(cases, null, "g1")).toBe(1);
});

it("returns to the case being looked at when it still exists", () => {
  expect(startIndexFor(CASES, { groupId: "g1", code: "B-002" }, "g1")).toBe(1);
});

it("ignores a cursor that belongs to another group", () => {
  // Codes repeat between groups, so a cursor written in one group must not
  // decide where another group opens: it would land on an unrelated case.
  expect(startIndexFor(CASES, { groupId: "other", code: "B-002" }, "g1")).toBe(2);
});

it("falls back to the first untested case for a code that is gone", () => {
  expect(startIndexFor(CASES, { groupId: "g1", code: "B-999" }, "g1")).toBe(2);
});

it("stays on the last case when the whole group is done", () => {
  const done = [caseWith("B-001", "通过"), caseWith("B-002", "通过")];
  expect(startIndexFor(done, null, "g1")).toBe(1);
  expect(allTested(done)).toBe(true);
  expect(allTested(CASES)).toBe(false);
  expect(allTested([])).toBe(false);
});
