import { render, screen } from "@testing-library/react";
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

const SAVED: LarkPeople = {
  reporter_open_id: "ou_reporter",
  owner_open_id: "ou_owner",
  env_reporter_open_id: "ou_from_env",
  effective_reporter_open_id: "ou_reporter",
  effective_owner_open_id: "ou_owner"
};

it("shows what the saved ids will actually be written as", async () => {
  render(<SettingsView load={async () => LOADED} save={vi.fn()} />);

  // The environment fallback is what a save has not overridden yet.
  expect(await screen.findByText(/ou_from_env/)).toBeVisible();
});

it("saves both boxes", async () => {
  const save = vi.fn().mockResolvedValue(SAVED);
  render(<SettingsView load={async () => LOADED} save={save} />);

  await userEvent.type(await screen.findByLabelText("报告人 open_id"), "ou_reporter");
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

  await userEvent.type(await screen.findByLabelText("报告人 open_id"), "Max");
  await userEvent.click(screen.getByRole("button", { name: "保存人员设置" }));

  expect(await screen.findByText(/open_id（ou_ 开头）/)).toBeVisible();
});
