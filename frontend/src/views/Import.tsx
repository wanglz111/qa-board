import { ChangeEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, FileText, LoaderCircle, Upload, X } from "lucide-react";

import type { AiPrompt, ImportPreview } from "../api";
import { AiPromptPanel } from "../components/AiPromptPanel";

type Props = {
  preview: (file: File) => Promise<ImportPreview>;
  confirm: (
    ticketId: string,
    name: string,
    mapping: Record<string, string>,
    importResults?: boolean
  ) => Promise<unknown>;
  onImported: () => void;
  loadPrompts?: () => Promise<AiPrompt[]>;
};

type UploadItem = {
  key: string;
  file: File;
  name: string;
  state: "previewing" | "ready" | "importing" | "imported" | "error";
  preview?: ImportPreview;
  mapping: Record<string, string>;
  // Whether confirming this file also writes the rows that carry a conclusion.
  // Defaults to on for a file that has any, and the operator can turn it off.
  writeResults: boolean;
  error?: string;
};

const MAPPING_FIELDS = [
  ["code", "用例编号"],
  ["title", "标题"],
  ["position", "顺序"]
] as const;

export function ImportView({ preview, confirm, onImported, loadPrompts }: Props) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [prompts, setPrompts] = useState<AiPrompt[]>([]);
  const [promptError, setPromptError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loadPrompts) return;
    let active = true;
    loadPrompts()
      .then((loaded) => {
        if (active) setPrompts(loaded);
      })
      .catch(() => {
        if (active) setPromptError("提示词加载失败，可刷新页面重试");
      });
    return () => {
      active = false;
    };
  }, [loadPrompts]);

  async function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const additions = files.map((file): UploadItem => ({
      key: crypto.randomUUID(),
      file,
      name: file.name.replace(/\.(md|markdown|csv|json|zip)$/i, ""),
      state: "previewing",
      mapping: {},
      writeResults: false
    }));
    setItems((current) => [...current, ...additions]);
    await Promise.all(additions.map(loadPreview));
    event.target.value = "";
  }

  async function loadPreview(item: UploadItem) {
    try {
      const result = await preview(item.file);
      patch(item.key, {
        preview: result,
        state: "ready",
        writeResults: (result.result_count ?? 0) > 0
      });
    } catch (reason) {
      patch(item.key, { state: "error", error: errorMessage(reason) });
    }
  }

  async function importItem(item: UploadItem) {
    if (!item.preview) return;
    patch(item.key, { state: "importing", error: undefined });
    try {
      await confirm(item.preview.ticket_id, item.name, item.mapping, item.writeResults);
      patch(item.key, { state: "imported" });
      onImported();
    } catch (reason) {
      patch(item.key, { state: "error", error: errorMessage(reason) });
    }
  }

  function patch(key: string, values: Partial<UploadItem>) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...values } : item));
  }

  function updateMapping(item: UploadItem, field: string, source: string) {
    const mapping = { ...item.mapping };
    if (source) mapping[field] = source;
    else delete mapping[field];
    patch(item.key, { mapping });
  }

  return (
    <section className="workspace-section" aria-labelledby="import-title">
      <div className="section-heading">
        <div><p className="eyebrow">IMPORT</p><h2 id="import-title">导入测试组</h2></div>
        <button className="primary" type="button" onClick={() => inputRef.current?.click()}><Upload size={17} />选择文件</button>
        <input ref={inputRef} className="visually-hidden" aria-label="选择用例文件" type="file" multiple accept=".md,.markdown,.csv,.json,.zip" onChange={chooseFiles} />
      </div>

      <AiPromptPanel prompts={prompts} />
      {promptError ? <p className="inline-status warning" role="status"><AlertCircle size={16} />{promptError}</p> : null}

      {items.length === 0 ? (
        <button className="empty-import" type="button" onClick={() => inputRef.current?.click()}>
          <Upload size={24} /><span>选择用例文件</span><small>MD / CSV / JSON / 带图用例包 ZIP</small>
        </button>
      ) : (
        <div className="upload-list">
          {items.map((item) => (
            <article className="upload-card" key={item.key}>
              <header>
                <FileText size={19} />
                <div><strong>{item.file.name}</strong><span>{formatBytes(item.file.size)}</span></div>
                <button className="icon-button" title="移除" aria-label={`移除 ${item.file.name}`} onClick={() => setItems((all) => all.filter((entry) => entry.key !== item.key))}><X size={17} /></button>
              </header>
              {item.state === "previewing" && <p className="inline-status"><LoaderCircle className="spin" size={16} />正在解析</p>}
              {item.error && <p className="inline-status error" role="alert"><AlertCircle size={16} />{item.error}</p>}
              {item.preview && (
                <div className="preview-body">
                  <div className="preview-summary">
                    <span>{item.preview.detected_format.toUpperCase()}</span>
                    <strong>{item.preview.count}</strong>
                    <span>条用例</span>
                    {item.preview.reference_asset_count ? (
                      <span className="preview-casebook">
                        {` · 原型图 ${item.preview.reference_asset_count} 张`}
                        {item.preview.reference_link_count
                          ? ` · 引用 ${item.preview.reference_link_count} 处`
                          : ""}
                        {item.preview.prototype_version
                          ? ` · 原型版本 ${item.preview.prototype_version}`
                          : ""}
                      </span>
                    ) : null}
                    {(item.preview.result_count ?? 0) > 0 ? (
                      <span className="preview-results">
                        {` · 检出 ${item.preview.result_count} 条执行结果`}
                        {(item.preview.evidence_only_count ?? 0) > 0
                          ? `（其中 ${item.preview.evidence_only_count} 条仅有过程、将只留档）`
                          : ""}
                      </span>
                    ) : null}
                  </div>
                  {(item.preview.result_count ?? 0) > 0 ? (
                    // The row's own layout lives in styles.css
                    // (`.preview-import-results`), beside the other field rules.
                    <label className="preview-import-results">
                      <input
                        type="checkbox"
                        checked={item.writeResults}
                        disabled={item.state === "imported"}
                        onChange={(e) => patch(item.key, { writeResults: e.target.checked })}
                      />
                      一并写入执行结果
                    </label>
                  ) : null}
                  {item.preview.warnings.map((warning) => <p className="inline-status warning" key={warning}><AlertCircle size={16} />{warning}</p>)}
                  <label>组名<input value={item.name} disabled={item.state === "imported"} onChange={(e) => patch(item.key, { name: e.target.value })} /></label>
                  <details>
                    <summary>字段映射</summary>
                    <div className="mapping-grid">
                      {MAPPING_FIELDS.map(([field, label]) => (
                        <label key={field}>{label}
                          <select value={item.mapping[field] ?? ""} onChange={(e) => updateMapping(item, field, e.target.value)}>
                            <option value="">自动识别</option>
                            {item.preview?.fields.map((source) => <option key={source} value={source}>{source}</option>)}
                          </select>
                        </label>
                      ))}
                    </div>
                  </details>
                  <div className="preview-table-wrap">
                    <table><thead><tr><th>编号</th><th>标题</th><th>模块</th><th>原型</th></tr></thead>
                      <tbody>{item.preview.cases.slice(0, 4).map((testCase) => <tr key={testCase.code}><td>{testCase.code}</td><td>{testCase.title}</td><td>{testCase.module ?? "-"}</td><td>{testCase.reference_asset_count ? `原型图 ${testCase.reference_asset_count} 张` : "-"}</td></tr>)}</tbody>
                    </table>
                  </div>
                  <button className={item.state === "imported" ? "success wide" : "primary wide"} disabled={!item.name.trim() || item.state === "importing" || item.state === "imported"} onClick={() => importItem(item)}>
                    {item.state === "imported" ? <><Check size={17} />已导入</> : item.state === "importing" ? <><LoaderCircle className="spin" size={17} />导入中</> : <><Upload size={17} />确认导入</>}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function errorMessage(reason: unknown) { return reason instanceof Error ? reason.message : "请求失败"; }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
