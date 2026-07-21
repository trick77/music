import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HomeHero, Song } from "./api";

// Genre links call the SPA router rather than doing a real navigation; mocking it
// is the only way to observe that the anchor's default was actually suppressed in
// favour of a client-side route change.
vi.mock("./router", async () => {
  const actual = await vi.importActual<typeof import("./router")>("./router");
  return { ...actual, navigate: vi.fn() };
});

import { Hero, type HeroItem } from "./Hero";
import { navigate } from "./router";

const navigateMock = vi.mocked(navigate);

// Hero anchors a drag on the track's live rendered offset, which it reads through
// DOMMatrixReadOnly. jsdom ships no DOMMatrix at all, so without a stand-in the
// whole pointer path throws before any of the swipe logic runs. The value it
// yields is irrelevant — the commit decision is made from the pointer deltas.
class FakeMatrix {
  m41 = 0;
  constructor(_transform: string) {}
}
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeMatrix;

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: "s1",
    title: "Golden Hour",
    artistName: "Kavinsky",
    album: "",
    year: 0,
    trackNo: 0,
    trackTotal: 0,
    durationMs: 210000,
    fileSize: 0,
    createdAt: "",
    sampleRate: 0,
    channels: 0,
    bitrateKbps: 0,
    genres: [],
    coverArtId: "",
    published: true,
    alignmentStatus: "",
    ...overrides,
  };
}

function item(overrides: Partial<HeroItem> = {}): HeroItem {
  return { song: song(), genres: [], ranked: true, ...overrides };
}

function homeHero(overrides: Partial<HomeHero> = {}): HomeHero {
  return {
    fanartId: "f1",
    kind: "genre",
    genreId: "g1",
    title: "Late night synths",
    subtitle: "The after-hours rotation.",
    accentColor: "#d97757",
    ...overrides,
  };
}

// Three distinct slides: the carousel behaviour (clones, dots, wrap) only exists
// above one item, so most of these tests need a multi-slide hero.
function threeItems(): HeroItem[] {
  return [
    item({ song: song({ id: "s1", title: "Golden Hour" }) }),
    item({ song: song({ id: "s2", title: "Nightcall" }) }),
    item({ song: song({ id: "s3", title: "Odd Look" }) }),
  ];
}

function renderHero(props: Partial<Parameters<typeof Hero>[0]> = {}) {
  const onPlay = vi.fn();
  const onShare = vi.fn();
  const view = render(
    <Hero
      hero={null}
      items={threeItems()}
      currentId={null}
      playing={false}
      onPlay={onPlay}
      onShare={onShare}
      {...props}
    />,
  );
  return { ...view, onPlay, onShare };
}

// The track is the sliding strip; it carries no role of its own, so it has to be
// reached by class.
function track(container: HTMLElement): HTMLElement {
  return container.querySelector(".hero-track") as HTMLElement;
}

// Which pill dot is lit — the only user-visible readout of the carousel's index.
function activeDot(): number {
  const dots = screen.getAllByLabelText(/^Show slide /);
  return dots.findIndex((d) => d.getAttribute("aria-current") === "true");
}

// Slides settle via a CSS transition that jsdom never runs, and Hero gates further
// moves until it fires. Releasing it by hand is what lets a test perform a second
// move, exactly as a real browser would after the animation completes.
function settle(container: HTMLElement) {
  fireEvent.transitionEnd(track(container), { propertyName: "transform" });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  // matchMedia is read during render, so a stub left behind would silently put
  // every later test into reduced-motion mode.
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

describe("Hero placeholder panel", () => {
  it("when there are no songs, then it shows the generic library panel with no actions", () => {
    renderHero({ items: [], hero: null });

    expect(screen.getByRole("heading", { name: "Your library" })).toBeInTheDocument();
    expect(screen.getByText(/Songs, playlists, and the sounds/)).toBeInTheDocument();
    // With nothing featured there is no song to play, share or page through.
    expect(screen.queryByRole("button", { name: /^Play / })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Show slide /)).not.toBeInTheDocument();
  });

  it("when there are no songs but a hero is starred, then its own copy takes over the panel", () => {
    const { container } = renderHero({ items: [], hero: homeHero() });

    expect(screen.getByRole("heading", { name: "Late night synths" })).toBeInTheDocument();
    expect(screen.getByText("The after-hours rotation.")).toBeInTheDocument();
    expect(screen.getByText("Featured")).toBeInTheDocument();
    // The starred fanart backs the panel; no cover art is involved.
    expect(container.innerHTML).toContain("/api/fanart/f1?size=hero");
  });
});

