import { useRef, useState } from "react";
import { ImagePlus, LoaderCircle, RotateCcw, Save, X } from "lucide-react";

import type { AttemptResult } from "../api";

export type SaveInput = {
  result: AttemptResult;
  note: string | null;
  consoleText: string | null;
};

export type SaveStatus = {
  tone: "saved" | "error" | "info";
  text: string;
};

type Props = {
  onSave: (input: SaveInput) => void;
  submitting: boolean;
  images: File[];
  onImagesChange: (images: File[]) => void;
  status: SaveStatus | null;
  onRetryUpload: () => void;
};

const RESULTS: AttemptResult[] = ["通过", "不通过", "未执行"];

export function OutcomeForm({
  onSave,
  submitting,
  images,
  onImagesChange,
  status,
  onRetryUpload
}: Props) {
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [note, setNote] = useState("");
  const [consoleText, setConsoleText] = useState("");
  const [validation, setValidation] = useState("");
  const imageInput = useRef<HTMLInputElement>(null);

  function appendImages(files: File[]) {
    const additions = files.filter((file) => file.type.startsWith("image/"));
    if (additions.length > 0) onImagesChange([...images, ...additions]);
  }

  function submit() {
    if (result === null) {
      setValidation("请选择执行结果");
      return;
    }
    if (result === "不通过" && note.trim() === "") {
      setValidation("不通过时必须填写失败说明");
      return;
    }
    setValidation("");
    onSave({
      result,
      note: note.trim() === "" ? null : note.trim(),
      consoleText: consoleText.trim() === "" ? null : consoleText
    });
  }

  return (
    <form
      className="outcome-form"
      aria-label="录入执行结果"
      onPaste={(event) => appendImages(Array.from(event.clipboardData.files))}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="result-buttons" role="group" aria-label="执行结果">
        {RESULTS.map((option) => (
          <button
            key={option}
            type="button"
            className={result === option ? `result-option active ${option}` : `result-option ${option}`}
            aria-pressed={result === option}
            disabled={submitting}
            onClick={() => setResult(option)}
          >
            {option}
          </button>
        ))}
      </div>

      <label>
        失败说明
        <textarea
          name="note"
          rows={3}
          value={note}
          required={result === "不通过"}
          disabled={submitting}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      <label>
        控制台输出
        <textarea
          name="console"
          rows={3}
          value={consoleText}
          disabled={submitting}
          onChange={(event) => setConsoleText(event.target.value)}
        />
      </label>

      <div className="attachment-row">
        <input
          ref={imageInput}
          className="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          aria-label="上传截图"
          onChange={(event) => {
            appendImages(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="ghost-button"
          disabled={submitting}
          onClick={() => imageInput.current?.click()}
        >
          <ImagePlus size={16} />添加截图
        </button>
        <span className="attachment-hint">可直接粘贴剪贴板图片</span>
      </div>

      {images.length > 0 ? (
        <ul className="attachment-list">
          {images.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <span>{file.name || "粘贴的截图"}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`移除 ${file.name || "粘贴的截图"}`}
                onClick={() => onImagesChange(images.filter((_, position) => position !== index))}
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {validation ? <p className="form-error" role="alert">{validation}</p> : null}
      {status ? (
        <p className={`inline-status save-status ${status.tone}`} role="status">
          {status.text}
        </p>
      ) : null}

      <div className="outcome-actions">
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
          {submitting ? "保存中" : "保存结果"}
        </button>
        {status?.tone === "error" && images.length > 0 ? (
          <button
            type="button"
            className="ghost-button"
            disabled={submitting}
            onClick={onRetryUpload}
          >
            <RotateCcw size={16} />重试上传截图
          </button>
        ) : null}
      </div>
    </form>
  );
}
