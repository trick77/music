import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, getStudioRun: vi.fn() };
});

import { StudioHistoryRun } from "./StudioHistoryRun";
import * as api from "./api";
import type { StudioRun } from "./api";
const mocked = vi.mocked(api);

function run(over: Partial<StudioRun> = {}): StudioRun {
  return {
    id: "r1",
    reference: "Metallica, Enter Sandman",
    referenceArtist: "Metallica",
    referenceTitle: "Enter Sandman",
    stylePrompt: "1991,thrash metal,no humming",
    lyrics: "[Verse]\nthe hallway light stays on till four",
    coverArtPrompt: "a single unlit hallway door standing open",
    genres: ["thrash metal"],
    bands: ["Hollow Sabbath"],
    titles: ["Sleep Is a Door"],
    albums: ["Nightfall Sessions"],
    coverArtId: "",
    refineCount: 0,
    createdAt: "2026-08-01 12:22:00",
    updatedAt: "2026-08-01 12:22:00",
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("StudioHistoryRun", () => {
  it("names the run from the artist and title the model identified", async () => {
    mocked.getStudioRun.mockResolvedValue(run());
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(
      await screen.findByRole("heading", { name: "Enter Sandman" }),
    ).toBeInTheDocument();
    // The artist shows in the subhead and again on the Reference detail row.
    expect(screen.getAllByText(/Metallica/).length).toBeGreaterThan(0);
  });

  // Everything the run produced comes back — this is the point of keeping it.
  it("shows all three band, title and album ideas", async () => {
    mocked.getStudioRun.mockResolvedValue(
      run({
        bands: ["Hollow Sabbath", "Ashen Verdict", "Grey Litany"],
        titles: ["Sleep Is a Door", "Hallway Light", "Four In The Morning"],
        albums: ["Nightfall Sessions", "The Long Dark", "Teeth Of The Year"],
      }),
    );
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    for (const name of [
      "Hollow Sabbath",
      "Ashen Verdict",
      "Grey Litany",
      "Sleep Is a Door",
      "Hallway Light",
      "Four In The Morning",
      "Nightfall Sessions",
      "The Long Dark",
      "Teeth Of The Year",
    ]) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }
  });

  it("shows the lyrics, both prompts and the genres", async () => {
    mocked.getStudioRun.mockResolvedValue(run());
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(
      await screen.findByText(/hallway light stays on/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1991,thrash metal/)).toBeInTheDocument();
    expect(screen.getByText(/unlit hallway door/)).toBeInTheDocument();
    expect(screen.getByText("Thrash Metal")).toBeInTheDocument();
  });

  // The style prompt carries its character count on a live run; a saved one
  // shows the same thing rather than a bare string.
  it("keeps the style prompt's character count", async () => {
    mocked.getStudioRun.mockResolvedValue(run({ stylePrompt: "abc" }));
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(await screen.findByText("3 / 500")).toBeInTheDocument();
  });

  // A saved run is read-only: nothing on it can start a write.
  it("offers no refine field and no editable boxes", async () => {
    mocked.getStudioRun.mockResolvedValue(run());
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    await screen.findByText(/\[Verse\]/);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /refine/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /generate cover art/i }),
    ).not.toBeInTheDocument();
  });

  it("says plainly that the run is read-only", async () => {
    mocked.getStudioRun.mockResolvedValue(run());
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
  });

  it("shows the cover image when the run has one", async () => {
    mocked.getStudioRun.mockResolvedValue(run({ coverArtId: "img1" }));
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    const img = await screen.findByRole("img", { name: /cover art/i });
    expect(img).toHaveAttribute("src", "/api/studio/coverart/img1");
  });

  it("omits the cover block entirely when the run has no image", async () => {
    mocked.getStudioRun.mockResolvedValue(run({ coverArtId: "" }));
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    await screen.findByText(/\[Verse\]/);
    expect(
      screen.queryByRole("img", { name: /cover art/i }),
    ).not.toBeInTheDocument();
  });

  // Copy buttons stay — that is what the run is kept for.
  it("keeps copy buttons on every card", async () => {
    mocked.getStudioRun.mockResolvedValue(run());
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    await screen.findByText(/\[Verse\]/);
    // Lyrics, style prompt, cover-art prompt, plus one per idea row.
    expect(
      screen.getAllByRole("button", { name: /copy/i }).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("reports the reference and the refine count in the run details", async () => {
    mocked.getStudioRun.mockResolvedValue(run({ refineCount: 2 }));
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(
      await screen.findByText("Metallica, Enter Sandman"),
    ).toBeInTheDocument();
    expect(screen.getByText(/2×/)).toBeInTheDocument();
  });

  it("omits the refine line for a run that was never refined", async () => {
    mocked.getStudioRun.mockResolvedValue(run({ refineCount: 0 }));
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    await screen.findByText(/\[Verse\]/);
    expect(screen.queryByText("Refined")).not.toBeInTheDocument();
  });

  it("closes on Escape and on the X", async () => {
    mocked.getStudioRun.mockResolvedValue(run());
    const onClose = vi.fn();
    render(
      <StudioHistoryRun id="r1" onClose={onClose} onRegenerate={() => {}} />,
    );
    await screen.findByText(/\[Verse\]/);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // The only way forward is a fresh generation, and it never touches this run.
  it("starts a fresh run from the reference without mutating this one", async () => {
    mocked.getStudioRun.mockResolvedValue(run());
    const onRegenerate = vi.fn();
    render(
      <StudioHistoryRun
        id="r1"
        onClose={() => {}}
        onRegenerate={onRegenerate}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /generate this song again/i }),
    );
    expect(onRegenerate).toHaveBeenCalledWith("Metallica, Enter Sandman");
  });

  it("surfaces a load failure instead of an empty sheet", async () => {
    mocked.getStudioRun.mockRejectedValue(new Error("nope"));
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("shows a spinner while the run is loading", () => {
    mocked.getStudioRun.mockReturnValue(new Promise(() => {}));
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
  });

  // A run the model could not identify still opens, labelled by its reference.
  it("falls back to the reference when the model named nothing", async () => {
    mocked.getStudioRun.mockResolvedValue(
      run({
        referenceArtist: "",
        referenceTitle: "",
        reference: "blue monday new order",
      }),
    );
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    expect(
      await screen.findByRole("heading", { name: "blue monday new order" }),
    ).toBeInTheDocument();
  });

  // Empty idea lists mean the run produced none; the card must not render three
  // blank rows in their place.
  it("omits idea columns the run never produced", async () => {
    mocked.getStudioRun.mockResolvedValue(
      run({ bands: [], titles: [], albums: [], genres: [] }),
    );
    render(
      <StudioHistoryRun id="r1" onClose={() => {}} onRegenerate={() => {}} />,
    );
    await screen.findByText(/\[Verse\]/);
    expect(screen.queryByText("Band name")).not.toBeInTheDocument();
    expect(screen.queryByText("Identity")).not.toBeInTheDocument();
  });
});
