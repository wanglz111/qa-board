import { useState } from "react";
import { Copy, FileDown, Sparkles } from "lucide-react";

export type AiPrompt = {
  id: string;
  title: string;
  summary: string;
  filename: string;
  markdown: string;
};

type Props = { prompts: AiPrompt[] };

export function AiPromptPanel({ prompts }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function copy(prompt: AiPrompt) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(prompt.markdown);
      setCopied(prompt.id);
      setError("");
    } catch {
      setError("复制失败，请改用下载按钮");
    }
  }

  function download(prompt: AiPrompt) {
    const blob = new Blob([prompt.markdown], {
      type: "text/markdown;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = prompt.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (prompts.length === 0) return null;

  return (
    <section className="ai-prompt-panel" aria-label="让 AI 先整理格式">
      <header className="ai-prompt-heading">
        <Sparkles size={18} />
        <div>
          <h3>先用 AI 整理格式，再上传</h3>
          <p>
            把提示词复制给 AI，连同你的需求和已有用例；AI 输出的就是这里能直接导入的格式。
            校验是严格模式，格式不对会整包拒绝并指出具体位置。
          </p>
        </div>
      </header>
      <div className="ai-prompt-cards">
        {prompts.map((prompt) => (
          <article className="ai-prompt-card" key={prompt.id}>
            <div>
              <strong>{prompt.title}</strong>
              <p>{prompt.summary}</p>
            </div>
            <div className="ai-prompt-actions">
              <button type="button" className="primary" onClick={() => void copy(prompt)}>
                <Copy size={15} />
                {copied === prompt.id ? "已复制" : "复制提示词"}
              </button>
              <button
                type="button"
                className="ghost-button"
                aria-label={`下载 ${prompt.filename}`}
                onClick={() => download(prompt)}
              >
                <FileDown size={15} />
                {prompt.filename}
              </button>
            </div>
          </article>
        ))}
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </section>
  );
}
