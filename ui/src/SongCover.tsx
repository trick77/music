import type { ReactNode } from "react";
import type { Song } from "./api";
import { coverUrl, coverInitial, type ImageSize } from "./cover";
import { usePlayer } from "./player";
import { NowPlayingBars } from "./NowPlayingBars";

// Shared cover thumbnail for a Song. Owns the now-playing equalizer overlay so
// every surface that shows a song's art gets the indicator for free — render
// this instead of hand-rolling <img src={coverUrl(...)}>. Use it ONLY for Song
// objects; playlist/artist/genre covers keep their own markup so they never
// light up.
type Props = {
  song: Song;
  size: number; // square px for the container
  radius: number;
  imgSize?: ImageSize; // cover variant to request ("thumb" | "card" | "hero")
  fallbackText?: string; // defaults to coverInitial(song.title)
  fallbackFontSize?: string;
  fallbackColor?: string; // default var(--color-muted)
  background?: string; // container bg; default var(--color-active)
  border?: string; // optional container border
  barsScale?: number; // scale NowPlayingBars up on large tiles
  children?: ReactNode; // extra overlays (e.g. a .playfab play button)
};

export function SongCover({
  song,
  size,
  radius,
  imgSize,
  fallbackText,
  fallbackFontSize,
  fallbackColor,
  background,
  border,
  barsScale,
  children,
}: Props) {
  const { current, playing } = usePlayer();
  const isPlaying = current?.id === song.id && playing;
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: radius,
        overflow: "hidden",
        background: background ?? "var(--color-active)",
        border,
        display: "grid",
        placeItems: "center",
      }}
    >
      {song.coverArtId ? (
        <img
          src={coverUrl(song.coverArtId, imgSize)}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: fallbackFontSize,
            color: fallbackColor ?? "var(--color-muted)",
          }}
        >
          {fallbackText ?? coverInitial(song.title)}
        </span>
      )}
      {isPlaying && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            background: "rgba(0,0,0,0.5)",
          }}
        >
          <NowPlayingBars scale={barsScale} />
        </span>
      )}
      {children}
    </div>
  );
}
