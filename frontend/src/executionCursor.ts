import type { GroupCase } from "./api";

// Where the operator was, so reopening the page returns to the case they were
// reading instead of the first row of the group.
const KEY = "testdeck.execution.cursor";

export type Cursor = { groupId: string; code: string };

export function readCursor(): Cursor | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cursor> | null;
    if (!parsed || typeof parsed.groupId !== "string" || typeof parsed.code !== "string") {
      return null;
    }
    if (!parsed.groupId || !parsed.code) return null;
    return { groupId: parsed.groupId, code: parsed.code };
  } catch {
    // A cursor is a convenience: storage being unavailable or holding junk must
    // never stop the page from opening a case.
    return null;
  }
}

export function writeCursor(cursor: Cursor): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cursor));
  } catch {
    // Same reasoning: a full or blocked storage is not an execution failure.
  }
}

// Deliberately exported with no caller yet: it completes the cursor's surface so
// the view layer can drop a cursor it cannot honour, instead of writing junk.
export function clearCursor(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Ignored on purpose.
  }
}

// A case is done once it has a result of any kind — 「未执行」 included: someone
// decided about it, so it is not the case to resume on.
function isDone(item: GroupCase): boolean {
  return (item.latest_result ?? null) !== null;
}

// Cases arrive in the server's `position` order, which is what makes "the first
// untested case" mean "the untested case with the lowest position".
export function startIndexFor(cases: GroupCase[], cursor: Cursor | null, groupId: string): number {
  if (cases.length === 0) return 0;
  // A cursor only speaks for the group it was written in: codes repeat across
  // groups, so a code from another group would land on an unrelated case.
  const rememberedCode = cursor && cursor.groupId === groupId ? cursor.code : null;
  if (rememberedCode) {
    const remembered = cases.findIndex((item) => item.code === rememberedCode);
    if (remembered >= 0) return remembered;
  }
  const untested = cases.findIndex((item) => !isDone(item));
  // Everything done: the last row is the most useful place to land, and the
  // page says so out loud rather than pretending there is work left.
  return untested >= 0 ? untested : cases.length - 1;
}

export function allTested(cases: GroupCase[]): boolean {
  return cases.length > 0 && cases.every(isDone);
}
