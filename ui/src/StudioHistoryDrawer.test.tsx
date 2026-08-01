import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, listStudioHistory: vi.fn(), deleteStudioRun: vi.fn() };
});

import { StudioHistoryDrawer } from "./StudioHistoryDrawer";
import * as api from "./api";
import type { StudioRun } from "./api";
const mocked = vi.mocked(api);

function run(over: Partial<StudioRun> = {}): StudioRun {
  return {
    id: "r1",
    reference: "Metallica, Enter Sandman",
    referenceArtist: "Metallica",
    referenceTitle: "Enter Sandman",
    stylePrompt: "",
    lyrics: "",
    coverArtPrompt: "",
    genres: ["thrash metal"],
    bands: [],
    titles: [],
    albums: [],
    coverArtId: "",
    refineCount: 0,
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("StudioHistoryDrawer", () => {
  it("shows the total in the header", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run()],
      total: 243,
      nextBefore: 12,
    });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText(/243 runs/)).toBeInTheDocument();
  });

  // One run is "1 run", not "1 runs".
  it("says run in the singular for a single run", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run()],
      total: 1,
      nextBefore: 0,
    });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText(/1 run\b/)).toBeInTheDocument();
  });

  // Decision 3: the run on screen is never in the list.
  it("excludes the run currently on screen", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [
        run({ id: "current", referenceTitle: "On Screen" }),
        run({ id: "old", referenceTitle: "Older" }),
      ],
      total: 2,
      nextBefore: 0,
    });
    render(
      <StudioHistoryDrawer
        onClose={() => {}}
        onOpen={() => {}}
        currentRunId="current"
      />,
    );
    expect(await screen.findByText("Older")).toBeInTheDocument();
    expect(screen.queryByText("On Screen")).not.toBeInTheDocument();
  });

  // Filtering happens at render time, so the header count stays the server's
  // honest total rather than dropping by one whenever a run is on screen.
  it("keeps the header count honest while hiding the live run", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "current" }), run({ id: "older" })],
      total: 9,
      nextBefore: 0,
    });
    render(
      <StudioHistoryDrawer
        onClose={() => {}}
        onOpen={() => {}}
        currentRunId="current"
      />,
    );
    expect(await screen.findByText(/9 runs/)).toBeInTheDocument();
  });

  it("groups rows under date headers", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [
        run({ id: "a", referenceTitle: "Recent", createdAt: nowStamp() }),
        run({
          id: "b",
          referenceTitle: "Ancient",
          createdAt: "2020-01-01 10:00:00",
        }),
      ],
      total: 2,
      nextBefore: 0,
    });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Earlier")).toBeInTheDocument();
  });

  // P1: an explicit button, and it disappears on the last page.
  it("pages with Show more and passes the cursor", async () => {
    mocked.listStudioHistory
      .mockResolvedValueOnce({
        runs: [run({ id: "a", referenceTitle: "First" })],
        total: 2,
        nextBefore: 41,
      })
      .mockResolvedValueOnce({
        runs: [run({ id: "b", referenceTitle: "Second" })],
        total: 2,
        nextBefore: 0,
      });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /show 25 more/i }),
    );
    await waitFor(() =>
      expect(mocked.listStudioHistory).toHaveBeenCalledWith(41),
    );
    expect(await screen.findByText("Second")).toBeInTheDocument();
    // Page two appends; it must not replace what is already on screen.
    expect(screen.getByText("First")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /show 25 more/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("reports how much of the history is on screen", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "a" }), run({ id: "b" })],
      total: 243,
      nextBefore: 41,
    });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText("2 of 243")).toBeInTheDocument();
  });

  it("opens a run when its row is clicked", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "r7" })],
      total: 1,
      nextBefore: 0,
    });
    const onOpen = vi.fn();
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={onOpen} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /^Enter Sandman/ }),
    );
    expect(onOpen).toHaveBeenCalledWith("r7");
  });

  it("shows an empty state on a first visit", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [],
      total: 0,
      nextBefore: 0,
    });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
  });

  // Emptying the page on screen is not the same as an empty history: the paging
  // button has to survive it, or the rest of the runs are unreachable and the
  // drawer claims there is "nothing here yet" while the server holds dozens.
  it("keeps paging offered after every loaded row is deleted", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "r7", referenceTitle: "Doomed" })],
      total: 26,
      nextBefore: 12,
    });
    mocked.deleteStudioRun.mockResolvedValue(undefined);
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete Doomed" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByText("Doomed")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Show 25 more/ }),
    ).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [],
      total: 0,
      nextBefore: 0,
    });
    const onClose = vi.fn();
    render(<StudioHistoryDrawer onClose={onClose} onOpen={() => {}} />);
    await screen.findByText(/nothing here yet/i);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on the X and on the scrim", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [],
      total: 0,
      nextBefore: 0,
    });
    const onClose = vi.fn();
    const { container } = render(
      <StudioHistoryDrawer onClose={onClose} onOpen={() => {}} />,
    );
    await screen.findByText(/nothing here yet/i);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(container.firstElementChild as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("surfaces a load failure instead of an empty list", async () => {
    mocked.listStudioHistory.mockRejectedValue(new Error("nope"));
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  // Deleting is destructive and irreversible, so it asks first.
  it("asks before deleting, and drops the row once confirmed", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [
        run({ id: "r7", referenceTitle: "Doomed" }),
        run({ id: "r8", referenceTitle: "Spared" }),
      ],
      total: 2,
      nextBefore: 0,
    });
    mocked.deleteStudioRun.mockResolvedValue(undefined);
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /delete Doomed/i }),
    );
    expect(mocked.deleteStudioRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mocked.deleteStudioRun).toHaveBeenCalledWith("r7"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Doomed")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Spared")).toBeInTheDocument();
    // The header total drops with the row rather than going stale.
    expect(await screen.findByText(/1 run\b/)).toBeInTheDocument();
  });

  it("keeps the row when the delete is cancelled", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "r7", referenceTitle: "Doomed" })],
      total: 1,
      nextBefore: 0,
    });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /delete Doomed/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocked.deleteStudioRun).not.toHaveBeenCalled();
    expect(screen.getByText("Doomed")).toBeInTheDocument();
  });

  it("keeps the row and reports a failed delete", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "r7", referenceTitle: "Doomed" })],
      total: 1,
      nextBefore: 0,
    });
    mocked.deleteStudioRun.mockRejectedValue(new Error("nope"));
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /delete Doomed/i }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocked.deleteStudioRun).toHaveBeenCalled());
    expect(screen.getByText("Doomed")).toBeInTheDocument();
  });

  // A run the model could not identify still has to be findable.
  it("labels an unidentified run with the reference verbatim", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [
        run({
          id: "r7",
          referenceArtist: "",
          referenceTitle: "",
          reference: "blue monday new order",
          genres: [],
        }),
      ],
      total: 1,
      nextBefore: 0,
    });
    render(<StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />);
    expect(
      await screen.findByText("blue monday new order"),
    ).toBeInTheDocument();
  });
});

