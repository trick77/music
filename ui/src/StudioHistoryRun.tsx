import { useEffect, useState } from "react";
import { getStudioRun, studioCoverArtUrl, type StudioRun } from "./api";
import { Icon } from "./Icon";
import { IdentityCard, ResultCard } from "./StudioShared";
import { Button, Spinner, buttonStyle, t } from "./ui";
import { useEscape } from "./useEscape";
import { formatRunDate, runLabel } from "./studioHistoryGroups";

// STYLE_LIMIT mirrors the live page's count on the style-prompt card, so a saved
// run reads exactly like the run it was.
const STYLE_LIMIT = 500;

type Props = {
  id: string;
  onClose: () => void;
  // onRegenerate hands the reference back so a fresh run can be started from it.
  // That run is a new entry — nothing here is ever mutated.
  onRegenerate: (reference: string) => void;
};

// StudioHistoryRun shows one saved run in full and read-only: every card the live
// page renders, minus the refine field, the editable boxes and the cover-art
// generator. Copy buttons stay, because copying is what the run is kept for.
export function StudioHistoryRun({ id, onClose, onRegenerate }: Props) {
  const [run, setRun] = useState<StudioRun | null>(null);
  const [error, setError] = useState("");

  useEscape(true, onClose);

  useEffect(() => {
    let live = true;
    getStudioRun(id)
      .then((r) => {
        if (live) setRun(r);
      })
      .catch(() => {
        if (live) setError("Could not open this run.");
      });
    return () => {
      live = false;
    };
  }, [id]);

  const label = run ? runLabel(run) : { title: "", subtitle: "" };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        // Above the drawer that opened it (70), which is itself above the
        // player dock (60). Below ConfirmDialog's 100.
        zIndex: 80,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(2px)",
        WebkitBackdropFilter: "blur(2px)",
        display: "grid",
        placeItems: "start center",
        overflowY: "auto",
        padding: "var(--space-5) 1rem",
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Saved Studio run"
        aria-busy={run === null && error === "" ? "true" : undefined}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 720,
          borderRadius: 14,
          border: "1px solid var(--color-elevated-border)",
          background: "var(--color-elevated)",
          padding: "var(--space-5)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "0.75rem",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, ...t.title }}>{label.title}</h2>
            {run && (
              <div style={{ ...t.label, marginTop: "0.2rem" }}>
                {label.subtitle !== "" && `${label.subtitle} · `}
                generated {formatRunDate(run.createdAt)}
              </div>
            )}
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "var(--color-muted)",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Icon name="close" size="24px" />
          </button>
        </div>

        {error !== "" && (
          <p
            role="alert"
            style={{
              color: "var(--color-accent-strong)",
              marginTop: "var(--space-5)",
            }}
          >
            {error}
          </p>
        )}

        {run === null && error === "" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              marginTop: "var(--space-5)",
              ...t.label,
            }}
          >
            <Spinner size="18px" />
            <span>Opening</span>
          </div>
        )}

        {run && (
          <>
            <p
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.45rem",
                margin: "var(--space-5) 0",
                padding: "8px 12px",
                borderRadius: "var(--radius-ui)",
                background: "color-mix(in srgb, var(--color-bg) 70%, #000)",
                border: "1px solid var(--color-border)",
                ...t.label,
              }}
            >
              <Icon name="clock" size="15px" />
              Saved run — read-only. Refining is only available for a run in
              progress.
            </p>

            <ResultCard name="Lyrics" text={run.lyrics} />

            <ResultCard
              name="Style prompt"
              note="→ Suno “Style”"
              count={`${run.stylePrompt.length} / ${STYLE_LIMIT}`}
              text={run.stylePrompt}
              monospace
            />

            <IdentityCard
              bands={run.bands}
              titles={run.titles}
              albums={run.albums}
              genres={run.genres}
            />

            <ResultCard
              name="Cover-art prompt"
              note="→ image generator"
              text={run.coverArtPrompt}
            />

            {/* The image is referenced, never copied — deleting this run leaves
                it in place, so the block is simply absent when there is none. */}
            {run.coverArtId !== "" && (
              <div style={{ marginBottom: "1.4rem" }}>
                <div style={{ ...t.label, marginBottom: "0.5rem" }}>
                  Cover art
                </div>
                <img
                  src={studioCoverArtUrl(run.coverArtId)}
                  alt="Cover art"
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
                <a
                  href={studioCoverArtUrl(run.coverArtId)}
                  download={`cover-${run.coverArtId}.png`}
                  style={{
                    ...buttonStyle("secondary", { small: true }),
                    marginTop: "var(--space-3)",
                    textDecoration: "none",
                  }}
                >
                  <Icon name="download" size="14px" /> Download
                </a>
              </div>
            )}

            <div
              style={{
                borderTop: "1px solid var(--color-border)",
                paddingTop: "var(--space-4)",
                marginBottom: "var(--space-5)",
              }}
            >
              <div style={{ ...t.micro, marginBottom: "0.5rem" }}>
                Run details
              </div>
              <DetailRow label="Reference" value={run.reference} />
              <DetailRow
                label="Generated"
                value={formatRunDate(run.createdAt)}
              />
              {run.refineCount > 0 && (
                <DetailRow
                  label="Refined"
                  value={`${run.refineCount}× — only the current wording is kept`}
                />
              )}
            </div>

            <Button onClick={() => onRegenerate(run.reference)}>
              Generate this song again
            </Button>
            <p style={{ ...t.label, margin: "0.5rem 0 0" }}>
              Starts a new run — this one stays as it is.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.75rem",
        padding: "0.2rem 0",
        fontSize: "var(--text-label)",
      }}
    >
      <span style={{ ...t.label, minWidth: 92 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>
        {value}
      </span>
    </div>
  );
}
