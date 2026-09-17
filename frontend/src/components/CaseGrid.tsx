import type { AttemptResult, GroupCase } from "../api";

type Props = {
  cases: GroupCase[];
  caseIndex: number;
  onJump: (index: number) => void;
};

// The four tone names are both the CSS classes and the legend's counters, so a
// single union keys the counter object: a square cannot be counted under a name
// it does not carry, and the legend cannot drift from the squares.
type Tone = "passed" | "failed" | "skipped" | "untested";

// 「未执行」 is a colour of its own: a case the operator deliberately skipped is
// not the same thing as a case nobody has looked at, and the difference is the
// whole point of the grid.
const TONE_CLASS: Record<AttemptResult, Tone> = {
  通过: "passed",
  不通过: "failed",
  未执行: "skipped"
};

function toneClass(latest: GroupCase["latest_result"]): Tone {
  return (latest && TONE_CLASS[latest]) || "untested";
}

export function CaseGrid({ cases, caseIndex, onJump }: Props) {
  const counts = { passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const item of cases) counts[toneClass(item.latest_result)] += 1;

  return (
    <div className="case-grid-block">
      <ul className="case-grid" aria-label="用例完成情况">
        {cases.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className={`case-square ${toneClass(item.latest_result)}${index === caseIndex ? " current" : ""}`}
              title={`${item.code} ${item.title}`}
              aria-label={`${item.code} ${item.latest_result ?? "未测"}`}
              aria-current={index === caseIndex ? "true" : undefined}
              onClick={() => onJump(index)}
            />
          </li>
        ))}
      </ul>
      <p className="case-grid-legend">
        通过 {counts.passed} · 不通过 {counts.failed} · 跳过 {counts.skipped} · 未测 {counts.untested}
      </p>
    </div>
  );
}
