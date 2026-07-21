import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Fanart, GenreSummary } from "./api";

// The generate/suggest/refine/poll endpoints are mocked at the api module
// boundary (as App.test.tsx does) so these tests exercise this surface's own
// state machine — suggest, refine, poll-to-done, set-as-background — rather than
// the HTTP client underneath it.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    listGenres: vi.fn(),
    generateFanart: vi.fn(),
    getFanartMeta: vi.fn(),
    suggestGenrePrompt: vi.fn(),
    refineGenrePrompt: vi.fn(),
    patchGenre: vi.fn(),
  };
});

// navigate performs a real history push and would leak route state between tests.
vi.mock("./router", async () => {
  const actual = await vi.importActual<typeof import("./router")>("./router");
  return { ...actual, navigate: vi.fn() };
});

import { GenreFanartMode } from "./StudioGenreFanart";
import * as api from "./api";
import { navigate } from "./router";

const mocked = vi.mocked(api);

function genre(overrides: Partial<GenreSummary> = {}): GenreSummary {
  return {
    id: "g1",
    name: "synthwave",
    songCount: 12,
    accentColor: "#ff00aa",
    hasBackground: false,
    backgroundFanartId: "",
    ...overrides,
  };
}

function fanart(overrides: Partial<Fanart> = {}): Fanart {
  return {
    id: "f1",
    kind: "genre",
    genreId: "g1",
    status: "ready",
    caption: "",
    isActive: false,
    isHero: false,
    width: 1920,
    height: 1080,
    ...overrides,
  };
}

// Mounts the surface and waits for the genre list effect to settle, so tests
// start from a populated picker rather than its "Loading…" first paint.
async function renderMode(props: Partial<Parameters<typeof GenreFanartMode>[0]> = {}) {
  const view = render(
    <GenreFanartMode
      chatEnabled
      imageModels={["flux-2-klein-4b", "sd-3.5"]}
      defaultImageModel="flux-2-klein-4b"
      {...props}
    />,
  );
  await waitFor(() => expect(mocked.listGenres).toHaveBeenCalled());
  return view;
}

// Fills the prompt, which every generate/refine path is gated on.
async function writePrompt(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("Fanart prompt"), text);
}

