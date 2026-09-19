import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, RotateCcw, Save, X } from "lucide-react";

import type { AttemptResult } from "../api";
import { ImageZoomDialog } from "./ImageZoomDialog";

export type SaveInput = {
  result: AttemptResult;
  note: string | null;
  consoleText: string | null;
  // 实测过程: the observation itself, which Lark keeps in a column of its own.
  // Optional only because a quick save has nothing to observe — never because
  // it may be smuggled into consoleText.
  evidence?: string | null;
};

export type SaveStatus = {
  tone: "saved" | "error" | "info";
  text: string;
};

export type OutcomeFormHandle = {
  setResult: (result: AttemptResult) => void;
  focusNote: () => void;
  // The 实测过程 as it stands right now, for a caller that saves without going
  // through this form's own submit — the keyboard quick save. Same shape as
  // `setResult`/`focusNote`: the form owns the field, the caller only asks.
  evidence: () => string;
  // Clears the five fields this form owns (result / note / console / evidence /
  // validation).
  // Attachments and the save status belong to the caller: they survive a reset on
  // purpose, so a failed screenshot upload can still be retried. Only a submit
  // whose *request* rejected must skip the reset — a save that landed with a
  // failed upload still resets, because the note is already stored server-side.
  // A case switch resets too, so a note typed for case A can never be submitted
  // under case B. The reset itself is unconditional: the caller decides when.
  reset: () => void;
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

function ImagePreview({
  file,
  disabled,
  onRemove
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const displayName = file.name || "粘贴的截图";

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  return (
    <li className="attachment-preview">
      <div className="attachment-preview-frame">
        {previewUrl ? (
          <button
            type="button"
            className="attachment-preview-open"
            aria-label={`预览 ${displayName}`}
            onClick={() => setZoomed(true)}
          >
            <img src={previewUrl} alt={`缺陷截图：${displayName}`} />
          </button>
        ) : null}
        <button
          type="button"
          className="attachment-remove"
          aria-label={`移除 ${displayName}`}
          disabled={disabled}
          onClick={onRemove}
        >
          <X size={15} />
        </button>
      </div>
      <span className="attachment-name" title={displayName}>{displayName}</span>
      {zoomed && previewUrl ? (
        <ImageZoomDialog
          src={previewUrl}
          alt={displayName}
          title={displayName}
          closeLabel="关闭图片预览"
          onClose={() => setZoomed(false)}
        />
      ) : null}
    </li>
  );
}

export const OutcomeForm = forwardRef<OutcomeFormHandle, Props>(function OutcomeForm(
  { onSave, submitting, images, onImagesChange, status, onRetryUpload },
  ref
) {
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [note, setNote] = useState("");
  const [consoleText, setConsoleText] = useState("");
  const [evidence, setEvidence] = useState("");
  const [validation, setValidation] = useState("");
  const imageInput = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    setResult: (next: AttemptResult) => {
      setResult(next);
      setValidation("");
    },
    focusNote: () => noteInput.current?.focus(),
    evidence: () => evidence,
    reset: () => {
      setResult(null);
      setNote("");
      setConsoleText("");
      setEvidence("");
      setValidation("");
    }
  }));

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
      consoleText: consoleText.trim() === "" ? null : consoleText,
      evidence: evidence.trim() === "" ? null : evidence
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
          ref={noteInput}
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

      <label>
        实测过程
        <textarea
          name="evidence"
          rows={3}
          value={evidence}
          placeholder="观测原文：选择器、实测值、报错原文"
          disabled={submitting}
          onChange={(event) => setEvidence(event.target.value)}
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
            <ImagePreview
              key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
              file={file}
              disabled={submitting}
              onRemove={() => onImagesChange(images.filter((_, position) => position !== index))}
            />
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
});
