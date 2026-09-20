package main

import (
	"net/http"
	"testing"
)

// ReadHeaderTimeout is the slow-loris bound: with it at zero, a client can open
// a connection, dribble headers forever, and hold a goroutine and a file
// descriptor. Asserting non-zero stops a later edit from silently reverting it.
//
// ReadTimeout and WriteTimeout must both stay ZERO, and that is not an
// oversight:
//
//   - ReadTimeout bounds the whole request including the body, and once the
//     body is read the same deadline cancels r.Context(). A legal 50 MB upload
//     (BACKEND_MAX_UPLOAD_MB) would be cut off on an ordinary uplink, and the
//     4 minute studio loop would die at the deadline.
//   - WriteTimeout would truncate the studio endpoint's text/event-stream
//     response.
func TestNewServerSetsHeaderTimeoutOnly(t *testing.T) {
	srv := newServer(":9999", http.NewServeMux())

	if srv.Addr != ":9999" {
		t.Errorf("Addr = %q, want :9999", srv.Addr)
	}
	if srv.Handler == nil {
		t.Error("Handler is nil")
	}
	if srv.ReadHeaderTimeout == 0 {
		t.Error("ReadHeaderTimeout is 0, which leaves the slow-loris hole open")
	}
	if srv.IdleTimeout == 0 {
		t.Error("IdleTimeout is 0, so keep-alive connections are never reaped")
	}
	if srv.ReadTimeout != 0 {
		t.Errorf("ReadTimeout = %v, want 0: it would cut off large uploads and cancel the studio loop", srv.ReadTimeout)
	}
	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %v, want 0: it would truncate the SSE stream", srv.WriteTimeout)
	}
}
