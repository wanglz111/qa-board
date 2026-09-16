# TestDeck Group Execution And Retest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit each task when its tests pass.

**Goal:** Execute only the selected imported group, save all outcomes in PostgreSQL, and create distinct attempts and retest labels without overwriting prior results.

**Architecture:** Cases are immutable group snapshots from Plan 01. Every submit appends an Attempt; current group progress derives from the latest Attempt of each GroupCase. Private screenshots attach to Attempts, and React renders an efficient keyboard-operable execution workspace. Old Lark data remains unavailable until Plan 03, so no external writes occur here.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, PostgreSQL, React/TypeScript, Vitest, Playwright.

---

## File Ownership

- `backend/app/models.py`, `backend/alembic/versions/0002_attempts.py`: append-only attempts, attachment metadata, retest allocation.
- `backend/app/execution.py`: attempt creation, group-scoped progress, history, server-side idempotency.
- `backend/app/screenshots.py`: authenticated attachment upload, retrieval and size/content checks.
- `backend/app/reports.py`: CSV/XLSX group reports; no public screenshot URL.
- `frontend/src/views/Execution.tsx`, `frontend/src/components/{CaseDetail,History,OutcomeForm,GroupSelector}.tsx`: single-case execution, navigation and history.
- `frontend/src/useCaseKeys.ts`, `frontend/src/usePiP.ts`: keyboard and Document PiP boundaries.
- `backend/tests/test_{execution,screenshots,reports}.py`, `frontend/src/**/*.test.tsx`, `frontend/e2e/*.spec.ts`: focused regression tests.

### Task 1: Append-Only Attempts And Database Progress

**Files:** Modify `backend/app/models.py`; create `backend/alembic/versions/0002_attempts.py`, `backend/app/execution.py`, `backend/tests/test_execution.py`.

- [ ] Write a failing DB/API test:

```python
def test_results_are_group_scoped_and_history_is_append_only(client, groups_with_shared_b001):
    first_id, second_id = groups_with_shared_b001
    one = client.post(f"/api/groups/{first_id}/cases/B-001/attempts",
                      json={"result": "不通过", "note": "binding failed", "idempotency_key": "first"})
    assert one.status_code == 201
    two = client.get(f"/api/groups/{second_id}/progress").json()
    assert two["untested"] == 1 and two["failed"] == 0
```

- [ ] Run `cd backend && python -m pytest tests/test_execution.py -q`; expected failure: attempts route absent.
- [ ] Add `Attempt(id UUID, group_case_id FK, label, sequence, state started/committed, result NULL until committed CHECK IN ('通过','不通过','未执行'), note, console_text, idempotency_key, created_at)`, and `Screenshot(id UUID, attempt_id FK, storage_key UNIQUE, mime, size_bytes, created_at)` in migration. Use `UNIQUE(group_case_id,sequence)`, `UNIQUE(group_case_id,label)`, and `UNIQUE(idempotency_key)` for committed requests; `label` must **not** be globally unique because different groups can initially use `B-001`. Position is never changed when saving a result; committed Attempts are immutable. `/api/groups/{id}/progress` counts the last committed Attempt per GroupCase, not old Lark records; `/api/groups/{id}/cases/{code}/attempts` lists all committed history in chronological order.
- [ ] Run migration twice and `cd backend && python -m pytest tests/test_execution.py -q`; add tests for 401/CSRF and two group snapshots sharing `B-001`. Commit `git add backend && git commit -m "feat: persist append-only group execution history"`.

### Task 2: Unique Retest Labels And Idempotent Submission

**Files:** Modify `backend/app/execution.py`, `backend/app/models.py`; create `backend/tests/test_retest.py`.

- [ ] Write a failing test:

```python
def test_same_request_reuses_attempt_but_retest_gets_new_label(client, imported_group):
    url = f"/api/groups/{imported_group}/cases/B-001/attempts"
    payload = {"result": "不通过", "note": "login broken", "idempotency_key": "submit-1"}
    first = client.post(url, json=payload).json()
    assert client.post(url, json=payload).json()["id"] == first["id"]
    next_attempt = client.post(url, json={"result": "通过", "idempotency_key": "submit-2"}).json()
    assert next_attempt["id"] != first["id"]
    assert next_attempt["label"] != first["label"]
```

