// Package buildinfo carries the build-time identity of the binary.
//
// Version is set at link time by the release build (see backend/Containerfile,
// which passes -ldflags "-X .../internal/buildinfo.Version=$BACKEND_VERSION").
// Local builds and `go run` keep the "dev" default. It lives in its own leaf
// package rather than in main so the HTTP layer can read it without threading a
// version through config.Config or the build() signature.
package buildinfo

// Version is the semver assigned by the release workflow, or "dev" when the
// binary was not built by it.
var Version = "dev"
