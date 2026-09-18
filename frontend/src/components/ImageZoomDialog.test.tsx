import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReferenceFocus } from "../api";
import { wheelDeltaPixels, wheelFactor } from "../imageZoom";
import { ImageZoomDialog } from "./ImageZoomDialog";

// C-082's prototype: a tall screenshot, the shape that used to arrive unreadable.
const LONG = { width: 340, height: 1658 };

// The viewer eases toward a gesture over several frames, so the tests drive the
// frames themselves instead of waiting on the environment's timers.
let scheduled = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

function runFrames(timestamp: number) {
  const due = Array.from(scheduled.values());
  scheduled = new Map();
  act(() => {
    for (const callback of due) callback(timestamp);
  });
}

// jsdom has no layout, so the stage reports a real size on purpose: the maths
// under test is exactly "what does the picture do inside a container this big".
// `clientHeight` doubles as the scroll height until a test says otherwise, so
// the stage looks like one that already holds the picture.
const STAGE = { width: 1000, height: 800 };
let stageScrollHeight = 10000;

beforeEach(() => {
  stageScrollHeight = 10000;
  scheduled = new Map();
  nextFrameId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    scheduled.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    scheduled.delete(id);
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => STAGE.width
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => STAGE.height
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => stageScrollHeight
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as unknown as { clientHeight?: number }).clientHeight;
  delete (HTMLElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
});

const stage = () => document.querySelector<HTMLElement>(".image-zoom-stage");
const frame = () => document.querySelector<HTMLElement>(".image-zoom-frame");
const frameWidth = () => Number.parseFloat(frame()?.style.width ?? "0");
const readout = () => screen.getByRole("button", { name: /当前缩放/ });
const percent = () => Number.parseInt(readout().getAttribute("aria-label")?.match(/当前缩放 (\d+)%/)?.[1] ?? "0", 10);

function wheel(deltaY: number, options: { ctrlKey?: boolean; clientX?: number; clientY?: number } = {}) {
  const target = stage();
  if (!target) throw new Error("stage missing");
  return act(() => {
    target.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        ctrlKey: options.ctrlKey ?? false,
        clientX: options.clientX ?? 0,
        clientY: options.clientY ?? 0,
        bubbles: true,
        cancelable: true
      })
    );
  });
}

function open(overrides: Partial<Parameters<typeof ImageZoomDialog>[0]> = {}) {
  const props = {
    src: "/api/case-reference-assets/a1",
    alt: "节点发售",
    title: "节点发售",
    closeLabel: "关闭原型图",
    onClose: vi.fn(),
    natural: LONG,
    ...overrides
  };
  const view = render(<ImageZoomDialog {...props} />);
  return { ...props, view };
}

