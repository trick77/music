// Small animated equalizer shown on the currently playing song's row.
// Render it only while playback is active; the bars always animate.
// `scale` enlarges the bars for big cover tiles (defaults to 1x for thumbs).
export function NowPlayingBars({ scale }: { scale?: number } = {}) {
  return (
    <span className="eq-bars" aria-hidden="true" style={scale && scale !== 1 ? { transform: `scale(${scale})` } : undefined}>
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
