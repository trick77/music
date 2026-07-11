// Small animated equalizer shown on the currently playing song's row.
// Render it only while playback is active; the bars always animate.
export function NowPlayingBars() {
  return (
    <span className="eq-bars" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