describe("Hero slide content", () => {
  it("when a slide is ranked, then its eyebrow states the play-count position", () => {
    renderHero({ items: [item({ song: song({ title: "Golden Hour" }) })] });

    expect(screen.getByText("#1 most played")).toBeInTheDocument();
  });

  it("when a slide is not ranked, then it is labelled a plain featured song", () => {
    renderHero({ items: [item({ ranked: false })] });

    // Without play counts the ordering is arbitrary, so claiming a rank would lie.
    expect(screen.getByText("Featured song")).toBeInTheDocument();
    expect(screen.queryByText("#1 most played")).not.toBeInTheDocument();
  });

  it("when a genre resolved to an id, then clicking it routes client-side instead of reloading", async () => {
    const user = userEvent.setup();
    renderHero({ items: [item({ genres: [{ name: "synth pop", id: "g7" }] })] });

    await user.click(screen.getByRole("link", { name: "Synth Pop" }));

    expect(navigateMock).toHaveBeenCalledWith("/genre/g7");
  });

  it("when a genre has no id, then it renders as plain text rather than a dead link", () => {
    renderHero({ items: [item({ genres: [{ name: "synth pop", id: null }] })] });

    expect(screen.getByText("Synth Pop")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Synth Pop" })).not.toBeInTheDocument();
  });

  it("when a song beyond the first has cover art, then its own cover backs the slide", () => {
    const items = threeItems();
    items[1] = item({ song: song({ id: "s2", title: "Nightcall", coverArtId: "c9" }) });
    const { container } = renderHero({ items, hero: homeHero() });

    // Only the #1 slide gets the starred fanart; the rest fall back to their cover.
    expect(container.innerHTML).toContain("/api/cover/c9?size=hero");
    expect(container.innerHTML).toContain("/api/fanart/f1?size=hero");
  });
});

describe("Hero action row", () => {
  it("when nothing of this song is playing, then the button offers to play it", () => {
    renderHero({ items: [item()], currentId: "other", playing: true });

    expect(screen.getByRole("button", { name: "Play Golden Hour" })).toBeInTheDocument();
  });

  it("when this song is the one playing, then the button offers to pause it", () => {
    renderHero({ items: [item()], currentId: "s1", playing: true });

    expect(screen.getByRole("button", { name: "Pause Golden Hour" })).toBeInTheDocument();
  });

  it("when the play button is pressed, then the currently shown song is handed back", async () => {
    const user = userEvent.setup();
    const { onPlay } = renderHero({ items: [item()] });

    await user.click(screen.getByRole("button", { name: "Play Golden Hour" }));

    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("when the song is published, then sharing it is offered and reports that song", async () => {
    const user = userEvent.setup();
    const { onShare } = renderHero({ items: [item()] });

    await user.click(screen.getByRole("button", { name: /Share/ }));

    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("when the song is unpublished, then sharing is withheld", () => {
    renderHero({ items: [item({ song: song({ published: false }) })] });

    // An unpublished /song/:id 404s for anonymous recipients, so a share link
    // would hand out a broken URL.
    expect(screen.queryByRole("button", { name: /Share/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/ })).toBeInTheDocument();
  });

  it("when the carousel moves on, then the action row acts on the newly shown song", async () => {
    const user = userEvent.setup();
    const { container, onPlay } = renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{ArrowRight}");
    settle(container);
    await user.click(screen.getByRole("button", { name: "Play Nightcall" }));

    // The row is stationary — it must follow the active slide, not the first one.
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }));
  });

  it("when a song is featured, then its download link points at that song's file", () => {
    renderHero({ items: [item({ song: song({ id: "s9" }) })] });

    expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute(
      "href",
      "/api/songs/s9/download",
    );
  });
});

describe("Hero keyboard paging", () => {
  it("when there is a single slide, then the panel is not focusable and has no dots", () => {
    renderHero({ items: [item()] });

    // Nothing to page through, so the panel must stay out of the tab order.
    expect(screen.getByRole("banner")).not.toHaveAttribute("tabindex");
    expect(screen.queryByLabelText(/^Show slide /)).not.toBeInTheDocument();
  });

  it("when the right arrow is pressed, then the next slide becomes current", async () => {
    const user = userEvent.setup();
    renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{ArrowRight}");

    expect(activeDot()).toBe(1);
  });

  it("when the left arrow is pressed on the first slide, then it wraps to the last one", async () => {
    const user = userEvent.setup();
    const { container } = renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{ArrowLeft}");

    expect(activeDot()).toBe(2);
    // The move lands on the cloned last slide; once settled the track silently
    // jumps to the real one so the loop can continue forward from there.
    settle(container);
    expect(track(container).style.transform).toBe("translateX(-300%)");
  });

  it("when a second arrow arrives before the slide settles, then it is ignored", async () => {
    const user = userEvent.setup();
    renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{ArrowRight}{ArrowRight}");

    // Stacking moves could run the child index past the clone into empty space.
    expect(activeDot()).toBe(1);
  });

  it("when the slide has settled, then a further arrow advances again", async () => {
    const user = userEvent.setup();
    const { container } = renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{ArrowRight}");
    settle(container);
    await user.keyboard("{ArrowRight}");

    expect(activeDot()).toBe(2);
  });

  it("when an unrelated key is pressed, then the carousel stays put", async () => {
    const user = userEvent.setup();
    renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{Enter}");

    expect(activeDot()).toBe(0);
  });
});

describe("Hero dots", () => {
  it("when a dot is clicked, then that slide becomes current", async () => {
    const user = userEvent.setup();
    renderHero();

    await user.click(screen.getByLabelText("Show slide 3"));

    expect(activeDot()).toBe(2);
  });

  it("when the already-current dot is clicked, then nothing moves", async () => {
    const user = userEvent.setup();
    const { container } = renderHero();

    await user.click(screen.getByLabelText("Show slide 1"));

    expect(activeDot()).toBe(0);
    // A no-op must not repaint the track onto a different child index.
    expect(track(container).style.transform).toBe("translateX(-100%)");
  });
});

describe("Hero auto-advance", () => {
  it("when the dwell elapses untouched, then it advances on its own", () => {
    vi.useFakeTimers();
    renderHero();

    act(() => vi.advanceTimersByTime(30000));

    expect(activeDot()).toBe(1);
  });

  it("when the pointer is over the panel, then auto-advance holds", () => {
    vi.useFakeTimers();
    renderHero();

    fireEvent.pointerEnter(screen.getByRole("banner"));
    act(() => vi.advanceTimersByTime(30000));

    // Sliding a hovered panel out from under the pointer steals the click target.
    expect(activeDot()).toBe(0);
  });

  it("when the pointer leaves again, then auto-advance resumes", () => {
    vi.useFakeTimers();
    const banner = renderHero() && screen.getByRole("banner");

    fireEvent.pointerEnter(banner);
    act(() => vi.advanceTimersByTime(30000));
    fireEvent.pointerLeave(banner);
    act(() => vi.advanceTimersByTime(30000));

    expect(activeDot()).toBe(1);
  });

  it("when the panel holds focus, then auto-advance holds", () => {
    vi.useFakeTimers();
    renderHero();

    fireEvent.focus(screen.getByRole("banner"));
    act(() => vi.advanceTimersByTime(30000));

    // A keyboard user reading the slide must not have it yanked away mid-read.
    expect(activeDot()).toBe(0);
  });

  it("when a manual move happens, then the next slide gets a full fresh dwell", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    // fireEvent rather than userEvent: user-event's own internal delay never
    // resolves once the timers are faked for the 30s dwell.
    fireEvent.click(screen.getByLabelText("Show slide 2"));
    settle(container);
    act(() => vi.advanceTimersByTime(29000));

    // The dwell restarted on the manual move, so it is not due yet.
    expect(activeDot()).toBe(1);

    act(() => vi.advanceTimersByTime(2000));

    expect(activeDot()).toBe(2);
  });
});

describe("Hero reduced motion", () => {
  function preferReducedMotion() {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: true });
  }

  it("when reduced motion is preferred, then slides are painted without a transition", async () => {
    preferReducedMotion();
    const user = userEvent.setup();
    const { container } = renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{ArrowRight}");

    expect(track(container).style.transition).toBe("none");
    expect(activeDot()).toBe(1);
  });

  it("when reduced motion is preferred, then the carousel never advances by itself", () => {
    preferReducedMotion();
    vi.useFakeTimers();
    renderHero();

    act(() => vi.advanceTimersByTime(120000));

    // Unsolicited motion is exactly what the preference asks us to stop.
    expect(activeDot()).toBe(0);
  });

  it("when reduced motion wraps past the end, then it snaps to the real slide immediately", async () => {
    preferReducedMotion();
    const user = userEvent.setup();
    const { container } = renderHero();
    screen.getByRole("banner").focus();

    await user.keyboard("{ArrowLeft}");

    // No transition will ever fire here, so the wrap has to normalise inline or
    // the track would be stranded on the clone forever.
    expect(track(container).style.transform).toBe("translateX(-300%)");
  });
});

