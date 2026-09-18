// Geometry for the shared image viewer.
//
// Pure on purpose: the arithmetic that decides what the operator sees is the
// part worth testing, and it must not need a layout engine to be verified. The
// component only wires DOM events to these functions.

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;

// 步进 for the toolbar buttons and the +/- keys.
export const ZOOM_STEP = 1.25;

// A jump to a focus box should leave the box at roughly this share of the
// container width. Past 3x a screenshot is mush, so the jump stops there —
// going further is the operator's call, not the button's.
export const JUMP_FILL = 0.6;
export const JUMP_MAX_SCALE = 3;

// A mouse notch is 100px in Chrome, a Windows precision touchpad pinch reports
// around 25px per event, and a trackpad on macOS reports a stream of tiny ones.
// The exponential turns all three into a proportional factor; the clamp stops a
// single flung delta from crossing several stops at once. The factor stays mild
// on purpose: the viewer eases toward the accumulated target on every frame, so
// a finger's small movement has to be able to ask for a small change.
const WHEEL_SENSITIVITY = 0.0015;
const WHEEL_MIN_FACTOR = 0.5;
const WHEEL_MAX_FACTOR = 2;

// Wheel deltas arrive in pixels, lines or pages depending on the device and the
// browser. Reading a line-mode delta as pixels would make one notch a 16th of
// the gesture it really is.
export function wheelDeltaPixels(event: { deltaY: number; deltaMode?: number }): number {
  const delta = Number.isFinite(event.deltaY) ? event.deltaY : 0;
  if (event.deltaMode === 1) return delta * 16;
  if (event.deltaMode === 2) return delta * 400;
  return delta;
}

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Scroll = { left: number; top: number };

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);
}

// 适应宽度: the scale that makes the picture span the container. This is what
// stops a long screenshot being squeezed to fit the viewport height.
export function fitWidthScale(natural: Size | null, viewportWidth: number): number {
  if (!natural || natural.width <= 0 || viewportWidth <= 0) return 1;
  return clampScale(viewportWidth / natural.width);
}

export function stepScale(scale: number, direction: number): number {
  if (direction === 0) return clampScale(scale);
  return clampScale(direction > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP);
}

export function wheelFactor(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const factor = Math.exp(-deltaY * WHEEL_SENSITIVITY);
  return Math.min(Math.max(factor, WHEEL_MIN_FACTOR), WHEEL_MAX_FACTOR);
}

// The scroll offsets that put the image point currently under `pointer` back
// under it once the scale changed. This is the whole reason a zoomed view feels
// anchored instead of jumpy.
//
// `pointer` is measured in the stage's own box. When the stage and the picture
// are given, the auto margins that centre a picture narrower than the stage are
// taken into account — that shift is not constant, it goes to zero as the
// picture grows past the stage, and ignoring it lets the anchor drift by half
// the difference.
export function scrollToKeepPoint(input: {
  scale: number;
  nextScale: number;
  pointer: Point;
  scroll: Scroll;
  viewport?: Size;
  picture?: Size;
}): Scroll {
  const { scale, nextScale, pointer, scroll, viewport, picture } = input;
  if (!Number.isFinite(scale) || scale <= 0) return scroll;
  const ratio = nextScale / scale;
  const shiftBefore = centredShift(viewport, picture, scale);
  const shiftAfter = centredShift(viewport, picture, nextScale);
  return {
    left: (scroll.left + pointer.x - shiftBefore) * ratio - pointer.x + shiftAfter,
    top: (scroll.top + pointer.y) * ratio - pointer.y
  };
}

function centredShift(viewport: Size | undefined, picture: Size | undefined, scale: number): number {
  if (!viewport || !picture) return 0;
  return Math.max(0, (viewport.width - picture.width * scale) / 2);
}

// Where to land when the operator clicks a focus box: zoom until the box fills
// a readable share of the width, then centre it. The scale is floored at 适应宽度
// (never zoom out to show a small box) and ceilinged at max(3x, 适应宽度) (never
// shrink a picture that already spans the container).
export function jumpToBox(input: {
  box: [number, number, number, number];
  natural: Size;
  container: Size;
  scale: number;
}): { scale: number; scroll: Scroll } | null {
  const { box, natural, container } = input;
  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0) return null;
  if (natural.width <= 0 || natural.height <= 0 || container.width <= 0) return null;

  const boxWidth = width * natural.width;
  const fit = fitWidthScale(natural, container.width);
  const wanted = (JUMP_FILL * container.width) / boxWidth;
  const scale = clampScale(Math.min(Math.max(wanted, fit), Math.max(JUMP_MAX_SCALE, fit)));

  const centreX = (x + width / 2) * natural.width * scale;
  const centreY = (y + height / 2) * natural.height * scale;
  return {
    scale,
    scroll: {
      left: centreX - container.width / 2,
      top: centreY - container.height / 2
    }
  };
}
