import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KaraokeView } from "./KaraokeView";

describe("KaraokeView", () => {
  it("renders each line's words as base + fill text", () => {
    const lines = [
      {
        text: "hello world",
        start: 1,
        end: 2,
        words: [
          { w: "hello", start: 1, end: 1.4, conf: 0.9 },
          { w: "world", start: 1.4, end: 2, conf: 0.9 },
        ],
      },
    ];
    const html = renderToStaticMarkup(<KaraokeView lines={lines} />);
    expect(html).toContain("hello");
    expect(html).toContain("world");
    expect(html).toContain("kv-fill");
    expect(html).toContain("kv-stage");
  });

  it("falls back to line.text when a line has no words", () => {
    const html = renderToStaticMarkup(<KaraokeView lines={[{ text: "instrumental", start: 0, end: 1, words: [] }]} />);
    expect(html).toContain("instrumental");
  });

  it("renders the intro floating-notes indicator", () => {
    const html = renderToStaticMarkup(
      <KaraokeView lines={[{ text: "hello", start: 1, end: 2, words: [] }]} />
    );
    expect(html).toContain("kv-intro-notes");
  });
});
