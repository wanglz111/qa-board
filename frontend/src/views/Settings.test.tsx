import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { ApiError, type LarkPeople } from "../api";
import { SettingsView } from "./Settings";

const LOADED: LarkPeople = {
  reporter_open_id: "",
  owner_open_id: "",
  env_reporter_open_id: "ou_from_env",
  effective_reporter_open_id: "ou_from_env",
  effective_owner_open_id: ""
};

// Both ids set. One fixture covers two roles, because the server echoes back the
// row it stored: this is what the page loads in the "clears both ids" case, and
// what a save of both boxes resolves with. It used to exist twice, byte-identical
// (``SAVED``), which was a fixture no assertion could tell apart.
const BOTH_SET: LarkPeople = {
  reporter_open_id: "ou_reporter",
  owner_open_id: "ou_owner",
  env_reporter_open_id: "ou_from_env",
  effective_reporter_open_id: "ou_reporter",
  effective_owner_open_id: "ou_owner"
};

const CLEARED: LarkPeople = {
  reporter_open_id: "",
  owner_open_id: "",
  env_reporter_open_id: "ou_from_env",
  effective_reporter_open_id: "ou_from_env",
  effective_owner_open_id: ""
};

// The save button stays disabled until the load settles, and a load that lands
// after typing overwrites the box -- so every interaction waits for the loaded
// state first. The env fallback is what proves the read came back.
async function waitUntilLoaded() {
  await screen.findByText(/ou_from_env/);
}

it("shows what the saved ids will actually be written as", async () => {
  render(<SettingsView load={async () => LOADED} save={vi.fn()} />);

  // The environment fallback is what a save has not overridden yet.
  expect(await screen.findByText(/ou_from_env/)).toBeVisible();
  // A section with an accessible name is a landmark of its own; this is what
  // aria-labelledby + the h2 id buy, and it is how the heading is reachable.
  expect(screen.getByRole("region", { name: "人员设置" })).toBeVisible();
});

it("saves both boxes", async () => {
  const save = vi.fn().mockResolvedValue(BOTH_SET);
  render(<SettingsView load={async () => LOADED} save={save} />);

  await waitUntilLoaded();

  await userEvent.type(screen.getByLabelText("报告人 open_id"), "ou_reporter");
  await userEvent.type(screen.getByLabelText("负责人 open_id"), "ou_owner");
  await userEvent.click(screen.getByRole("button", { name: "保存人员设置" }));

  expect(save).toHaveBeenCalledWith({
    reporter_open_id: "ou_reporter",
    owner_open_id: "ou_owner"
  });
  expect(await screen.findByText("人员设置已保存")).toBeVisible();
});

it("shows the server's refusal verbatim", async () => {
  const save = vi.fn().mockRejectedValue(new ApiError(422, "报告人 要填本应用名下的 open_id（ou_ 开头）"));
  render(<SettingsView load={async () => LOADED} save={save} />);

  await waitUntilLoaded();

  await userEvent.type(screen.getByLabelText("报告人 open_id"), "Max");
  await userEvent.click(screen.getByRole("button", { name: "保存人员设置" }));

  expect(await screen.findByText(/open_id（ou_ 开头）/)).toBeVisible();
});

it("clears both ids when both boxes are emptied", async () => {
  const save = vi.fn().mockResolvedValue(CLEARED);
  render(<SettingsView load={async () => BOTH_SET} save={save} />);

  const reporter = await screen.findByLabelText("报告人 open_id");
  await waitFor(() => expect(reporter).toHaveValue("ou_reporter"));

  await userEvent.clear(reporter);
  await userEvent.clear(screen.getByLabelText("负责人 open_id"));
  await userEvent.click(screen.getByRole("button", { name: "保存人员设置" }));

  // An emptied box is the one request that erases a stored id, so it has to
  // travel as an empty string rather than as a missing key.
  expect(save).toHaveBeenCalledWith({ reporter_open_id: "", owner_open_id: "" });
  expect(await screen.findByText("人员设置已保存")).toBeVisible();
  // "I know it is empty" must read differently from "I could not read it".
  expect(screen.getAllByText("（空）")).toHaveLength(1);
  expect(screen.queryByText("（未知）")).toBeNull();
});

it("does not offer a save that would erase what it could not read", async () => {
  const save = vi.fn();
  render(
    <SettingsView
      load={async () => {
        throw new ApiError(500, "读取人员设置失败");
      }}
      save={save}
    />
  );

  // Two unknown values, not two empty ones: nothing was read, so the page must
  // not claim to know the stored ids are blank.
  expect(await screen.findAllByText("（未知）")).toHaveLength(2);
  expect(screen.getByRole("alert")).toHaveTextContent("读取人员设置失败");
  expect(screen.getByRole("button", { name: "保存人员设置" })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});
