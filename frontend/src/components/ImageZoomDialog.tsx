import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent
} from "react";
import { Minus, Plus, X } from "lucide-react";

import type { ReferenceFocus } from "../api";
import {
  clampScale,
  fitWidthScale,
  jumpToBox,
  scrollToKeepPoint,
  stepScale,
  wheelDeltaPixels,
  wheelFactor,
  type Point,
  type Scroll,
  type Size
} from "../imageZoom";
import { FocusOverlay } from "./FocusOverlay";

type Props = {
  src: string;
  alt: string;
  title: string;
  closeLabel: string;
  onClose: () => void;
  // The asset's own size when the caller already knows it. The dialog also
  // reads the real one off the picture once it loads, so a stale record in the
  // API cannot leave the view scaled against a size that is not there.
  natural?: Size | null;
  focus?: ReferenceFocus[];
  // Index into `focus` to land on as soon as the size is known.
  initialFocus?: number | null;
  // Present when the caller can step to a sibling picture; enables ← / →.
  onStep?: (delta: number) => void;
};

// How long the view takes to catch up with the gesture, and how close is close
// enough to stop the frame loop.
const GLIDE_TAU_MS = 60;
const GLIDE_SETTLE = 0.002;

// The one viewer for every picture in the desk.
//
// The picture is laid out at its real size times `scale` inside a scrolling
// stage, rather than being shrunk to fit and then blown up with a transform:
// a long prototype therefore arrives readable (适应宽度) instead of as a strip,
// 1:1 stays pixel exact, and scrolling, trackpad inertia and PageDown come from
// the browser instead of from hand-written panning.
export function ImageZoomDialog({
  src,
  alt,
  title,
  closeLabel,
  onClose,
  natural = null,
  focus = [],
  initialFocus = null,
  onStep
}: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(natural);
  const [scale, setScaleState] = useState(1);
  // Bumped when only the scroll target moved: it forces the commit that writes
  // it, with the new frame already in the DOM.
  const [, setScrollTick] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [activeFocus, setActiveFocus] = useState<number | null>(null);

  const scaleRef = useRef(1);
  // Where the gesture is heading. A pinch is not one event: the OS delivers a
  // stream of coarse ones (a Windows precision touchpad steps ~25px per event,
  // which used to land as a visible 5% jump each time), so the input accumulates
  // here and the view eases toward it on every frame instead of snapping.
  const targetRef = useRef(1);
  // The point of the stage the gesture is holding still, in the stage's own box.
  const anchorRef = useRef<Point | null>(null);
  const glideRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  // 适应宽度 keeps refitting when the stage changes size; that is the whole
  // reason a picture opened in the picture-in-picture window arrives fitted to
  // it. Any manual zoom takes the mode over.
  const modeRef = useRef<"fit" | "manual">("fit");
  const pending = useRef<Scroll | null>(null);
  const sizeRef = useRef<Size | null>(natural);
  const focusRef = useRef(focus);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const jumped = useRef(false);
  const lastSrc = useRef<string | null>(null);

  sizeRef.current = size;
  focusRef.current = focus;
  const naturalWidth = natural?.width ?? 0;
  const naturalHeight = natural?.height ?? 0;

  // Declared first on purpose: every other layout effect may queue a scroll
  // target, and this is the one that writes it — after the commit that carries
  // the new picture size, never before it.
  useLayoutEffect(() => {
    const el = stage.current;
    const next = pending.current;
    if (!el || !next) return;
    // The offset may only be written once the stage really holds the picture at
    // the current scale. It does not yet while the bytes are still arriving, and
    // it does not yet inside the pass that queued it — effects are not promised
    // to run exactly once (StrictMode runs them twice on purpose). Written
    // early, the browser clamps the offset against the older, shorter layout and
    // the requested view is lost. So: keep the request until the layout can take
    // it.
    const expected = sizeRef.current ? sizeRef.current.height * scaleRef.current : 0;
    if (expected > 0 && el.scrollHeight + 1 < expected) return;
    pending.current = null;
    el.scrollLeft = next.left;
    el.scrollTop = next.top;
  });

  // The glide's single tunable: how long the view takes to catch up with the
  // gesture. Short enough to feel attached to the finger, long enough that a
  // coarse event stream reads as motion instead of as steps.
  const stopGlide = useCallback(() => {
    if (glideRef.current !== null) cancelAnimationFrame(glideRef.current);
    glideRef.current = null;
    lastFrameRef.current = 0;
  }, []);

  // The one place a scale reaches the DOM. A glide frame writes here too, so
  // there is a single path for "the picture is now this big".
  const commit = useCallback((next: number, scroll: Scroll | null) => {
    const value = clampScale(next);
    const changed = Math.abs(value - scaleRef.current) >= 1e-9;
    scaleRef.current = value;
    pending.current = scroll;
    if (changed) {
      setScaleState(value);
      return;
    }
    // The scale stays where it is, so React would skip the render — but the
    // offset still has to be written after a commit. Written here instead, the
    // browser would clamp it against the layout currently on screen (the
    // previous scale's frame), which is how a jump to a focus box lands in the
    // wrong place.
    setScrollTick((tick) => tick + 1);
  }, []);

  // The offsets that keep the anchored point still while the scale moves.
  const holdScroll = useCallback(
    (from: number, to: number, pointer: Point | null): Scroll | null => {
      const el = stage.current;
      const picture = sizeRef.current;
      if (!pointer || !el || !picture) return null;
      return scrollToKeepPoint({
        scale: from,
        nextScale: to,
        pointer,
        scroll: { left: el.scrollLeft, top: el.scrollTop },
        viewport: { width: el.clientWidth, height: el.clientHeight },
        picture
      });
    },
    []
  );

  const tick = useCallback(
    (now: number) => {
      glideRef.current = null;
      const target = clampScale(targetRef.current);
      const current = scaleRef.current;
      if (Math.abs(target - current) < GLIDE_SETTLE) {
        commit(target, holdScroll(current, target, anchorRef.current));
        return;
      }
      // Frame-rate independent easing, so a 120Hz screen and a 60Hz one settle
      // in the same wall-clock time.
      const elapsed = lastFrameRef.current === 0 ? 16.7 : Math.min(now - lastFrameRef.current, 64);
      lastFrameRef.current = now;
      const next = current + (target - current) * (1 - Math.exp(-elapsed / GLIDE_TAU_MS));
      commit(next, holdScroll(current, next, anchorRef.current));
      glideRef.current = requestAnimationFrame(tick);
    },
    [commit, holdScroll]
  );

  // Writes a scale the caller has already decided on. Deliberate jumps (适应宽度,
  // 1:1, a step button, a focus box) land at once: predictable, and the toolbar
  // reading stays exact to what the operator asked for.
  const applyNow = useCallback((next: number, scroll: Scroll | null) => {
    stopGlide();
    const value = clampScale(next);
    targetRef.current = value;
    commit(value, scroll);
  }, [commit, stopGlide]);

  // Only the gesture glides, and it glides toward the scale the finger keeps
  // asking for — a coarse event stream then reads as continuous motion rather
  // than as steps.
  const glideTo = useCallback(
    (next: number, pointer: Point | null) => {
      targetRef.current = clampScale(next);
      if (pointer) anchorRef.current = pointer;
      if (glideRef.current === null) glideRef.current = requestAnimationFrame(tick);
    },
    [tick]
  );

  const toFit = useCallback(
    (resetScroll: boolean) => {
      modeRef.current = "fit";
      const el = stage.current;
      applyNow(
        fitWidthScale(sizeRef.current, el?.clientWidth ?? 0),
        resetScroll ? { left: 0, top: 0 } : null
      );
    },
    [applyNow]
  );

  // The point of the stage in the middle of the viewport right now, which is
  // what a toolbar zoom holds still.
  const centreOf = useCallback(
    (el: HTMLElement | null): Point | null =>
      el ? { x: el.clientWidth / 2, y: el.scrollTop + el.clientHeight / 2 } : null,
    []
  );

  const zoomTo = useCallback(
    (next: number, pointer: Point | null) => {
      const value = clampScale(next);
      applyNow(value, holdScroll(scaleRef.current, value, pointer));
    },
    [applyNow, holdScroll]
  );

  const zoomBy = useCallback(
    (direction: number) => {
      modeRef.current = "manual";
      zoomTo(stepScale(scaleRef.current, direction), centreOf(stage.current));
    },
    [centreOf, zoomTo]
  );

  const zoomActual = useCallback(() => {
    modeRef.current = "manual";
    zoomTo(1, centreOf(stage.current));
  }, [centreOf, zoomTo]);

  const jumpTo = useCallback(
    (index: number) => {
      const el = stage.current;
      const current = sizeRef.current;
      const item = focusRef.current[index];
      if (!el || !current || !item?.box) return;
      const target = jumpToBox({
        box: item.box,
        natural: current,
        container: { width: el.clientWidth, height: el.clientHeight },
        scale: scaleRef.current
      });
      if (!target) return;
      // The operator asked to look at one box, so a later window resize may not
      // steal the view back to 适应宽度.
      modeRef.current = "manual";
      setActiveFocus(index);
      applyNow(target.scale, target.scroll);
    },
    [applyNow]
  );

  const toggleActual = useCallback(() => {
    const el = stage.current;
    const current = sizeRef.current;
    if (!el || !current) return;
    const fit = fitWidthScale(current, el.clientWidth);
    if (Math.abs(scaleRef.current - fit) < 0.01) zoomActual();
    else toFit(false);
  }, [toFit, zoomActual]);

  // A new picture starts over: fitted, at the top, nothing highlighted.
  useLayoutEffect(() => {
    setSize(naturalWidth > 0 && naturalHeight > 0 ? { width: naturalWidth, height: naturalHeight } : null);
  }, [src, naturalWidth, naturalHeight]);

  useLayoutEffect(() => {
    const fresh = lastSrc.current !== src;
    lastSrc.current = src;
    if (fresh) {
      jumped.current = false;
      setActiveFocus(null);
      modeRef.current = "fit";
    }
    if (modeRef.current !== "fit" || !size) return;
    applyNow(fitWidthScale(size, stage.current?.clientWidth ?? 0), fresh ? { left: 0, top: 0 } : null);
  }, [src, size, applyNow]);

  // Opening in the picture-in-picture window or resizing the browser changes
  // the stage width; 适应宽度 has to follow it or the picture is refitted to a
  // container that no longer exists.
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (modeRef.current !== "fit") return;
      const node = stage.current;
      applyNow(fitWidthScale(sizeRef.current, node?.clientWidth ?? 0), null);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [applyNow]);

  // React's own wheel listener is passive, so it cannot stop the browser from
  // turning a pinch into a page zoom. This one is attached by hand on purpose.
  // A plain wheel is not intercepted: it is the operator scrolling the picture.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      modeRef.current = "manual";
      // Accumulate into the target rather than moving the picture here: the
      // frame loop eases toward it, which is what turns a stream of coarse
      // events into a continuous zoom.
      glideTo(targetRef.current * wheelFactor(wheelDeltaPixels(event)), pointer);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [glideTo]);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  // A frame loop outliving the viewer would keep writing to a detached stage.
  useEffect(() => stopGlide, [stopGlide]);

  // Landing on a focus box needs the real size, which may only arrive with the
  // picture's own load event.
  useLayoutEffect(() => {
    if (jumped.current || typeof initialFocus !== "number" || !size) return;
    jumped.current = true;
    jumpTo(initialFocus);
  }, [initialFocus, size, jumpTo]);

  function onLoad(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width <= 0 || height <= 0) return;
    if (sizeRef.current?.width === width && sizeRef.current?.height === height) return;
    const next = { width, height };
    sizeRef.current = next;
    setSize(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const key = event.key;
    if (key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && onStep) {
      event.stopPropagation();
      onStep(key === "ArrowLeft" ? -1 : 1);
    } else if (key === "+" || key === "=") {
      event.stopPropagation();
      zoomBy(1);
    } else if (key === "-" || key === "_") {
      event.stopPropagation();
      zoomBy(-1);
    } else if (key === "0") {
      event.stopPropagation();
      toFit(false);
    } else if (key === "1") {
      event.stopPropagation();
      zoomActual();
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const el = stage.current;
    // Touch already scrolls natively, and a synthetic drag there would fight
    // the browser's own momentum.
    if (!el || event.pointerType !== "mouse" || event.button !== 0) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture?.(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const el = stage.current;
    const start = drag.current;
    if (!el || !start) return;
    el.scrollLeft = start.left - (event.clientX - start.x);
    el.scrollTop = start.top - (event.clientY - start.y);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    const el = stage.current;
    if (el?.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId);
  }

  const jumpable = focus.flatMap((item, index) => (item.box ? [index] : []));

  return (
    <div
      className="image-zoom-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      ref={dialog}
      onKeyDown={onKeyDown}
    >
      <div className="image-zoom-bar">
        <span className="image-zoom-title" title={title}>{title}</span>
        <div className="image-zoom-tools">
          <button type="button" className="icon-button" aria-label="缩小" onClick={() => zoomBy(-1)}>
            <Minus size={16} />
          </button>
          <button
            type="button"
            className="image-zoom-readout"
            aria-label={`当前缩放 ${Math.round(scale * 100)}%，点击回到适应宽度`}
            onClick={() => toFit(false)}
          >
            {Math.round(scale * 100)}%
          </button>
          <button type="button" className="icon-button" aria-label="放大" onClick={() => zoomBy(1)}>
            <Plus size={16} />
          </button>
          <button type="button" className="ghost-button" aria-label="适应宽度" onClick={() => toFit(false)}>
            适应宽度
          </button>
          <button type="button" className="ghost-button" aria-label="原始尺寸 1:1" onClick={zoomActual}>
            1:1
          </button>
          <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </div>
      <div
        className="image-zoom-stage"
        ref={stage}
        data-dragging={dragging ? "true" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={toggleActual}
      >
        <div
          className="image-zoom-frame"
          data-pending={size ? undefined : "true"}
          // `min-height` from the known size, so the stage already has the
          // picture's real height before its bytes arrive. Without it the frame
          // is 0px tall until load, the browser clamps any scroll target the
          // operator's action queued (a box to land on) to 0, and that view is
          // lost — the picture then opens at the top with the wrong scroll.
          style={
            size
              ? { width: `${size.width * scale}px`, minHeight: `${size.height * scale}px` }
              : undefined
          }
        >
          <img className="image-zoom-img" src={src} alt={alt} draggable={false} onLoad={onLoad} />
          <FocusOverlay focus={focus} activeIndex={activeFocus} />
        </div>
      </div>
      {jumpable.length > 0 ? (
        <div className="image-zoom-focus" role="group" aria-label="关注点">
          <span className="image-zoom-focus-hint">关注点</span>
          {jumpable.map((index) => (
            <button
              key={`${focus[index].label}-${index}`}
              type="button"
              className={index === activeFocus ? "image-zoom-chip active" : "image-zoom-chip"}
              title={focus[index].note ?? focus[index].label}
              onClick={() => jumpTo(index)}
            >
              {focus[index].label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
