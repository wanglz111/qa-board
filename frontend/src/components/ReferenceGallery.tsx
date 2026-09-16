import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import type { ReferenceAsset } from "../api";

type Props = {
  assets: ReferenceAsset[];
  assetUrl: (assetId: string) => string;
};

export function ReferenceGallery({ assets, assetUrl }: Props) {
  const expected = assets.filter((asset) => asset.role === "expected");
  // A case can legitimately hold only locator images; then they are all we have.
  const primary = expected.length > 0 ? expected : assets;
  const locators = assets.filter((asset) => asset.role === "locator");
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIndex(0);
    setZoomed(false);
  }, [assets]);

  // Focus the overlay so its own keys win over the execution shortcuts.
  useEffect(() => {
    if (zoomed) dialog.current?.focus();
  }, [zoomed]);

  if (primary.length === 0) return null;
  const current = primary[Math.min(index, primary.length - 1)];

  function step(delta: number) {
    setIndex((value) => Math.min(Math.max(value + delta, 0), primary.length - 1));
  }

  return (
    <section className="reference-gallery" aria-label="原型参考图">
      <header className="reference-gallery-heading">
        <div>
          <p className="eyebrow">REFERENCE</p>
          <h3>原型参考图</h3>
        </div>
        <span className="case-count">{index + 1} / {primary.length}</span>
      </header>
      <button
        type="button"
        className="reference-gallery-main"
        aria-label={`放大查看 ${current.name}`}
        onClick={() => setZoomed(true)}
      >
        <img src={assetUrl(current.id)} alt={current.name} />
      </button>
      <p className="reference-gallery-name">
        <span>{current.caption ?? current.name}</span>
        {current.prototype_version ? <em>原型 {current.prototype_version}</em> : null}
      </p>
      {current.focus.length > 0 ? (
        <ul className="reference-gallery-focus">
          {current.focus.map((item) => (
            <li key={item.label}>
              <strong>{item.label}</strong>
              {item.note ? <span>{item.note}</span> : null}
              {item.box ? (
                <span className="reference-gallery-box">
                  {item.box.map((value) => `${Math.round(value * 100)}%`).join(" / ")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {primary.length > 1 ? (
        <div className="reference-gallery-stepper">
          <button
            type="button"
            className="icon-button"
            aria-label="上一张原型图"
            disabled={index === 0}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="下一张原型图"
            disabled={index >= primary.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
      ) : null}
      {locators.length > 0 ? (
        <div className="reference-gallery-locators">
          <p className="eyebrow">定位辅助图</p>
          <ul>
            {locators.map((asset) => (
              <li key={asset.link_id}>
                <img src={assetUrl(asset.id)} alt="" />
                <span>{asset.name}</span>
                {asset.caption && asset.caption !== asset.name ? (
                  <em className="reference-gallery-caption">{asset.caption}</em>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {zoomed ? (
        <div
          className="reference-gallery-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={current.name}
          tabIndex={-1}
          ref={dialog}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setZoomed(false);
            } else if (event.key === "ArrowLeft") {
              event.stopPropagation();
              step(-1);
            } else if (event.key === "ArrowRight") {
              event.stopPropagation();
              step(1);
            }
          }}
        >
          <div className="reference-gallery-dialog-bar">
            <span>{current.name}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭原型图"
              onClick={() => setZoomed(false)}
            >
              <X size={17} />
            </button>
          </div>
          <img src={assetUrl(current.id)} alt={current.name} />
        </div>
      ) : null}
    </section>
  );
}
