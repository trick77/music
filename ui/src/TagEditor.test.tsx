import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Song, SongStats, Suggestion } from "./api";

// TagEditor owns the whole edit-a-song flow: four tabs of staged edits, an artist
// autocomplete, a cover op that is deliberately not applied until Save, and a
// two-phase save (tags first, cover second) with a distinct failure story for each
// phase. Mocking at the api module boundary — as App.test.tsx does — keeps these
// tests about that behaviour rather than about the HTTP client.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    updateSong: vi.fn(),
    uploadCover: vi.fn(),
    removeCover: vi.fn(),
    suggest: vi.fn(),
    getSongStats: vi.fn(),
  };
});

import { TagEditor } from "./TagEditor";
import * as api from "./api";

const mocked = vi.mocked(api);

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: "s1",
    title: "golden hour",
    artistName: "Kavinsky",
    album: "outrun",
    year: 2010,
    trackNo: 3,
    trackTotal: 0,
    durationMs: 210000,
    fileSize: 5_242_880,
    createdAt: "2024-03-01 12:00:00",
    sampleRate: 44100,
    channels: 2,
    bitrateKbps: 320,
    genres: ["synthwave"],
    coverArtId: "",
    lyrics: "",
    published: true,
    alignmentStatus: "",
    ...overrides,
  };
}

function stats(overrides: Partial<SongStats> = {}): SongStats {
  return { plays: 1234, lastPlayedAt: "2024-05-01 09:00:00", ...overrides };
}

function suggestion(value: string, count: number): Suggestion {
  return { value, count };
}

const GENRE_PLACEHOLDER = "Add genre — Tab completes, Enter adds";

// The genre suggestions are debounced, so every assertion about the dropdown has to
// wait for the request the keystrokes queued rather than for the keystrokes alone.
function genreInput(): HTMLInputElement {
  return screen.getByPlaceholderText(GENRE_PLACEHOLDER) as HTMLInputElement;
}

// Mounts the editor with spy callbacks so every test can assert on close/save
// without repeating the wiring.
function renderEditor(overrides: Partial<Song> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const s = song(overrides);
  const view = render(
    <TagEditor song={s} onClose={onClose} onSaved={onSaved} />,
  );
  return { ...view, onClose, onSaved, song: s };
}

// The four tabs are all mounted at once (only their visibility toggles), so text
// lookups can be ambiguous. Scoping by the tab's own control keeps queries honest.
async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("tab", { name }));
}

// The Details fields use plain <label> elements with no htmlFor, so they carry no
// accessible name; reach them through their visible label's group instead of by
// position, which would silently follow the wrong field if the form is reordered.
function fieldUnder(label: string): HTMLInputElement {
  // Some labels sit in a header row alongside a "Title case" action, so the input
  // is a sibling of that row rather than of the label — walk out until a wrapper
  // that actually owns an input is found.
  let node: HTMLElement | null = screen.getByText(label).closest("div");
  while (node && !node.querySelector("input")) node = node.parentElement;
  return node?.querySelector("input") as HTMLInputElement;
}

