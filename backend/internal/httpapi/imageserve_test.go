package httpapi

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/media"
)

func writeTestImage(t *testing.T, store *media.Store, rel string, w, h int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 128, 255})
		}
	}
	f, err := store.Create(rel)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
}

func TestServeSizedImage_variantsDifferBySize(t *testing.T) {
	store, err := media.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writeTestImage(t, store, "covers/x.png", 2000, 2000)

	get := func(size string) []byte {
		req := httptest.NewRequest(http.MethodGet, "/api/cover/x?size="+size, nil)
		rec := httptest.NewRecorder()
		serveSizedImage(rec, req, store, "covers/x.png")
		if rec.Code != http.StatusOK {
			t.Fatalf("size %q: code %d", size, rec.Code)
		}
		return rec.Body.Bytes()
	}
	thumb, hero, full := get("thumb"), get("hero"), get("")
	if len(thumb) == 0 || len(hero) == 0 || len(full) == 0 {
		t.Fatal("empty body")
	}
	if len(thumb) >= len(hero) {
		t.Fatalf("thumb (%d) should be smaller than hero (%d)", len(thumb), len(hero))
	}
	if bytes.Equal(thumb, full) {
		t.Fatal("thumb must differ from the full original")
	}
	// Second request serves the identical cached variant.
	if !bytes.Equal(thumb, get("thumb")) {
		t.Fatal("cached thumb differs on second request")
	}
}
