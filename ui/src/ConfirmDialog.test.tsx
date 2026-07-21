import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  const base = {
    title: "Delete song",
    message: "Delete “Enter Sandman”?",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: () => {},
    onCancel: () => {},
  };

  it("renders a labeled dialog with title, message and both buttons", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...base} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Delete song");
    expect(html).toContain("Enter Sandman");
    expect(html).toContain("Delete");
    expect(html).toContain("Cancel");
  });

  it("shows the error line and disables confirm while busy", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog {...base} busy error="Could not delete" />,
    );
    expect(html).toContain("Could not delete");
    expect(html).toContain("disabled");
  });
});