beforeEach(() => {
  // jsdom implements neither half of the object-URL API, and the cover staging
  // path creates one on pick and revokes it on cleanup.
  URL.createObjectURL = vi.fn(() => "blob:staged-cover");
  URL.revokeObjectURL = vi.fn();
  mocked.updateSong.mockResolvedValue(song());
  mocked.suggest.mockResolvedValue([]);
  mocked.getSongStats.mockResolvedValue(stats());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TagEditor details tab", () => {
  it("when opened, then the fields are seeded from the song", () => {
    // Given / When
    renderEditor({
      title: "Nightcall",
      artistName: "Kavinsky",
      album: "OutRun",
      year: 2010,
    });

    // Then
    expect(screen.getByDisplayValue("Nightcall")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Kavinsky")).toBeInTheDocument();
    expect(screen.getByDisplayValue("OutRun")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2010")).toBeInTheDocument();
  });

  it("when the year and track number are zero, then those fields start empty rather than showing 0", () => {
    // Given / When
    // A missing year is stored as 0, and rendering that literally would put a
    // bogus "0" in the field that the user then has to clear by hand.
    renderEditor({ year: 0, trackNo: 0, trackTotal: 0 });

    // Then
    expect(screen.queryByDisplayValue("0")).not.toBeInTheDocument();
  });

  it("when Title case is pressed, then the title field is recapitalised", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ title: "golden hour" });

    // When
    await user.click(screen.getAllByRole("button", { name: "Title case" })[0]);

    // Then
    expect(screen.getByDisplayValue("Golden Hour")).toBeInTheDocument();
  });

  it("when the album Title case is pressed, then only the album is recapitalised", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ title: "golden hour", album: "outrun forever" });

    // When
    await user.click(screen.getAllByRole("button", { name: "Title case" })[1]);

    // Then
    expect(screen.getByDisplayValue("Outrun Forever")).toBeInTheDocument();
    // The title button was not pressed, so its value must be untouched.
    expect(screen.getByDisplayValue("golden hour")).toBeInTheDocument();
  });

  it("when the song belongs to an album, then the track number is read-only and shows N of Y", () => {
    // Given / When
    // Album track numbers are assigned per artist+album by the server, so an
    // editable field here would silently lose whatever the user typed.
    renderEditor({ trackNo: 3, trackTotal: 12 });

    // Then
    const field = screen.getByDisplayValue("3 of 12") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
  });

  it("when the song is a single, then the track number stays editable", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ trackNo: 3, trackTotal: 0 });
    const field = screen.getByDisplayValue("3") as HTMLInputElement;

    // When
    await user.clear(field);
    await user.type(field, "7");

    // Then
    expect(field.readOnly).toBe(false);
    expect(field).toHaveValue("7");
  });
});

describe("TagEditor genres", () => {
  it("when a genre is typed and Enter pressed, then it becomes a chip and the input clears", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ genres: [] });
    const input = genreInput();

    // When
    await user.type(input, "darkwave{Enter}");

    // Then
    expect(
      screen.getByRole("button", { name: "Remove Darkwave" }),
    ).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("when an existing genre is re-added in a different case, then it is not duplicated", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ genres: ["synthwave"] });

    // When
    await user.type(genreInput(), "SYNTHWAVE{Enter}");

    // Then
    // Case-insensitive dedupe: "Synthwave" and "synthwave" are the same tag, and
    // two chips would mean two genre rows on the server.
    expect(
      screen.getAllByRole("button", { name: /^Remove Synthwave$/ }),
    ).toHaveLength(1);
  });

  it("when only whitespace is submitted, then no chip is added", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ genres: [] });

    // When
    await user.type(genreInput(), "   {Enter}");

    // Then
    expect(
      screen.queryByRole("button", { name: /^Remove/ }),
    ).not.toBeInTheDocument();
  });

  it("when a genre chip's remove button is clicked, then that chip disappears", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ genres: ["synthwave", "darkwave"] });

    // When
    await user.click(screen.getByRole("button", { name: "Remove Synthwave" }));

    // Then
    expect(
      screen.queryByRole("button", { name: "Remove Synthwave" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Darkwave" }),
    ).toBeInTheDocument();
  });
});

