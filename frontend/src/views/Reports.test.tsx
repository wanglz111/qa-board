import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Group } from "../api";
import { ReportsView } from "./Reports";

const GROUPS: Group[] = [
  { id: "0918-id", name: "Sprint 0918", source_name: "0918.csv", source_version: "3", count: 14, created_at: "2026-09-16T08:00:00Z", archived_at: null },
  { id: "0922-id", name: "Sprint 0922", source_name: "0922.json", source_version: "1", count: 6, created_at: "2026-09-16T08:00:00Z", archived_at: null }
];

it("downloads only the chosen group's report", async () => {
  render(
    <ReportsView
      loadGroups={async () => GROUPS}
      reportUrl={(groupId, format) => `/api/groups/${groupId}/reports.${format}`}
    />
  );

  expect(await screen.findByRole("link", { name: /下载 CSV/ })).toHaveAttribute(
    "href",
    "/api/groups/0918-id/reports.csv"
  );
  expect(screen.getByRole("link", { name: /下载 XLSX/ })).toHaveAttribute(
    "href",
    "/api/groups/0918-id/reports.xlsx"
  );

  await userEvent.selectOptions(screen.getByLabelText("选择测试组"), "0922-id");

  expect(screen.getByRole("link", { name: /下载 CSV/ })).toHaveAttribute(
    "href",
    "/api/groups/0922-id/reports.csv"
  );
  expect(screen.getByText(/仅导出/)).toHaveTextContent("Sprint 0922");
  expect(screen.getByText(/截图不包含在内/)).toBeVisible();
});