beforeEach(() => {
  mocked.listGenres.mockResolvedValue([genre(), genre({ id: "g2", name: "darkwave", hasBackground: true })]);
  mocked.generateFanart.mockResolvedValue({ id: "f1", status: "generating" });
  // A terminal status on the first poll keeps pollUntilDone off its 1.5s timer,
  // so these tests need no fake timers.
  mocked.getFanartMeta.mockResolvedValue(fanart());
  mocked.patchGenre.mockResolvedValue({
    genre: genre(), songs: [], fanart: [], backgroundId: "f1", heroId: "",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// GenreFanartMode is the Studio surface that generates a wide genre background.
// It reuses the existing generate + suggest-prompt endpoints; rendered idle (no
// effects run under SSR) so the markup is deterministic and fetch-free.
describe("GenreFanartMode", () => {
  it("renders the genre picker, prompt field, and Generate action", () => {
    const html = renderToStaticMarkup(<GenreFanartMode chatEnabled={false} imageModels={["flux-2-klein-4b"]} defaultImageModel="flux-2-klein-4b" />);
    expect(html).toContain('aria-label="Genre"');
    expect(html).toContain('aria-label="Fanart prompt"');
    expect(html).toContain("Generate fanart");
  });

  it("shows Suggest prompt only when chat is enabled", () => {
    const off = renderToStaticMarkup(<GenreFanartMode chatEnabled={false} imageModels={[]} defaultImageModel="" />);
    expect(off).not.toContain("Suggest prompt");
    const on = renderToStaticMarkup(<GenreFanartMode chatEnabled={true} imageModels={[]} defaultImageModel="" />);
    expect(on).toContain("Suggest prompt");
  });
});

describe("GenreFanartMode genre picker", () => {
  it("when the genres load, then they are listed and the first is preselected", async () => {
    // Given / When
    await renderMode();

    // Then
    // Nothing can be generated without a genre, so defaulting to the first one
    // saves a click that has no meaningful alternative on first open.
    const picker = screen.getByLabelText("Genre") as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("g1"));
    expect(screen.getByRole("option", { name: /Synthwave/ })).toBeInTheDocument();
  });

  it("when a genre already has a background, then it is not flagged as needing artwork", async () => {
    // Given / When
    await renderMode();

    // Then
    // The flag is the whole point of this picker: it tells the user which genres
    // still look bare on the home surface.
    expect(await screen.findByRole("option", { name: "Synthwave — needs artwork" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Darkwave" })).toBeInTheDocument();
  });

  it("when a genre is preselected by the caller, then the loaded list does not override it", async () => {
    // Given / When
    // Arriving from a genre page must land on that genre, not on the alphabetically
    // first one.
    await renderMode({ initialGenreId: "g2" });

    // Then
    await waitFor(() => expect(screen.getByLabelText("Genre")).toHaveValue("g2"));
  });

  it("when the genre list fails to load, then it reports the failure", async () => {
    // Given
    mocked.listGenres.mockRejectedValue(new Error("500"));

    // When
    await renderMode();

    // Then
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load genres");
  });

  it("when the genre is switched, then a previous result is cleared", async () => {
    // Given
    const user = userEvent.setup();
    await renderMode();
    await writePrompt(user, "neon skyline");
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));
    expect(await screen.findByAltText("Generated genre fanart")).toBeInTheDocument();

    // When
    await user.selectOptions(screen.getByLabelText("Genre"), "g2");

    // Then
    // The image belongs to the genre it was generated for; leaving it on screen
    // would invite setting a synthwave picture as the darkwave background.
    expect(screen.queryByAltText("Generated genre fanart")).not.toBeInTheDocument();
  });
});

describe("GenreFanartMode prompt authoring", () => {
  it("when Suggest prompt is used, then the returned prompt fills the field", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggestGenrePrompt.mockResolvedValue("a chrome coastline at dusk");
    await renderMode();

    // When
    await user.click(screen.getByRole("button", { name: /Suggest prompt/ }));

    // Then
    expect(mocked.suggestGenrePrompt).toHaveBeenCalledWith("g1");
    await waitFor(() => expect(screen.getByLabelText("Fanart prompt")).toHaveValue("a chrome coastline at dusk"));
  });

  it("when suggesting a prompt fails, then it says so and leaves the field editable", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggestGenrePrompt.mockRejectedValue(new Error("502"));
    await renderMode();

    // When
    await user.click(screen.getByRole("button", { name: /Suggest prompt/ }));

    // Then
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not suggest a prompt");
    expect(screen.getByLabelText("Fanart prompt")).not.toBeDisabled();
  });

  it("when a refine instruction is submitted, then the rewritten prompt replaces the old one", async () => {
    // Given
    const user = userEvent.setup();
    mocked.refineGenrePrompt.mockResolvedValue("a chrome coastline at dusk, heavy rain");
    await renderMode();
    await writePrompt(user, "a chrome coastline at dusk");

    // When
    await user.type(screen.getByLabelText("Refine prompt instruction"), "add rain{Enter}");

    // Then
    expect(mocked.refineGenrePrompt).toHaveBeenCalledWith("g1", "a chrome coastline at dusk", "add rain");
    await waitFor(() => expect(screen.getByLabelText("Fanart prompt")).toHaveValue("a chrome coastline at dusk, heavy rain"));
  });

  it("when refining fails, then the original prompt is kept and the failure reported", async () => {
    // Given
    const user = userEvent.setup();
    mocked.refineGenrePrompt.mockRejectedValue(new Error("502"));
    await renderMode();
    await writePrompt(user, "neon skyline");

    // When
    await user.type(screen.getByLabelText("Refine prompt instruction"), "darker{Enter}");

    // Then
    // A failed rewrite must not cost the user the prompt they already had.
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not refine the prompt");
    expect(screen.getByLabelText("Fanart prompt")).toHaveValue("neon skyline");
  });

  it("when chat is disabled, then neither prompt-authoring aid is offered", async () => {
    // Given / When
    await renderMode({ chatEnabled: false });

    // Then
    // Both controls call an LLM, so without chat they would only ever error.
    expect(screen.queryByRole("button", { name: /Suggest prompt/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Refine prompt instruction")).not.toBeInTheDocument();
  });
});

describe("GenreFanartMode generation", () => {
  it("when the prompt is empty, then generation is blocked", async () => {
    // Given / When
    await renderMode();

    // Then
    // A blank prompt would spend a model call on nothing.
    expect(screen.getByRole("button", { name: "Generate fanart" })).toBeDisabled();
  });

  it("when generating, then the chosen model is submitted with the trimmed prompt", async () => {
    // Given
    const user = userEvent.setup();
    await renderMode();
    await writePrompt(user, "  neon skyline  ");
    await user.selectOptions(screen.getByLabelText("Image model"), "sd-3.5");

    // When
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));

    // Then
    await waitFor(() => expect(mocked.generateFanart).toHaveBeenCalledWith("neon skyline", "genre", "g1", "sd-3.5"));
  });

  it("when the job completes, then the image is shown and the action becomes Regenerate", async () => {
    // Given
    const user = userEvent.setup();
    mocked.getFanartMeta.mockResolvedValue(fanart({ id: "f7", status: "ready" }));
    await renderMode();
    await writePrompt(user, "neon skyline");

    // When
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));

    // Then
    const img = await screen.findByAltText("Generated genre fanart");
    expect(img).toHaveAttribute("src", expect.stringContaining("f7"));
    // Relabelling matters: pressing the same button again is a second attempt,
    // not a no-op on the picture already on screen.
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  it("when the job reports failure, then its error is surfaced and no image is shown", async () => {
    // Given
    const user = userEvent.setup();
    mocked.getFanartMeta.mockResolvedValue(fanart({ status: "failed", error: "content filter tripped" }));
    await renderMode();
    await writePrompt(user, "neon skyline");

    // When
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));

    // Then
    expect(await screen.findByRole("alert")).toHaveTextContent("content filter tripped");
    expect(screen.queryByAltText("Generated genre fanart")).not.toBeInTheDocument();
  });

  it("when the job fails without a reason, then a generic message stands in", async () => {
    // Given
    const user = userEvent.setup();
    mocked.getFanartMeta.mockResolvedValue(fanart({ status: "failed", error: "" }));
    await renderMode();
    await writePrompt(user, "neon skyline");

    // When
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));

    // Then
    expect(await screen.findByRole("alert")).toHaveTextContent("Generation failed");
  });

  it("when the request cannot be started, then it reports it and returns to idle", async () => {
    // Given
    const user = userEvent.setup();
    mocked.generateFanart.mockRejectedValue(new Error("503"));
    await renderMode();
    await writePrompt(user, "neon skyline");

    // When
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));

    // Then
    // Staying busy forever would strand the user with no way to retry.
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start generation");
    expect(screen.getByRole("button", { name: "Generate fanart" })).toBeEnabled();
  });

  it("when a job is in flight, then the surface announces it and locks the inputs", async () => {
    // Given
    const user = userEvent.setup();
    mocked.getFanartMeta.mockReturnValue(new Promise(() => {}));
    await renderMode();
    await writePrompt(user, "neon skyline");

    // When
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));

    // Then
    // The genre must not change mid-job, or the result would be filed under a
    // genre the user never generated for.
    expect(await screen.findByText("Generating fanart")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generating" })).toBeDisabled();
    expect(screen.getByLabelText("Genre")).toBeDisabled();
    expect(screen.getByLabelText("Image model")).toBeDisabled();
  });
});

