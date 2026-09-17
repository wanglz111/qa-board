# Defect Thumbnail Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a pending defect screenshot in the same fullscreen viewer used by prototype reference images.

**Architecture:** Keep preview state inside the existing `ImagePreview` so each file continues to own exactly one object URL. Reuse `reference-gallery-dialog` for the modal surface and add only a thumbnail-button reset style.

**Tech Stack:** React 19, TypeScript, Testing Library, Vitest, Playwright, existing CSS.

---

### Task 1: Component Preview Interaction

**Files:**
- Modify: `frontend/src/components/OutcomeForm.test.tsx`
- Modify: `frontend/src/components/OutcomeForm.tsx`

- [ ] **Step 1: Write the failing interaction test**

Extend the controlled screenshot test to click `预览 checkout-error.png`, assert a dialog named `checkout-error.png`, then press Escape and assert the dialog disappears.

```tsx
await userEvent.click(screen.getByRole("button", { name: "预览 checkout-error.png" }));
const dialog = screen.getByRole("dialog", { name: "checkout-error.png" });
expect(within(dialog).getByRole("img", { name: "checkout-error.png" })).toHaveAttribute(
  "src",
  "blob:defect-preview"
);
await userEvent.keyboard("{Escape}");
expect(screen.queryByRole("dialog", { name: "checkout-error.png" })).not.toBeInTheDocument();
```

- [ ] **Step 2: Verify the test fails for the missing preview button**

Run: `npm test -- --run src/components/OutcomeForm.test.tsx`

Expected: FAIL because `预览 checkout-error.png` does not exist.

- [ ] **Step 3: Implement the existing-gallery interaction**

Add `zoomed` state and a focused dialog ref to `ImagePreview`. Render the thumbnail image inside a labelled button. When open, render the existing gallery dialog structure, close on Escape with propagation stopped, and close through an icon button labelled `关闭图片预览`.

```tsx
const [zoomed, setZoomed] = useState(false);
const dialog = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (zoomed) dialog.current?.focus();
}, [zoomed]);
```

The dialog must reuse `previewUrl`; it must not call `URL.createObjectURL` again.

- [ ] **Step 4: Verify the focused component suite passes**

Run: `npm test -- --run src/components/OutcomeForm.test.tsx`

Expected: 4 tests pass, including open and Escape-close behavior.

### Task 2: Visual Alignment and Browser Coverage

**Files:**
- Modify: `frontend/src/styles.css`
- Modify: `frontend/e2e/pip.spec.ts`

- [ ] **Step 1: Add the thumbnail preview button style**

Add a reset that fills the existing square frame and communicates zoom behavior while retaining the current image crop.

```css
.attachment-preview-open { display: block; width: 100%; height: 100%; padding: 0; background: none; border: 0; cursor: zoom-in; }
```

- [ ] **Step 2: Extend browser assertions**

After pasting the PNG, click `预览 checkout-error.png`, verify the named dialog and decoded full image, close it with Escape, and retain the existing removal and no-overflow assertions. Repeat the open/close assertions in the supported Picture-in-Picture branch.

- [ ] **Step 3: Run focused browser verification**

Run: `npm run e2e -- --grep "pasted defect|picture-in-picture"`

Expected: 2 tests pass. Inspect the fullscreen preview screenshots at desktop and mobile sizes.

- [ ] **Step 4: Run the complete verification gate**

Run: `npm test -- --run`

Expected: all frontend unit tests pass.

Run: `npm run build`

Expected: TypeScript and Vite production build complete successfully.

Run: `npm run e2e`

Expected: all Playwright tests pass.

Run: `git diff --check`

Expected: no output and exit code 0.
