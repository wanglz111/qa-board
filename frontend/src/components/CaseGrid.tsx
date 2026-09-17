import type { GroupCase } from "../api";
// The classification lives in one module so the desk's counts cannot disagree
// with these squares about which result is which tone.
import { toneOf, type Tone } from "../caseTone";

type Props = {
  cases: GroupCase[];
  caseIndex: number;
  onJump: (index: number) => void;
};

export function CaseGrid({ cases, caseIndex, onJump }: Props) {
  // The four tone names are both the CSS classes and the legend's counters, so a
  // single union keys the counter object: a square cannot be counted under a name
  // it does not carry, and the legend cannot drift from the squares.
  const counts: Record<Tone, number> = { passed: 0, failed: 0, skipped: 0, untested: 0 };
  for (const item of cases) counts[toneOf(item.latest_result)] += 1;

  return (
    <div className="case-grid-block">
      <ul className="case-grid" aria-label="用例完成情况">
        {cases.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className={`case-square ${toneOf(item.latest_result)}${index === caseIndex ? " current" : ""}`}
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
