import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadToast } from "./App";

// UploadToast is a plain flash pill normally, and grows a determinate progress
// bar + percentage while an upload is in flight — switching to a spinner and an
// indeterminate sweep once the bytes are up but the server is still finalizing.
describe("UploadToast", () => {
  const render = (
    uploading: boolean,
    pct: number,
    message = "Uploading “neon.mp3”…",
  ) =>
    renderToStaticMarkup(
      <UploadToast
        message={message}
        uploading={uploading}
        pct={pct}
        bottom={80}
      />,
    );

  it("shows only the message as a pill when not uploading", () => {
    const html = render(false, 0, "Added “Neon”");
    expect(html).toContain("Added “Neon”");
    // No progress affordances on a plain flash.
    expect(html).not.toContain("app-upload-indef");
    expect(html).not.toContain("app-spin");
    expect(html).not.toContain("%</span>");
  });

  it("renders a determinate bar and live percentage mid-upload", () => {
    const html = render(true, 63);
    expect(html).toContain("63%");
    // Determinate fill sized to the percentage, no spinner, no indeterminate sweep.
    expect(html).toContain("width:63%");
    expect(html).not.toContain("app-upload-indef");
    expect(html).not.toContain("app-spin");
  });

  it("swaps to a spinner + indeterminate sweep at 100% while the server finalizes", () => {
    const html = render(true, 100);
    // No misleading percentage text (the "%</span>" is the pct label); show the
    // spinner and the sweeping bar instead. ("100%" alone would match the bar's
    // own height:100% CSS, so assert on the label's closing tag.)
    expect(html).not.toContain("%</span>");
    expect(html).toContain("app-spin");
    expect(html).toContain("app-upload-indef");
  });
});

// The mobile tab bar and the docked player stack at the bottom of a phone
// screen. Everything anchored down there derives its offset from the shared
// --tabbar-h / --safe-b tokens, so the toast can't end up behind the nav.
describe("UploadToast bottom offset", () => {
  it("when a track is docked, then the toast clears the dock and the mobile tab bar", () => {
    const html = renderToStaticMarkup(
      <UploadToast message="Added" uploading={false} pct={0} bottom={120} />,
    );
    expect(html).toContain(
      "bottom:calc(120px + var(--tabbar-h) + var(--safe-b))",
    );
  });

  it("when nothing is docked, then it still clears the mobile tab bar", () => {
    const html = renderToStaticMarkup(
      <UploadToast message="Added" uploading={false} pct={0} bottom={80} />,
    );
    expect(html).toContain(
      "bottom:calc(80px + var(--tabbar-h) + var(--safe-b))",
    );
  });
});
