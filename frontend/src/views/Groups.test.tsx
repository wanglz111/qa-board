import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Group, GroupCase } from "../api";
import { GroupsView } from "./Groups";

const noArchive = async (groupId: string) => group(groupId);

function group(id: string, name = "Group A", archivedAt: string | null = null): Group {
  return {
    id,
    name,
    source_name: `${id}.csv`,
    source_version: "1",
    count: 1,
    created_at: "2026-09-16",
    archived_at: archivedAt
  };
}

// The row's own button is named by everything it shows, and the retire action
// beside it is named `归档 <group>`: a loose name query matches both, so the
// tests go through the visible text instead.
async function openGroup(name: string) {
  const row = (await screen.findByText(name)).closest("button");
  if (row === null) throw new Error(`no row button for ${name}`);
  await userEvent.click(row);
}

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
    loadGroups={async () => [{ ...group("a"), source_name: "a.zip" }]}
    loadCases={async () => [withImages]}
    archive={noArchive}
    restore={noArchive}
  />);

  await openGroup("Group A");
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
    loadGroups={async () => [group("a"), group("b", "Group B")]}
    loadCases={(id) => id === "a" ? first.promise : second.promise}
    archive={noArchive}
    restore={noArchive}
  />);

  await openGroup("Group A");
  expect(screen.getByText(/a\.csv · v1/)).toBeVisible();
  await openGroup("Group B");
  second.resolve([{ id: "b1", code: "B-1", position: 1, title: "Second group case", module: null, layer: null, priority: null, preconditions: null, test_data: null, steps: null, expected: null, expect_absent: [], visual_check: "text_and_visual", prototype_note: null, latest_result: null, reference_assets: [] }]);
  expect(await screen.findByText("Second group case")).toBeVisible();
  first.resolve([{ id: "a1", code: "A-1", position: 1, title: "Stale first case", module: null, layer: null, priority: null, preconditions: null, test_data: null, steps: null, expected: null, expect_absent: [], visual_check: "text_and_visual", prototype_note: null, latest_result: null, reference_assets: [] }]);

  expect(screen.queryByText("Stale first case")).not.toBeInTheDocument();
});

it("asks before retiring a group and says what archiving keeps", async () => {
  let retired = false;
  const archive = vi.fn(async (groupId: string) => {
    retired = true;
    return group(groupId, "Group A", "2026-09-18T00:00:00Z");
  });
  render(
    <GroupsView
      refreshKey={0}
      loadGroups={async () => (retired ? [] : [group("a")])}
      loadCases={async () => []}
      archive={archive}
      restore={noArchive}
    />
  );

  await userEvent.click(await screen.findByRole("button", { name: "归档 Group A" }));

  expect(archive).not.toHaveBeenCalled();
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("归档这个测试组？");
  expect(dialog).toHaveTextContent("随时可以点「恢复」");
  // The one thing an operator could get wrong: archiving does not touch Lark.
  expect(dialog).toHaveTextContent("归档不动 Lark");

  await userEvent.click(within(dialog).getByRole("button", { name: "确认归档" }));

  expect(archive).toHaveBeenCalledWith("a");
  expect(await screen.findByText(/板上没有测试组/)).toBeVisible();
});

it("keeps archived groups one toggle away, with a way back", async () => {
  const restore = vi.fn(async (groupId: string) => group(groupId));
  render(
    <GroupsView
      refreshKey={0}
      loadGroups={async (includeArchived) => [
        ...(includeArchived ? [group("old", "Sprint 0918", "2026-09-18T00:00:00Z")] : []),
        group("a")
      ]}
      loadCases={async () => []}
      archive={noArchive}
      restore={restore}
    />
  );

  // Retired groups are off the board until asked for, so a mistake made now
  // cannot be re-run by accident.
  expect(screen.queryByText("Sprint 0918")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "显示已归档" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );

  await userEvent.click(screen.getByRole("button", { name: "显示已归档" }));

  expect(await screen.findByText("已归档（1）")).toBeVisible();
  expect(screen.getByText("Sprint 0918")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "恢复 Sprint 0918" }));
  expect(restore).toHaveBeenCalledWith("old");
});

it("shows an archived group's cases without inviting work on them", async () => {
  render(
    <GroupsView
      refreshKey={0}
      loadGroups={async () => [group("old", "Sprint 0918", "2026-09-18T00:00:00Z")]}
      loadCases={async () => [
        {
          id: "c1",
          code: "C-05",
          position: 1,
          title: "旧用例",
          module: null,
          layer: null,
          priority: null,
          preconditions: null,
          test_data: null,
          steps: null,
          expected: null,
          expect_absent: [],
          visual_check: "text_and_visual",
          prototype_note: null,
          latest_result: null,
          reference_assets: []
        }
      ]}
      archive={noArchive}
      restore={noArchive}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: "显示已归档" }));
  await openGroup("Sprint 0918");
  expect(await screen.findByText("旧用例")).toBeVisible();
  expect(screen.getByText("1 条 · 已归档")).toBeVisible();
});
