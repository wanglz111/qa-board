import type { Health, StepId } from "../../larkDraft";

type LarkHealthStripProps = { health: Health; onJump: (step: StepId) => void };

// 常驻一行。tone 只决定颜色，step 决定「点它去哪儿」；
// step === null（健康态）时它是纯文本 —— 没有可跳的目标就不该长成一个按钮。
// E2：这一行会随 sync / live 变化，所以它是 live region（role="status" 就是
// aria-live="polite" + aria-atomic 的语义），与改造前 LarkCheck.tsx:608 的
// role="status" 实践一致；tone 是 bad 也仍然是 status —— 门 4 要的是健康态
// 没有 role="alert"，不是禁止播报。
export function LarkHealthStrip({ health, onJump }: LarkHealthStripProps) {
  const step = health.step;
  return (
    <p
      className={`inline-status lark-health-strip ${health.tone}`}
      data-tone={health.tone}
      role="status"
      aria-live="polite"
    >
      {step === null ? (
        health.text
      ) : (
        <button type="button" className="lark-health-jump" onClick={() => onJump(step)}>
          {health.text}
        </button>
      )}
    </p>
  );
}