describe("Hero swipe", () => {
  // Drags are driven with fireEvent because the gesture needs exact clientX
  // values and controlled time between moves to produce a known velocity.
  function drag(container: HTMLElement, moves: { x: number; after: number }[], start = 500) {
    const el = track(container);
    fireEvent.pointerDown(el, { clientX: start, pointerId: 1 });
    for (const m of moves) {
      act(() => vi.advanceTimersByTime(m.after));
      fireEvent.pointerMove(el, { clientX: m.x, pointerId: 1 });
    }
    return el;
  }

  it("when a drag travels past the threshold, then it commits to the next slide", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    const el = drag(container, [{ x: 380, after: 100 }]);
    fireEvent.pointerUp(el, { clientX: 380, pointerId: 1 });

    expect(activeDot()).toBe(1);
  });

  it("when a drag is pulled the other way past the threshold, then it goes back a slide", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    const el = drag(container, [{ x: 620, after: 100 }]);
    fireEvent.pointerUp(el, { clientX: 620, pointerId: 1 });

    // Wrapping backwards off the first slide lands on the last one.
    expect(activeDot()).toBe(2);
  });

  it("when a drag stops short and slowly, then it snaps back without changing slide", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    const el = drag(container, [{ x: 490, after: 200 }]);
    fireEvent.pointerUp(el, { clientX: 490, pointerId: 1 });

    expect(activeDot()).toBe(0);
  });

  it("when a short drag is flicked quickly, then it still commits", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    const el = drag(container, [{ x: 470, after: 10 }]);
    fireEvent.pointerUp(el, { clientX: 470, pointerId: 1 });

    // 30px is under the distance threshold, but at 3px/ms it is unmistakably a
    // deliberate swipe — treating it as a miss would feel broken.
    expect(activeDot()).toBe(1);
  });

  it("when the pointer is cancelled mid-drag, then the travel so far still decides", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    const el = drag(container, [{ x: 300, after: 100 }]);
    fireEvent.pointerCancel(el, { pointerId: 1 });

    // A cancel carries no coordinates, so the last seen x has to stand in.
    expect(activeDot()).toBe(1);
  });

  it("when the drag is released outside the panel, then it is still resolved", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    drag(container, [{ x: 300, after: 100 }]);
    fireEvent.pointerUp(window, { clientX: 300, pointerId: 1 });

    // Without the window-level listener the carousel would stay stuck mid-drag.
    expect(activeDot()).toBe(1);
  });

  it("when the pointer moves with no button held, then the track is left alone", () => {
    vi.useFakeTimers();
    const { container } = renderHero();

    fireEvent.pointerMove(track(container), { clientX: 100, pointerId: 1 });

    expect(track(container).style.transform).toBe("translateX(-100%)");
  });

  it("when a drag happens while a slide is animating, then it takes the slide over", () => {
    vi.useFakeTimers();
    const { container } = renderHero();
    const banner = screen.getByRole("banner");

    // Keyed with fireEvent because user-event's delay stalls under fake timers,
    // and the drag below needs faked time to produce a known velocity.
    fireEvent.keyDown(banner, { key: "ArrowRight" });
    const el = drag(container, [{ x: 300, after: 100 }]);
    fireEvent.pointerUp(el, { clientX: 300, pointerId: 1 });

    // Grabbing mid-animation must start a fresh drag rather than be swallowed by
    // the moving gate, which no transitionend has cleared yet.
    expect(activeDot()).toBe(2);
  });

  it("when the panel has a single slide, then dragging it does nothing", () => {
    vi.useFakeTimers();
    const { container } = renderHero({ items: [item()] });

    const el = track(container);
    fireEvent.pointerDown(el, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 100, pointerId: 1 });

    expect(el.style.transform).toBe("translateX(0%)");
  });
});