- [ ] Run `cd backend && python -m pytest tests/test_retest.py -q`; expected failure: repeat submission does not return same attempt.
- [ ] Allocate a stable group short code at import (e.g. `0918-` + first 6 group UUID hex chars); first attempt with no known prior history can display `B-001`, but any new retest gets `B-001-R0918-a1b2c3-01`, `-02`, etc. Plan 03 also applies this label to the **first** attempt if read-only Lark history already contains `B-001`. Allocate sequence under group-case row lock and DB constraints, with conflict retry; do not use source filename alone as a key. Idempotency key maps to one committed Attempt only if group case and payload match; same key with changed payload returns 409. `note` is mandatory for `不通过`; passing retest does not erase old failed Attempt. `POST /api/groups/{id}/cases/{code}/retest` reserves a `started` Attempt and label; `POST /api/attempts/{attempt_id}/submit` commits it once with outcome+idempotency key. Aborted empty started Attempts do not count in progress. Never update a committed Attempt.
- [ ] Run `cd backend && python -m pytest tests/test_retest.py -q`; include concurrent-label allocation and empty-start-not-counted tests. Commit `git add backend && git commit -m "feat: allocate unique retest attempts without overwrite"`.

### Task 3: Authenticated Private Screenshots

**Files:** Create `backend/app/screenshots.py`, `backend/tests/test_screenshots.py`; modify `backend/app/main.py`, `backend/app/models.py`.

- [ ] Write a failing test:

```python
def test_uploaded_attachment_is_private_and_uses_uuid_storage(client, attempt_id, anonymous_client):
    response = client.post(f"/api/attempts/{attempt_id}/screenshots",
                           files={"image": ("../../unsafe.png", valid_png, "image/png")})
    assert response.status_code == 201
    shot_id = response.json()["id"]
    assert response.json()["storage_key"] != "../../unsafe.png"
    assert anonymous_client.get(f"/api/screenshots/{shot_id}").status_code == 401
```

- [ ] Run `cd backend && python -m pytest tests/test_screenshots.py -q`; expected failure: screenshot endpoint absent.
- [ ] Upload at most 20 MB, decode with Pillow and allow PNG/JPEG/WebP. Derive storage key from `uuid4()` and validated MIME rather than client filename, persist in `UPLOAD_DIR` supplied by env, store only key in DB, and serve via `GET /api/screenshots/{id}` after session validation with `Cache-Control: private, no-store`. A failure to write the file must not create a dangling DB row; reject non-images and path traversal. In `backend/tests/conftest.py`, add `valid_png` as Pillow-generated 1x1 PNG bytes, `attempt_id` as a saved local Attempt ID, `anonymous_client` without a session, and `UPLOAD_DIR` as a test-only temporary directory. No proxy `/uploads/` location exists.
- [ ] Run `cd backend && python -m pytest tests/test_screenshots.py -q`; include invalid format/oversize/attempt ID mismatch and persistence-after-restart tests. Commit `git add backend && git commit -m "feat: protect screenshots with administrator auth"`.

### Task 4: Single-Case React Execution Workspace

**Files:** Create `frontend/src/views/Execution.tsx`, `frontend/src/components/{CaseDetail,History,OutcomeForm,GroupSelector}.tsx`, `frontend/src/views/Execution.test.tsx`; modify `frontend/src/App.tsx`, `frontend/src/styles.css`.

- [ ] Write a failing view test:

```tsx
it("shows only selected group's case and asks for failure note", async () => {
  render(<ExecutionView groupId="0918-id" loadCases={loadCases} submit={submit} />);
  expect(await screen.findByText(/B-001/)).toBeInTheDocument();
  expect(screen.queryByText(/0922-id/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "不通过" }));
  expect(screen.getByLabelText("失败说明")).toBeRequired();
});
```

