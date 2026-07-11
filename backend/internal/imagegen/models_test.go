package imagegen

import (
	"slices"
	"testing"
)

func TestResolveModel(t *testing.T) {
	cases := []struct {
		name      string
		requested string
		dflt      string
		want      string
		ok        bool
	}{
		{"empty falls back to default", "", "flux-2-klein-4b", "flux-2-klein-4b", true},
		{"allowed model honored", "flux-2-pro", "flux-2-klein-4b", "flux-2-pro", true},
		{"unknown rejected", "evil/../path", "flux-2-klein-4b", "", false},
		{"operator default off-list still honored when requested", "custom-model", "custom-model", "custom-model", true},
		{"empty with off-list default returns that default", "", "custom-model", "custom-model", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ResolveModel(tc.requested, tc.dflt)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("ResolveModel(%q,%q) = (%q,%v), want (%q,%v)", tc.requested, tc.dflt, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestPickerModels_unionsOffListDefault(t *testing.T) {
	// A default already on the allowlist is not duplicated.
	got := PickerModels("flux-2-flex")
	if !slices.Equal(got, AllowedModels) {
		t.Fatalf("PickerModels(on-list) = %v, want %v", got, AllowedModels)
	}
	// An operator default off the allowlist is prepended so the UI can preselect it.
	got = PickerModels("custom-model")
	if len(got) != len(AllowedModels)+1 || got[0] != "custom-model" {
		t.Fatalf("PickerModels(off-list) = %v, want custom-model prepended", got)
	}
	if !ModelAllowed("flux-2-pro") || ModelAllowed("nope") {
		t.Fatalf("ModelAllowed mismatch")
	}
}
