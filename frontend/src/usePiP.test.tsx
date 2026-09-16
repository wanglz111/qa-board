import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePiP } from "./usePiP";

type FakeApi = {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
  window: Window | null;
};

function Harness() {
  const pip = usePiP();
  const source = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={source} data-testid="source">
        执行台
      </div>
      <button type="button" onClick={() => void pip.open(source.current)}>
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

  it("mirrors the execution node into the PiP document", async () => {
    const pipDocument = document.implementation.createHTMLDocument("pip");
    const pipWindow = {
      document: pipDocument,
      close: vi.fn(),
      focus: vi.fn(),
      addEventListener: vi.fn()
    } as unknown as Window;
    (window as { documentPictureInPicture?: FakeApi }).documentPictureInPicture = {
      requestWindow: vi.fn().mockResolvedValue(pipWindow),
      window: null
    };

    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "画中画" }));

    expect(pipDocument.querySelector(".pip-surface")?.textContent).toContain("执行台");
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

    function Opener() {
      const pip = usePiP();
      const source = useRef<HTMLDivElement>(null);
      useEffect(() => {
        void pip.open(source.current);
      }, [pip]);
      return <div ref={source}>执行台</div>;
    }

    const view = render(<Opener />);
    await vi.waitFor(() => expect(pipDocument.querySelector(".pip-surface")).not.toBeNull());
    view.unmount();

    expect(close).toHaveBeenCalled();
  });
});
