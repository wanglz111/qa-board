import { useEffect, useState } from "react";
import { History as HistoryIcon, LoaderCircle, Paperclip, RotateCcw, Table2 } from "lucide-react";

import type { Attempt, LegacyHistory as LegacyHistoryData, LegacyResult } from "../api";

type Props = {
  code: string;
  loadHistory: (code: string) => Promise<LegacyHistoryData>;
  attachmentUrl?: (refId: string, index: number) => string;
  attempts?: Attempt[];
  onStartRetest?: () => void;
  reservedLabel?: string | null;
};

type Tab = "legacy" | "current";

const RESULT_CLASS: Record<string, string> = {
  通过: "result-pass",
  不通过: "result-fail",
  未执行: "result-skip"
};

function formatDate(value: number | null): string {
  if (value === null) return "时间未知";
  return new Date(value * 1000).toLocaleString();
}

function LegacyRecord({ record, attachmentUrl }: { record: LegacyResult; attachmentUrl?: Props["attachmentUrl"] }) {
  return (
    <li className="attempt-row">
      <div className="attempt-row-head">
        <code>{record.case_text || record.record_id}</code>
        <span className={`result-badge ${RESULT_CLASS[record.result ?? ""] ?? ""}`}>
          {record.result ?? "未记录"}
        </span>
        <time>{formatDate(record.observed_at)}</time>
      </div>
      {record.note ? <p className="case-text">{record.note}</p> : null}
      {record.attachments.length > 0 && attachmentUrl ? (
        <ul className="legacy-attachments">
          {record.attachments.map((attachment) => (
            <li key={attachment.index}>
              <Paperclip size={14} />
              {attachment.mime?.startsWith("image/") ? (
                <img
                  src={attachmentUrl(record.ref_id, attachment.index)}
                  alt={attachment.name ?? "旧表截图"}
                  loading="lazy"
                />
              ) : null}
              <span>{attachment.name ?? "附件"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function LegacyHistory({
  code,
  loadHistory,
  attachmentUrl,
  attempts = [],
  onStartRetest,
  reservedLabel
}: Props) {
  const [tab, setTab] = useState<Tab>("legacy");
  const [data, setData] = useState<LegacyHistoryData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    loadHistory(code)
      .then((result) => !cancelled && setData(result))
      .catch((reason) => !cancelled && setError(reason instanceof Error ? reason.message : "读取旧表失败"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [code, loadHistory]);

  // Defensive defaults: a partial payload must degrade, never blank the page.
  const original = data?.original ?? [];
  const retests = data?.retests ?? [];
  const bugs = data?.bugs ?? [];
  const readErrors = data?.read_errors ?? [];
  const unknownCount = data?.unknown_count ?? 0;
  const legacyFailure = original.find((record) => record.result === "不通过") ?? null;
  const uncertain = data ? data.certainty !== "verified" || data.ambiguous === true : false;

  return (
    <section className="attempt-history legacy-history" aria-label="旧表只读记录">
      <div className="legacy-tabs" role="tablist" aria-label="结果视图">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "legacy"}
          className={tab === "legacy" ? "active" : ""}
          onClick={() => setTab("legacy")}
        >
          <Table2 size={15} />旧表只读记录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "current"}
          className={tab === "current" ? "active" : ""}
          onClick={() => setTab("current")}
        >
          <HistoryIcon size={15} />本组测试
        </button>
      </div>

      {tab === "current" ? (
        attempts.length === 0 ? (
          <p className="inline-status">本组还没有执行记录</p>
        ) : (
          <ol className="attempt-list">
            {attempts.map((attempt) => (
              <li key={attempt.id} className="attempt-row">
                <div className="attempt-row-head">
                  <code>{attempt.label}</code>
                  <span className={`result-badge ${RESULT_CLASS[attempt.result ?? ""] ?? ""}`}>
                    {attempt.result ?? "未提交"}
                  </span>
                  <time>{new Date(attempt.created_at).toLocaleString()}</time>
                </div>
                {attempt.note ? <p className="case-text">说明：{attempt.note}</p> : null}
              </li>
            ))}
          </ol>
        )
      ) : loading ? (
        <p className="inline-status"><LoaderCircle className="spin" size={16} />读取旧表</p>
      ) : error ? (
        <p className="inline-status error" role="alert">{error}</p>
      ) : data && !data.available ? (
        <div>
          <p className="inline-status warning">旧表当前不可读，未显示历史结果</p>
          {readErrors.map((item) => (
            <p key={item} className="inline-status error" role="alert">{item}</p>
          ))}
        </div>
      ) : data ? (
        <>
          <p className="legacy-source">
            来源：{data.source_table_name ?? "未知表"} · 读取时间 {new Date(data.read_at).toLocaleString()}
            {data.base_name ? ` · ${data.base_name}` : ""}
          </p>

          {uncertain ? (
            <p className="inline-status warning">
              旧表匹配不确定（{data.uncertainty ?? "缺少可验证的日期"}），未确认上次失败
            </p>
          ) : legacyFailure ? (
            <p className="legacy-failure">上次失败：{legacyFailure.note ?? legacyFailure.result}</p>
          ) : (
            <p className="inline-status">旧表没有该用例的失败记录</p>
          )}

          {bugs.length === 0 ? (
            <p className="inline-status">未匹配到旧缺陷</p>
          ) : (
            <ul className="legacy-bugs">
              {bugs.map((bug) => (
                <li key={bug.record_id ?? bug.description}>
                  <span className="result-badge">旧缺陷 {bug.status ?? "状态未知"}</span>
                  <p className="case-text">{bug.description}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="attachment-hint">
            旧缺陷仅作参考：本工具只新增记录，不会关闭或修改旧缺陷。
          </p>

          {(original.length > 0 || retests.length > 0) && (
            <ol className="attempt-list">
              {[...original, ...retests].map((record) => (
                <LegacyRecord
                  key={record.ref_id}
                  record={record}
                  attachmentUrl={attachmentUrl}
                />
              ))}
            </ol>
          )}

          {unknownCount > 0 ? (
            <p className="inline-status warning">
              另有 {unknownCount} 条旧记录无法解析用例编号，未参与判断
            </p>
          ) : null}

          {onStartRetest ? (
            <div className="legacy-actions">
              <button type="button" className="ghost-button" onClick={onStartRetest}>
                <RotateCcw size={16} />复测（新标签，不覆盖旧结果）
              </button>
              {reservedLabel ? (
                <span className="attachment-hint">已预留 {reservedLabel}</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
