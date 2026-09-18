import { describe, expect, it } from "vitest";

import {
  MAX_SCALE,
  MIN_SCALE,
  clampScale,
  fitWidthScale,
  jumpToBox,
  scrollToKeepPoint,
  stepScale,
  wheelDeltaPixels,
  wheelFactor
} from "./imageZoom";

// C-082's prototype: a tall screenshot, the shape that broke the old viewer.
const LONG = { width: 340, height: 1658 };

describe("clampScale", () => {
  it("holds a scale inside the readable range", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it("falls back to 1 instead of propagating a broken number", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(0)).toBe(1);
    expect(clampScale(-3)).toBe(1);
  });
});

describe("fitWidthScale", () => {
  it("makes the picture span the container", () => {
    expect(fitWidthScale({ width: 480, height: 320 }, 960)).toBe(2);
    expect(fitWidthScale({ width: 1200, height: 800 }, 960)).toBe(0.8);
  });

  it("still answers while the size is unknown", () => {
    expect(fitWidthScale(null, 960)).toBe(1);
    expect(fitWidthScale({ width: 0, height: 0 }, 960)).toBe(1);
    expect(fitWidthScale(LONG, 0)).toBe(1);
  });
});

describe("stepScale", () => {
  it("walks one step in each direction and stops at the bounds", () => {
    expect(stepScale(1, 1)).toBeCloseTo(1.25);
    expect(stepScale(1, -1)).toBeCloseTo(0.8);
    expect(stepScale(MAX_SCALE, 1)).toBe(MAX_SCALE);
    expect(stepScale(MIN_SCALE, -1)).toBe(MIN_SCALE);
  });
});

describe("wheelFactor", () => {
  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });

  it("keeps one flung delta from crossing several stops", () => {
    expect(wheelFactor(-100000)).toBeLessThanOrEqual(2);
    expect(wheelFactor(100000)).toBeGreaterThanOrEqual(0.5);
  });

  it("is symmetric around zero so in and out cancel", () => {
    expect(wheelFactor(-50) * wheelFactor(50)).toBeCloseTo(1);
  });
});

describe("wheelDeltaPixels", () => {
  it("reads a pixel delta as it is", () => {
    expect(wheelDeltaPixels({ deltaY: -25 })).toBe(-25);
    expect(wheelDeltaPixels({ deltaY: 100, deltaMode: 0 })).toBe(100);
  });

  it("scales line and page deltas, which are not pixels", () => {
    // A wheel in line mode reports 3 lines where a pixel-mode wheel reports 48:
    // reading them as pixels would make one notch a 16th of the gesture.
    expect(wheelDeltaPixels({ deltaY: -3, deltaMode: 1 })).toBe(-48);
    expect(wheelDeltaPixels({ deltaY: 1, deltaMode: 2 })).toBe(400);
  });

  it("answers 0 rather than propagating a broken delta", () => {
    expect(wheelDeltaPixels({ deltaY: Number.NaN })).toBe(0);
  });
});

describe("scrollToKeepPoint", () => {
  it("keeps the image point under the pointer when zooming in", () => {
    expect(
      scrollToKeepPoint({ scale: 1, nextScale: 2, pointer: { x: 100, y: 50 }, scroll: { left: 0, top: 0 } })
    ).toEqual({ left: 100, top: 50 });
  });

  it("accounts for the scroll already applied", () => {
    expect(
      scrollToKeepPoint({ scale: 1, nextScale: 2, pointer: { x: 100, y: 50 }, scroll: { left: 200, top: 300 } })
    ).toEqual({ left: 500, top: 650 });
  });

  it("returns to the same view when the scale did not change", () => {
    expect(
      scrollToKeepPoint({ scale: 1.5, nextScale: 1.5, pointer: { x: 40, y: 60 }, scroll: { left: 12, top: 34 } })
    ).toEqual({ left: 12, top: 34 });
  });

  it("follows the centring shift, which goes away as the picture grows", () => {
    // A 600px picture at 1:1 sits centred in a 1000px stage, so it starts at 200.
    const settled = scrollToKeepPoint({
      scale: 1,
      nextScale: 2,
      pointer: { x: 800, y: 100 },
      scroll: { left: 0, top: 0 },
      viewport: { width: 1000, height: 800 },
      picture: { width: 600, height: 1200 }
    });

    // Under the pointer sat picture x = 800 - 200 = 600. At 2x the picture is
    // 1200 wide — wider than the stage, so nothing is centred any more — and
    // that point has to land on 800 again: 600 * 2 - 800 = 400.
    expect(settled.left).toBeCloseTo(400);
    // The shift-free arithmetic would have parked it at 800 and let the anchor
    // drift by half the difference.
    expect(settled.left).not.toBeCloseTo(800);
  });

  it("keeps the shift when the picture stays narrower than the stage", () => {
    const settled = scrollToKeepPoint({
      scale: 1,
      nextScale: 1.5,
      pointer: { x: 500, y: 100 },
      scroll: { left: 0, top: 0 },
      viewport: { width: 1000, height: 800 },
      picture: { width: 400, height: 1200 }
    });

    // starts at 300, so the pointer sits on picture x = 200; at 1.5x the picture
    // is 600 wide and centred by 200 -> 200 * 1.5 + 200 = 500, no scroll needed.
    expect(settled.left).toBeCloseTo(0);
  });
});

describe("jumpToBox", () => {
  const box: [number, number, number, number] = [0.62, 0.78, 0.3, 0.08];

  it("zooms the box up to a readable share of the width and centres it", () => {
    const target = jumpToBox({
      box,
      natural: LONG,
      container: { width: 1000, height: 800 },
      scale: 2.9
    });

    expect(target).not.toBeNull();
    // 0.3 * 340 = 102px wide, and 60% of 1000 is 600, so the box wants 5.9x —
    // capped at 3x so the picture stays legible.
    expect(target?.scale).toBe(3);
    // box centre: (0.62 + 0.15) * 340 * 3 = 785.4 across, (0.78 + 0.04) * 1658 * 3 = 4078.7 down
    expect(target?.scroll.left).toBeCloseTo(785.4 - 500);
    expect(target?.scroll.top).toBeCloseTo(4078.68 - 400);
  });

  it("never zooms out below 适应宽度 and never shrinks a picture that already fits", () => {
    const small = { width: 340, height: 1658 };
    const container = { width: 1000, height: 800 };
    // 适应宽度 is 1000/340 = 2.94, above the 3x ceiling only for a tiny picture;
    // a big box would ask for less than 适应宽度, so 适应宽度 wins.
    expect(
      jumpToBox({ box: [0, 0, 0.9, 0.9], natural: small, container, scale: 1 })?.scale
    ).toBeCloseTo(1000 / 340);
    // A picture already wider than the container: the jump must not zoom out.
    expect(
      jumpToBox({ box: [0, 0, 0.05, 0.05], natural: { width: 4000, height: 2000 }, container, scale: 0.25 })?.scale
    ).toBe(3);
  });

  it("refuses a box it cannot place", () => {
    expect(jumpToBox({ box: [0.1, 0.1, 0, 0.2], natural: LONG, container: { width: 1000, height: 800 }, scale: 1 })).toBeNull();
    expect(jumpToBox({ box, natural: { width: 0, height: 0 }, container: { width: 1000, height: 800 }, scale: 1 })).toBeNull();
  });
});
