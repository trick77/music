// titleCase capitalizes an album or song title following the convention of its
// language. The language is auto-detected from the text (no UI selector), because
// a music library mixes English, German and French titles freely.
//
// This is a best-effort heuristic, not a dictionary: German noun detection and
// French proper-noun preservation are approximate. The button that calls this only
// fills a field — the user can still edit before saving — so occasional misses are
// cheap to correct.

export type Lang = "en" | "de" | "fr";

// Small words kept lowercase mid-title (articles, conjunctions, short prepositions).
// EN/DE follow "capitalize principal words"; FR uses sentence case and ignores these.
const SMALL: Record<Lang, Set<string>> = {
  en: new Set("a an and as at but by en for if in nor of off on or per so the to up via vs yet".split(" ")),
  de: new Set("der die das den dem des ein eine einen einem einer und oder aber im in am an auf aus bei für von vor zu zum zur über unter durch ohne um als wie dass ob".split(" ")),
  fr: new Set(), // FR is sentence-cased, no small-word list needed
};

// Function words used only for language detection (broader than SMALL, includes
// forms that would otherwise be capitalized, e.g. FR elisions handled separately).
const DETECT: Record<Lang, Set<string>> = {
  en: new Set("the of and a an to in on at for with from by is are this that".split(" ")),
  de: new Set("der die das und oder im in am ein eine mit von zu für auf aus bei nach über unter des dem den ist".split(" ")),
  fr: new Set("le la les un une des du de et ou dans sur pour avec sans que qui au aux ce cette mon ma mes est".split(" ")),
};

// capFirst uppercases the first letter of a token, skipping any leading punctuation
// so "(remastered)" → "(Remastered)" and "'round" → "'Round".
function capFirst(word: string): string {
  const m = word.match(/^([^\p{L}]*)(\p{L})(.*)$/u);
  if (!m) return word;
  return m[1] + m[2].toLocaleUpperCase() + m[3];
}

// detectLang scores the text by diacritics and function-word hits; highest wins,
// ties and no-signal fall back to English (the library's lingua franca).
export function detectLang(input: string): Lang {
  const s = input.toLowerCase();
  const score: Record<Lang, number> = { en: 0, de: 0, fr: 0 };

  // Strong character signals.
  if (/ß/.test(s)) score.de += 3;
  if (/[œç]/.test(s)) score.fr += 3;
  // FR elisions: l' d' j' qu' c' n' s' t' m'
  const elisions = s.match(/\b[ldjcnstm]['’]|qu['’]/g);
  if (elisions) score.fr += 2 * elisions.length;
  // Softer diacritic hints.
  score.de += (s.match(/[äöü]/g) || []).length;
  score.fr += (s.match(/[àèùêâîôûëïœæ]/g) || []).length;

  // Function-word hits.
  const words = s.split(/[^\p{L}]+/u).filter(Boolean);
  for (const w of words) {
    if (DETECT.de.has(w)) score.de += 2;
    if (DETECT.fr.has(w)) score.fr += 2;
    if (DETECT.en.has(w)) score.en += 2;
  }

  const best = (Object.keys(score) as Lang[]).reduce((a, b) => (score[b] > score[a] ? b : a), "en");
  return score[best] === 0 ? "en" : best;
}

// titleCase applies the detected language's casing convention. Whitespace is
// preserved exactly (split keeps the separators).
export function titleCase(input: string): string {
  if (!input.trim()) return input;
  const lang = detectLang(input);
  const tokens = input.split(/(\s+)/); // odd indices are whitespace runs

  const wordIdx = tokens.map((t, i) => (t.trim() !== "" ? i : -1)).filter((i) => i >= 0);
  const firstIdx = wordIdx[0];
  const lastIdx = wordIdx[wordIdx.length - 1];

  return tokens
    .map((tok, idx) => {
      if (tok.trim() === "") return tok;

      if (lang === "fr") {
        // Sentence case: capitalize only the first word; preserve mixed-case proper
        // nouns ("Paris", "Édith") but lowercase everything else — including ALL-CAPS
        // shouts like "VIE", which start with a capital but aren't proper nouns.
        if (idx === firstIdx) return capFirst(tok.toLocaleLowerCase());
        const isProperNoun = /^[^\p{L}]*\p{Lu}/u.test(tok) && /\p{Ll}/u.test(tok);
        return isProperNoun ? tok : tok.toLocaleLowerCase();
      }

      const lower = tok.toLocaleLowerCase();
      const core = (lower.match(/\p{L}[\p{L}\p{M}'’.-]*/u) || [lower])[0];
      const isSmall = SMALL[lang].has(core);
      if (isSmall && idx !== firstIdx && idx !== lastIdx) return lower;
      return capFirst(lower);
    })
    .join("");
}
