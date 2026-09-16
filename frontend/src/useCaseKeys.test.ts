import { afterEach, describe, expect, it, vi } from "vitest";

import { dispatchCaseKey, isTypingTarget, resolveCaseKey, type CaseKeyHandlers } from "./useCaseKeys";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

function focusTarget(tag: "textarea" | "input" | "div"): HTMLElement {
  const element = document.createElement(tag);
  if (tag === "div") element.setAttribute("contenteditable", "true");
  document.body.append(element);
  element.focus();
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTypingTarget", () => {
  it("treats inputs, textareas and contenteditable nodes as typing targets", () => {
    expect(isTypingTarget(focusTarget("textarea"))).toBe(true);
    expect(isTypingTarget(focusTarget("input"))).toBe(true);
    expect(isTypingTarget(focusTarget("div"))).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("dispatchCaseKey", () => {
  it("does not submit when the failure note textarea has focus", () => {
    const onPass = vi.fn();
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    dispatchCaseKey(new KeyboardEvent("keydown", { key: "Enter" }), onPass);
    expect(onPass).not.toHaveBeenCalled();
  });

  it("leaves Enter to the focused control so a button keeps its own action", () => {
    const onPass = vi.fn();
    const button = document.createElement("button");
    button.textContent = "不通过";
    document.body.append(button);
    button.focus();

    expect(dispatchCaseKey(key({ key: "Enter" }), { onPass })).toBe(false);
    expect(onPass).not.toHaveBeenCalled();
  });

  it("submits a pass when nothing editable has focus", () => {
    const onPass = vi.fn();
    expect(dispatchCaseKey(key({ key: "Enter" }), onPass)).toBe(true);
    expect(onPass).toHaveBeenCalledTimes(1);
  });

  it("maps Backspace to failure and Ctrl+B to skip", () => {
    const onFail = vi.fn();
    const onSkip = vi.fn();
    expect(dispatchCaseKey(key({ key: "Backspace" }), { onFail })).toBe(true);
    expect(dispatchCaseKey(key({ key: "b", ctrlKey: true }), { onSkip })).toBe(true);
    expect(dispatchCaseKey(key({ key: "b" }), { onSkip })).toBe(false);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("maps arrows and Ctrl+Z to case navigation and Ctrl+P to the PiP command", () => {
    const handlers: CaseKeyHandlers = {
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onBack: vi.fn(),
      onTogglePiP: vi.fn()
    };
    dispatchCaseKey(key({ key: "ArrowRight" }), handlers);
    dispatchCaseKey(key({ key: "ArrowLeft" }), handlers);
    dispatchCaseKey(key({ key: "z", ctrlKey: true }), handlers);
    dispatchCaseKey(key({ key: "p", ctrlKey: true }), handlers);
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1);
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    expect(handlers.onTogglePiP).toHaveBeenCalledTimes(1);
  });

  it("ignores shortcuts while a submission is in flight", () => {
    const onPass = vi.fn();
    expect(dispatchCaseKey(key({ key: "Enter" }), { onPass, enabled: false })).toBe(false);
    expect(onPass).not.toHaveBeenCalled();
    expect(resolveCaseKey(key({ key: "Enter" }), { onPass, enabled: false })).toBeNull();
  });

  it("leaves plain typing and modified shortcuts alone", () => {
    const handlers: CaseKeyHandlers = { onPass: vi.fn(), onNext: vi.fn() };
    expect(dispatchCaseKey(key({ key: "a" }), handlers)).toBe(false);
    expect(dispatchCaseKey(key({ key: "Enter", altKey: true }), handlers)).toBe(false);
    expect(dispatchCaseKey(key({ key: "ArrowDown", ctrlKey: true }), handlers)).toBe(false);
    expect(handlers.onPass).not.toHaveBeenCalled();
    expect(handlers.onNext).not.toHaveBeenCalled();
  });
});
