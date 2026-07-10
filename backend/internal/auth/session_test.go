package auth

import (
	"strings"
	"testing"
	"time"
)

func TestSignParseSession_roundTrip(t *testing.T) {
	secret := "a-long-random-secret"
	want := Session{Username: "alice", ExpiresAt: time.Now().Add(time.Hour).Truncate(time.Second)}
	raw, err := SignSession(secret, want)
	if err != nil {
		t.Fatalf("SignSession: %v", err)
	}
	if raw == "" || !strings.Contains(raw, ".") {
		t.Fatalf("signed value looks wrong: %q", raw)
	}
	got, err := ParseSession(secret, raw)
	if err != nil {
		t.Fatalf("ParseSession: %v", err)
	}
	if got.Username != want.Username || !got.ExpiresAt.Equal(want.ExpiresAt) {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
}

func TestParseSession_rejectsTamperedPayload(t *testing.T) {
	secret := "s3cr3t"
	raw, err := SignSession(secret, Session{Username: "bob", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.SplitN(raw, ".", 2)
	// Swap the payload for a different username but keep the old signature.
	forged, _ := SignSession(secret, Session{Username: "attacker", ExpiresAt: time.Now().Add(time.Hour)})
	forgedPayload := strings.SplitN(forged, ".", 2)[0]
	tampered := forgedPayload + "." + parts[1]
	if _, err := ParseSession(secret, tampered); err == nil {
		t.Fatal("expected signature mismatch on tampered payload")
	}
}

func TestParseSession_rejectsWrongSecret(t *testing.T) {
	raw, err := SignSession("secret-one", Session{Username: "carol", ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseSession("secret-two", raw); err == nil {
		t.Fatal("expected error verifying with the wrong secret")
	}
}

func TestParseSession_rejectsExpired(t *testing.T) {
	secret := "s"
	raw, err := SignSession(secret, Session{Username: "dan", ExpiresAt: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseSession(secret, raw); err == nil {
		t.Fatal("expected error for an expired session")
	}
}

func TestParseSession_rejectsGarbage(t *testing.T) {
	for _, raw := range []string{"", "nodot", "a.b.c", "!!!.???", "."} {
		if _, err := ParseSession("s", raw); err == nil {
			t.Fatalf("expected error for garbage input %q", raw)
		}
	}
}