describe("GenreFanartMode activating a result", () => {
  // Every test here needs a finished generation to act on.
  async function generateReady(user: ReturnType<typeof userEvent.setup>) {
    await renderMode();
    await writePrompt(user, "neon skyline");
    await user.click(screen.getByRole("button", { name: "Generate fanart" }));
    await screen.findByAltText("Generated genre fanart");
  }

  it("when Set as background is pressed, then it is applied to the genre and confirmed", async () => {
    // Given
    const user = userEvent.setup();
    await generateReady(user);

    // When
    await user.click(screen.getByRole("button", { name: "Set as background" }));

    // Then
    await waitFor(() => expect(mocked.patchGenre).toHaveBeenCalledWith("g1", { backgroundFanartId: "f1" }));
    // Disabling afterwards is the confirmation — a second identical PATCH would
    // be a wasted write with no visible effect.
    expect(await screen.findByRole("button", { name: /Set as background/ })).toBeDisabled();
  });

  it("when applying the background fails, then it says so and stays retryable", async () => {
    // Given
    const user = userEvent.setup();
    mocked.patchGenre.mockRejectedValue(new Error("500"));
    await generateReady(user);

    // When
    await user.click(screen.getByRole("button", { name: "Set as background" }));

    // Then
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not set background");
    expect(screen.getByRole("button", { name: "Set as background" })).toBeEnabled();
  });

  it("when Open genre is pressed, then it routes to that genre's page", async () => {
    // Given
    const user = userEvent.setup();
    await generateReady(user);

    // When
    await user.click(screen.getByRole("button", { name: "Open genre" }));

    // Then
    expect(navigate).toHaveBeenCalledWith("/genre/g1");
  });
});
