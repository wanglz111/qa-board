import { useEffect, useRef } from "react";

export type CaseKeyHandlers = {
  onPass?: () => void;
  onFail?: () => void;
  onSkip?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onBack?: () => void;
  onTogglePiP?: () => void;
  onEscape?: () => void;
  enabled?: boolean;
};

export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const element = target as HTMLElement | null | undefined;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea" || tag === "input" || tag === "select") return true;
  if (element.isContentEditable === true) return true;
  const editable = element.getAttribute?.("contenteditable");
  return editable !== null && editable !== undefined && editable !== "false";
}

// Enter activates the focused control itself, so a focused button, link or
// custom widget keeps its own meaning instead of being read as "通过".
export function isEnterOwnedByControl(target: EventTarget | null | undefined): boolean {
  const element = target as HTMLElement | null | undefined;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || tag === "summary") return true;
  const role = element.getAttribute?.("role");
  return role === "button" || role === "tab" || role === "menuitem" || role === "switch";
}

// Keyboard shortcuts must never fire while the tester is typing a failure note,
// so the check reads both the event target and the live focus owner. Tests build
// bare KeyboardEvents, which carry no target even when a field holds focus.
function isTypingContext(event: KeyboardEvent): boolean {
  if (isTypingTarget(event.target)) return true;
  return typeof document !== "undefined" && isTypingTarget(document.activeElement);
}

function isControlContext(event: KeyboardEvent): boolean {
  if (isEnterOwnedByControl(event.target)) return true;
  return typeof document !== "undefined" && isEnterOwnedByControl(document.activeElement);
}

export function resolveCaseKey(
  event: KeyboardEvent,
  handlers: CaseKeyHandlers
): (() => void) | null {
  if (handlers.enabled === false) return null;
  if (event.defaultPrevented || event.altKey) return null;
  if (isTypingContext(event)) return null;
  if (event.key === "Enter" && isControlContext(event)) return null;
  const ctrl = event.ctrlKey || event.metaKey;
  switch (event.key) {
    case "Enter":
      return handlers.onPass ?? null;
    case "Backspace":
      return handlers.onFail ?? null;
    case "Escape":
      return handlers.onEscape ?? null;
    case "b":
    case "B":
      return ctrl ? handlers.onSkip ?? null : null;
    case "p":
    case "P":
      return ctrl ? handlers.onTogglePiP ?? null : null;
    case "z":
    case "Z":
      return ctrl ? handlers.onBack ?? handlers.onPrevious ?? null : null;
    case "ArrowLeft":
    case "ArrowUp":
      return ctrl ? null : handlers.onPrevious ?? null;
    case "ArrowRight":
    case "ArrowDown":
      return ctrl ? null : handlers.onNext ?? null;
    default:
      return null;
  }
}

/**
 * Runs one keyboard event against the shortcut map.
 *
 * @returns true when a shortcut consumed the event.
 */
export function dispatchCaseKey(
  event: KeyboardEvent,
  handlersOrPass: CaseKeyHandlers | (() => void)
): boolean {
  const handlers = typeof handlersOrPass === "function" ? { onPass: handlersOrPass } : handlersOrPass;
  const action = resolveCaseKey(event, handlers);
  if (!action) return false;
  action();
  return true;
}

export function useCaseKeys(handlers: CaseKeyHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dispatchCaseKey(event, latest.current)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
