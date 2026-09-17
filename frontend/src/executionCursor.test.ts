import { afterEach, vi } from "vitest";

import {
  nextUntestedIndex,
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

it("falls back to the first unrun case once the remembered case is done", () => {
  // B-002 already carries a result, so resuming on it would park the operator on
  // a finished row — the first unrun case is the only useful landing spot.
  expect(startIndexFor(CASES, { groupId: "g1", code: "B-002" }, "g1")).toBe(2);
});

it("returns to the remembered case while it is still unrun", () => {
  // B-004 is unrun but is not the first unrun row (B-003 is), so this only
  // passes if the cursor branch is actually honoured.
  expect(startIndexFor(CASES, { groupId: "g1", code: "B-004" }, "g1")).toBe(3);
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

it("advances to the first unrun case after the current one", () => {
  // CASES: B-001 通过, B-002 不通过, B-003 null, B-004 null
  expect(nextUntestedIndex(CASES, 1)).toBe(2);
});

it("wraps around to the earliest unrun case", () => {
  // from the last row (B-004, unrun): nothing after it, so wrap back to B-003
  expect(nextUntestedIndex(CASES, 3)).toBe(2);
});

it("reports nowhere to go once every case has a result", () => {
  const done = [caseWith("B-001", "通过"), caseWith("B-002", "未执行")];
  expect(nextUntestedIndex(done, 0)).toBeNull();
});

it("does not fall back to the current case when it is the only one left", () => {
  expect(nextUntestedIndex([caseWith("B-001", "通过"), caseWith("B-002", null)], 1)).toBeNull();
});

it("has nowhere to go in an empty group", () => {
  expect(nextUntestedIndex([], 0)).toBeNull();
});

it("treats a negative index as 'from the beginning'", () => {
  expect(nextUntestedIndex(CASES, -1)).toBe(2);
});

it("looks strictly after the current case before wrapping", () => {
  // A wrong "first unrun case overall" implementation returns 0 here.
  const spaced = [caseWith("B-001", null), caseWith("B-002", "通过"), caseWith("B-003", null)];
  expect(nextUntestedIndex(spaced, 1)).toBe(2);
});

it("treats an out-of-range start as the beginning of the group", () => {
  // The only unrun case is the last row: a wrap loop capped at `length - 1`
  // never inspects it and wrongly reports nowhere to go.
  const tailUnrun = [caseWith("B-001", "通过"), caseWith("B-002", "通过"), caseWith("B-003", null)];
  expect(nextUntestedIndex(tailUnrun, tailUnrun.length)).toBe(2);
  expect(nextUntestedIndex(tailUnrun, 99)).toBe(2);
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
