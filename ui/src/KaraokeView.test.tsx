import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, act } from "@testing-library/react";
import type { AlignedLine } from "./api";

// The sweep reads the live <audio> currentTime every frame. Replacing the player
// singleton with a hand-held element is what makes the clock deterministic, so a
// test can park playback at an exact moment and inspect the resulting fill.
vi.mock("./player", () => ({ player: { getAudioElement: vi.fn() } }));

import { KaraokeView } from "./KaraokeView";
import { player } from "./player";

describe("KaraokeView", () => {
  it("renders each line's words as per-word sweep spans", () => {
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
    expect(html).toContain("kv-word");
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

// --- Live sweep -------------------------------------------------------------
// Everything below drives the requestAnimationFrame loop by hand: the spy
// captures the scheduled callback instead of letting the browser run it, so each
// "frame" happens at a moment the test chooses.

let frames: FrameRequestCallback[] = [];
let cancelSpy: ReturnType<typeof vi.spyOn>;
let audio: { currentTime: number };

beforeEach(() => {
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  audio = { currentTime: 0 };
  vi.mocked(player.getAudioElement).mockReturnValue(audio as HTMLAudioElement);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function word(w: string, start: number, end: number) {
  return { w, start, end, conf: 0.9 };
}

// Three lines with real word timings, spaced far enough apart that each one's
// activation window is unambiguous.
function lyrics(): AlignedLine[] {
  return [
    { text: "hello world", start: 1, end: 2, words: [word("hello", 1, 1.4), word("world", 1.4, 2)] },
    { text: "come back", start: 5, end: 6, words: [word("come", 5, 5.5), word("back", 5.5, 6)] },
    { text: "now", start: 9, end: 9.5, words: [word("now", 9, 9.5)] },
  ];
}

// Runs the single pending callback. The first one is the loop's `start`, which
// only positions the stage and schedules the real frame; every later one is a
// frame proper.
function runPending() {
  const cb = frames.shift();
  frames.length = 0;
  if (cb) act(() => void cb(0));
}

function mount(lines: AlignedLine[]) {
  const view = render(<KaraokeView lines={lines} />);
  runPending(); // consume `start`
  return view;
}

// Parks playback at `time` and paints one frame.
function seek(time: number) {
  audio.currentTime = time;
  runPending();
}

// Lines and words carry no roles of their own, so they are reached by class.
function lineEls(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(".kv-line"));
}
function fillOf(container: HTMLElement, text: string) {
  const span = Array.from(container.querySelectorAll<HTMLElement>(".kv-word")).find((s) => s.textContent === text);
  return span?.style.getPropertyValue("--p");
}

describe("KaraokeView line focus", () => {
  it("when playback sits inside the first line, then only that line is lit", () => {
    const { container } = mount(lyrics());

    seek(1.2);

    const lines = lineEls(container);
    expect(lines[0].classList.contains("kv-active")).toBe(true);
    expect(lines[1].classList.contains("kv-active")).toBe(false);
  });

  it("when playback reaches the next line's lead-in, then focus moves to it", () => {
    const { container } = mount(lyrics());

    // The second line takes focus 0.6s before its first word, i.e. from 4.4s.
    seek(4.5);

    const lines = lineEls(container);
    expect(lines[1].classList.contains("kv-active")).toBe(true);
    expect(lines[0].classList.contains("kv-active")).toBe(false);
  });

  it("when a line is not in focus, then it is dimmed and blurred by its distance", () => {
    const { container } = mount(lyrics());

    seek(1.2);

    // Depth cue: the further a line sits from the one being sung, the fainter and
    // softer it gets, down to a floor so it never disappears entirely.
    const lines = lineEls(container);
    expect(lines[1].style.opacity).toBe("0.38");
    expect(lines[1].style.filter).toBe("blur(2.5px)");
    expect(lines[2].style.opacity).toBe("0.28");
    expect(lines[2].style.filter).toBe("blur(4.0px)");
  });

  it("when the focused line regains focus, then its dimming is cleared again", () => {
    const { container } = mount(lyrics());

    seek(4.5);
    seek(1.2);

    const lines = lineEls(container);
    expect(lines[0].style.opacity).toBe("");
    expect(lines[0].style.filter).toBe("");
  });

  it("when the last line has been finished for longer than the hold, then nothing stays lit", () => {
    const { container } = mount(lyrics());

    // The final line ends at 9.5s and is held for 4s past that.
    seek(11);
    const stillHeld = lineEls(container)[2].classList.contains("kv-active");
    seek(14);

    expect(stillHeld).toBe(true);
    expect(lineEls(container)[2].classList.contains("kv-active")).toBe(false);
  });

  it("when no audio element exists yet, then the view opens on the first line instead of crashing", () => {
    vi.mocked(player.getAudioElement).mockReturnValue(null);
    const { container } = mount(lyrics());

    runPending();

    expect(lineEls(container)[0].classList.contains("kv-active")).toBe(true);
  });
});

describe("KaraokeView word fill", () => {
  it("when a word is half sung, then its fill is half written", () => {
    const { container } = mount(lyrics());

    // 1.0s of audio reads as 1.2s of sweep — the highlight runs slightly ahead to
    // compensate for the perceived lag.
    seek(1.0);

    expect(fillOf(container, "hello")).toBe("0.500");
    expect(fillOf(container, "world")).toBe("0.000");
  });

  it("when the sweep has moved on, then earlier words are full and later ones empty", () => {
    const { container } = mount(lyrics());

    seek(5.1);

    expect(fillOf(container, "hello")).toBe("1");
    expect(fillOf(container, "come")).toBe("0.600");
    expect(fillOf(container, "now")).toBe("0");
  });

  it("when a word is held far longer than the sweep cap, then it still fills at the capped rate", () => {
    const { container } = mount([
      { text: "ooooh", start: 0, end: 10, words: [word("ooooh", 0, 10)] },
    ]);

    seek(0.4);

    // A ten-second held note would otherwise crawl; the sweep is capped at 1.2s so
    // the word finishes filling while it is still recognisably being sung.
    expect(fillOf(container, "ooooh")).toBe("0.500");
  });

  it("when a word has no duration at all, then it flips from empty to full at its timestamp", () => {
    const { container } = mount([
      { text: "hey", start: 2, end: 2, words: [word("hey", 2, 2)] },
    ]);

    seek(1.5);
    const before = fillOf(container, "hey");
    seek(2.3);

    expect(before).toBe("0.000");
    expect(fillOf(container, "hey")).toBe("1.000");
  });

  it("when a line has no word timings, then it renders its raw text without fill spans breaking", () => {
    const { container } = mount([{ text: "instrumental break", start: 0, end: 4, words: [] }]);

    seek(1);

    expect(container.textContent).toContain("instrumental break");
    expect(fillOf(container, "instrumental break")).toBe("");
  });
});

describe("KaraokeView intro", () => {
  function withLeadIn(): AlignedLine[] {
    // First word at 3s: a long enough instrumental lead-in to be worth animating.
    return [{ text: "here we go", start: 3, end: 4, words: [word("here", 3, 3.5), word("we", 3.5, 4)] }];
  }

  it("when a long instrumental lead-in is still running, then the notes flourish shows", () => {
    const { container } = mount(withLeadIn());

    seek(1);

    expect(container.querySelector(".kv-intro-notes")?.classList.contains("kv-visible")).toBe(true);
  });

  it("when the first word is about to land, then the flourish is cleared", () => {
    const { container } = mount(withLeadIn());

    seek(1);
    seek(2.5);

    // It clears a beat early so the first lyric line takes focus on a clean stage.
    expect(container.querySelector(".kv-intro-notes")?.classList.contains("kv-visible")).toBe(false);
  });

  it("when the song starts singing almost immediately, then no intro flourish appears", () => {
    const { container } = mount(lyrics());

    seek(0.1);

    // A one-second lead-in is too short to animate — the notes would flash and go.
    expect(container.querySelector(".kv-intro-notes")?.classList.contains("kv-visible")).toBe(false);
  });
});

describe("KaraokeView auto-scroll", () => {
  it("when the view opens, then the first line is parked at the reading line", () => {
    const { container } = render(<KaraokeView lines={lyrics()} />);

    runPending();

    // The focused line sits at 40% of the viewport height rather than centred.
    const inner = container.querySelector<HTMLElement>(".kv-inner");
    expect(inner?.style.transform).toBe(`translateY(${window.innerHeight * 0.4}px)`);
  });

  it("when the window is resized, then the scroll position is recomputed", () => {
    const { container } = mount(lyrics());
    seek(1.2);

    (window as unknown as { innerHeight: number }).innerHeight = 1000;
    act(() => void window.dispatchEvent(new Event("resize")));
    seek(1.3);

    // Wrapped line heights change on reflow, so a stale transform would leave the
    // sung line off the reading position.
    const inner = container.querySelector<HTMLElement>(".kv-inner");
    expect(inner?.style.transform).toBe("translateY(400px)");
    (window as unknown as { innerHeight: number }).innerHeight = 768;
  });
});

describe("KaraokeView lifecycle", () => {
  it("when the view unmounts, then the animation loop is cancelled", () => {
    const { unmount } = mount(lyrics());
    seek(1.2);

    unmount();

    // A surviving loop would keep mutating detached DOM every frame forever.
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("when fonts finish loading, then the loop starts once they are ready", async () => {
    // Metrics change as webfonts swap in, so the first scroll position is deferred
    // until they are settled.
    (document as unknown as { fonts: unknown }).fonts = { ready: Promise.resolve() };
    const { container } = render(<KaraokeView lines={lyrics()} />);

    await act(async () => {});
    seek(1.0);

    expect(fillOf(container, "hello")).toBe("0.500");
    delete (document as unknown as { fonts?: unknown }).fonts;
  });

  it("when the view unmounts before the fonts resolve, then no loop is ever started", async () => {
    let release = () => {};
    (document as unknown as { fonts: unknown }).fonts = { ready: new Promise<void>((r) => (release = r)) };
    const { unmount } = render(<KaraokeView lines={lyrics()} />);

    unmount();
    release();
    await act(async () => {});

    // The promise outliving the component would otherwise spawn a loop nothing can
    // cancel any more.
    expect(frames).toHaveLength(0);
    delete (document as unknown as { fonts?: unknown }).fonts;
  });
});
