import type { ReferenceFocus } from "../api";

type Props = {
  focus: ReferenceFocus[];
  // The box the operator just jumped to. It pulses so the eye lands on it.
  activeIndex?: number | null;
};

// The picture's own rendered box is the positioning context, so a normalised
// box needs no pixel arithmetic and follows every zoom for free — which is
// exactly why the picture may not be laid out with `object-fit`.
export function FocusOverlay({ focus, activeIndex = null }: Props) {
  const boxes = focus.flatMap((item, index) => (item.box ? [{ item, index }] : []));
  if (boxes.length === 0) return null;
  return (
    <span className="image-focus-overlay" aria-hidden="true">
      {boxes.map(({ item, index }) => {
        const [x, y, width, height] = item.box as [number, number, number, number];
        return (
          <span
            key={`${item.label}-${index}`}
            className={index === activeIndex ? "image-focus-box active" : "image-focus-box"}
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${width * 100}%`,
              height: `${height * 100}%`
            }}
          />
        );
      })}
    </span>
  );
}
