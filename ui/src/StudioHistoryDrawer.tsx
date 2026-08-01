import { useCallback, useEffect, useState } from "react";
import { listStudioHistory, deleteStudioRun, type StudioRun } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Spinner, t } from "./ui";
import { useEscape } from "./useEscape";
import { groupRuns, runLabel } from "./studioHistoryGroups";

// PAGE_SIZE is the server's own page size, repeated here only for the button
// label ("Show 25 more"). The cursor, not this number, decides what comes back.
const PAGE_SIZE = 25;

type Props = {
  onClose: () => void;
  // onOpen hands the chosen run's id up; the parent owns the read-only view, so
  // the drawer never has to know what opening a run looks like.
  onOpen: (id: string) => void;
  // The run on screen, if there is one. Decision 3: it is filtered out of the
  // list at render time — never at fetch time, so the header count stays the
  // server's honest total.
  currentRunId?: string;
};

// StudioHistoryDrawer lists every finished Studio run, newest first, and lets one
// be opened or deleted. Panel geometry follows QueueDrawer (fixed right, 340px,
// Escape closes); the scrim is the one AddToPlaylist uses, which QueueDrawer
// predates and lacks.
export function StudioHistoryDrawer({ onClose, onOpen, currentRunId }: Props) {
  const [runs, setRuns] = useState<StudioRun[]>([]);
  const [total, setTotal] = useState(0);
  const [nextBefore, setNextBefore] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<StudioRun | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEscape(true, onClose);

  // load fetches one page. `before` of 0 is the first page and replaces what is
  // on screen; a real cursor appends, which is what makes "Show more" additive
  // rather than a jump.
  const load = useCallback(async (before: number) => {
    setLoading(true);
    setError("");
    try {
      const page = await listStudioHistory(before || undefined);
      setRuns((prev) => (before ? [...prev, ...page.runs] : page.runs));
      setTotal(page.total);
      setNextBefore(page.nextBefore);
    } catch {
      setError("Could not load history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteStudioRun(pendingDelete.id);
      setRuns((prev) => prev.filter((r) => r.id !== pendingDelete.id));
      setTotal((n) => Math.max(0, n - 1));
      setPendingDelete(null);
    } catch {
      setDeleteError("Could not delete this run.");
    } finally {
      setDeleting(false);
    }
  };

  const visible = runs.filter((r) => r.id !== currentRunId);
  const groups = groupRuns(visible, new Date());

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          // Above the player dock (PlayerBar is zIndex 60), not below it. A
          // fixed, z-indexed scrim starts its own stacking context, so the
          // panel's z-index would be measured inside this one — taking
          // QueueDrawer's 60 for the panel and AddToPlaylist's 50 for the scrim
          // would put the whole drawer under the dock and hide its footer.
          zIndex: 70,
          background: "rgba(0,0,0,0.5)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Studio history"
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: 340,
            maxWidth: "90vw",
            background: "var(--color-panel)",
            borderLeft: "1px solid var(--color-border)",
            padding: "1rem",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "0.75rem",
              gap: "0.5rem",
            }}
          >
            <h3 style={{ margin: 0, ...t.title }}>
              History
              {/* The count is what the server holds, so it stays honest while
                  the live run is filtered out of the rows below. It is dropped
                  entirely when there is nothing to show, or the header would
                  read "1 run" directly above "Nothing here yet." */}
              {total > 0 && visible.length > 0 && (
                <span
                  style={{
                    ...t.label,
                    fontFamily: "var(--font-sans)",
                    marginLeft: "0.5rem",
                  }}
                >
                  {total} {total === 1 ? "run" : "runs"}
                </span>
              )}
            </h3>
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
                fontSize: "var(--text-label)",
                margin: "0.5rem 0",
              }}
            >
              {error}
            </p>
          )}

          {loading && runs.length === 0 && (
            <div
              aria-busy="true"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                ...t.label,
              }}
            >
              <Spinner size="16px" />
              <span>Loading</span>
            </div>
          )}

          {/* "Nothing here yet" only when there is genuinely nothing left to
              fetch: deleting every row of the page on screen empties `visible`
              while the server still holds later pages. */}
          {!loading &&
            error === "" &&
            visible.length === 0 &&
            nextBefore === 0 && (
              <p style={{ ...t.label, lineHeight: 1.6, margin: 0 }}>
                Nothing here yet. Generate a song and it will be kept so you can
                come back to it.
              </p>
            )}

          <div style={{ flex: 1 }}>
            {groups.map((group) => (
              <div key={group.label} style={{ marginBottom: "0.75rem" }}>
                <div style={{ ...t.micro, margin: "0.6rem 0 0.35rem" }}>
                  {group.label}
                </div>
                {group.runs.map((run) => (
                  <HistoryRow
                    key={run.id}
                    run={run}
                    onOpen={onOpen}
                    onDelete={() => {
                      setDeleteError("");
                      setPendingDelete(run);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* The footer also stays up when the page on screen has been emptied
              but a cursor remains, or "Show 25 more" would vanish and the rest
              of the history would be unreachable until the drawer is reopened. */}
          {(visible.length > 0 || nextBefore !== 0) && (
            <div
              style={{
                borderTop: "1px solid var(--color-border)",
                paddingTop: "0.7rem",
                marginTop: "0.3rem",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.5rem",
              }}
            >
              <span style={{ ...t.label, fontVariantNumeric: "tabular-nums" }}>
                {visible.length} of {total}
              </span>
              {nextBefore !== 0 && (
                <button
                  onClick={() => load(nextBefore)}
                  disabled={loading}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--color-accent-text)",
                    fontFamily: "var(--font-sans)",
                    fontSize: "var(--text-label)",
                    fontWeight: 500,
                    cursor: loading ? "default" : "pointer",
                  }}
                >
                  {loading ? "Loading" : `Show ${PAGE_SIZE} more`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Deliberately a sibling of the scrim, not a child of it: ConfirmDialog's
          own backdrop does not stop propagation, so nested inside the scrim a
          backdrop click would cancel the confirm AND bubble into onClose —
          closing the drawer, and doing it even mid-delete, when the dialog is
          specifically swallowing the cancel. */}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete this run?"
          message={
            <>
              “{runLabel(pendingDelete).title}” will be removed from history.
              Any cover art it produced is kept.
            </>
          }
          confirmLabel="Delete"
          danger
          busy={deleting}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );
}

// HistoryRow is one saved run: a button so the accessible name is the run's title
// and a keyboard user can reach it, with the delete sitting outside that button
// (nesting one button inside another is invalid and swallows the click).
function HistoryRow({
  run,
  onOpen,
  onDelete,
}: {
  run: StudioRun;
  onOpen: (id: string) => void;
  onDelete: () => void;
}) {
  const { title, subtitle } = runLabel(run);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.4rem",
        padding: "0.15rem 0",
      }}
    >
      <button
        onClick={() => onOpen(run.id)}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: "left",
          background: "none",
          border: "none",
          padding: "0.3rem 0",
          color: "var(--color-ink)",
          cursor: "pointer",
          fontFamily: "var(--font-sans)",
        }}
      >
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            ...t.ui,
          }}
        >
          {title}
        </span>
        {subtitle !== "" && (
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              ...t.label,
            }}
          >
            {subtitle}
          </span>
        )}
      </button>
      <button
        aria-label={`Delete ${title}`}
        onClick={onDelete}
        style={{
          background: "none",
          border: "none",
          color: "var(--color-muted)",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          padding: 4,
        }}
      >
        <Icon name="trash" size="16px" />
      </button>
    </div>
  );
}
