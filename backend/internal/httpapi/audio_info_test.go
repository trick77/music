package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// songAudio reads a song's audio fields off the API — the shape the Info tab sees.
func songAudio(t *testing.T, h http.Handler, id string) (sampleRate, channels, bitrate int) {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/songs/"+id, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("get song status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		SampleRate  int `json:"sampleRate"`
		Channels    int `json:"channels"`
		BitrateKbps int `json:"bitrateKbps"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got.SampleRate, got.Channels, got.BitrateKbps
}

// A newly uploaded song carries its audio info immediately.
// Ground truth for the fixture is ffprobe's: 44100 Hz, 2ch, 128 kbps.
func TestUpload_RecordsAudioInfo(t *testing.T) {
	dev, _ := devAndAnon(t)
	id := uploadedSongID(t, dev)

	sr, ch, br := songAudio(t, dev, id)
	if sr != 44100 || ch != 2 {
		t.Errorf("got %d Hz / %dch, want 44100 / 2", sr, ch)
	}
	if br < 127 || br > 129 {
		t.Errorf("bitrate = %d kbps, want ~128", br)
	}
}
