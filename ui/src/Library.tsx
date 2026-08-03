import { useEffect, useMemo, useRef, useState } from "react";
import { listGenres, type GenreSummary, type Song } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { fanartUrl } from "./fanart";
import { daysSinceAdded, formatDayGroup, formatDuration } from "./format";
import { navigate } from "./router";
import { Glyph } from "./Glyph";
import { HScrollRail } from "./HScrollRail";
import { Icon } from "./Icon";
import { t, UnpublishedBadge } from "./ui";
import { genreLabel } from "./titleCase";
import { usePlayer } from "./player";
import { SongCover } from "./SongCover";

type Tab = "all" | "recent" | "favorites" | "unpublished" | "genres";

/** How far back "Recently added" reaches, in calendar days. */
const RECENT_DAYS = 30;

const TAB_LABELS: Record<Tab, string> = {
  all: "All songs",
  recent: "Recently added",
  favorites: "Favorites",
  unpublished: "Unpublished",
  genres: "Genres",
};

/**
 * The filter field matches title and artist — the two things a row shows, so a
 * match is always visible in the result rather than hiding in a tag the list
 * doesn't render. Same fields as the playlist page's filter.
 */
function matchesQuery(song: Song, needle: string): boolean {
  if (!needle) return true;
  return `${song.title} ${song.artistName}`.toLowerCase().includes(needle);
}

/**
 * What the row above the pills calls the things it is counting. "3 of 24
 * favorites" reads better than "3 of 24 songs" when Favorites is the tab you are
 * looking at — the count should name the category, not the table it came from.
 */
function countNoun(tab: Tab, n: number): string {
  if (tab === "genres") return n === 1 ? "genre" : "genres";
  if (tab === "favorites") return n === 1 ? "favorite" : "favorites";
  if (tab === "unpublished")
    return n === 1 ? "unpublished song" : "unpublished songs";
  return n === 1 ? "song" : "songs";
}

type Props = {
  songs: Song[];
  favoriteIds: string[];
  authenticated: boolean;
  studioEnabled?: boolean;
  imageGenEnabled?: boolean;
  initialTab: Tab;
  // Bumped by the parent after an upload jump to force a re-sync to initialTab even
  // when initialTab itself is unchanged (URL already /unpublished, tab had drifted).
  tabResetKey?: number;
  onPlay: (song: Song) => void;
  renderRowActions: (song: Song) => React.ReactNode;
};

