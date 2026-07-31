import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StudioProgress, StudioResult } from "./api";

// Studio's three network calls stream Server-Sent Events. Mocking them at the api
// boundary lets a test hold a generation open and push progress into it, which is
// the only way to observe the loading surface at all.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    studioGenerate: vi.fn(),
    studioRefine: vi.fn(),
    generateStudioCoverArt: vi.fn(),
  };
});

// The clipboard is unavailable in jsdom, so copyText is stubbed to let both the
// success and the fall-back-to-prompt path be exercised.
vi.mock("./share", async () => {
  const actual = await vi.importActual<typeof import("./share")>("./share");
  return { ...actual, copyText: vi.fn() };
});

// The two image-generator modes are whole features with their own suites; stubbing
// them keeps these tests about which mode StudioPage chose to show.
vi.mock("./StudioGenreFanart", () => ({
  GenreFanartMode: ({ initialGenreId }: { initialGenreId?: string }) => (
    <div data-testid="fanart-mode">{initialGenreId ?? ""}</div>
  ),
}));
vi.mock("./StudioAlbumCover", () => ({
  AlbumCoverMode: () => <div data-testid="coverart-mode" />,
}));

import { StudioPage } from "./StudioPage";
import * as api from "./api";
import { copyText } from "./share";

const mocked = vi.mocked(api);
const copyMock = vi.mocked(copyText);

function result(overrides: Partial<StudioResult> = {}): StudioResult {
  return {
    stylePrompt: "1990s, grunge, distorted guitars",
    lyrics: "[Verse]\nthe river takes it back",
    coverArtPrompt: "a rain-soaked neon alley",
    genres: ["synth pop"],
    bands: ["Paper Anchor", "The Slow Tide"],
    titles: ["Undertow"],
    albums: ["Low Water"],
    ...overrides,
  };
}

// A generation the test controls: it stays pending until resolved, so the loading
// surface can be inspected, and progress can be pushed at will.
function deferredGenerate() {
  let push!: (p: StudioProgress) => void;
  let pushPartial!: (p: Partial<StudioResult>) => void;
  let finish!: (r: StudioResult) => void;
  let fail!: (e: Error) => void;
  mocked.studioGenerate.mockImplementation((_ref, onProgress, onPartial) => {
    push = onProgress;
    pushPartial = onPartial ?? (() => {});
    return new Promise<StudioResult>((res, rej) => {
      finish = res;
      fail = rej;
    });
  });
  return {
    push: (p: StudioProgress) => act(() => void push(p)),
    // One finished turn arriving mid-run, as the server streams it.
    partial: (p: Partial<StudioResult>) => act(() => void pushPartial(p)),
    finish: async (r: StudioResult) => {
      await act(async () => finish(r));
    },
    fail: async (e: Error) => {
      await act(async () => fail(e));
    },
  };
}

// Fills the reference field and submits, which is Studio's single reset+run action.
async function generate(
  user: ReturnType<typeof userEvent.setup>,
  reference = "Enter Sandman",
) {
  await user.type(screen.getByLabelText("Song reference"), reference);
  await user.click(screen.getByRole("button", { name: "Generate" }));
}

// Renders Studio and drives it through to a finished result, the state every
// output card depends on.
async function renderWithResult(
  props: Parameters<typeof StudioPage>[0] = {},
  r = result(),
) {
  const user = userEvent.setup();
  const run = deferredGenerate();
  render(<StudioPage {...props} />);
  await generate(user);
  await run.finish(r);
  return { user, run };
}

