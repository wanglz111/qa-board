import { afterEach, vi } from "vitest";

import {
  startIndexFor,
  allTested,
  readCursor,
  writeCursor,
  clearCursor
} from "./executionCursor";
import type { GroupCase } from "./api";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

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

it("counts a case whose result field is missing as untested", () => {
  const withoutField = { ...caseWith("B-001", null) } as Partial<GroupCase>;
  delete withoutField.latest_result;
  const cases = [withoutField as GroupCase, caseWith("B-002", "通过")];
  expect(startIndexFor(cases, null, "g1")).toBe(0);
  expect(allTested(cases)).toBe(false);
});

it("returns to the case being looked at when it still exists", () => {
  expect(startIndexFor(CASES, { groupId: "g1", code: "B-002" }, "g1")).toBe(1);
});

it("falls back to the first untested case for a code that is gone", () => {
  expect(startIndexFor(CASES, { groupId: "g1", code: "B-999" }, "g1")).toBe(2);
});

it("ignores a cursor remembered for another group", () => {
  // Codes repeat across groups: this casebook is re-imported under a new group
  // id, so B-002 is also in the group the operator just opened.
  expect(startIndexFor(CASES, { groupId: "g2", code: "B-002" }, "g1")).toBe(2);
});

it("opens on the first case of an empty group", () => {
  expect(startIndexFor([], null, "g1")).toBe(0);
});

it("stays on the last case when the whole group is done", () => {
  const done = [caseWith("B-001", "通过"), caseWith("B-002", "通过")];
  expect(startIndexFor(done, null, "g1")).toBe(1);
  expect(allTested(done)).toBe(true);
  expect(allTested(CASES)).toBe(false);
  expect(allTested([])).toBe(false);
});

it("round-trips a cursor through storage", () => {
  expect(readCursor()).toBeNull();
  writeCursor({ groupId: "g1", code: "B-002" });
  expect(readCursor()).toEqual({ groupId: "g1", code: "B-002" });
  clearCursor();
  expect(readCursor()).toBeNull();
});

it("treats junk in storage as no cursor rather than throwing", () => {
  window.localStorage.setItem("testdeck.execution.cursor", "{not json");
  expect(readCursor()).toBeNull();
  window.localStorage.setItem("testdeck.execution.cursor", JSON.stringify({ groupId: "g1" }));
  expect(readCursor()).toBeNull();
});

it("swallows a storage write that throws", () => {
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("quota exceeded");
  });
  expect(() => writeCursor({ groupId: "g1", code: "B-002" })).not.toThrow();
});
