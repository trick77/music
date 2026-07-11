import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SyncingBadge } from "./SyncingBadge";

describe("SyncingBadge", () => {
  it("renders the syncing indicator while generating", () => {
    const html = renderToStaticMarkup(<SyncingBadge status="generating" />);
    expect(html).toContain("Syncing");
    expect(html).toContain("kv-pulse");
  });

  it("renders nothing for other statuses", () => {
    for (const status of ["", "ready", "failed", undefined] as const) {
      expect(renderToStaticMarkup(<SyncingBadge status={status} />)).toBe("");
    }
  });
});
