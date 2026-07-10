import type { Song } from "./api";

export function addToQueue(queue: Song[], song: Song): Song[] {
  return [...queue, song];
}

export function playNext(queue: Song[], song: Song): Song[] {
  return [song, ...queue];
}

export function removeAt(queue: Song[], index: number): Song[] {
  return queue.filter((_, i) => i !== index);
}

export function reorder(queue: Song[], from: number, to: number): Song[] {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) {
    return queue;
  }
  const next = [...queue];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
