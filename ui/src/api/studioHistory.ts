// --- Studio history ---------------------------------------------------------
// Every completed Studio run is kept server-side so it can be reopened
// read-only. These are the four calls the history drawer and the saved-run view
// make; the write side (creating a run) happens inside the generate stream, not
// here.

// A saved Studio run, as returned by /api/studio/history. Mirrors
// library.StudioRun on the backend; every field is what the run produced.
export type StudioRun = {
  id: string;
  reference: string;
  // The real artist and title as the model identified them. Either may be empty
  // when it declined — callers fall back to `reference` verbatim.
  referenceArtist: string;
  referenceTitle: string;
  stylePrompt: string;
  lyrics: string;
  coverArtPrompt: string;
  genres: string[];
  bands: string[];
  titles: string[];
  albums: string[];
  coverArtId: string;
  refineCount: number;
  createdAt: string;
  updatedAt: string;
};

export type StudioHistoryPage = {
  runs: StudioRun[];
  total: number;
  // 0 means this was the last page — the drawer drops its "Show more" button.
  nextBefore: number;
};

// listStudioHistory fetches one page, newest first. Pass the previous page's
// nextBefore to continue; omit it (or pass 0, which is what the last page
// reports) for the first page.
export async function listStudioHistory(
  before?: number,
): Promise<StudioHistoryPage> {
  const url = before
    ? `/api/studio/history?before=${before}`
    : "/api/studio/history";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`studio history failed (${r.status})`);
  return r.json();
}

export async function getStudioRun(id: string): Promise<StudioRun> {
  const r = await fetch(`/api/studio/history/${id}`);
  if (!r.ok) throw new Error(`studio run failed (${r.status})`);
  return r.json();
}

// patchStudioRun updates a saved run in place. Only the keys given are touched,
// so a lyrics edit cannot clear the attached cover art.
export async function patchStudioRun(
  id: string,
  patch: { lyrics?: string; coverArtId?: string },
): Promise<void> {
  const r = await fetch(`/api/studio/history/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`studio run update failed (${r.status})`);
}

export async function deleteStudioRun(id: string): Promise<void> {
  const r = await fetch(`/api/studio/history/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`studio run delete failed (${r.status})`);
}
