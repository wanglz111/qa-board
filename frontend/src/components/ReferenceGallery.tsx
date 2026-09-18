import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import type { ReferenceAsset, ReferenceFocus } from "../api";
import { ImageZoomDialog } from "./ImageZoomDialog";

type Props = {
  assets: ReferenceAsset[];
  assetUrl: (assetId: string) => string;
};

// A focus box is only useful once the operator can see where it is, so an item
// that carries one opens the viewer on that box instead of just naming a
// percentage nobody can locate by eye.
function FocusList({ focus, onJump }: { focus: ReferenceFocus[]; onJump?: (index: number) => void }) {
  if (focus.length === 0) return null;
  return (
    <ul className="reference-gallery-focus">
      {focus.map((item, index) => {
        const body = (
          <>
            <strong>{item.label}</strong>
            {item.note ? <span>{item.note}</span> : null}
            {item.box ? (
              <span className="reference-gallery-box">
                {item.box.map((value) => `${Math.round(value * 100)}%`).join(" / ")}
              </span>
            ) : null}
          </>
        );
        return (
          <li key={item.label}>
            {onJump && item.box ? (
              <button
                type="button"
                aria-label={`放大查看关注点 ${item.label}`}
                onClick={() => onJump(index)}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ReferenceGallery({ assets, assetUrl }: Props) {
  const expected = assets.filter((asset) => asset.role === "expected");
  // A case can legitimately hold only locator images; then they are all we have.
  const primary = expected.length > 0 ? expected : assets;
  const locators = assets.filter((asset) => asset.role === "locator");
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  // The box to land on when the viewer opens; null opens fitted to the width.
  const [focusTarget, setFocusTarget] = useState<number | null>(null);

  useEffect(() => {
    setIndex(0);
    setZoomed(false);
    setFocusTarget(null);
  }, [assets]);

  if (primary.length === 0) return null;
  const current = primary[Math.min(index, primary.length - 1)];

  function step(delta: number) {
    setFocusTarget(null);
    setIndex((value) => Math.min(Math.max(value + delta, 0), primary.length - 1));
  }

  function open(box: number | null) {
    setFocusTarget(box);
    setZoomed(true);
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
        onClick={() => open(null)}
      >
        <img src={assetUrl(current.id)} alt={current.name} />
      </button>
      <p className="reference-gallery-name">
        <span>{current.caption ?? current.name}</span>
        {current.prototype_version ? <em>原型 {current.prototype_version}</em> : null}
      </p>
      <FocusList focus={current.focus} onJump={open} />
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
                <FocusList focus={asset.focus} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {zoomed ? (
        <ImageZoomDialog
          src={assetUrl(current.id)}
          alt={current.name}
          title={current.name}
          closeLabel="关闭原型图"
          onClose={() => setZoomed(false)}
          natural={{ width: current.width, height: current.height }}
          focus={current.focus}
          initialFocus={focusTarget}
          onStep={primary.length > 1 ? step : undefined}
        />
      ) : null}
    </section>
  );
}
