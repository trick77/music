// Barrel for the HTTP API client. The surface was one 600-line module; it is now
// split into per-domain files (songs, playlists, genres, …) re-exported here so
// every `import { … } from "./api"` call site keeps working unchanged. Import
// from a specific domain file directly when you want a narrower dependency.
export * from "./session";
export * from "./songs";
export * from "./alignment";
export * from "./playlists";
export * from "./genres";
export * from "./artists";
export * from "./home";
export * from "./favorites";
export * from "./studio";
export * from "./albums";
