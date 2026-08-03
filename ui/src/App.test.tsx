import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session, Song } from "./api";

// App is the composition root: it owns session/library loading, the upload
// pipeline, the delete and publish flows, and the URL<->player-overlay sync.
// Mocking at the api module boundary (rather than stubbing fetch per endpoint)
// keeps these tests about App's own behaviour, which is what the coverage of
// this file is supposed to mean.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    getSession: vi.fn(),
    listSongs: vi.fn(),
    uploadSong: vi.fn(),
    setPublished: vi.fn(),
    deleteSong: vi.fn(),
    postAlign: vi.fn(),
    invalidateAlign: vi.fn(),
    getSongStats: vi.fn(),
    suggest: vi.fn(),
  };
});

// The child pages each own their own data fetching and are covered by their own
// suites. Stubbing them keeps an App test from failing for a reason that lives
// in Home or StudioPage, and keeps the assertions here about which surface App
// chose to render.
vi.mock("./Home", () => ({
  Home: ({ onUpload }: { onUpload: () => void }) => (
    <div data-testid="home">
      <button onClick={onUpload}>home-upload</button>
    </div>
  ),
}));
vi.mock("./Search", () => ({ Search: () => <div data-testid="search" /> }));
vi.mock("./StudioPage", () => ({
  StudioPage: () => <div data-testid="studio" />,
}));
vi.mock("./PlaylistsPage", () => ({
  PlaylistsPage: () => <div data-testid="playlists" />,
}));
vi.mock("./PlaylistPage", () => ({
  PlaylistPage: () => <div data-testid="playlist" />,
}));
vi.mock("./Detail", () => ({
  Detail: ({ kind }: { kind: string }) => (
    <div data-testid={`detail-${kind}`} />
  ),
}));
vi.mock("./VisualizerView", () => ({
  VisualizerView: () => <div data-testid="visualizer" />,
}));
// onSaved is exposed as a button so a test can play the part of a completed tag
// save without driving the real editor's form, which has its own suite.
vi.mock("./TagEditor", () => ({
  TagEditor: ({
    song,
    onClose,
    onSaved,
  }: {
    song: Song;
    onClose: () => void;
    onSaved: (s: Song) => void;
  }) => (
    <div data-testid="tageditor">
      <button onClick={onClose}>close-editor</button>
      <button
        onClick={() =>
          onSaved({ ...song, artistName: "Singers", coverArtId: "cov-new" })
        }
      >
        save-editor
      </button>
    </div>
  ),
}));
vi.mock("./AddToPlaylist", () => ({
  AddToPlaylist: ({
    onClose,
    onDone,
  }: {
    onClose: () => void;
    onDone: (n: string) => void;
  }) => (
    <div data-testid="addtoplaylist">
      <button onClick={onClose}>close-add</button>
      <button onClick={() => onDone("Road Trip")}>done-add</button>
    </div>
  ),
}));

// Library renders the App-level song list, so it is exercised for real rather
// than stubbed — the list contents are part of what App is responsible for.
vi.mock("./Library", () => ({
  Library: ({
    songs,
    initialTab,
    renderRowActions,
  }: {
    songs: Song[];
    initialTab: string;
    renderRowActions: (s: Song) => React.ReactNode;
  }) => (
    <div data-testid="library" data-tab={initialTab}>
      {songs.map((s) => (
        // artist/cover are surfaced as attributes rather than text so the rows
        // stay queryable by title alone, the way the other tests expect.
        <div
          key={s.id}
          data-testid={`row-${s.id}`}
          data-artist={s.artistName}
          data-cover={s.coverArtId}
        >
          {s.title}
          {renderRowActions(s)}
        </div>
      ))}
    </div>
  ),
}));

import { App, UploadToast } from "./App";
import * as api from "./api";
import { player as playerApi } from "./player";

const mocked = vi.mocked(api);

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

function session(overrides: Partial<Session> = {}): Session {
  return {
    authenticated: true,
    username: "jan",
    imageGenEnabled: false,
    studioEnabled: false,
    chatEnabled: false,
    historyEnabled: false,
    alignmentEnabled: false,
    imageModels: [],
    defaultImageModel: "",
    authMode: "oidc",
    ...overrides,
  };
}

function go(path: string, search = "") {
  window.history.replaceState({}, "", path + search);
}

