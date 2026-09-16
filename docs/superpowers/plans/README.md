# TestDeck Implementation Order

The approved product behavior is in `CLOUD-DEPLOY-PLAN.md`. Execute these three independently testable increments in order:

1. `2026-09-16-01-foundation-import.md` - single admin, versioned database groups, MD/CSV/JSON books and preview/import UI.
2. `2026-09-16-02-execution-retest.md` - append-only group attempts, screenshots, keyboard/PiP desk and reports. No Lark writes in this increment.
3. `2026-09-16-03-lark-release.md` - legacy read-only mapping, explicit table-name confirmation, new-attempt-only writes, GHCR images and one-command Compose deployment.
4. `2026-09-16-04-lark-connection.md` - paste a Lark wiki/base link, bind one execution and one defect table per test group, store them in PostgreSQL, and force a confirmation when a group's table changes.
5. `2026-09-16-05-lark-table-setup.md` - detect missing headers, offer an explicit 「设置表头」 button that creates only the approved fields, and create a whole table when a base has none.
6. `2026-09-16-06-lark-reconcile.md` - read a group's table back (live or from snapshots), diff it against the local records, and resolve each row by hand with multi-select.
7. `2026-09-16-image-case-bundle-import.md` - import a strict casebook v1 ZIP (`casebook.json` + `assets/`), attach reference images to each case, show them beside the case during execution, and hand both AI prompts (with the embedded schema) to the user on the import page.

For every checkbox task: write the failing test, verify it fails for the expected reason, implement the small change, run focused and affected suites, inspect `git diff --check`, and commit that task's own files immediately. Record the commit in the task plan before starting the next checkbox task. Never stage `.env`, `.env.production`, external case directories, runtime screenshots or backups.

Plans 04 to 06 replace the environment-configured Lark target from Plan 03. Run them in order; each one is independently testable but 05 and 06 assume 04 has landed.

All 18 application tasks are complete, plus the nine Plan 04-06 tasks; the delivered
state is `baeeb76` on `feature/cloud-testdeck`. `.gitignore` was a separate completed
planning task (`c86d603`). GHCR publication, the server deployment and the release
procedure are recorded in `docs/HANDOFF-RELEASE.md`.