describe("TagEditor genre typeahead", () => {
  // The endpoint matches substrings, so these fixtures deliberately mix a match that
  // only contains the query with one that starts with it.
  const singMatches = [
    suggestion("throat singing", 12),
    suggestion("singer-songwriter", 3),
  ];

  it("when a prefix is typed, then the completion is shown inline and the matches are listed with their counts", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });

    // When
    await user.type(genreInput(), "Sing");

    // Then
    await waitFor(() =>
      expect(mocked.suggest).toHaveBeenCalledWith("genre", "Sing"),
    );
    // Only the tail is rendered as the ghost — the typed part stays the input's own.
    expect(await screen.findByText("er-Songwriter")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Throat Singing/ }),
    ).toBeVisible();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("when a substring match outranks the prefix match, then the prefix one is highlighted and completes", async () => {
    // Given
    const user = userEvent.setup();
    // "throat singing" comes first and is more used, but it cannot complete "sing".
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });

    // When
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // Then
    expect(
      screen.getByRole("option", { name: /Singer-Songwriter/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("option", { name: /Throat Singing/ }),
    ).toHaveAttribute("aria-selected", "false");
  });

  it("when nothing typed is a prefix of a match, then no inline completion is shown", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue([suggestion("throat singing", 12)]);
    renderEditor({ genres: [] });

    // When
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // Then
    // A ghost tail would read as "sing…ing" — a completion the field cannot make.
    expect(screen.queryByText("ing")).not.toBeInTheDocument();
  });

  it("when Tab is pressed, then the highlighted suggestion is added in its stored form", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    await user.keyboard("{Tab}");

    // Then
    expect(
      screen.getByRole("button", { name: "Remove Singer-Songwriter" }),
    ).toBeInTheDocument();
    expect(genreInput()).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("when the arrow keys move the highlight, then Tab adds the newly highlighted genre", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    // The prefix match ("singer-songwriter", index 1) starts highlighted; up moves
    // to the substring match above it.
    await user.keyboard("{ArrowUp}{Tab}");

    // Then
    expect(
      screen.getByRole("button", { name: "Remove Throat Singing" }),
    ).toBeInTheDocument();
  });

  it("when Tab is pressed with no suggestions, then nothing is added and focus leaves the field", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue([]);
    renderEditor({ genres: [] });
    const input = genreInput();
    await user.type(input, "zzz");
    await waitFor(() => expect(mocked.suggest).toHaveBeenCalled());

    // When
    await user.keyboard("{Tab}");

    // Then
    // Tab is the only way out of the field by keyboard — it must never be trapped.
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(input).not.toHaveFocus();
  });

  it("when Shift+Tab is pressed, then the suggestion is not accepted", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    await user.keyboard("{Shift>}{Tab}{/Shift}");

    // Then
    // Backwards tabbing is navigation, never completion.
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("when Enter is pressed, then the literal text is added rather than the suggestion", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    await user.keyboard("{Enter}");

    // Then
    // Enter is the only way to coin a genre that does not exist yet, even when it
    // is a prefix of one that does.
    expect(
      screen.getByRole("button", { name: "Remove Sing" }),
    ).toBeInTheDocument();
  });

  it("when a suggestion is tapped, then it is added — the touch path with no Tab key", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    await user.click(screen.getByRole("option", { name: /Throat Singing/ }));

    // Then
    expect(
      screen.getByRole("button", { name: "Remove Throat Singing" }),
    ).toBeInTheDocument();
  });

  it("when the Tab button is pressed, then it completes like the Tab key", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    // Touch keyboards have no Tab key, so the button is the completion affordance.
    await user.click(screen.getByRole("button", { name: "Tab" }));

    // Then
    expect(
      screen.getByRole("button", { name: "Remove Singer-Songwriter" }),
    ).toBeInTheDocument();
  });

  it("when there is nothing to complete, then the Tab button is disabled", async () => {
    // Given / When
    renderEditor({ genres: [] });

    // Then
    expect(screen.getByRole("button", { name: "Tab" })).toBeDisabled();
  });

  it("when Escape is pressed with the list open, then only the list closes", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    const { onClose } = renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    await user.keyboard("{Escape}");

    // Then
    // The dropdown is the topmost surface, so the press stops there — a second one
    // closes the editor.
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("when the field is emptied, then the list closes and no request is made", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue(singMatches);
    renderEditor({ genres: [] });
    await user.type(genreInput(), "sing");
    await screen.findByRole("listbox");

    // When
    await user.clear(genreInput());

    // Then
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(mocked.suggest).not.toHaveBeenCalledWith("genre", "");
  });
});

describe("TagEditor artist autocomplete", () => {
  it("when the artist field is typed into, then matching suggestions are offered with their counts", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue([
      suggestion("Kavinsky", 12),
      suggestion("Kavinsky Remixes", 3),
    ]);
    renderEditor({ artistName: "" });

    // When
    await user.type(fieldUnder("Artist"), "Kav");

    // Then
    expect(mocked.suggest).toHaveBeenCalledWith("artist", "Kav");
    expect(await screen.findByText("Kavinsky Remixes")).toBeInTheDocument();
    // The count is what makes the list useful — it tells the user which spelling
    // is the established one rather than a typo they made once.
    expect(await screen.findByText("12")).toBeInTheDocument();
  });

  it("when a suggestion is chosen, then it replaces the artist and the list closes", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue([suggestion("Kavinsky", 12)]);
    renderEditor({ artistName: "" });
    await user.type(fieldUnder("Artist"), "Kav");
    const option = await screen.findByText("12");

    // When
    // The option commits on mousedown, before the field's blur can clear the list.
    await user.click(option.parentElement as HTMLElement);

    // Then
    expect(fieldUnder("Artist")).toHaveValue("Kavinsky");
    await waitFor(() =>
      expect(screen.queryByText("12")).not.toBeInTheDocument(),
    );
  });

  it("when nothing matches what was typed, then no suggestion list is rendered", async () => {
    // Given
    const user = userEvent.setup();
    mocked.suggest.mockResolvedValue([]);
    renderEditor({ artistName: "" });

    // When
    await user.type(fieldUnder("Artist"), "zzz");

    // Then
    await waitFor(() => expect(mocked.suggest).toHaveBeenCalled());
    expect(
      screen.queryByText("zzz", { selector: "span" }),
    ).not.toBeInTheDocument();
  });
});