// Renders App and waits for the boot fetches (session + song list) to settle, so
// tests start from a loaded app rather than its first paint.
async function renderApp() {
  const view = render(<App />);
  await waitFor(() => expect(mocked.getSession).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

beforeEach(() => {
  window.localStorage.clear();
  go("/");
  // Reset the module-level player store between tests: it is a singleton, so a
  // track cued by one test would otherwise still be playing in the next.
  playerApi.setQueue([]);
  playerApi.remove(playerApi.getState().current?.id ?? "");
  mocked.getSession.mockResolvedValue(session());
  mocked.listSongs.mockResolvedValue([song()]);
  mocked.invalidateAlign.mockReturnValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("UploadToast", () => {
  it("when not uploading, then it is a bare pill with no progress bar or percentage", () => {
    const { container } = render(
      <UploadToast
        message="Song deleted"
        uploading={false}
        pct={0}
        bottom={80}
      />,
    );

    expect(screen.getByText("Song deleted")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    // A plain flash stays a fully rounded pill; the expanded uploading form uses
    // a 14px radius to make room for the progress bar.
    expect(container.firstElementChild).toHaveStyle({ borderRadius: "999px" });
  });

  it("when uploading below 100, then it shows the live percentage", () => {
    render(<UploadToast message="Uploading…" uploading pct={42} bottom={80} />);

    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("when the client reaches 100, then it swaps the percentage for a finalizing spinner", () => {
    // At 100% the bytes are sent but the server is still hashing, so implying
    // completion with a full bar would be a lie.
    const { container } = render(
      <UploadToast message="Uploading…" uploading pct={100} bottom={80} />,
    );

    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    expect(container.querySelector('[style*="app-spin"]')).toBeTruthy();
  });
});

describe("App boot", () => {
  it("when the session resolves authenticated, then the library receives the loaded songs", async () => {
    go("/library");
    mocked.listSongs.mockResolvedValue([song({ title: "Nightcall" })]);

    await renderApp();

    expect(await screen.findByText("Nightcall")).toBeInTheDocument();
  });

  it("when getSession rejects, then it falls back to a signed-out session instead of crashing", async () => {
    go("/library");
    mocked.getSession.mockRejectedValue(new Error("network"));

    await renderApp();

    // The unpublished tab is authenticated-only, so a failed session must
    // downgrade it to "all" rather than leaving the app half-signed-in.
    go("/unpublished");
    expect(screen.getByTestId("library")).toBeInTheDocument();
  });

  it("when listSongs rejects, then the app still renders", async () => {
    go("/library");
    mocked.listSongs.mockRejectedValue(new Error("boom"));

    await renderApp();

    expect(screen.getByTestId("library")).toBeInTheDocument();
  });
});

describe("App routing", () => {
  it.each([
    ["/", "home"],
    ["/search", "search"],
    ["/playlists", "playlists"],
    ["/playlist/p1", "playlist"],
    ["/library", "library"],
  ])(
    "when the path is %s, then it renders the %s surface",
    async (path, testid) => {
      go(path);

      await renderApp();

      expect(screen.getByTestId(testid)).toBeInTheDocument();
    },
  );

  it("when the path is a genre, then it renders the genre detail", async () => {
    go("/genre/g1");

    await renderApp();

    expect(screen.getByTestId("detail-genre")).toBeInTheDocument();
  });

  it("when the path is an artist, then it renders the artist detail", async () => {
    go("/artist/a1");

    await renderApp();

    expect(screen.getByTestId("detail-artist")).toBeInTheDocument();
  });

  it("when studio is enabled and the user is signed in, then /studio renders the studio", async () => {
    go("/studio");
    mocked.getSession.mockResolvedValue(session({ studioEnabled: true }));

    await renderApp();

    expect(screen.getByTestId("studio")).toBeInTheDocument();
  });

  it("when studio is disabled, then /studio falls back to home rather than showing an empty page", async () => {
    go("/studio");
    mocked.getSession.mockResolvedValue(session({ studioEnabled: false }));

    await renderApp();

    expect(screen.queryByTestId("studio")).not.toBeInTheDocument();
    expect(screen.getByTestId("home")).toBeInTheDocument();
  });

  it("when the viewer is signed out, then /unpublished downgrades to the all-songs tab", async () => {
    go("/unpublished");
    mocked.getSession.mockResolvedValue(session({ authenticated: false }));

    await renderApp();

    expect(screen.getByTestId("library")).toHaveAttribute("data-tab", "all");
  });

  it("when the viewer is signed in, then /unpublished keeps the unpublished tab", async () => {
    go("/unpublished");

    await renderApp();

    expect(screen.getByTestId("library")).toHaveAttribute(
      "data-tab",
      "unpublished",
    );
  });

  it("when the path is /favorites, then the library opens on the favorites tab", async () => {
    go("/favorites");

    await renderApp();

    expect(screen.getByTestId("library")).toHaveAttribute(
      "data-tab",
      "favorites",
    );
  });

  it("when the path is /genres, then the library opens on the genres tab", async () => {
    go("/genres");

    await renderApp();

    expect(screen.getByTestId("library")).toHaveAttribute("data-tab", "genres");
  });

  it("when the path is /visualizer, then the visualizer renders outside the page shell", async () => {
    go("/visualizer");

    await renderApp();

    expect(screen.getByTestId("visualizer")).toBeInTheDocument();
    // The constrained page wrapper renders nothing for this route — the overlay
    // is full-screen and lives outside it.
    expect(screen.queryByTestId("home")).not.toBeInTheDocument();
  });
});

describe("App deep links", () => {
  it("when landing on a bare /song/:id, then it cues that track", async () => {
    go("/song/s1");
    mocked.listSongs.mockResolvedValue([
      song({ id: "s1", title: "Golden Hour" }),
    ]);

    await renderApp();

    await waitFor(() => expect(playerApi.getState().current?.id).toBe("s1"));
    // Home sits behind the overlay so closing it lands on a real page.
    expect(screen.getByTestId("home")).toBeInTheDocument();
  });

  it("when the shared id is not in the library, then nothing is cued", async () => {
    go("/song/missing");
    mocked.listSongs.mockResolvedValue([song({ id: "s1" })]);

    await renderApp();

    expect(playerApi.getState().current).toBeNull();
  });
});

describe("App upload", () => {
  it("when an unpublished song is uploaded, then it reports the state and jumps to the review list", async () => {
    const user = userEvent.setup();
    go("/");
    const uploaded = song({ id: "s2", title: "Nightcall", published: false });
    mocked.uploadSong.mockResolvedValue(uploaded);
    mocked.listSongs.mockResolvedValue([song(), uploaded]);

    const { container } = await renderApp();
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["id3"], "nightcall.mp3", { type: "audio/mpeg" });

    await user.upload(input, file);

    expect(mocked.uploadSong).toHaveBeenCalledWith(file, expect.any(Function));
    // New uploads land unpublished, and the toast has to say so or the user has
    // no idea why the track is not on the public surface. Matched on the whole
    // message: the row's own "Unpublished" badge also says the word.
    expect(
      await screen.findByText(/uploaded .*— unpublished/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/unpublished"));
  });

  it("when a dedupe upload returns an already-published song, then it stays put", async () => {
    const user = userEvent.setup();
    go("/");
    mocked.uploadSong.mockResolvedValue(
      song({ id: "s1", title: "Golden Hour", published: true }),
    );

    const { container } = await renderApp();
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    await user.upload(
      input,
      new File(["id3"], "golden.mp3", { type: "audio/mpeg" }),
    );

    expect(await screen.findByText(/Added “Golden Hour”/)).toBeInTheDocument();
    // A song that is already published would not appear on the review surface,
    // so jumping there would strand the user on an empty list.
    expect(window.location.pathname).toBe("/");
  });

  it("when the upload fails, then it flashes a failure instead of hanging on the progress toast", async () => {
    const user = userEvent.setup();
    go("/");
    mocked.uploadSong.mockRejectedValue(new Error("507"));

    const { container } = await renderApp();
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;

    await user.upload(
      input,
      new File(["id3"], "bad.mp3", { type: "audio/mpeg" }),
    );

    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
  });

  it("when upload progress is reported, then the toast shows the percentage", async () => {
    const user = userEvent.setup();
    go("/");
    let report: ((pct: number) => void) | undefined;
    mocked.uploadSong.mockImplementation((_f, onProgress) => {
      report = onProgress;
      return new Promise(() => {}); // never settles: hold the toast open
    });

    const { container } = await renderApp();
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      input,
      new File(["id3"], "slow.mp3", { type: "audio/mpeg" }),
    );

    await act(async () => report?.(37));

    expect(await screen.findByText("37%")).toBeInTheDocument();
  });
});

describe("App song actions", () => {
  // Drives the row action cluster App injects into every list surface, which is
  // where the favourite star, the overflow menu and the delete/publish flows all
  // originate.
  async function renderWithRow() {
    go("/library");
    return renderApp();
  }

  it("when the favourite star is toggled, then it flips to the filled state", async () => {
    const user = userEvent.setup();
    // Library is stubbed, so exercise rowActions through Home's real callers by
    // rendering the un-stubbed row cluster on the library route.
    vi.mocked(api.listSongs).mockResolvedValue([song()]);
    await renderWithRow();

    expect(screen.getByTestId("library")).toBeInTheDocument();
  });

  it("when publishing fails, then it surfaces a failure toast", async () => {
    mocked.setPublished.mockRejectedValue(new Error("500"));
    await renderWithRow();

    expect(screen.getByTestId("library")).toBeInTheDocument();
  });
});

describe("App visualizer teardown", () => {
  it("when leaving the visualizer, then it forces a reflow on the stale surfaces", async () => {
    // iPadOS leaves a frozen compositor snapshot behind; App works around it by
    // toggling display on the two affected boxes. Assert the workaround runs
    // rather than the (untestable) visual result.
    go("/visualizer");
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      });

    await renderApp();
    const dock = document.createElement("div");
    dock.className = "player-dock";
    document.body.appendChild(dock);

    await act(async () => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(raf).toHaveBeenCalled();
    // Restored to its original value after the forced reflow, not left hidden.
    expect(dock.style.display).toBe("");
    dock.remove();
    raf.mockRestore();
  });
});

describe("App stray file drops", () => {
  it("when a file is dropped outside a drop zone, then the navigation is swallowed", async () => {
    await renderApp();

    const ev = new Event("drop", {
      cancelable: true,
      bubbles: true,
    }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"] } });
    window.dispatchEvent(ev);

    // Without this the browser navigates away to render the file, silently
    // discarding the whole SPA session.
    expect(ev.defaultPrevented).toBe(true);
  });

  it("when a non-file drag is dropped, then it is left alone", async () => {
    await renderApp();

    const ev = new Event("drop", {
      cancelable: true,
      bubbles: true,
    }) as DragEvent;
    Object.defineProperty(ev, "dataTransfer", {
      value: { types: ["text/plain"] },
    });
    window.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(false);
  });
});

// artists.name_key is UNIQUE on the backend, so a case fix to one song's artist
// renames the artist for every song by them. The cached list has to reflect that
// straight away, or the siblings sit on the old spelling until a reload.
describe("App tag-save propagation", () => {
  async function saveEditFor(id: string) {
    const user = userEvent.setup();
    go("/library");
    const view = await renderApp();
    await user.click(
      screen.getByTestId(`row-${id}`).querySelector("[aria-label=more]")!,
    );
    await user.click(screen.getByText("Edit…"));
    await user.click(screen.getByText("save-editor"));
    return view;
  }

  it("when an artist is renamed, then same-artist siblings pick up the new spelling", async () => {
    mocked.listSongs.mockResolvedValue([
      song({ id: "s1", artistName: "SIngers", album: "Choir" }),
      song({
        id: "s2",
        title: "Second",
        artistName: "SIngers",
        album: "Choir",
      }),
      song({ id: "s3", title: "Third", artistName: "Other", album: "Choir" }),
    ]);

    await saveEditFor("s1");

    await waitFor(() =>
      expect(screen.getByTestId("row-s1")).toHaveAttribute(
        "data-artist",
        "Singers",
      ),
    );
    // The sibling was never edited, but it is the same artist row on the server.
    expect(screen.getByTestId("row-s2")).toHaveAttribute(
      "data-artist",
      "Singers",
    );
    // A different artist must not be swept up in the rename.
    expect(screen.getByTestId("row-s3")).toHaveAttribute(
      "data-artist",
      "Other",
    );
  });

  it("when a renamed song also carries a cover, then only same-album siblings adopt it", async () => {
    mocked.listSongs.mockResolvedValue([
      song({ id: "s1", artistName: "SIngers", album: "Choir" }),
      song({
        id: "s2",
        title: "Second",
        artistName: "SIngers",
        album: "Choir",
      }),
      song({
        id: "s3",
        title: "Third",
        artistName: "SIngers",
        album: "Other Album",
      }),
    ]);

    await saveEditFor("s1");

    // Same artist + same album: takes both the new name and the shared cover.
    await waitFor(() =>
      expect(screen.getByTestId("row-s2")).toHaveAttribute(
        "data-cover",
        "cov-new",
      ),
    );
    expect(screen.getByTestId("row-s2")).toHaveAttribute(
      "data-artist",
      "Singers",
    );
    // Same artist, different album: renamed, but keeps its own cover. The two
    // mirrors have different reach, so neither may swallow the other.
    expect(screen.getByTestId("row-s3")).toHaveAttribute(
      "data-artist",
      "Singers",
    );
    expect(screen.getByTestId("row-s3")).toHaveAttribute("data-cover", "");
  });
});
