// --- Studio (Phase 9) -------------------------------------------------------
// Generate/refine stream Server-Sent Events: `progress` while MiMo researches,
// then a final `result` (or `error`). onProgress is called per progress event.

export type StudioProgress = { phase: string; detail: string };
export type StudioResult = { stylePrompt: string; lyrics: string; coverArtPrompt: string; genres: string[]; bands: string[]; titles: string[]; albums: string[] };

// streamStudio POSTs a JSON body and reads an SSE response, dispatching progress
// events and returning the final result (or throwing on error).
async function streamStudio(
  path: string,
  body: unknown,
  onProgress: (p: StudioProgress) => void,
): Promise<Record<string, unknown>> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) throw new Error(`studio request failed (${r.status})`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: Record<string, unknown> | undefined;
  let errorMsg: string | undefined;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const lines = frame.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:"));
      const dataLine = lines.find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const event = eventLine ? eventLine.slice(6).trim() : "message";
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event === "progress") onProgress(data as StudioProgress);
      else if (event === "result") result = data;
      else if (event === "error") errorMsg = String(data.error ?? "generation failed");
    }
  }
  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error("studio returned no result");
  return result;
}

export async function studioGenerate(reference: string, onProgress: (p: StudioProgress) => void): Promise<StudioResult> {
  return (await streamStudio("/api/studio/generate", { reference }, onProgress)) as unknown as StudioResult;
}

export async function studioRefine(
  reference: string,
  lyrics: string,
  instruction: string,
  onProgress: (p: StudioProgress) => void,
): Promise<string> {
  const result = await streamStudio("/api/studio/refine", { reference, lyrics, instruction }, onProgress);
  return String(result.lyrics ?? "");
}

// MODEL_LABELS gives known BFL models a friendly picker label; the model list
// itself comes from the session (imageModels), so an operator-set model still
// renders (falling back to its raw id).
const MODEL_LABELS: Record<string, string> = {
  "flux-2-klein-4b": "Fast · flux-2-klein-4b",
  "flux-2-flex": "Balanced (typography) · flux-2-flex",
  "flux-2-pro": "Best quality · flux-2-pro",
};

// imageModelOptions turns the session's model ids into {id,label} picker options.
export function imageModelOptions(models: string[]): { id: string; label: string }[] {
  return (models ?? []).map((id) => ({ id, label: MODEL_LABELS[id] ?? id }));
}

export async function generateStudioCoverArt(
  prompt: string,
  model: string,
): Promise<{ id: string; status: string; width: number; height: number }> {
  const r = await fetch("/api/studio/coverart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
  });
  if (!r.ok) throw new Error(`cover art failed (${r.status})`);
  return r.json();
}

export function studioCoverArtUrl(id: string): string {
  return `/api/studio/coverart/${id}`;
}
