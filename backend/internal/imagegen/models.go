package imagegen

// AllowedModels is the single source of truth for the BFL models a user may pick
// in any image-generation UI (genre fanart, album cover, Suno cover). Each value
// becomes a URL path segment in the BFL call, so only known models are accepted;
// anything else is rejected before any upstream request. Ordered for stable
// presentation in the picker.
var AllowedModels = []string{
	"flux-2-klein-4b",
	"flux-2-flex",
	"flux-2-pro",
}

// ModelAllowed reports whether model is in the allowlist.
func ModelAllowed(model string) bool {
	for _, m := range AllowedModels {
		if m == model {
			return true
		}
	}
	return false
}

// PickerModels returns the allowlist with dflt guaranteed present: an operator
// may set BACKEND_BFL_MODEL to a model that isn't in the hardcoded list, and the
// UI must still be able to preselect it. dflt (when non-empty) is prepended if it
// isn't already in AllowedModels; order is otherwise preserved.
func PickerModels(dflt string) []string {
	if dflt == "" || ModelAllowed(dflt) {
		out := make([]string, len(AllowedModels))
		copy(out, AllowedModels)
		return out
	}
	return append([]string{dflt}, AllowedModels...)
}

// ResolveModel returns the model to use for a request: the env default when the
// requested model is empty, the request's model when it is allowed, or ok=false
// when it is a non-empty unknown model that must be rejected. A dflt off the
// hardcoded allowlist is honored (operator override), matching PickerModels.
func ResolveModel(requested, dflt string) (string, bool) {
	if requested == "" {
		return dflt, true
	}
	if requested == dflt || ModelAllowed(requested) {
		return requested, true
	}
	return "", false
}
