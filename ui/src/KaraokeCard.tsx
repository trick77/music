// KaraokeCard renders the non-playing karaoke states over the plain lyrics: a
// needs-sync CTA or a failed+retry card. Copy mirrors the locked mock
// (docs/mockups/karaoke). onGenerate re-POSTs /align. The plain lyrics stay visible
// (dimmed) behind the card so an unaligned song still shows its words.
export function KaraokeCard({ state, lyrics, onGenerate }: {
  state: "needs" | "failed" | "loading" | "plain";
  lyrics: string;
  onGenerate: () => void;
}) {
  // "plain" shows only the lyrics, crisp and full-strength — the static view for
  // anyone who can't sync (logged out, or alignment disabled). "loading" shows the
  // dimmed backdrop lyrics with no card while a ready song's aligned lines are still
  // being fetched — so no message box flashes.
  const isBare = state === "loading" || state === "plain";
  const copy = isBare ? null : {
    needs: {
      h: "Sync lyrics to the music",
      p: "Generate word-by-word karaoke timing — about a minute. Also runs automatically when you save lyrics in the tag editor.",
      btn: "Generate karaoke",
    },
    failed: {
      h: "Couldn’t sync this song",
      p: "Something went wrong aligning the words. You can try again.",
      btn: "Try again",
    },
  }[state];
  return (
    <div style={{ position: "relative", height: "100%" }}>
      {/* Plain lyrics — crisp and readable in the "plain" static view; dimmed and
          blurred behind the CTA cards so an unaligned song still shows its words. */}
      <pre
        aria-label="Lyrics"
        style={{
          position: "absolute", inset: 0, overflow: "auto", margin: 0, padding: "8vh 8vw",
          fontFamily: "var(--font-serif)", fontSize: 20, lineHeight: 1.6,
          whiteSpace: "pre-wrap", textAlign: "center",
          ...(state === "plain"
            ? { color: "rgba(250,249,245,.85)" }
            : { color: "rgba(250,249,245,.55)", filter: "blur(2px)", WebkitFilter: "blur(2px)", opacity: 0.5 }),
        }}
      >
        {lyrics}
      </pre>
      {copy && (
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24 }}>
        <div
          role="status"
          style={{
            textAlign: "center", maxWidth: 380, background: "color-mix(in srgb, var(--color-panel) 80%, transparent)",
            border: "1px solid var(--color-border)", borderRadius: 16, padding: "30px 28px", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
          }}
        >
          <div
            style={{
              width: 54, height: 54, margin: "0 auto 16px", borderRadius: "50%", background: "var(--color-active)",
              display: "grid", placeItems: "center", color: "var(--color-accent-strong)", fontSize: 26,
            }}
          >
            ♪
          </div>
          <h3 style={{ fontFamily: "var(--font-serif)", fontWeight: 600, margin: "0 0 8px", fontSize: 21, color: "var(--color-ink)" }}>{copy.h}</h3>
          <p style={{ margin: "0 0 20px", color: "var(--color-muted)", fontSize: 14, lineHeight: 1.55 }}>{copy.p}</p>
          {copy.btn && (
            <button
              onClick={onGenerate}
              style={{
                background: "var(--color-accent-fill)", color: "var(--color-ink)", border: "none",
                borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600, cursor: "pointer",
              }}
            >
              {copy.btn}
            </button>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
