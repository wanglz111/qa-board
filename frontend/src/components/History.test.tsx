import { render, screen, within } from "@testing-library/react";

import type { Attempt } from "../api";
import { History } from "./History";

function attempt(id: string, label: string, source: Attempt["source"]): Attempt {
  return {
    id,
    label,
    sequence: 1,
    state: "committed",
    result: "通过",
    note: null,
    console_text: null,
    evidence: null,
    source,
    created_at: "2026-09-16T09:00:00Z",
    screenshots: []
  };
}

it("marks only the rows that were adopted from the table", () => {
  render(
    <History
      attempts={[
        attempt("attempt-1", "B-001", "execution"),
        attempt("attempt-2", "B-001-R0918-01", "reconcile")
      ]}
    />
  );

  const rows = screen.getAllByRole("listitem");
  expect(within(rows[0]).queryByText("来自表内对账")).not.toBeInTheDocument();
  const badge = within(rows[1]).getByText("来自表内对账");
  expect(badge).toHaveClass("attempt-source");
});

it("shows the screenshots a run was submitted with", () => {
  const shot = {
    id: "shot-1",
    attempt_id: "attempt-1",
    storage_key: "abc123.png",
    mime: "image/png",
    size_bytes: 42,
    created_at: "2026-09-16T09:00:01Z"
  };
  render(
    <History
      attempts={[{ ...attempt("attempt-1", "B-001", "execution"), screenshots: [shot] }]}
      screenshotUrl={(id) => `/api/screenshots/${id}`}
    />
  );

  const image = screen.getByRole("img", { name: "截图 abc123.png" });
  expect(image).toHaveAttribute("src", "/api/screenshots/shot-1");
  expect(screen.getByRole("link", { name: "查看截图 abc123.png" })).toHaveAttribute(
    "href",
    "/api/screenshots/shot-1"
  );
});

it("marks an imported row and shows its evidence", () => {
  render(
    <History
      attempts={[
        { ...attempt("attempt-3", "B-002", "import"), evidence: "1. 实测遮罩 rgba(0,0,0,.65)" }
      ]}
    />
  );

  const row = screen.getByRole("listitem");
  expect(within(row).getByText("来自导入结果")).toHaveClass("attempt-source");
  expect(within(row).getByText(/实测遮罩/)).toBeInTheDocument();
});

it("leaves the picture out when the page has no screenshot route", () => {
  const shot = {
    id: "shot-1",
    attempt_id: "attempt-1",
    storage_key: "abc123.png",
    mime: "image/png",
    size_bytes: 42,
    created_at: "2026-09-16T09:00:01Z"
  };
  render(<History attempts={[{ ...attempt("attempt-1", "B-001", "execution"), screenshots: [shot] }]} />);

  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});
