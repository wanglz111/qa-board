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

it("shows casebook totals for a casebook zip", async () => {
  const previewSpy = vi.fn().mockResolvedValue({
    ticket_id: "casebook-ticket",
    detected_format: "zip",
    count: 67,
    title: "Odyssey 节点发售回归",
    reference_asset_count: 99,
    reference_link_count: 182,
    prototype_version: "v2.0",
    cases: [
      {
        code: "C-05",
        position: 1,
        title: "认购主流程-准确",
        module: "二、节点认购与期次",
        priority: null,
        expect_absent: ["已售罄"],
        visual_check: "text_and_visual",
        reference_asset_count: 2
      }
    ],
    fields: ["code", "title"],
    errors: [],
    warnings: []
  });
  render(<ImportView preview={previewSpy} confirm={vi.fn()} onImported={vi.fn()} />);

  await userEvent.upload(
    screen.getByLabelText("选择用例文件"),
    new File(["PK"], "odyssey-casebook.zip", { type: "application/zip" })
  );

  expect(await screen.findByText(/原型图 99 张/)).toBeVisible();
  expect(screen.getByText(/引用 182 处/)).toBeVisible();
  expect(screen.getByText(/原型版本 v2\.0/)).toBeVisible();
  expect(screen.getByText("原型图 2 张")).toBeVisible();
});
