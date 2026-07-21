import { useEffect, useState } from "react";
import {
  listAlbums,
  generateStudioCoverArt,
  studioCoverArtUrl,
  suggestAlbumPrompt,
  refineAlbumPrompt,
  setAlbumCover,
  type AlbumSummary,
} from "./api";
import { Icon } from "./Icon";
import { ModelPicker, RefineRow } from "./StudioShared";
import { Button, Spinner, controlClass, fieldLabel, t } from "./ui";

type Props = {
  chatEnabled: boolean;
  imageModels: string[];
  defaultImageModel: string;
};

// AlbumCoverMode generates a square 1:1 cover for a library album and applies it
// to every song of that album. It mirrors GenreFanartMode: suggest-prompt authors
// an editable prompt (seeded with artist/album/genre), generate produces an image
// synchronously, and "Set as album cover" maps it via the album_covers table.
export function AlbumCoverMode({
  chatEnabled,
  imageModels,
  defaultImageModel,
}: Props) {
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [index, setIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(defaultImageModel);
  const [suggesting, setSuggesting] = useState(false);
  const [refining, setRefining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<{ id: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listAlbums()
      .then(setAlbums)
      .catch(() => setErr("Could not load albums"));
  }, []);

  const album = albums[index];

  const reset = () => {
    setImage(null);
    setSaved(false);
  };

  const onSuggest = async () => {
    if (!album) return;
    setSuggesting(true);
    setErr(null);
    try {
      setPrompt(await suggestAlbumPrompt(album.artistId, album.album));
    } catch {
      setErr("Could not suggest a prompt");
    } finally {
      setSuggesting(false);
    }
  };

  const onRefine = async (instruction: string) => {
    if (!album || !prompt.trim()) return;
    setRefining(true);
    setErr(null);
    try {
      setPrompt(
        await refineAlbumPrompt(
          album.artistId,
          album.album,
          prompt.trim(),
          instruction,
        ),
      );
    } catch {
      setErr("Could not refine the prompt");
    } finally {
      setRefining(false);
    }
  };

  const onGenerate = async () => {
    if (!album || !prompt.trim() || busy) return;
    setBusy(true);
    setErr(null);
    reset();
    try {
      const res = await generateStudioCoverArt(prompt.trim(), model);
      setImage({ id: res.id });
    } catch (e) {
      setErr((e as Error).message || "Cover art generation failed");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!album || !image) return;
    setErr(null);
    try {
      await setAlbumCover(album.artistId, album.album, image.id);
      setSaved(true);
      // Reflect the new cover on the album list so it no longer shows "needs artwork".
      setAlbums((as) =>
        as.map((a, i) => (i === index ? { ...a, hasCover: true } : a)),
      );
    } catch {
      setErr("Could not set album cover");
    }
  };

  const genDisabled = busy || !album || prompt.trim() === "";

  return (
    <div>
      <label htmlFor="album-select" style={fieldLabel}>
        Album
      </label>
      <select
        id="album-select"
        aria-label="Album"
        className={controlClass}
        value={index}
        onChange={(e) => {
          setIndex(Number(e.target.value));
          reset();
        }}
        disabled={busy}
        style={{ marginBottom: "var(--space-5)", maxWidth: "100%" }}
      >
        {albums.length === 0 && <option value={0}>No albums found</option>}
        {albums.map((a, i) => (
          <option key={`${a.artistId}-${a.album}`} value={i}>
            {a.artistName} — {a.album}
            {a.hasCover ? "" : " · needs artwork"}
          </option>
        ))}
      </select>

      <ModelPicker
        models={imageModels}
        value={model}
        onChange={setModel}
        disabled={busy}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label
          htmlFor="album-prompt"
          style={{ ...fieldLabel, marginBottom: 0 }}
        >
          Prompt
        </label>
        {chatEnabled && (
          <Button
            variant="ghost"
            small
            busy={suggesting}
            disabled={!album}
            onClick={onSuggest}
          >
            {!suggesting && <Icon name="feather" size="14px" />}Suggest prompt
          </Button>
        )}
      </div>
      <textarea
        id="album-prompt"
        aria-label="Album cover prompt"
        className={controlClass}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={suggesting || refining}
        placeholder="Describe the album cover — a single strong subject, palette, mood…"
        rows={3}
        style={{ marginBottom: "var(--space-3)" }}
      />
      {chatEnabled && (
        <RefineRow
          onRefine={onRefine}
          busy={refining}
          disabled={busy || !album || prompt.trim() === ""}
        />
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4)",
          marginBottom: "var(--space-1)",
        }}
      >
        <Button busy={busy} disabled={genDisabled} onClick={onGenerate}>
          {busy ? "Generating" : image ? "Regenerate" : "Generate cover"}
        </Button>
        <span style={t.label}>
          Square 1:1 · applies to every song of the album.
        </span>
      </div>

      {busy && (
        <div
          aria-live="polite"
          aria-busy="true"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--color-muted)",
            ...t.body,
            marginTop: "var(--space-3)",
          }}
        >
          <Spinner size="18px" />
          <span>Generating cover</span>
        </div>
      )}
      {err && !busy && (
        <p
          role="alert"
          style={{
            color: "var(--color-accent-strong)",
            fontSize: "var(--text-label)",
            margin: "var(--space-3) 0 0",
          }}
        >
          {err}
        </p>
      )}

      {image && !busy && (
        <div style={{ marginTop: "1rem" }}>
          <img
            src={studioCoverArtUrl(image.id)}
            alt="Generated album cover"
            style={{
              width: "100%",
              maxWidth: 360,
              aspectRatio: "1 / 1",
              objectFit: "cover",
              borderRadius: "var(--radius-ui)",
              border: "1px solid var(--color-border)",
              display: "block",
            }}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              marginTop: "var(--space-3)",
              flexWrap: "wrap",
            }}
          >
            <Button
              variant={saved ? "secondary" : "primary"}
              small
              disabled={saved}
              onClick={apply}
            >
              {saved && <Icon name="check" size="14px" />}Set as album cover
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
