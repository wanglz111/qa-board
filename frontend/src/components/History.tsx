import type { Attempt } from "../api";

type Props = {
  attempts: Attempt[];
};

const RESULT_CLASS: Record<string, string> = {
  通过: "result-pass",
  不通过: "result-fail",
  未执行: "result-skip"
};

export function History({ attempts }: Props) {
  return (
    <section className="attempt-history" aria-label="执行历史">
      <div className="history-heading">
        <h3>执行历史</h3>
        <span>{attempts.length > 0 ? `${attempts.length} 次` : "尚无结果"}</span>
      </div>
      {attempts.length === 0 ? (
        <p className="inline-status">该用例还没有执行记录</p>
      ) : (
        <ol className="attempt-list">
          {attempts.map((attempt) => (
            <li key={attempt.id} className="attempt-row">
              <div className="attempt-row-head">
                <code>{attempt.label}</code>
                <span className={`result-badge ${RESULT_CLASS[attempt.result ?? ""] ?? ""}`}>
                  {attempt.result ?? "未提交"}
                </span>
                {attempt.source === "reconcile" ? (
                  <span className="attempt-source">来自表内对账</span>
                ) : null}
                <time dateTime={attempt.created_at}>
                  {new Date(attempt.created_at).toLocaleString()}
                </time>
              </div>
              {attempt.note ? <p className="case-text">说明：{attempt.note}</p> : null}
              {attempt.console_text ? (
                <pre className="console-text">{attempt.console_text}</pre>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