describe("TagEditor lyrics tab", () => {
  it("when lyrics are edited, then the textarea holds the new text", async () => {
    // Given
    const user = userEvent.setup();
    const user2 = user;
    renderEditor({ lyrics: "" });
    await openTab(user2, "Lyrics");
    const area = screen.getByPlaceholderText(/Paste lyrics here/);

    // When
    await user.type(area, "drive at night");

    // Then
    expect(area).toHaveValue("drive at night");
  });

  it("when Clean is pressed, then Suno's bracketed directives are stripped but sung ad-libs survive", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({
      lyrics: "[Verse 1]\nDrive at night (ooh)\n\n\n[Chorus]\nNightcall",
    });
    await openTab(user, "Lyrics");

    // When
    await user.click(screen.getByRole("button", { name: "Clean" }));

    // Then
    // Bracketed structure markers are never sung; parenthesised ad-libs usually
    // are, so stripping those too would delete real lyrics.
    const area = screen.getByPlaceholderText(
      /Paste lyrics here/,
    ) as HTMLTextAreaElement;
    expect(area.value).toContain("(ooh)");
    expect(area.value).not.toContain("[Verse 1]");
    expect(area.value).not.toContain("[Chorus]");
    expect(area.value).not.toMatch(/\n{3,}/);
  });

  it("when a tab is switched away from and back, then the unsaved edit survives", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ lyrics: "" });
    await openTab(user, "Lyrics");
    await user.type(
      screen.getByPlaceholderText(/Paste lyrics here/),
      "midnight",
    );

    // When
    // All panels stay mounted precisely so a tab switch cannot discard edits.
    await openTab(user, "Details");
    await openTab(user, "Lyrics");

    // Then
    expect(screen.getByPlaceholderText(/Paste lyrics here/)).toHaveValue(
      "midnight",
    );
  });
});

describe("TagEditor cover tab", () => {
  it("when the song has no art, then the artist initial stands in and there is nothing to remove", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ coverArtId: "", artistName: "Kavinsky" });

    // When
    await openTab(user, "Cover");

    // Then
    expect(screen.getByLabelText("Add cover")).toBeInTheDocument();
    expect(screen.getByText("K")).toBeInTheDocument();
    // Removal is keyed on the stored art, not the preview: there is no server-side
    // cover to delete here.
    expect(
      screen.queryByRole("button", { name: "Remove cover" }),
    ).not.toBeInTheDocument();
  });

  it("when the song already has art, then it is previewed and offered for replacement", async () => {
    // Given
    const user = userEvent.setup();
    const { container } = renderEditor({ coverArtId: "c9" });

    // When
    await openTab(user, "Cover");

    // Then
    expect(screen.getByLabelText("Replace cover")).toBeInTheDocument();
    // The stored cover is requested without a ?size, which serves the original
    // bytes rather than a thumbnail.
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/api/cover/c9",
    );
  });

  it("when a file is picked, then it is staged as a preview and flagged as pending rather than uploaded", async () => {
    // Given
    const user = userEvent.setup();
    const { container } = renderEditor({ coverArtId: "" });
    await openTab(user, "Cover");
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    // When
    await user.upload(
      input,
      new File(["png"], "art.png", { type: "image/png" }),
    );

    // Then
    // Staging, not uploading: cover changes are album-wide, so they must wait for
    // an explicit Save like every other edit in this dialog.
    expect(mocked.uploadCover).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "blob:staged-cover",
    );
    expect(
      screen.getByText(/Pending — applies when you save/),
    ).toBeInTheDocument();
  });

  it("when remove cover is clicked, then the preview clears and the removal is only staged", async () => {
    // Given
    const user = userEvent.setup();
    const { container } = renderEditor({
      coverArtId: "c9",
      artistName: "Kavinsky",
    });
    await openTab(user, "Cover");

    // When
    await user.click(screen.getByRole("button", { name: "Remove cover" }));

    // Then
    expect(mocked.removeCover).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("K")).toBeInTheDocument();
    // Once removal is staged there is nothing left to remove, so the badge goes.
    expect(
      screen.queryByRole("button", { name: "Remove cover" }),
    ).not.toBeInTheDocument();
  });

  it("when an accepted image is dropped on the art, then it is staged just like a picked file", async () => {
    // Given
    renderEditor({ coverArtId: "" });
    const user = userEvent.setup();
    await openTab(user, "Cover");
    const zone = screen.getByLabelText("Add cover");
    const file = new File(["png"], "dropped.png", { type: "image/png" });

    // When
    const data = { types: ["Files"], files: [file], dropEffect: "" };
    await user.pointer({ target: zone });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragEnter(zone, { dataTransfer: data });
    fireEvent.drop(zone, { dataTransfer: data });

    // Then
    // A drop must go through the same staging path as the picker — uploading
    // straight from the drop would be the one cover edit that bypasses Save.
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(file));
    expect(mocked.uploadCover).not.toHaveBeenCalled();
  });

  it("when a non-image is dropped, then it is refused with an explanation", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ coverArtId: "" });
    await openTab(user, "Cover");
    const zone = screen.getByLabelText("Add cover");
    const { fireEvent } = await import("@testing-library/react");
    const data = {
      types: ["Files"],
      files: [new File(["%PDF"], "sleeve.pdf", { type: "application/pdf" })],
    };

    // When
    fireEvent.dragEnter(zone, { dataTransfer: data });
    fireEvent.drop(zone, { dataTransfer: data });

    // Then
    // The browser enforces `accept` for the picker but not for drops, so the
    // refusal has to be visible here or a PDF reaches the server.
    expect(await screen.findByRole("alert")).toHaveTextContent(/JPEG or PNG/);
  });
});

