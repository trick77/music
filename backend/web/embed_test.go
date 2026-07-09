package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSPAHandler_servesIndex(t *testing.T) {
	rr := httptest.NewRecorder()
	SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
}

func TestSPAHandler_unknownFallsBackToIndex(t *testing.T) {
	rr := httptest.NewRecorder()
	SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", "/library", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("SPA route should serve index, status = %d", rr.Code)
	}
}
