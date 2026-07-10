// Minimal service worker: installability only, no offline caching (spec §15a).
// It claims clients so the app is controlled and installable, but does not
// intercept fetches — everything is served fresh from the origin.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