// nowStamp writes "now" in the SQLite column format the server emits (UTC, space
// separated), so a test row lands in the Today bucket whenever the suite runs.
function nowStamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

describe("StudioHistoryDrawer layering and counts", () => {
  // The header must not read "1 run" directly above "Nothing here yet." — which
  // is exactly the state of a user's very first generate, whose only run is the
  // one on screen.
  it("drops the count when the only run is the one on screen", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "current" })],
      total: 1,
      nextBefore: 0,
    });
    render(
      <StudioHistoryDrawer
        onClose={() => {}}
        onOpen={() => {}}
        currentRunId="current"
      />,
    );
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/\d+ runs?\b/)).not.toBeInTheDocument();
  });

  // ConfirmDialog's backdrop does not stop propagation, so a dialog nested
  // inside the drawer's scrim would close the drawer too — and would do it even
  // mid-delete, when the dialog is deliberately swallowing the cancel.
  it("does not close the drawer when the confirm backdrop is clicked", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [run({ id: "r7", referenceTitle: "Doomed" })],
      total: 1,
      nextBefore: 0,
    });
    const onClose = vi.fn();
    render(<StudioHistoryDrawer onClose={onClose} onOpen={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /delete Doomed/i }),
    );
    const dialog = screen.getByRole("dialog", { name: "Delete this run?" });
    await userEvent.click(dialog.parentElement as Element);
    expect(
      screen.queryByRole("dialog", { name: "Delete this run?" }),
    ).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Doomed")).toBeInTheDocument();
  });

  // The player dock is zIndex 60 and renders after the page, so a scrim below
  // that would bury the drawer's footer under it.
  it("sits above the player dock", async () => {
    mocked.listStudioHistory.mockResolvedValue({
      runs: [],
      total: 0,
      nextBefore: 0,
    });
    const { container } = render(
      <StudioHistoryDrawer onClose={() => {}} onOpen={() => {}} />,
    );
    const scrim = container.firstElementChild as HTMLElement;
    expect(Number(scrim.style.zIndex)).toBeGreaterThan(60);
  });
});
