import { fireEvent, render, screen } from "@testing-library/react";
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
});