beforeEach(() => {
  copyMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("StudioPage reference form", () => {
  it("when the reference is empty, then generating is not offered", () => {
    render(<StudioPage />);

    // Submitting nothing would burn a research run on an empty query.
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("when the reference is only whitespace, then generating stays blocked", async () => {
    const user = userEvent.setup();
    render(<StudioPage />);

    await user.type(screen.getByLabelText("Song reference"), "   ");

    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("when a song is named, then it is researched under its trimmed name", async () => {
    const user = userEvent.setup();
    deferredGenerate();
    render(<StudioPage />);

    await generate(user, "  Enter Sandman  ");

    expect(mocked.studioGenerate).toHaveBeenCalledWith(
      "Enter Sandman",
      expect.any(Function), // progress
      expect.any(Function), // partial results
    );
  });
});

describe("StudioPage research progress", () => {
  it("when research has started but reported nothing, then it says so and locks the form", async () => {
    const user = userEvent.setup();
    deferredGenerate();
    render(<StudioPage />);

    await generate(user);

    expect(screen.getByText("Starting research")).toBeInTheDocument();
    // Editing the reference mid-run would desync it from the result being built.
    expect(screen.getByLabelText("Song reference")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Working/ })).toBeDisabled();
  });

  it("when progress arrives, then the latest step is shown and the earlier ones listed", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    run.push({ phase: "search", detail: "Searching the web" });
    run.push({ phase: "read", detail: "Reading reviews" });

    expect(screen.getByText("Reading reviews")).toBeInTheDocument();
    // Completed steps stay visible so a long run reads as progress, not a stall.
    expect(screen.getByRole("listitem")).toHaveTextContent("Searching the web");
  });

  it("when only one step has arrived, then no completed-step list is shown yet", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    run.push({ phase: "search", detail: "Searching the web" });

    expect(screen.getByText("Searching the web")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("when the run finishes, then the progress surface gives way to the results", async () => {
    await renderWithResult();

    expect(screen.queryByText("Starting research")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Lyrics (editable)")).toBeInTheDocument();
  });
});

// Generation runs in three turns, and each one's output is shown the moment it
// lands rather than at the very end — the page should never be a blank wait.
describe("StudioPage progressive results", () => {
  it("when a run starts, then every card is already on the page as a placeholder", async () => {
    const user = userEvent.setup();
    deferredGenerate();
    render(<StudioPage />);

    await generate(user);

    const pending = screen.getAllByRole("generic", { busy: true });
    expect(pending.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("→ Suno “Lyrics” · being written")).toBeVisible();
  });

  it("when the first turn lands, then its card fills while the rest keep waiting", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    run.partial({
      stylePrompt: "1990s, grunge, distorted guitars",
      genres: ["grunge"],
    });

    // The style prompt is readable and copyable right away...
    expect(
      screen.getByText("1990s, grunge, distorted guitars"),
    ).toBeInTheDocument();
    // The genre pill from the same turn is up too (the style prompt text also
    // contains the word, hence the exact match on the pill).
    expect(screen.getByText("Grunge")).toBeInTheDocument();
    // ...while the lyrics are still being written, and cannot be refined yet.
    expect(
      screen.queryByLabelText("Lyrics (editable)"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Refine lyrics instruction")).toBeDisabled();
  });

  it("when the lyrics turn lands, then they are editable before the run ends", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    run.partial({ stylePrompt: "1990s, grunge" });
    run.partial({ lyrics: "[Verse]\nthe river takes it back" });

    expect(screen.getByLabelText("Lyrics (editable)")).toHaveValue(
      "[Verse]\nthe river takes it back",
    );
    // The naming turn has not answered yet, so its slot is still a placeholder.
    expect(screen.getByText("→ naming it")).toBeVisible();
  });

  it("when a later turn fails, then the parts that did land stay on screen", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    run.partial({ stylePrompt: "1990s, grunge, distorted guitars" });
    await run.fail(new Error("studio request failed (502)"));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "studio request failed (502)",
    );
    // The finished style prompt is still usable...
    expect(
      screen.getByText("1990s, grunge, distorted guitars"),
    ).toBeInTheDocument();
    // ...and nothing is left shimmering or drawn as an empty box.
    expect(
      screen.queryByLabelText("Lyrics (editable)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("generic", { busy: true }),
    ).not.toBeInTheDocument();
  });

  it("when the run ends, then the final result replaces what the partials built", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    run.partial({ lyrics: "[Verse]\nfirst draft" });
    await run.finish(result());

    expect(screen.getByLabelText("Lyrics (editable)")).toHaveValue(
      "[Verse]\nthe river takes it back",
    );
  });
});

describe("StudioPage results", () => {
  it("when a result arrives, then every output the model produced is shown", async () => {
    await renderWithResult();

    expect(screen.getByLabelText("Lyrics (editable)")).toHaveValue(
      "[Verse]\nthe river takes it back",
    );
    expect(
      screen.getByText("1990s, grunge, distorted guitars"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Cover-art prompt (editable)")).toHaveValue(
      "a rain-soaked neon alley",
    );
    expect(screen.getByText("Paper Anchor")).toBeInTheDocument();
    expect(screen.getByText("Undertow")).toBeInTheDocument();
    expect(screen.getByText("Low Water")).toBeInTheDocument();
    expect(screen.getByText("Synth Pop")).toBeInTheDocument();
  });

  it("when the style prompt is shown, then its length is counted against Suno's limit", async () => {
    await renderWithResult({}, result({ stylePrompt: "abc" }));

    // Suno silently truncates past 500 characters, so the budget has to be visible.
    expect(screen.getByText("3 / 500")).toBeInTheDocument();
  });

  it("when the model named nothing and classified nothing, then the identity card is omitted", async () => {
    await renderWithResult(
      {},
      result({ bands: [], titles: [], albums: [], genres: [] }),
    );

    expect(screen.queryByText("Identity")).not.toBeInTheDocument();
    expect(
      screen.getByText("1990s, grunge, distorted guitars"),
    ).toBeInTheDocument();
  });

  it("when only genres came back, then the identity card shows them without name columns", async () => {
    await renderWithResult({}, result({ bands: [], titles: [], albums: [] }));

    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.queryByText("Band name")).not.toBeInTheDocument();
    expect(screen.getByText("Synth Pop")).toBeInTheDocument();
  });

  it("when the lyrics are hand-edited, then the edit is kept", async () => {
    const { user } = await renderWithResult();

    const box = screen.getByLabelText("Lyrics (editable)");
    await user.clear(box);
    await user.type(box, "a new line");

    expect(box).toHaveValue("a new line");
  });

  it("when generation fails, then the reason is announced instead of empty results", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    await run.fail(new Error("studio request failed (502)"));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "studio request failed (502)",
    );
    expect(
      screen.queryByLabelText("Lyrics (editable)"),
    ).not.toBeInTheDocument();
    // The form has to unlock again or the failure is a dead end.
    expect(screen.getByLabelText("Song reference")).not.toBeDisabled();
  });

  it("when the failure carries no message, then a generic one is shown", async () => {
    const user = userEvent.setup();
    const run = deferredGenerate();
    render(<StudioPage />);
    await generate(user);

    await run.fail(new Error(""));

    expect(screen.getByRole("alert")).toHaveTextContent("Generation failed");
  });
});

describe("StudioPage stale reference", () => {
  it("when the reference is changed after a run, then a regenerate hint appears", async () => {
    const { user } = await renderWithResult();

    await user.clear(screen.getByLabelText("Song reference"));
    await user.type(screen.getByLabelText("Song reference"), "Nightcall");

    // The results on screen belong to the previous song, so the mismatch is called
    // out rather than left to look like they updated.
    expect(
      screen.getByText(/Press Enter to regenerate for “Nightcall”/),
    ).toBeInTheDocument();
  });

  it("when the reference is cleared entirely, then no stale hint is shown", async () => {
    const { user } = await renderWithResult();

    await user.clear(screen.getByLabelText("Song reference"));

    expect(
      screen.queryByText(/Press Enter to regenerate/),
    ).not.toBeInTheDocument();
  });

  it("when the reference is unchanged, then no stale hint is shown", async () => {
    await renderWithResult();

    expect(
      screen.queryByText(/Press Enter to regenerate/),
    ).not.toBeInTheDocument();
  });
});

describe("StudioPage lyric refinement", () => {
  it("when no instruction is given, then refining is not offered", async () => {
    await renderWithResult();

    expect(screen.getByRole("button", { name: "Refine" })).toBeDisabled();
  });

  it("when an instruction is submitted, then the lyrics are rewritten in place", async () => {
    const { user } = await renderWithResult();
    mocked.studioRefine.mockResolvedValue("[Verse]\nthe river keeps it");

    await user.type(
      screen.getByLabelText("Refine lyrics instruction"),
      "darker chorus",
    );
    await user.click(screen.getByRole("button", { name: "Refine" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Lyrics (editable)")).toHaveValue(
        "[Verse]\nthe river keeps it",
      ),
    );
    // Refinement works from the song that was actually generated, not whatever is
    // currently typed in the reference field.
    expect(mocked.studioRefine).toHaveBeenCalledWith(
      "Enter Sandman",
      "[Verse]\nthe river takes it back",
      "darker chorus",
      expect.any(Function),
    );
  });

  it("when a refinement succeeds, then the instruction field is emptied for the next one", async () => {
    const { user } = await renderWithResult();
    mocked.studioRefine.mockResolvedValue("[Verse]\nrewritten");

    await user.type(
      screen.getByLabelText("Refine lyrics instruction"),
      "darker chorus",
    );
    await user.click(screen.getByRole("button", { name: "Refine" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Refine lyrics instruction")).toHaveValue(
        "",
      ),
    );
  });

  it("when a refinement is in flight, then progress is shown and the results are hidden", async () => {
    const { user } = await renderWithResult();
    let push!: (p: StudioProgress) => void;
    mocked.studioRefine.mockImplementation((_r, _l, _i, onProgress) => {
      push = onProgress;
      return new Promise<string>(() => {});
    });

    await user.type(
      screen.getByLabelText("Refine lyrics instruction"),
      "darker chorus",
    );
    await user.click(screen.getByRole("button", { name: "Refine" }));
    act(() => void push({ phase: "write", detail: "Rewriting the chorus" }));

    expect(screen.getByText("Rewriting the chorus")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Lyrics (editable)"),
    ).not.toBeInTheDocument();
  });

  it("when a refinement fails, then the reason is announced and the lyrics are left intact", async () => {
    const { user } = await renderWithResult();
    mocked.studioRefine.mockRejectedValue(new Error("refine timed out"));

    await user.type(
      screen.getByLabelText("Refine lyrics instruction"),
      "darker chorus",
    );
    await user.click(screen.getByRole("button", { name: "Refine" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "refine timed out",
    );
    expect(screen.getByLabelText("Lyrics (editable)")).toHaveValue(
      "[Verse]\nthe river takes it back",
    );
  });

  it("when a refinement fails without a message, then a generic one is shown", async () => {
    const { user } = await renderWithResult();
    mocked.studioRefine.mockRejectedValue(new Error(""));

    await user.type(
      screen.getByLabelText("Refine lyrics instruction"),
      "darker chorus",
    );
    await user.click(screen.getByRole("button", { name: "Refine" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Refinement failed",
    );
  });
});

describe("StudioPage copy buttons", () => {
  it("when a copy succeeds, then it confirms and then returns to its label", async () => {
    await renderWithResult();

    // fireEvent rather than userEvent: user-event's internal delay never resolves
    // once the timers are faked for the confirmation window.
    vi.useFakeTimers();
    fireEvent.click(
      within(
        screen.getByText("Style prompt").parentElement!.parentElement!,
      ).getByRole("button", { name: "Copy" }),
    );
    await act(async () => {});

    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(copyMock).toHaveBeenCalledWith("1990s, grunge, distorted guitars");

    act(() => void vi.advanceTimersByTime(1500));

    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
  });

  it("when the clipboard is unavailable, then the text is offered in a prompt instead", async () => {
    await renderWithResult();
    copyMock.mockResolvedValue(false);
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);

    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    await act(async () => {});

    // Insecure contexts have no clipboard API at all; a prompt is the only way to
    // let the user get the text out.
    expect(promptSpy).toHaveBeenCalledWith(
      "Copy this text",
      expect.any(String),
    );
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    promptSpy.mockRestore();
  });
});

describe("StudioPage modes", () => {
  it("when image generation is off, then Studio stays the single-purpose Suno tool", () => {
    render(<StudioPage />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.getByText("Turn a song into a Suno prompt."),
    ).toBeInTheDocument();
  });

  it("when image generation is on, then the fanart mode can be switched to", async () => {
    const user = userEvent.setup();
    render(<StudioPage imageGenEnabled />);

    await user.click(screen.getByRole("tab", { name: "Genre → Fanart" }));

    expect(screen.getByTestId("fanart-mode")).toBeInTheDocument();
    expect(
      screen.getByText("Generate cover fanart for a genre."),
    ).toBeInTheDocument();
    // The Suno tool is put away rather than stacked underneath.
    expect(screen.queryByLabelText("Song reference")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Genre → Fanart" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("when the album cover mode is chosen, then it replaces the Suno tool", async () => {
    const user = userEvent.setup();
    render(<StudioPage imageGenEnabled />);

    await user.click(screen.getByRole("tab", { name: "Album Cover" }));

    expect(screen.getByTestId("coverart-mode")).toBeInTheDocument();
    expect(
      screen.getByText("Create or replace cover art for an album."),
    ).toBeInTheDocument();
  });

  it("when arriving from a genre, then Studio opens straight into fanart for it", () => {
    render(<StudioPage imageGenEnabled initialGenreId="g1" />);

    expect(screen.getByTestId("fanart-mode")).toHaveTextContent("g1");
  });

  it("when arriving from a genre without an image generator, then it falls back to the Suno tool", () => {
    render(<StudioPage initialGenreId="g1" />);

    // Fanart mode has nothing to generate with, so opening into it would be a
    // dead end.
    expect(screen.queryByTestId("fanart-mode")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Song reference")).toBeInTheDocument();
  });

  it("when switching back to the Suno tool, then its results are still there", async () => {
    const { user } = await renderWithResult({ imageGenEnabled: true });

    await user.click(screen.getByRole("tab", { name: "Genre → Fanart" }));
    await user.click(screen.getByRole("tab", { name: "Song → Suno" }));

    expect(screen.getByLabelText("Lyrics (editable)")).toHaveValue(
      "[Verse]\nthe river takes it back",
    );
  });
});

describe("StudioPage cover art", () => {
  it("when image generation is off, then no cover-art generator is offered", async () => {
    await renderWithResult();

    expect(
      screen.queryByRole("button", { name: /Generate cover art/ }),
    ).not.toBeInTheDocument();
    // The prompt itself is still useful — it can be pasted elsewhere.
    expect(
      screen.getByLabelText("Cover-art prompt (editable)"),
    ).toBeInTheDocument();
  });

  it("when image generation is on, then the configured models are offered", async () => {
    await renderWithResult({
      imageGenEnabled: true,
      imageModels: ["flux-2-pro", "some-other"],
      defaultImageModel: "flux-2-pro",
    });

    const picker = screen.getByLabelText("Cover art model");
    expect(picker).toHaveValue("flux-2-pro");
    // Known models get a friendly label; an operator-set one falls back to its id.
    expect(
      within(picker).getByRole("option", { name: "Best quality · flux-2-pro" }),
    ).toBeInTheDocument();
    expect(
      within(picker).getByRole("option", { name: "some-other" }),
    ).toBeInTheDocument();
  });

  it("when a cover is generated, then it is shown with the chosen model and a download", async () => {
    const { user } = await renderWithResult({
      imageGenEnabled: true,
      imageModels: ["flux-2-pro", "flux-2-flex"],
      defaultImageModel: "flux-2-pro",
    });
    mocked.generateStudioCoverArt.mockResolvedValue({
      id: "img7",
      status: "ok",
      width: 1024,
      height: 1024,
    });

    await user.selectOptions(
      screen.getByLabelText("Cover art model"),
      "flux-2-flex",
    );
    await user.click(
      screen.getByRole("button", { name: /Generate cover art/ }),
    );

    const image = await screen.findByAltText("Generated cover art");
    expect(image).toHaveAttribute("src", expect.stringContaining("img7"));
    expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute(
      "download",
      "cover-img7.png",
    );
    expect(mocked.generateStudioCoverArt).toHaveBeenCalledWith(
      "a rain-soaked neon alley",
      "flux-2-flex",
    );
  });

  it("when a cover already exists, then the action offers to regenerate it", async () => {
    const { user } = await renderWithResult({
      imageGenEnabled: true,
      imageModels: ["flux-2-pro"],
    });
    mocked.generateStudioCoverArt.mockResolvedValue({
      id: "img7",
      status: "ok",
      width: 1024,
      height: 1024,
    });

    await user.click(
      screen.getByRole("button", { name: /Generate cover art/ }),
    );
    await screen.findByAltText("Generated cover art");

    expect(
      screen.getByRole("button", { name: /Regenerate/ }),
    ).toBeInTheDocument();
  });

  it("when a cover is being generated, then the wait is announced and the model locked", async () => {
    const { user } = await renderWithResult({
      imageGenEnabled: true,
      imageModels: ["flux-2-pro"],
    });
    mocked.generateStudioCoverArt.mockImplementation(
      () => new Promise(() => {}),
    );

    await user.click(
      screen.getByRole("button", { name: /Generate cover art/ }),
    );

    expect(screen.getByText("Generating cover art")).toBeInTheDocument();
    // Changing the model mid-run would not affect the image already being made.
    expect(screen.getByLabelText("Cover art model")).toBeDisabled();
  });

  it("when cover generation fails, then the reason is announced", async () => {
    const { user } = await renderWithResult({
      imageGenEnabled: true,
      imageModels: ["flux-2-pro"],
    });
    mocked.generateStudioCoverArt.mockRejectedValue(
      new Error("model overloaded"),
    );

    await user.click(
      screen.getByRole("button", { name: /Generate cover art/ }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "model overloaded",
    );
    expect(
      screen.queryByAltText("Generated cover art"),
    ).not.toBeInTheDocument();
  });

  it("when the cover-art prompt is emptied, then generating is not offered", async () => {
    const { user } = await renderWithResult({
      imageGenEnabled: true,
      imageModels: ["flux-2-pro"],
    });

    await user.clear(screen.getByLabelText("Cover-art prompt (editable)"));

    // There is nothing to draw from, so the request would only waste a call.
    expect(
      screen.getByRole("button", { name: /Generate cover art/ }),
    ).toBeDisabled();
  });
});