describe("ImageZoomDialog", () => {
  it("opens fitted to the width so a long prototype is readable, not a strip", () => {
    open();

    // 1000 / 340 = 2.94 — the picture spans the stage instead of fitting its height.
    expect(percent()).toBe(294);
    expect(frameWidth()).toBeCloseTo(1000);
  });

  it("keeps 1:1 pixel exact and goes back to 适应宽度", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "原始尺寸 1:1" }));
    expect(percent()).toBe(100);
    expect(frameWidth()).toBeCloseTo(340);

    await userEvent.click(screen.getByRole("button", { name: "适应宽度" }));
    expect(percent()).toBe(294);
    expect(frameWidth()).toBeCloseTo(1000);
  });

  it("eases toward a pinch over several frames instead of jumping, and keeps the point under the finger", async () => {
    open();
    const fitScale = frameWidth() / LONG.width;
    const pointer = { x: 300, y: 200 };
    const anchoredPicturePoint = 300 / fitScale;

    // One touchpad-sized event. Nothing moves until a frame runs: the gesture
    // asks, the frame loop answers.
    await wheel(-25, { ctrlKey: true, clientX: pointer.x, clientY: pointer.y });
    expect(frameWidth() / LONG.width).toBe(fitScale);

    runFrames(16);
    const firstFrame = frameWidth() / LONG.width;
    expect(firstFrame).toBeGreaterThan(fitScale);
    // …and the whole step is spread over the following frames: the first one
    // carries only a fraction of it.
    const settled = fitScale * wheelFactor(wheelDeltaPixels({ deltaY: -25 }));
    expect(firstFrame).toBeLessThan(fitScale + (settled - fitScale) * 0.5);

    runFrames(32);
    const secondFrame = frameWidth() / LONG.width;
    expect(secondFrame).toBeGreaterThan(firstFrame);
    expect(secondFrame).toBeLessThan(settled);

    // The anchored photograph point stays under the finger on the way.
    expect((300 + (stage()?.scrollLeft ?? 0)) / secondFrame).toBeCloseTo(anchoredPicturePoint);

    for (let stamp = 48; stamp <= 800; stamp += 16) runFrames(stamp);
    expect(frameWidth() / LONG.width).toBeCloseTo(settled, 4);
    expect((300 + (stage()?.scrollLeft ?? 0)) / (frameWidth() / LONG.width)).toBeCloseTo(
      anchoredPicturePoint
    );
  });

  it("accumulates a gesture, so a slow pinch keeps moving the same way", async () => {
    open();
    const fitScale = frameWidth() / LONG.width;

    await wheel(-25, { ctrlKey: true, clientX: 300, clientY: 200 });
    await wheel(-25, { ctrlKey: true, clientX: 300, clientY: 200 });
    for (let stamp = 16; stamp <= 800; stamp += 16) runFrames(stamp);

    const doubled = fitScale * wheelFactor(wheelDeltaPixels({ deltaY: -25 })) ** 2;
    expect(frameWidth() / LONG.width).toBeCloseTo(doubled, 4);
  });

  it("leaves a plain wheel alone, because that is the operator scrolling the picture", async () => {
    open();

    await wheel(120);

    expect(percent()).toBe(294);
    expect(stage()?.scrollLeft).toBe(0);
  });

  it("refuses to let a pinch zoom the browser page out from under the picture", async () => {
    open();

    const target = stage();
    if (!target) throw new Error("stage missing");
    const event = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it("walks the zoom with the toolbar and the keyboard", async () => {
    open();

    await userEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(percent()).toBe(368);
    await userEvent.click(screen.getByRole("button", { name: "缩小" }));
    expect(percent()).toBe(294);

    await userEvent.keyboard("{+}");
    expect(percent()).toBe(368);
    await userEvent.keyboard("0");
    expect(percent()).toBe(294);
    await userEvent.keyboard("1");
    expect(percent()).toBe(100);
  });

  it("toggles between the fitted view and 1:1 on a double click", async () => {
    open();

    await userEvent.dblClick(stage() as HTMLElement);
    expect(percent()).toBe(100);

    await userEvent.dblClick(stage() as HTMLElement);
    expect(percent()).toBe(294);
  });

  it("closes on Escape and hands the arrow keys to the caller", async () => {
    const onClose = vi.fn();
    const onStep = vi.fn();
    open({ onClose, onStep });

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.keyboard("{ArrowRight}");
    expect(onStep.mock.calls.map(([delta]) => delta)).toEqual([-1, 1]);
  });

  it("jumps to the box the operator picked and marks it", async () => {
    const focus: ReferenceFocus[] = [
      { label: "确认按钮", note: "文案应为「确认购买」", box: [0.62, 0.78, 0.3, 0.08] }
    ];
    open({ focus });

    await userEvent.click(screen.getByRole("button", { name: "确认按钮" }));

    // 0.3 * 340px = 102px wide, so 60% of the stage wants 5.9x — capped at 3x.
    expect(percent()).toBe(300);
    expect(stage()?.scrollLeft).toBeCloseTo(0.77 * 340 * 3 - 500);
    expect(stage()?.scrollTop).toBeCloseTo(0.82 * 1658 * 3 - 400);
    expect(document.querySelector(".image-focus-box.active")).not.toBeNull();
  });

  it("keeps a queued landing until the stage can actually scroll there", () => {
    // The picture's bytes have not arrived, so the stage has nothing to scroll
    // yet. Writing the offset here would let the browser clamp it away against
    // the empty layout — the operator's view would be gone for good.
    stageScrollHeight = 0;
    const focus: ReferenceFocus[] = [
      { label: "确认按钮", note: null, box: [0.62, 0.78, 0.3, 0.08] }
    ];
    const { view, ...props } = open({ focus, initialFocus: 0 });

    expect(stage()?.scrollTop).toBe(0);
    expect(percent()).toBe(300);

    // The picture arrives: the stage is now the picture's real height, and the
    // queued landing is written by the next commit.
    stageScrollHeight = 10000;
    view.rerender(<ImageZoomDialog {...props} />);

    expect(stage()?.scrollTop).toBeCloseTo(0.82 * 1658 * 3 - 400);
  });

  it("opens already landed on the box the gallery asked for", () => {
    const focus: ReferenceFocus[] = [
      { label: "头部", note: null, box: [0, 0, 1, 0.12] },
      { label: "确认按钮", note: null, box: [0.62, 0.78, 0.3, 0.08] }
    ];
    open({ focus, initialFocus: 1 });

    expect(percent()).toBe(300);
    expect(screen.getByRole("button", { name: "确认按钮" })).toHaveClass("active");
  });

  it("leaves a box it cannot place to the picture's own view", async () => {
    const focus: ReferenceFocus[] = [{ label: "没有坐标", note: null, box: null }];
    open({ focus });

    expect(screen.queryByRole("button", { name: "没有坐标" })).toBeNull();
    expect(screen.queryByRole("group", { name: "关注点" })).toBeNull();
  });

  it("takes the real size off the picture when the caller has none", () => {
    open({ natural: null });

    const image = screen.getByRole("img", { name: "节点发售" });
    expect(frame()?.dataset.pending).toBe("true");

    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 480 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 2400 });
    act(() => {
      fireEvent.load(image);
    });

    expect(percent()).toBe(208);
    expect(frameWidth()).toBeCloseTo(1000);
  });

  it("paints no focus overlay when there is nothing to point at", () => {
    open();

    expect(document.querySelector(".image-focus-overlay")).toBeNull();
  });
});
