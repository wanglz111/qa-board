import { useCallback, useEffect, useRef, useState } from "react";

type PipWindow = Window & { document: Document };

type DocumentPictureInPictureApi = {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<PipWindow>;
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

// React re-renders in place, so the PiP document mirrors the live node instead
// of copying a snapshot that would silently go stale.
export function mirrorNode(source: HTMLElement, container: HTMLElement): void {
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.removeAttribute("id");
  container.replaceChildren(clone);
}

export function usePiP(): PipWindowHandle {
  const [supported] = useState(() => isPiPSupported());
  const [pipWindow, setPipWindow] = useState<PipWindow | null>(null);
  const current = useRef<PipWindow | null>(null);
  const observer = useRef<MutationObserver | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    const open = current.current;
    observer.current?.disconnect();
    observer.current = null;
    current.current = null;
    setPipWindow(null);
    if (open) open.close();
    const restore = previousFocus.current;
    previousFocus.current = null;
    if (restore && typeof restore.focus === "function") restore.focus();
  }, []);

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
        pip = await documentPictureInPicture.requestWindow({ width: 420, height: 620 });
      } catch {
        return null;
      }
      copyStyles(document, pip.document);
      const container = pip.document.createElement("div");
      container.className = "pip-surface";
      pip.document.body.append(container);
      previousFocus.current = (document.activeElement as HTMLElement | null) ?? null;
      mirrorNode(source, container);

      const sync = new MutationObserver(() => mirrorNode(source, container));
      sync.observe(source, { childList: true, subtree: true, characterData: true, attributes: true });
      observer.current = sync;

      pip.addEventListener("pagehide", () => {
        observer.current?.disconnect();
        observer.current = null;
        current.current = null;
        setPipWindow(null);
      });

      current.current = pip;
      setPipWindow(pip);
      return pip;
    },
    []
  );

  const toggle = useCallback(
    async (source: HTMLElement | null) => {
      if (current.current) close();
      else await open(source);
    },
    [close, open]
  );

  useEffect(() => () => {
    observer.current?.disconnect();
    observer.current = null;
    current.current?.close();
    current.current = null;
  }, []);

  return { supported, pipWindow, open, close, toggle };
}
