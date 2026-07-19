export function songShareUrl(id: string): string {
  return `${location.origin}/song/${id}`;
}

export function playlistShareUrl(id: string): string {
  return `${location.origin}/playlist/${id}`;
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
