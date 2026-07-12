export function songShareUrl(id: string): string {
  return `${location.origin}/song/${id}`;
}

export function playlistShareUrl(id: string): string {
  return `${location.origin}/playlist/${id}`;
}

// lyricsShareUrl is the deep link that opens the full player in lyrics mode.
export function lyricsShareUrl(id: string): string {
  return `${location.origin}/song/${id}?player=lyrics`;
}

// copyText copies to the clipboard, resolving false when unavailable (e.g.
// insecure context) so callers can fall back to a prompt.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
