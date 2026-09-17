import type { AttemptResult, GroupCase } from "./api";

export type Tone = "passed" | "failed" | "skipped" | "untested";

// 「未执行」 is a tone of its own: a case the operator deliberately skipped is not
// the same thing as a case nobody has looked at. One map, so the grid and the
// desk's counts can never disagree about which is which.
const TONES: Record<AttemptResult, Tone> = {
  通过: "passed",
  不通过: "failed",
  未执行: "skipped"
};

export function toneOf(latest: GroupCase["latest_result"]): Tone {
  return (latest && TONES[latest]) || "untested";
}