describe("TagEditor info tab", () => {
  it("when the info tab is opened, then the play figures are fetched and shown", async () => {
    // Given
    const user = userEvent.setup();
    mocked.getSongStats.mockResolvedValue(stats({ plays: 1234 }));
    renderEditor();

    // When
    await openTab(user, "Info");

    // Then
    expect(mocked.getSongStats).toHaveBeenCalledWith("s1");
    expect(await screen.findByText("1,234")).toBeInTheDocument();
  });

  it("when the editor opens on the details tab, then the stats request is deferred", () => {
    // Given / When
    // The stats endpoint is editor-only and costs a round trip; fetching it for
    // every opened dialog would spend it on users who never look at Info.
    renderEditor();

    // Then
    expect(mocked.getSongStats).not.toHaveBeenCalled();
  });

  it("when the stats request is still in flight, then a spinner stands in for the figures", async () => {
    // Given
    const user = userEvent.setup();
    mocked.getSongStats.mockReturnValue(new Promise(() => {}));
    const { container } = renderEditor();

    // When
    await openTab(user, "Info");

    // Then
    await waitFor(() =>
      expect(container.querySelector(".ui-spin")).toBeTruthy(),
    );
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("when the stats request fails, then the figures read Unavailable instead of spinning forever", async () => {
    // Given
    const user = userEvent.setup();
    mocked.getSongStats.mockRejectedValue(new Error("403"));
    renderEditor();

    // When
    await openTab(user, "Info");

    // Then
    // Both play rows degrade, because a failed request tells us nothing about
    // either figure.
    expect(await screen.findAllByText("Unavailable")).toHaveLength(2);
  });

  it("when the info tab is re-opened, then the already-loaded stats are not re-fetched", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor();
    await openTab(user, "Info");
    await screen.findByText("1,234");

    // When
    await openTab(user, "Details");
    await openTab(user, "Info");

    // Then
    expect(mocked.getSongStats).toHaveBeenCalledTimes(1);
  });

  it("when the audio properties are unknown, then they render as em dashes rather than zeroes", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ bitrateKbps: 0, sampleRate: 0, channels: 0 });

    // When
    await openTab(user, "Info");

    // Then
    // 0 means "not decoded yet", not "0 kbps" — printing the number would be a lie
    // about the file.
    const bitrate = screen.getByText("Bitrate").closest("div") as HTMLElement;
    expect(within(bitrate).getByText("—")).toBeInTheDocument();
  });

  it("when the file details are known, then duration and size are shown in human units", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ durationMs: 210000, fileSize: 5_242_880, channels: 2 });

    // When
    await openTab(user, "Info");

    // Then
    expect(screen.getByText("3:30")).toBeInTheDocument();
    expect(screen.getByText("5.0 MB")).toBeInTheDocument();
    expect(screen.getByText("Stereo")).toBeInTheDocument();
  });
});

