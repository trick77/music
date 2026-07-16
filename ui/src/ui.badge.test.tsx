import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UnpublishedBadge } from "./ui";

// The pill is rendered in both places and CSS shows one (see .row-badge-* in
// index.css): with the row actions where the row is wide, on the meta line on a
// phone — where an actions-side pill squeezed the title to zero width.
describe("UnpublishedBadge", () => {
  it("when the song is unpublished, then each placement is tagged for its breakpoint", () => {
    expect(renderToStaticMarkup(<UnpublishedBadge show placement="actions" />)).toContain('class="row-badge-actions"');
    expect(renderToStaticMarkup(<UnpublishedBadge show placement="meta" />)).toContain('class="row-badge-meta"');
  });

  it("when the song is published (or the viewer is anonymous), then nothing renders", () => {
    // `show` carries the auth AND published gate — an anonymous viewer never
    // sees an unpublished song at all, so it must never leak a badge.
    expect(renderToStaticMarkup(<UnpublishedBadge show={false} placement="actions" />)).toBe("");
    expect(renderToStaticMarkup(<UnpublishedBadge show={false} placement="meta" />)).toBe("");
  });

  it("when it renders, then the label is spelled out, not truncated", () => {
    // No ellipsis: in this design system '…' means 'opens more UI'.
    const html = renderToStaticMarkup(<UnpublishedBadge show placement="meta" />);
    expect(html).toContain("Unpublished");
    expect(html).not.toContain("…");
  });
});
