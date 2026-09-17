import { useCallback, useLayoutEffect, useRef, useState } from "react";

type PipWindow = Window & { document: Document };

type DocumentPictureInPictureApi = {
  requestWindow: (options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }) => Promise<PipWindow>;
  window: PipWindow | null;
};

export type PipWindowHandle = {
  supported: boolean;
  pipWindow: PipWindow | null;
  open: (source: HTMLElement | null) => Promise<PipWindow | null>;
  close: () => void;
  toggle: (source: HTMLElement | null) => Promise<void>;
};

function api(win: unknown): DocumentPictureInPictureApi | null {
  const candidate = (win as { documentPictureInPicture?: DocumentPictureInPictureApi } | null)
    ?.documentPictureInPicture;
  return candidate && typeof candidate.requestWindow === "function" ? candidate : null;
}

export function isPiPSupported(win: unknown = typeof window === "undefined" ? null : window): boolean {
  return api(win) !== null;
}

export function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const cssText = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      const style = to.createElement("style");
      style.textContent = cssText;
      to.head.append(style);
    } catch {
      const owner = sheet.ownerNode as HTMLLinkElement | null;
      if (owner?.href) {
        const link = to.createElement("link");
        link.rel = "stylesheet";
        link.href = owner.href;
        to.head.append(link);
      }
    }
  }
}

// The caller supplies a stable portal host. Moving that exact node preserves
// React state and the event delegation installed on the portal container.
export function usePiP(): PipWindowHandle {
  const [supported] = useState(() => isPiPSupported());
  const [pipWindow, setPipWindow] = useState<PipWindow | null>(null);
  const current = useRef<PipWindow | null>(null);
  const home = useRef<{ parent: Node; nextSibling: ChildNode | null } | null>(null);
  const moved = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const restore = useCallback(() => {
    const source = moved.current;
    const location = home.current;
    moved.current = null;
    home.current = null;
    if (!source || !location) return;
    if (location.nextSibling?.parentNode === location.parent) {
      location.parent.insertBefore(source, location.nextSibling);
    } else {
      location.parent.appendChild(source);
    }
  }, []);

  const close = useCallback(() => {
    const open = current.current;
    current.current = null;
    setPipWindow(null);
    restore();
    if (open) open.close();
    const focusTarget = previousFocus.current;
    previousFocus.current = null;
    if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
  }, [restore]);

  const open = useCallback(
    async (source: HTMLElement | null): Promise<PipWindow | null> => {
      const documentPictureInPicture = api(typeof window === "undefined" ? null : window);
      if (!documentPictureInPicture || !source) return null;
      if (current.current) {
        current.current.focus();
        return current.current;
      }

      // The browser can reject the request (no user activation, policy). The
      // command then simply does nothing instead of raising an unhandled error.
      let pip: PipWindow;
      try {
        pip = await documentPictureInPicture.requestWindow({
          width: 420,
          height: 760,
          disallowReturnToOpener: true
        });
      } catch {
        return null;
      }
      copyStyles(document, pip.document);
      pip.document.documentElement.lang = document.documentElement.lang || "zh-CN";
      pip.document.title = "TestDeck - 用例执行";
      pip.document.body.className = "pip-body";
      const container = pip.document.createElement("div");
      container.className = "pip-surface";
      pip.document.body.append(container);
      previousFocus.current = (document.activeElement as HTMLElement | null) ?? null;
      if (!source.parentNode) {
        pip.close();
        return null;
      }
      home.current = { parent: source.parentNode, nextSibling: source.nextSibling };
      moved.current = source;
      container.append(source);

      pip.addEventListener("pagehide", () => {
        restore();
        current.current = null;
        setPipWindow(null);
      });

      current.current = pip;
      setPipWindow(pip);
      return pip;
    },
    [restore]
  );

  const toggle = useCallback(
    async (source: HTMLElement | null) => {
      if (current.current) close();
      else await open(source);
    },
    [close, open]
  );

  useLayoutEffect(() => () => {
    const open = current.current;
    current.current = null;
    restore();
    open?.close();
  }, [restore]);

  return { supported, pipWindow, open, close, toggle };
}
