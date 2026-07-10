import { useEffect, useState } from "react";
import { getGenre, type GenreDetail as GD, type Song } from "./api";
import { fanartUrl, genreInitial } from "./fanart";
import { navigate } from "./router";
import { GenreEditor } from "./GenreEditor";

type Props = { id: string; authenticated: boolean; imageGenEnabled: boolean; onPlay: (s: Song) => void };

export function GenreDetail({ id, authenticated, imageGenEnabled, onPlay }: Props) {
  const [data, setData] = useState<GD | null>(null);
  const [editing, setEditing] = useState(false);
  const load = () => getGenre(id).then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, [id]);

  if (!data) return <p style={{ color: "var(--color-muted)" }}>Loading…</p>;
  const bg = fanartUrl(data.backgroundId, "hero");
  const accent = data.genre.accentColor || "var(--color-accent)";

  return (
    <div>
      <button onClick={() => navigate("/genres")} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", marginBottom: "1rem" }}>← Genres</button>
      <div style={{
        position: "relative", borderRadius: 16, overflow: "hidden", minHeight: 220,
        display: "flex", alignItems: "flex-end", padding: "1.25rem",
        background: bg ? `linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.75)), url(${bg}) center/cover`
                       : `linear-gradient(135deg, ${accent}, var(--color-panel))`,
      }}>
        {!bg && <span aria-hidden style={{ position: "absolute", top: 12, left: 16, fontSize: "2rem", opacity: 0.5, fontFamily: "var(--font-serif)" }}>{genreInitial(data.genre.name)}</span>}
        <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-end", width: "100%" }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-serif)", color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,0.6)" }}>{data.genre.name}</h1>
          {authenticated && (
            <button onClick={() => setEditing(true)} style={{ background: "rgba(0,0,0,0.45)", border: "1px solid rgba(255,255,255,0.35)", color: "#fff", borderRadius: 8, padding: "0.4rem 0.9rem", cursor: "pointer" }}>Edit</button>
          )}
        </div>
      </div>

      <ul style={{ listStyle: "none", padding: 0, marginTop: "1.25rem" }}>
        {data.songs.map((s) => (
          <li key={s.id} style={{ display: "flex", justifyContent: "space-between", padding: "0.5rem 0", borderBottom: "1px solid var(--color-border)" }}>
            <button onClick={() => onPlay(s)} style={{ background: "none", border: "none", color: "var(--color-ink)", cursor: "pointer", textAlign: "left" }}>
              {s.title} <span style={{ color: "var(--color-muted)" }}>— {s.artistName}</span>
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <GenreEditor
          detail={data}
          imageGenEnabled={imageGenEnabled}
          onClose={() => setEditing(false)}
          onChanged={() => load()}
        />
      )}
    </div>
  );
}
