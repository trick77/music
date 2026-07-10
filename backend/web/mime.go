package web

import "mime"

// Go's mime package does not map .webmanifest on every platform, which would
// make http.FileServer serve the PWA manifest with a sniffed/empty type.
// Register it explicitly so installability works.
func init() {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}