describe("TagEditor saving", () => {
  it("when the edited fields are saved, then they are sent and the dialog reports and closes", async () => {
    // Given
    const user = userEvent.setup();
    const saved = song({ title: "Nightcall" });
    mocked.updateSong.mockResolvedValue(saved);
    const { onSaved, onClose } = renderEditor({
      title: "golden hour",
      year: 2010,
      trackTotal: 0,
      trackNo: 3,
    });
    const title = screen.getByDisplayValue("golden hour");
    await user.clear(title);
    await user.type(title, "Nightcall");

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    await waitFor(() =>
      expect(mocked.updateSong).toHaveBeenCalledWith("s1", {
        title: "Nightcall",
        artistName: "Kavinsky",
        album: "outrun",
        year: 2010,
        trackNo: 3,
        genres: ["synthwave"],
        lyrics: "",
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onClose).toHaveBeenCalled();
  });

  it("when the year and track fields are blank, then they are sent as zero rather than NaN", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ year: 0, trackNo: 0, trackTotal: 0 });

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    // Number("") is 0 but Number("abc") is NaN, which would serialise to null and
    // wipe the column — the `|| 0` guard is what this pins down.
    await waitFor(() =>
      expect(mocked.updateSong).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ year: 0, trackNo: 0 }),
      ),
    );
  });

  it("when the album and year are retyped, then the new values are sent", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ album: "outrun", year: 2010, trackTotal: 0 });
    const album = fieldUnder("Album");
    const year = fieldUnder("Year");
    await user.clear(album);
    await user.type(album, "OutRun 2");
    await user.clear(year);
    await user.type(year, "2013");

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    // The year is held as text while editing so a half-typed "20" isn't coerced
    // to a number mid-keystroke; it must still arrive as a number.
    await waitFor(() =>
      expect(mocked.updateSong).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ album: "OutRun 2", year: 2013 }),
      ),
    );
  });

  it("when the year is not a number, then it is saved as zero rather than NaN", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ year: 2010, trackTotal: 0 });
    const year = fieldUnder("Year");
    await user.clear(year);
    await user.type(year, "unknown");

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    // Number("unknown") is NaN, which would serialise to null and blank the column.
    await waitFor(() =>
      expect(mocked.updateSong).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ year: 0 }),
      ),
    );
  });

  it("when a genre was typed but never confirmed with Enter, then saving still includes it", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ genres: ["synthwave"] });
    await user.type(genreInput(), "darkwave");

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    // Losing a typed-but-unconfirmed genre on save is the obvious trap here: the
    // user typed it, so they meant it.
    await waitFor(() =>
      expect(mocked.updateSong).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ genres: ["synthwave", "darkwave"] }),
      ),
    );
  });

  it("when the pending genre duplicates an existing chip, then it is not added twice", async () => {
    // Given
    const user = userEvent.setup();
    renderEditor({ genres: ["synthwave"] });
    await user.type(genreInput(), "Synthwave");

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    await waitFor(() =>
      expect(mocked.updateSong).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ genres: ["synthwave"] }),
      ),
    );
  });

  it("when the tag save fails, then it says so and keeps the dialog open with the edits intact", async () => {
    // Given
    const user = userEvent.setup();
    mocked.updateSong.mockRejectedValue(new Error("500"));
    const { onSaved, onClose } = renderEditor({ title: "golden hour" });

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    // Closing on failure would silently discard everything the user typed.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save changes",
    );
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("golden hour")).toBeInTheDocument();
  });

  it("when a staged cover is saved, then the tags go first and the upload second", async () => {
    // Given
    const user = userEvent.setup();
    const order: string[] = [];
    mocked.updateSong.mockImplementation(async () => {
      order.push("tags");
      return song();
    });
    mocked.uploadCover.mockImplementation(async () => {
      order.push("cover");
      return song({ coverArtId: "c9" });
    });
    const { container, onClose } = renderEditor({ coverArtId: "" });
    await openTab(user, "Cover");
    const file = new File(["png"], "art.png", { type: "image/png" });
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      file,
    );

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    // The cover is keyed off artist+album, so it has to be applied after the tag
    // edit or it lands on the album the user just renamed away from.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(order).toEqual(["tags", "cover"]);
    expect(mocked.uploadCover).toHaveBeenCalledWith("s1", file);
  });

  it("when a staged removal is saved, then removeCover is called instead of an upload", async () => {
    // Given
    const user = userEvent.setup();
    const stripped = song({ coverArtId: "" });
    mocked.removeCover.mockResolvedValue(stripped);
    const { onSaved } = renderEditor({ coverArtId: "c9" });
    await openTab(user, "Cover");
    await user.click(screen.getByRole("button", { name: "Remove cover" }));

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    await waitFor(() => expect(mocked.removeCover).toHaveBeenCalledWith("s1"));
    expect(mocked.uploadCover).not.toHaveBeenCalled();
    // The song handed back is the one from the cover call, not the tag call, or
    // the caller's row would still show the deleted art.
    expect(onSaved).toHaveBeenCalledWith(stripped);
  });

  it("when the tags save but the cover upload fails, then it reports the partial save and stays open", async () => {
    // Given
    const user = userEvent.setup();
    const taggedOnly = song({ title: "Nightcall" });
    mocked.updateSong.mockResolvedValue(taggedOnly);
    mocked.uploadCover.mockRejectedValue(new Error("507"));
    const { container, onSaved, onClose } = renderEditor({ coverArtId: "" });
    await openTab(user, "Cover");
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["png"], "art.png", { type: "image/png" }),
    );

    // When
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // Then
    // The tags are already committed, so the caller must be told; the dialog stays
    // open with the cover still staged because Save is a safe retry.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tags saved, but the cover could not be updated",
    );
    expect(onSaved).toHaveBeenCalledWith(taggedOnly);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Pending — applies when you save/),
    ).toBeInTheDocument();
  });

  it("when a save is in flight, then the dialog cannot be closed out from under it", async () => {
    // Given
    const user = userEvent.setup();
    mocked.updateSong.mockReturnValue(new Promise(() => {}));
    const { onClose } = renderEditor();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // When
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Then
    // Closing mid-write would leave the user unsure whether the edit landed.
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("TagEditor dismissal", () => {
  it("when Cancel is pressed, then it closes without writing anything", async () => {
    // Given
    const user = userEvent.setup();
    const { onClose } = renderEditor();

    // When
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Then
    expect(onClose).toHaveBeenCalled();
    expect(mocked.updateSong).not.toHaveBeenCalled();
  });

  it("when the close icon is pressed, then it closes", async () => {
    // Given
    const user = userEvent.setup();
    const { onClose } = renderEditor();

    // When
    await user.click(screen.getByRole("button", { name: "Close" }));

    // Then
    expect(onClose).toHaveBeenCalled();
  });

  it("when Escape is pressed, then it closes", async () => {
    // Given
    const user = userEvent.setup();
    const { onClose } = renderEditor();

    // When
    await user.keyboard("{Escape}");

    // Then
    expect(onClose).toHaveBeenCalled();
  });

  it("when Escape is pressed during a save, then the dialog holds", async () => {
    // Given
    const user = userEvent.setup();
    mocked.updateSong.mockReturnValue(new Promise(() => {}));
    const { onClose } = renderEditor();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    // When
    await user.keyboard("{Escape}");

    // Then
    expect(onClose).not.toHaveBeenCalled();
  });

  it("when the backdrop is clicked, then it closes, but a click inside the dialog does not", async () => {
    // Given
    const user = userEvent.setup();
    const { onClose, container } = renderEditor();

    // When
    await user.click(screen.getByRole("dialog"));

    // Then
    // The dialog stops propagation so that selecting text inside it never
    // dismisses the editor.
    expect(onClose).not.toHaveBeenCalled();

    await user.click(container.querySelector(".ui-overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });

  it("when a staged cover preview is discarded, then its object URL is released", async () => {
    // Given
    const user = userEvent.setup();
    const { container, unmount } = renderEditor({ coverArtId: "" });
    await openTab(user, "Cover");
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["png"], "art.png", { type: "image/png" }),
    );

    // When
    unmount();

    // Then
    // Object URLs pin their blob in memory for the life of the document, so an
    // unreleased preview leaks the whole image on every cancelled edit.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:staged-cover");
  });
});
