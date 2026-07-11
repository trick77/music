// Small animated equalizer shown on the currently playing song's row.
// Bars animate while playing and freeze mid-height when paused.
export function NowPlayingBars({ playing }: { playing: boolean }) {
  return (
    <span className={"eq-bars" + (playing ? "" : " eq-bars--paused")} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