export function Library({
  songs,
  favoriteIds,
  authenticated,
  studioEnabled = false,
  imageGenEnabled = false,
  initialTab,
  tabResetKey,
  onPlay,
  renderRowActions,
}: Props) {
  const { current, playing } = usePlayer();
  const [tab, setTab] = useState<Tab>(initialTab);
  // Follow route-driven tab changes (e.g. jumping to /unpublished after an upload)
  // even when Library is already mounted — useState above only seeds the first mount.
  // Pill clicks change `tab` locally without touching `initialTab`, so they aren't
  // clobbered by this effect.
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, tabResetKey]);
  // Keep the selected pill on screen: landing on /unpublished scrolls the strip
  // to it rather than leaving the active pill off the right edge. `nearest` does
  // NOT mean "never scrolls an ancestor" — with the pill off screen it still
  // scrolls the page, just to the closest edge instead of centring. That is the
  // wanted behaviour here: switching tabs from far down a list brings the top of
  // the new list into view. `authenticated` is a dep because it adds/removes the
  // Unpublished pill, which shifts the others along.
  const activeTabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      inline: "nearest",
      block: "nearest",
    });
  }, [tab, authenticated]);
  const [genres, setGenres] = useState<GenreSummary[]>([]);
  const [needsArtworkOnly, setNeedsArtworkOnly] = useState(false);
  useEffect(() => {
    if (tab === "genres")
      listGenres()
        .then(setGenres)
        .catch(() => setGenres([]));
  }, [tab]);

  // The filter text deliberately OUTLIVES a pill change: having typed "nova",
  // switching to Favorites to ask "is it one of mine?" is the whole point of
  // putting counts on the pills. It dies with the component on navigating away.
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  // One `now` per mount, so the "Recently added" window and its day headers can't
  // disagree between two renders of the same list.
  const now = useMemo(() => new Date(), []);

  // The Unpublished pill only makes sense for logged-in users — anonymous
  // viewers never receive unpublished songs.
  const tabs: Tab[] = [
    "all",
    "recent",
    "favorites",
    ...(authenticated ? (["unpublished"] as Tab[]) : []),
    "genres",
  ];

  const inCategory = (song: Song, which: Tab): boolean => {
    if (which === "favorites") return favoriteIds.includes(song.id);
    if (which === "unpublished") return !song.published;
    if (which === "recent") {
      const days = daysSinceAdded(song.createdAt, now);
      // A null timestamp is "we don't know when", which is not "recently"; a
      // negative one is a clock skew into the future, which certainly is.
      return days !== null && days < RECENT_DAYS;
    }
    return true;
  };

  // Every number on the page comes from this one pass, so a pill and the row
  // above it can never disagree. `matching` is the count under the current
  // query — what a pill shows. `total` ignores the query — the row's denominator.
  const counts = useMemo(() => {
    const out = {} as Record<Tab, { matching: number; total: number }>;
    for (const which of tabs) {
      if (which === "genres") continue;
      let matching = 0;
      let total = 0;
      for (const song of songs) {
        if (!inCategory(song, which)) continue;
        total++;
        if (matchesQuery(song, needle)) matching++;
      }
      out[which] = { matching, total };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, favoriteIds, authenticated, needle, now]);

  const shown = useMemo(() => {
    if (tab === "genres") return [];
    const list = songs.filter(
      (s) => inCategory(s, tab) && matchesQuery(s, needle),
    );
    // Newest first is the only ordering that makes "Recently added" readable —
    // and it is what the day-group headers below assume.
    if (tab === "recent")
      list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, favoriteIds, tab, needle, now]);

  // "Recently added" breaks into calendar days; every other tab is one flat run.
  const dayGroups = useMemo(() => {
    if (tab !== "recent") return null;
    const groups: { label: string; songs: Song[] }[] = [];
    for (const song of shown) {
      const label = formatDayGroup(song.createdAt, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.songs.push(song);
      else groups.push({ label, songs: [song] });
    }
    return groups;
  }, [shown, tab, now]);

  const genreMatches = (g: GenreSummary) =>
    !needle || genreLabel(g.name).toLowerCase().includes(needle);

  const clearQuery = () => setQuery("");

  // One row, rendered either straight into a flat <ul> or into one of the
  // "Recently added" day groups.
  const renderRow = (song: Song) => {
    const isPlaying = current?.id === song.id && playing;
    return (
      <li
        key={song.id}
        onClick={() => onPlay(song)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.85rem",
          padding: "0.6rem 0.85rem",
          borderRadius: "var(--radius-ui, 10px)",
          cursor: "pointer",
        }}
      >
        <SongCover
          song={song}
          size={44}
          radius={8}
          border="1px solid var(--color-border)"
          fallbackText={coverInitial(song.artistName)}
        />

        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: "block",
              color: isPlaying
                ? "var(--color-accent-strong)"
                : "var(--color-ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {song.title}
          </span>
          <span
            className="row-meta"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              ...t.label,
            }}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {song.artistName}
            </span>
            <UnpublishedBadge
              show={authenticated && !song.published}
              placement="meta"
            />
          </span>
        </span>
        <span
          style={{
            color: "var(--color-muted)",
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {formatDuration(song.durationMs)}
        </span>
        <span
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: "0.9rem",
            flexShrink: 0,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {renderRowActions(song)}
        </span>
      </li>
    );
  };

  const genreTotal = genres.length;
  const genreMatching = genres.filter(genreMatches).length;
  const active = counts[tab] ?? { matching: 0, total: 0 };
  const rowTotal = tab === "genres" ? genreTotal : active.total;
  const rowMatching = tab === "genres" ? genreMatching : active.matching;

  return (
    <div>
      {/* Search leads the page, above the pills: it acts on the whole library and
          the pills partition what it leaves, so their counts move as you type. A
          field UNDER the numbers it changes reads backwards. The row is the same
          skeleton as the Genres tab's own row below — count prose left, control
          right, wrapping to a second line on a phone. */}
      {(rowTotal > 0 || needle) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: "1rem",
          }}
        >
          <span style={t.label}>
            {needle ? (
              rowMatching > 0 ? (
                <>
                  <b style={{ color: "var(--color-accent-strong)" }}>
                    {rowMatching} of {rowTotal}
                  </b>{" "}
                  {countNoun(tab, rowTotal)} match “{query.trim()}”
                </>
              ) : (
                <>
                  No {countNoun(tab, 0)} match “{query.trim()}”
                </>
              )
            ) : tab === "recent" ? (
              <>
                <b style={{ color: "var(--color-accent-strong)" }}>
                  {rowTotal} {rowTotal === 1 ? "song" : "songs"}
                </b>{" "}
                added in the last {RECENT_DAYS} days
              </>
            ) : (
              <>
                {rowTotal} {countNoun(tab, rowTotal)}
              </>
            )}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              background: "var(--color-panel)",
              border: "1px solid var(--color-border)",
              borderRadius: 999,
              padding: "0.5rem 1rem",
              // Shrink before the row wraps, then take a full line of its own.
              flex: "1 1 240px",
              minWidth: 0,
              maxWidth: 320,
            }}
          >
            <Glyph
              name="search"
              size={18}
              style={{ color: "var(--color-muted)", flexShrink: 0 }}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              // A placeholder is not an accessible name, so the field carries one
              // of its own. Enter has nothing to submit — the list already filtered
              // on every keystroke — so it means "done typing" and drops the
              // phone keyboard off the results.
              aria-label={tab === "genres" ? "Filter genres" : "Filter songs"}
              placeholder={
                tab === "genres" ? "Filter genres…" : "Filter songs…"
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                color: "var(--color-ink)",
                fontSize: "var(--text-input)",
                outline: "none",
                minWidth: 0,
              }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                aria-label="Clear the filter"
                style={{
                  display: "flex",
                  border: "none",
                  background: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "var(--color-muted)",
                  flexShrink: 0,
                }}
              >
                <Icon name="close" size="16px" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* The pills scroll rather than wrap: four of them were already ~387px on a
          ~350px phone content box, and the fifth takes the strip past 500px. The
          rail is the same component the cover rails use — it fades whichever edge
          has more beyond it and grows a ‹/› nudge button there, on pointer devices
          only, since a touch screen just swipes.
          The 3px of vertical padding is room for a focused pill's ring: a scroll
          container clips at its padding box, and without it the ring's top and
          bottom arcs are cut off. The margin gives that 3px back. */}
      <div style={{ marginBottom: "calc(1.25rem - 3px)" }}>
        <HScrollRail innerStyle={{ gap: "0.4rem", padding: "3px 0" }}>
          {tabs.map((k) => (
            <button
              key={k}
              ref={k === tab ? activeTabRef : undefined}
              onClick={() => setTab(k)}
              style={{
                padding: "7px 14px",
                borderRadius: 999,
                cursor: "pointer",
                fontSize: "var(--text-ui)",
                border: "1px solid transparent",
                flexShrink: 0,
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                background:
                  tab === k ? "var(--color-accent-fill)" : "transparent",
                color: tab === k ? "var(--color-ink)" : "var(--color-muted)",
              }}
            >
              {TAB_LABELS[k]}
              {/* Genres counts tiles, not songs, so it has no comparable number.
                  Everywhere else the count is "how many under the current query",
                  which is what makes a pill answer "is it hiding under there?".
                  The explicit space is not decoration: `gap` separates the two
                  visually but not textually, so without it the button's
                  accessible name reads "All songs2". */}
              {k !== "genres" && (
                <>
                  {" "}
                  <span
                    style={{
                      fontSize: "var(--text-label)",
                      fontVariantNumeric: "tabular-nums",
                      opacity: 0.75,
                    }}
                  >
                    {counts[k]?.matching ?? 0}
                  </span>
                </>
              )}
            </button>
          ))}
        </HScrollRail>
      </div>

      {tab === "genres" ? (
        (() => {
          const missing = genres.filter((g) => !g.hasBackground).length;
          // The filter field above the pills narrows the tiles too — it is the
          // page's one search box, so it must not go dead on this tab.
          const shownGenres = genres
            .filter(genreMatches)
            .filter((g) => !needsArtworkOnly || !g.hasBackground);
          return (
            <div>
              {genres.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                    marginBottom: "1rem",
                  }}
                >
                  <span style={t.label}>
                    {missing > 0 ? (
                      <>
                        <b style={{ color: "var(--color-accent-strong)" }}>
                          {missing} of {genres.length}
                        </b>{" "}
                        genres still need artwork
                      </>
                    ) : (
                      <>All {genres.length} genres have artwork</>
                    )}
                  </span>
                  {(missing > 0 || needsArtworkOnly) && (
                    <button
                      onClick={() => setNeedsArtworkOnly((v) => !v)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "7px 14px",
                        borderRadius: 999,
                        cursor: "pointer",
                        fontSize: "var(--text-ui)",
                        border: `1px solid ${needsArtworkOnly ? "var(--color-accent-strong)" : "var(--color-border)"}`,
                        background: needsArtworkOnly
                          ? "var(--color-active)"
                          : "transparent",
                        color: needsArtworkOnly
                          ? "var(--color-accent-strong)"
                          : "var(--color-muted)",
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: "50%",
                          background: "var(--color-accent-strong)",
                        }}
                      />
                      Needs artwork only
                    </button>
                  )}
                </div>
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))",
                  gap: 14,
                }}
              >
                {shownGenres.map((g) => {
                  // A genre that needs artwork offers a direct route into Studio to
                  // generate it — the entry point lives where the gap is flagged.
                  const canMake =
                    !g.hasBackground && studioEnabled && imageGenEnabled;
                  // With artwork, the tile shows the fanart muted the hero way (dark
                  // gradient over the image); without, it degrades to the accent tint.
                  const bg = g.hasBackground
                    ? fanartUrl(g.backgroundFanartId, "card")
                    : "";
                  return (
                    <div
                      key={g.id}
                      className="tile"
                      style={{
                        position: "relative",
                        borderRadius: 14,
                        overflow: "hidden",
                        minHeight: "clamp(150px, 15vw, 190px)",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "flex-end",
                        background: bg
                          ? `linear-gradient(180deg, rgba(20,20,18,0.22), rgba(20,20,18,0.66)), url(${bg}) center/cover no-repeat`
                          : g.accentColor
                            ? `linear-gradient(135deg, ${g.accentColor}, var(--color-panel))`
                            : "var(--color-active)",
                        border: g.hasBackground
                          ? "1px solid var(--color-border)"
                          : "1px dashed var(--color-border)",
                        color: g.hasBackground ? "#fff" : "var(--color-ink)",
                      }}
                    >
                      {/* Base click layer: open the genre. Sits behind the label and the CTA. */}
                      <button
                        onClick={() => navigate(`/genre/${g.id}`)}
                        aria-label={`${genreLabel(g.name)}, ${g.songCount} ${g.songCount === 1 ? "song" : "songs"}`}
                        style={{
                          position: "absolute",
                          inset: 0,
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      />
                      {!g.hasBackground && (
                        <span
                          style={{
                            position: "absolute",
                            top: 8,
                            right: 8,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            pointerEvents: "none",
                            background:
                              "color-mix(in srgb, var(--color-accent-strong) 30%, var(--color-bg))",
                            border:
                              "1px solid color-mix(in srgb, var(--color-accent-strong) 55%, transparent)",
                            borderRadius: 999,
                            padding: "2px 8px",
                            ...t.micro,
                            fontWeight: 600,
                            color: "#fff",
                          }}
                        >
                          <span
                            style={{
                              width: 5,
                              height: 5,
                              borderRadius: "50%",
                              background: "var(--color-accent-strong)",
                            }}
                          />
                          Needs artwork
                        </span>
                      )}
                      <div
                        style={{
                          position: "relative",
                          pointerEvents: "none",
                          padding: "0.9rem",
                        }}
                      >
                        <div
                          style={{
                            ...t.title,
                            ...(g.hasBackground
                              ? {
                                  color: "#fff",
                                  textShadow: "0 2px 12px rgba(0,0,0,0.6)",
                                }
                              : null),
                          }}
                        >
                          {genreLabel(g.name)}
                        </div>
                        <div
                          style={
                            g.hasBackground
                              ? {
                                  fontSize: "var(--text-label)",
                                  fontWeight: 500,
                                  color: "rgba(255,255,255,0.82)",
                                }
                              : t.label
                          }
                        >
                          {g.songCount} {g.songCount === 1 ? "song" : "songs"}
                        </div>
                      </div>
                      {canMake && (
                        <button
                          onClick={() => navigate(`/studio/genre/${g.id}`)}
                          style={{
                            position: "relative",
                            margin: "0 0.9rem 0.9rem",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 6,
                            fontSize: "var(--text-label)",
                            fontWeight: 600,
                            color: "var(--color-accent-strong)",
                            cursor: "pointer",
                            border: "1px solid var(--color-accent-strong)",
                            borderRadius: 8,
                            padding: "5px 8px",
                            background:
                              "color-mix(in srgb, var(--color-accent-strong) 12%, transparent)",
                          }}
                        >
                          <Glyph name="spark" size={13} /> Create in Studio
                        </button>
                      )}
                    </div>
                  );
                })}
                {genres.length === 0 && (
                  <p style={{ color: "var(--color-muted)" }}>No genres yet.</p>
                )}
                {/* A query that matches nothing is a different fact from a
                    library that holds nothing, and it has a way out. */}
                {genres.length > 0 &&
                  shownGenres.length === 0 &&
                  (needle && genreMatching === 0 ? (
                    <NoMatches query={query.trim()} onClear={clearQuery} />
                  ) : (
                    <p style={{ color: "var(--color-muted)" }}>
                      Every genre has artwork.
                    </p>
                  ))}
              </div>
            </div>
          );
        })()
      ) : shown.length === 0 ? (
        // Two different facts, two different messages: a query that found nothing
        // is not an empty category, and only one of them has a way out.
        needle ? (
          <NoMatches query={query.trim()} onClear={clearQuery} />
        ) : (
          <p style={{ color: "var(--color-muted)" }}>
            {tab === "favorites"
              ? "No favorites yet — tap the star on a song."
              : tab === "unpublished"
                ? "Nothing unpublished — every song is live."
                : tab === "recent"
                  ? `Nothing added in the last ${RECENT_DAYS} days.`
                  : "Nothing here yet."}
          </p>
        )
      ) : dayGroups ? (
        dayGroups.map((group) => (
          <section key={group.label}>
            <h2 style={{ ...t.label, margin: "0.6rem 0.85rem 0.25rem" }}>
              {group.label}
            </h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {group.songs.map(renderRow)}
            </ul>
          </section>
        ))
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.map(renderRow)}
        </ul>
      )}
    </div>
  );
}

/** The search-miss empty state, shared by the song list and the genre grid. */
function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <p style={{ color: "var(--color-muted)" }}>
      Nothing matches “{query}”.{" "}
      <button
        onClick={onClear}
        style={{
          border: "none",
          background: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--color-accent-strong)",
          font: "inherit",
        }}
      >
        Clear the filter
      </button>
    </p>
  );
}
