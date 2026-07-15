import { useCallback, useRef, useState } from "react";

// The image types every upload surface accepts. Kept here rather than repeated
// inline so the file picker and the drop path can never disagree about what is
// allowed — IMAGE_ACCEPT feeds <input accept>, isAcceptedImage guards drops.
export const ACCEPTED_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png"];
export const IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(",");

export function isAcceptedImage(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(file.type);
}

/** Message shown when a drop is refused, so every surface words it the same. */
export const IMAGE_REJECT_MESSAGE = "Drop a JPEG or PNG image";

type Options = {
  /** Called with an accepted image. The same handler should back the file input. */
  onFile: (file: File) => void;
  /** Called instead when the drop is not a JPEG/PNG — surface it to the user. */
  onReject?: (message: string) => void;
  /** When true the zone ignores drops entirely (e.g. anonymous viewers). */
  disabled?: boolean;
};

/**
 * useImageDrop — makes any element an image drop target.
 *
 * `accept` on <input type=file> is enforced by the browser for the picker but NOT
 * for drops, so the type check has to live here: without it a dropped PDF or HEIC
 * would go straight to the server.
 *
 * `dropping` is true only while a drag carrying files is over the element, so a
 * caller can render a highlight. Depth counting keeps that flag steady — dragenter
 * and dragleave also fire when the pointer crosses child nodes, which would
 * otherwise make the highlight flicker.
 */
export function useImageDrop({ onFile, onReject, disabled }: Options) {
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);

  // Reorder drags (queue rows, playlist rows) carry no files — ignore them so
  // dragging a row across a cover never lights it up as a drop target.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const reset = useCallback(() => {
    depth.current = 0;
    setDropping(false);
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDropping(true);
  }, [disabled]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return;
    // Both dragenter and dragover must preventDefault or the drop never fires.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return;
    depth.current -= 1;
    if (depth.current <= 0) reset();
  }, [disabled, reset]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    reset();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!isAcceptedImage(file)) {
      onReject?.(IMAGE_REJECT_MESSAGE);
      return;
    }
    onFile(file);
  }, [disabled, onFile, onReject, reset]);

  return {
    /** True while an accepted-looking drag hovers the zone — render a highlight. */
    dropping,
    /** Spread onto the element that should accept drops. */
    dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
