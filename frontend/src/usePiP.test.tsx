import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePiP } from "./usePiP";

type FakeApi = {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
  window: Window | null;
};

function Harness() {
  const pip = usePiP();
  const mount = useRef<HTMLDivElement>(null);
  const [source] = useState(() => {
    const node = document.createElement("div");
    node.dataset.testid = "source";
    return node;
  });
  const [clicks, setClicks] = useState(0);

  useLayoutEffect(() => {
    mount.current?.append(source);
  }, [source]);

  return (
    <div>
      <div ref={mount} data-testid="mount" />
      {createPortal(
        <button type="button" onClick={() => setClicks((value) => value + 1)}>
          执行台 {clicks}
        </button>,
        source
      )}
      <button type="button" onClick={() => void pip.open(source)}>
        画中画
      </button>
      <span data-testid="supported">{String(pip.supported)}</span>
    </div>
  );
}

afterEach(() => {
  delete (window as { documentPictureInPicture?: FakeApi }).documentPictureInPicture;
});

describe("usePiP", () => {
  it("reports the command as unsupported when the browser has no Document PiP", () => {
    render(<Harness />);
    expect(screen.getByTestId("supported")).toHaveTextContent("false");
  });

  it("does not raise when the browser rejects the window request", async () => {
    const rejection = vi.fn().mockRejectedValue(new Error("no user activation"));
    (window as { documentPictureInPicture?: FakeApi }).documentPictureInPicture = {
      requestWindow: rejection,
      window: null
    };
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);

    render(<Harness />);
    expect(screen.getByTestId("supported")).toHaveTextContent("true");
    await userEvent.click(screen.getByRole("button", { name: "画中画" }));

    expect(rejection).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("moves the live execution node into PiP so React controls remain interactive", async () => {
    const pipDocument = document.implementation.createHTMLDocument("pip");
    let onPageHide: (() => void) | undefined;
    const pipWindow = {
      document: pipDocument,
      close: vi.fn(),
      focus: vi.fn(),
      addEventListener: vi.fn((name: string, handler: () => void) => {
        if (name === "pagehide") onPageHide = handler;
      })
    } as unknown as Window;
    (window as { documentPictureInPicture?: FakeApi }).documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue(pipWindow),
      window: null
    };

    render(<Harness />);
    const source = screen.getByTestId("source");
    await userEvent.click(screen.getByRole("button", { name: "画中画" }));

    expect(pipDocument.querySelector(".pip-surface")?.firstElementChild).toBe(source);
    const pipButton = pipDocument.querySelector("button");
    expect(pipButton?.textContent).toBe("执行台 0");
    act(() => (pipButton as HTMLButtonElement).click());
    expect(pipButton?.textContent).toBe("执行台 1");

    act(() => onPageHide?.());
    expect(screen.getByTestId("mount")).toContainElement(source);
  });
});

// React 19 needs a tick before effects settle in the harness above.
describe("usePiP cleanup", () => {
  it("closes the mirrored window when the view unmounts", async () => {
    const close = vi.fn();
    const pipDocument = document.implementation.createHTMLDocument("pip");
    (window as { documentPictureInPicture?: FakeApi }).documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue({
        document: pipDocument,
        close,
        focus: vi.fn(),
        addEventListener: vi.fn()
      } as unknown as Window),
      window: null
    };

    const view = render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "画中画" }));
    await vi.waitFor(() => expect(pipDocument.querySelector(".pip-surface")).not.toBeNull());
    view.unmount();

    expect(close).toHaveBeenCalled();
  });
});
