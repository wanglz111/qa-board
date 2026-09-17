import { afterEach, vi } from "vitest";

import {
  startIndexFor,
  allTested,
  readCursor,
  writeCursor,
  clearCursor
} from "./executionCursor";
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
  expect(startIndexFor(CASES, null)).toBe(2);
});

it("counts a skipped case as done", () => {
  const cases = [caseWith("B-001", "未执行"), caseWith("B-002", null)];
  expect(startIndexFor(cases, null)).toBe(1);
});

it("returns to the case being looked at when it still exists", () => {
  expect(startIndexFor(CASES, "B-002")).toBe(1);
});

it("falls back to the first untested case for a code that is gone", () => {
  expect(startIndexFor(CASES, "B-999")).toBe(2);
});

it("stays on the last case when the whole group is done", () => {
  const done = [caseWith("B-001", "通过"), caseWith("B-002", "通过")];
  expect(startIndexFor(done, null)).toBe(1);
  expect(allTested(done)).toBe(true);
  expect(allTested(CASES)).toBe(false);
  expect(allTested([])).toBe(false);
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
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