- [ ] Run `cd frontend && npm test -- --run`; expected failure: `ExecutionView` absent.
- [ ] Make group selector display name/count/progress; case detail displays title, module/layer/priority, preconditions, test data, steps, expected, current result and attempt history. Navigation uses `position` within the chosen group only. Outcome form submits pass/fail/skip plus optional console text and image paste/upload; failure requires note. Disabled controls during submission and distinct “saved locally / pending Lark / failed” messages; Lark labels remain pending until Plan 03. Favor compact unframed layout and readable long content at 360px.
- [ ] Run `cd frontend && npm test -- --run && npm run build`; add tests for long text, offline failure, retry and switching to a group sharing `B-001`. Check Playwright screenshots desktop/mobile. Commit `git add frontend && git commit -m "feat: build group-focused test execution desk"`.

### Task 5: Keyboard Navigation And Browser PiP

**Files:** Create `frontend/src/useCaseKeys.ts`, `frontend/src/usePiP.ts`, `frontend/src/useCaseKeys.test.ts`, `frontend/e2e/pip.spec.ts`; modify `frontend/src/views/Execution.tsx`.

- [ ] Write failing shortcut test:

```tsx
it("does not submit when the failure note textarea has focus", () => {
  const onPass = vi.fn();
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  textarea.focus();
  dispatchCaseKey(new KeyboardEvent("keydown", { key: "Enter" }), onPass);
  expect(onPass).not.toHaveBeenCalled();
});
```

- [ ] Run `cd frontend && npm test -- --run`; expected failure: `dispatchCaseKey` absent.
- [ ] Use scoped key listener: Enter pass, Backspace fail, Ctrl+B skip, arrows navigate, Ctrl+Z navigate backward, Ctrl+P toggle PiP, Escape close dialog, but ignore textarea/input/contenteditable and submitting state. For Document PiP, check `documentPictureInPicture` availability; request window only from click/key user activation, copy CSS and move or render the same execution state into PiP, restore focus/content on close. If unavailable, disable PiP command and keep desktop workflow usable.
- [ ] Run Vitest and `cd frontend && npx playwright test e2e/pip.spec.ts`; test supported Chromium and unsupported browser fallback with desktop screenshot. Commit `git add frontend && git commit -m "feat: preserve safe shortcuts and optional PiP"`.

### Task 6: Group-Level Export

**Files:** Create `backend/app/reports.py`, `backend/tests/test_reports.py`, `frontend/src/views/Reports.tsx`; modify `frontend/src/App.tsx`.

- [ ] Write failing report test:

```python
import csv
import io

def test_export_is_group_scoped_and_blocks_spreadsheet_formula(client, imported_group, add_case):
    add_case(imported_group, code="X-001", title="=HYPERLINK(\"https://unsafe.test\")")
    output = client.get(f"/api/groups/{imported_group}/reports.csv")
    assert output.status_code == 200
    titles = [row["title"] for row in csv.DictReader(io.StringIO(output.text))]
    assert "'=HYPERLINK" in titles[-1]
```

- [ ] Run `cd backend && python -m pytest tests/test_reports.py -q`; expected failure: report endpoint absent.
- [ ] Return `GET /api/groups/{id}/reports.csv` and `GET /api/groups/{id}/reports.xlsx` via openpyxl. Include source file/version, only current group's cases, latest attempt, execution history count, result/notes/time and screenshot count; CSV must have a `title` header used by the test. No publicly accessible screenshot URLs. Prefix values beginning `=,+,-,@` with apostrophe for spreadsheet consumers, escape HTML if future HTML report is added. Add `add_case(group_id,code,title)` fixture in `backend/tests/conftest.py` and Reports view with group choice and CSV/XLSX download commands.
- [ ] Run backend/frontend suites and inspect an exported workbook with openpyxl to ensure malicious text is literal. Commit `git add backend frontend && git commit -m "feat: export safe group-level test reports"`.

## Checkpoint Before Plan 03

Fresh verification: `cd backend && python -m pytest -q`, `cd frontend && npm test -- --run && npm run build && npx playwright test`, `git status --short`. Reimport a newer group with shared `B-001` and assert earlier progress remains unchanged. No Lark writes exist yet, and `progress.json` must not be imported anywhere in runtime code.
