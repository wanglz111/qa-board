import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OutcomeForm, type OutcomeFormHandle, type SaveInput } from "./OutcomeForm";

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

function renderForm(
  overrides: Partial<Parameters<typeof OutcomeForm>[0]> = {}
) {
  const onSave = vi.fn<(input: SaveInput) => void>();
  const onImagesChange = vi.fn<(images: File[]) => void>();
  const ref = createRef<OutcomeFormHandle>();
  render(
    <OutcomeForm
      ref={ref}
      onSave={onSave}
      submitting={false}
      images={[]}
      onImagesChange={onImagesChange}
      status={null}
      onRetryUpload={vi.fn()}
      {...overrides}
    />
  );
  return { onSave, onImagesChange, ref };
}

function ControlledForm() {
  const [images, setImages] = useState<File[]>([]);

  return (
    <OutcomeForm
      onSave={vi.fn()}
      submitting={false}
      images={images}
      onImagesChange={setImages}
      status={null}
      onRetryUpload={vi.fn()}
    />
  );
}

describe("OutcomeForm", () => {
  it("requires a failure note and saves the typed outcome", async () => {
    const { onSave, ref } = renderForm();
    const note = screen.getByLabelText("失败说明");
    expect(note).not.toBeRequired();
    await userEvent.click(screen.getByRole("button", { name: "不通过" }));
    expect(note).toBeRequired();
    await userEvent.click(screen.getByRole("button", { name: "保存结果" }));
    expect(onSave).not.toHaveBeenCalled();

    await userEvent.type(note, "绑定未触发");
    await userEvent.click(screen.getByRole("button", { name: "保存结果" }));

    expect(onSave).toHaveBeenCalledWith({
      result: "不通过",
      note: "绑定未触发",
      consoleText: null
    });
    expect(ref.current).not.toBeNull();
  });

  it("collects a pasted screenshot into the pending image list", () => {
    const { onImagesChange } = renderForm();
    const pasted = new File(["binary"], "pasted.png", { type: "image/png" });

    fireEvent.paste(screen.getByLabelText("录入执行结果"), {
      clipboardData: { files: [pasted] }
    });

    expect(onImagesChange).toHaveBeenCalledWith([pasted]);
  });

  it("renders a pasted screenshot preview and releases it when removed", async () => {
    const createObjectURL = vi.fn(() => "blob:defect-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL }
    });
    const { unmount } = render(<ControlledForm />);
    const pasted = new File(["binary"], "checkout-error.png", { type: "image/png" });

    fireEvent.paste(screen.getByLabelText("录入执行结果"), {
      clipboardData: { files: [pasted] }
    });

    const preview = await screen.findByRole("img", { name: "缺陷截图：checkout-error.png" });
    expect(preview).toHaveAttribute("src", "blob:defect-preview");
    expect(createObjectURL).toHaveBeenCalledWith(pasted);

    await userEvent.click(screen.getByRole("button", { name: "预览 checkout-error.png" }));
    const dialog = screen.getByRole("dialog", { name: "checkout-error.png" });
    expect(within(dialog).getByRole("img", { name: "checkout-error.png" })).toHaveAttribute(
      "src",
      "blob:defect-preview"
    );

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "checkout-error.png" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "移除 checkout-error.png" }));

    expect(screen.queryByRole("img", { name: "缺陷截图：checkout-error.png" })).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:defect-preview");
    unmount();
  });

  it("ignores pasted content that is not an image", () => {
    const { onImagesChange } = renderForm();
    const pasted = new File(["text"], "notes.txt", { type: "text/plain" });

    fireEvent.paste(screen.getByLabelText("录入执行结果"), {
      clipboardData: { files: [pasted] }
    });

    expect(onImagesChange).not.toHaveBeenCalled();
  });

  it("resets the result, the note, the console and the validation, leaving the form pristine", async () => {
    const user = userEvent.setup();
    const { ref } = renderForm();

    await user.click(screen.getByRole("button", { name: "不通过" }));
    await user.type(screen.getByLabelText("失败说明"), "绑定未触发");
    await user.type(screen.getByLabelText("控制台输出"), "wallet.bind timeout");

    act(() => ref.current?.reset());

    expect(screen.getByRole("button", { name: "不通过" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("失败说明")).toHaveValue("");
    expect(screen.getByLabelText("控制台输出")).toHaveValue("");

    // Behavioural proof of "pristine": with no result selected, submitting again
    // must re-raise the validation instead of saving something the user cleared.
    await user.click(screen.getByRole("button", { name: "保存结果" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请选择执行结果");
  });

  it("clears a validation message left behind by an empty submit", async () => {
    const user = userEvent.setup();
    const { ref } = renderForm();

    await user.click(screen.getByRole("button", { name: "保存结果" }));
    expect(screen.getByRole("alert")).toHaveTextContent("请选择执行结果");

    act(() => ref.current?.reset());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves the attachments and the save status to the caller", async () => {
    const createObjectURL = vi.fn(() => "blob:retained-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL }
    });
    const shot = new File(["png"], "shot.png", { type: "image/png" });
    const { ref, onImagesChange, onSave } = renderForm({
      images: [shot],
      status: { tone: "error", text: "结果已保存到本地，但截图上传失败" }
    });

    act(() => ref.current?.reset());

    expect(screen.getByRole("img", { name: "缺陷截图：shot.png" })).toBeInTheDocument();
    expect(screen.getByText("结果已保存到本地，但截图上传失败")).toBeInTheDocument();
    expect(onImagesChange).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
