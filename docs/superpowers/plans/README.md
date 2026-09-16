# TestDeck Implementation Order

The approved product behavior is in `CLOUD-DEPLOY-PLAN.md`. Execute these three independently testable increments in order:

1. `2026-09-16-01-foundation-import.md` - single admin, versioned database groups, MD/CSV/JSON books and preview/import UI.
2. `2026-09-16-02-execution-retest.md` - append-only group attempts, screenshots, keyboard/PiP desk and reports. No Lark writes in this increment.
3. `2026-09-16-03-lark-release.md` - legacy read-only mapping, explicit table-name confirmation, new-attempt-only writes, GHCR images and one-command Compose deployment.

For every checkbox task: write the failing test, verify it fails for the expected reason, implement the small change, run focused and affected suites, inspect `git diff --check`, and commit that task's own files immediately. Record the commit in the task plan before starting the next checkbox task. Never stage `.env`, `.env.production`, external case directories, runtime screenshots or backups.

All 18 application tasks remain unstarted. `.gitignore` was a separate completed planning task (`c86d603`). There is no application code or verified GHCR publication yet.
