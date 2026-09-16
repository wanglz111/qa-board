import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ImportView } from "./Import";


it("creates one preview for each selected file", async () => {
  const previewSpy = vi.fn().mockResolvedValue({
    ticket_id: "ticket",
    detected_format: "csv",
    count: 1,
    cases: [],
    fields: [],
    errors: [],
    warnings: []
  });
  render(<ImportView preview={previewSpy} confirm={vi.fn()} onImported={vi.fn()} />);
  const files = [
    new File(["用例编号,用例标题\nB-001,Login"], "0918.csv", { type: "text/csv" }),
    new File(['{"cases":[{"id":"C-001","title":"Bind"}]}'], "0922.json")
  ];

  await userEvent.upload(screen.getByLabelText("选择用例文件"), files);

  expect(previewSpy).toHaveBeenCalledTimes(2);

  await userEvent.upload(screen.getByLabelText("选择用例文件"), files[0]);
  expect(screen.getAllByText("0918.csv")).toHaveLength(2);
  await userEvent.click(screen.getAllByLabelText("移除 0918.csv")[0]);
  expect(screen.getAllByText("0918.csv")).toHaveLength(1);
});
