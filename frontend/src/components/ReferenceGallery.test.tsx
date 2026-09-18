import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ReferenceAsset, ReferenceFocus } from "../api";
import { ReferenceGallery } from "./ReferenceGallery";

function asset(
  overrides: Partial<ReferenceAsset> & { id: string; name: string }
): ReferenceAsset {
  return {
    link_id: `${overrides.id}-link`,
    asset_key: overrides.id,
    mime: "image/png",
    width: 340,
    height: 1658,
    asset_type: "page",
    screen: "节点发售",
    state: "发售中",
    prototype_version: "v2.0",
    role: "expected",
    caption: null,
    focus: [],
    ...overrides
  };
}

const focus: ReferenceFocus = {
  label: "确认按钮",
  note: "文案应为「确认购买」",
  box: [0.62, 0.78, 0.3, 0.08]
};

const url = (id: string) => `/api/case-reference-assets/${id}`;

it("renders nothing without reference images", () => {
  const { container } = render(<ReferenceGallery assets={[]} assetUrl={url} />);

  expect(container).toBeEmptyDOMElement();
});

it("keeps locators out of the stepper and shows focus notes", () => {
  render(
    <ReferenceGallery
      assets={[
        asset({ id: "a1", name: "节点发售", focus: [focus] }),
        asset({ id: "a2", name: "购买确认" }),
        asset({ id: "a3", name: "个人中心入口", role: "locator", caption: "从这里进" })
      ]}
      assetUrl={url}
    />
  );

  expect(screen.getByRole("img", { name: "节点发售" })).toHaveAttribute(
    "src",
    "/api/case-reference-assets/a1"
  );
  expect(screen.getByText("1 / 2")).toBeVisible();
  expect(screen.getByText("确认按钮")).toBeVisible();
  expect(screen.getByText("文案应为「确认购买」")).toBeVisible();
  expect(screen.getByText("定位辅助图")).toBeVisible();
  expect(screen.getByText("个人中心入口")).toBeVisible();
});

it("shows the focus notes of locator images", () => {
  const locatorFocus: ReferenceFocus = {
    label: "入口位置",
    note: "右上角头像菜单",
    box: [0.7, 0.05, 0.2, 0.1]
  };
  render(
    <ReferenceGallery
      assets={[
        asset({ id: "a1", name: "节点发售" }),
        asset({ id: "a3", name: "个人中心入口", role: "locator", focus: [locatorFocus] })
      ]}
      assetUrl={url}
    />
  );

  expect(screen.getByText("定位辅助图")).toBeVisible();
  expect(screen.getByText("入口位置")).toBeVisible();
  expect(screen.getByText("右上角头像菜单")).toBeVisible();
  expect(screen.getByText("70% / 5% / 20% / 10%")).toBeVisible();
});

it("switches images with the stepper without leaving the expected group", async () => {
  render(
    <ReferenceGallery
      assets={[
        asset({ id: "a1", name: "节点发售" }),
        asset({ id: "a2", name: "购买确认" }),
        asset({ id: "a3", name: "个人中心入口", role: "locator" })
      ]}
      assetUrl={url}
    />
  );

  await userEvent.click(screen.getByRole("button", { name: "下一张原型图" }));

  expect(screen.getByText("2 / 2")).toBeVisible();
  expect(screen.getByRole("img", { name: "购买确认" })).toBeVisible();
  expect(screen.getByRole("button", { name: "下一张原型图" })).toBeDisabled();
});

it("falls back to every image when a case has only locators", () => {
  render(
    <ReferenceGallery
      assets={[asset({ id: "a3", name: "个人中心入口", role: "locator" })]}
      assetUrl={url}
    />
  );

  expect(screen.getByRole("img", { name: "个人中心入口" })).toBeVisible();
});

it("opens a zoom dialog and closes it with Escape", async () => {
  render(
    <ReferenceGallery assets={[asset({ id: "a1", name: "节点发售" })]} assetUrl={url} />
  );

  await userEvent.click(screen.getByRole("button", { name: "放大查看 节点发售" }));
  expect(screen.getByRole("dialog", { name: "节点发售" })).toBeVisible();

  await userEvent.keyboard("{Escape}");

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens the viewer landed on the focus box the operator picked", async () => {
  // jsdom has no layout, so the stage is told how big it is: landing on a box
  // is arithmetic against a container width.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 1000
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => 800
  });
  try {
    render(
      <ReferenceGallery
        assets={[asset({ id: "a1", name: "节点发售", focus: [focus] })]}
        assetUrl={url}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "放大查看关注点 确认按钮" }));

    const dialog = screen.getByRole("dialog", { name: "节点发售" });
    expect(within(dialog).getByRole("button", { name: "确认按钮" })).toHaveClass("active");
    // 0.3 * 340px wide box, 60% of a 1000px stage -> capped at 3x.
    expect(within(dialog).getByRole("button", { name: /当前缩放 300%/ })).toBeVisible();
  } finally {
    delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
    delete (HTMLElement.prototype as unknown as { clientHeight?: number }).clientHeight;
  }
});
