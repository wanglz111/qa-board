import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { GroupCase } from "../api";
import { GroupsView } from "./Groups";

it("marks cases that carry reference images", async () => {
  const reference = {
    id: "asset-1",
    link_id: "link-1",
    asset_key: "sale-stage-selling",
    name: "节点发售",
    mime: "image/png",
    width: 340,
    height: 1658,
    asset_type: "page",
    screen: "节点发售",
    state: "发售中",
    prototype_version: "v2.0",
    role: "expected" as const,
    caption: null,
    focus: []
  };
  const withImages: GroupCase = {
    id: "c1",
    code: "C-05",
    position: 1,
    title: "认购主流程-准确",
    module: null,
    layer: null,
    priority: null,
    preconditions: null,
    test_data: null,
    steps: null,
    expected: null,
    expect_absent: ["已售罄"],
    visual_check: "text_and_visual",
    prototype_note: null,
    latest_result: null,
    reference_assets: [reference, { ...reference, id: "asset-2", link_id: "link-2" }]
  };
  render(<GroupsView
    refreshKey={0}
    loadGroups={async () => [
      { id: "a", name: "Group A", source_name: "a.zip", source_version: "1", count: 1, created_at: "2026-09-16" }
    ]}
    loadCases={async () => [withImages]}
  />);

  await userEvent.click(await screen.findByRole("button", { name: /Group A/ }));
  expect(await screen.findByText("原型 2 张")).toBeVisible();
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("keeps cases aligned with the most recently selected group", async () => {
  const first = deferred<GroupCase[]>();
  const second = deferred<GroupCase[]>();
  render(<GroupsView
    refreshKey={0}
    loadGroups={async () => [
      { id: "a", name: "Group A", source_name: "a.csv", source_version: "1", count: 1, created_at: "2026-09-16" },
      { id: "b", name: "Group B", source_name: "b.csv", source_version: "1", count: 1, created_at: "2026-09-16" }
    ]}
    loadCases={(id) => id === "a" ? first.promise : second.promise}
  />);

  await userEvent.click(await screen.findByRole("button", { name: /Group A/ }));
  expect(screen.getByText(/a\.csv · v1/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /Group B/ }));
  second.resolve([{ id: "b1", code: "B-1", position: 1, title: "Second group case", module: null, layer: null, priority: null, preconditions: null, test_data: null, steps: null, expected: null, expect_absent: [], visual_check: "text_and_visual", prototype_note: null, latest_result: null, reference_assets: [] }]);
  expect(await screen.findByText("Second group case")).toBeVisible();
  first.resolve([{ id: "a1", code: "A-1", position: 1, title: "Stale first case", module: null, layer: null, priority: null, preconditions: null, test_data: null, steps: null, expected: null, expect_absent: [], visual_check: "text_and_visual", prototype_note: null, latest_result: null, reference_assets: [] }]);

  expect(screen.queryByText("Stale first case")).not.toBeInTheDocument();
});
