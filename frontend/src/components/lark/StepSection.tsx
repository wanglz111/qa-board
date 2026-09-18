import type { ReactNode } from "react";

type StepSectionProps = {
  index: number;                                   // 1..4
  title: string;
  summary: string;                                 // 收起时那一行
  state: "done" | "open" | "todo" | "attention";
  disabled?: boolean;
  onOpen: () => void;
  children?: ReactNode;
};

// 收起时只留「标题行 + summary」：那一行是给不展开的眼睛看的，展开后它就是重复信息。
export function StepSection({
  index,
  title,
  summary,
  state,
  disabled = false,
  onOpen,
  children
}: StepSectionProps) {
  const open = state === "open";
  return (
    <section className={`lark-step lark-step-${state}`} data-state={state}>
      <h3 className="lark-step-heading">
        <button
          type="button"
          className="lark-step-title"
          disabled={disabled}
          aria-expanded={open}
          onClick={onOpen}
        >
          <span className="lark-step-index">第 {index} 步</span>{" "}
          {title}
        </button>
        {open ? null : <span className="lark-step-summary">{summary}</span>}
      </h3>
      {open ? <div className="lark-step-body">{children}</div> : null}
    </section>
  );
}
