# Defect Thumbnail Fullscreen Preview Design

## Goal

Allow users to click a pending defect screenshot thumbnail and inspect the full image without leaving the execution form. The interaction and appearance should match the existing prototype reference-image preview.

## Interaction

- The thumbnail image is a button labelled `预览 <文件名>`.
- Activating it opens a full-viewport modal overlay in the current document, including a Document Picture-in-Picture document.
- The overlay uses the existing `reference-gallery-dialog` presentation: dark backdrop, filename in the top bar, close icon, and a contained full-size image.
- The dialog receives focus when opened so execution keyboard shortcuts do not intercept its keys.
- `Escape` closes the dialog and stops propagation.
- The close icon closes the dialog.
- The existing top-right thumbnail remove control remains independent from previewing.
- This change does not add carousel navigation, download behavior, or a new browser tab.

## Component Design

`ImagePreview` continues to own the object URL lifecycle for one `File`. It gains local `zoomed` state and a dialog ref. The thumbnail and dialog reuse the same object URL, so opening a preview does not allocate another URL and removing the file still revokes the URL on unmount.

The modal reuses the existing `reference-gallery-dialog` CSS class to keep the defect preview aligned with the prototype reference preview. Only a small button-reset rule is added for the clickable thumbnail surface.

## Accessibility

- Thumbnail button: `aria-label="预览 <文件名>"`.
- Overlay: `role="dialog"`, `aria-modal="true"`, and accessible name equal to the filename.
- Close button: `aria-label="关闭图片预览"`.
- The dialog is programmatically focused after opening.

## Verification

- Component test: click the thumbnail, assert the named dialog and full-size image appear, press `Escape`, and assert it closes.
- Browser test: paste a real PNG, open the preview, verify it is visible and decoded, close it, and retain the existing desktop/mobile/PiP coverage.
- Run the full frontend unit suite, production build, Playwright suite, and `git diff --check`.
