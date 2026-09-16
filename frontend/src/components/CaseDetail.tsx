import { ChevronLeft, ChevronRight } from "lucide-react";

import type { GroupCase } from "../api";
import { ReferenceGallery } from "./ReferenceGallery";

type Props = {
  testCase: GroupCase;
  position: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  referenceAssetUrl?: (assetId: string) => string;
};

const defaultAssetUrl = (assetId: string) => `/api/case-reference-assets/${assetId}`;

const FIELDS: Array<[keyof GroupCase, string]> = [
  ["module", "模块"],
  ["layer", "分层"],
  ["priority", "优先级"],
  ["preconditions", "前置条件"],
  ["test_data", "测试数据"],
  ["steps", "执行步骤"],
  ["expected", "预期结果"]
];

export function CaseDetail({
  testCase,
  position,
  total,
  onPrevious,
  onNext,
  referenceAssetUrl
}: Props) {
  return (
    <article className="case-detail" aria-labelledby="case-title">
      <header className="case-detail-heading">
        <div>
          <p className="eyebrow">
            <code>{testCase.code}</code> · {position} / {total}
          </p>
          <h2 id="case-title">{testCase.title}</h2>
        </div>
        <div className="case-stepper">
          <button
            type="button"
            className="icon-button"
            aria-label="上一条用例"
            onClick={onPrevious}
            disabled={position <= 1}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="下一条用例"
            onClick={onNext}
            disabled={position >= total}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      </header>
      <dl className="case-fields">
        {FIELDS.map(([key, label]) => {
          const value = testCase[key];
          return (
            <div key={String(key)}>
              <dt>{label}</dt>
              <dd className="case-text">
                {value === null || value === "" ? "—" : String(value)}
              </dd>
            </div>
          );
        })}
      </dl>
      {testCase.expect_absent.length > 0 ? (
        <ul className="expect-absent" aria-label="不应出现">
          {testCase.expect_absent.map((text) => (
            <li key={text}>不应出现：{text}</li>
          ))}
        </ul>
      ) : null}
      <ReferenceGallery
        assets={testCase.reference_assets}
        assetUrl={referenceAssetUrl ?? defaultAssetUrl}
      />
      {testCase.prototype_note ? (
        <p className="prototype-note">
          <strong>原型备注</strong>
          <span>{testCase.prototype_note}</span>
        </p>
      ) : null}
    </article>
  );
}
