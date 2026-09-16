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
    source,
    created_at: "2026-09-16T09:00:00Z"
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
