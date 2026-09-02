package streaming

import "strings"

// Audio-language matching for the viewer's preferred spoken language.
//
// Track language tags come from ffprobe, which passes through whatever the
// container carried: Matroska mandates ISO 639-2 but muxers write both the
// bibliographic ("ger", "fre", "chi") and terminology ("deu", "fra", "zho")
// codes, MP4 files sometimes carry 639-1 ("en"), and hand-tagged files carry
// region suffixes ("en-US", "pt_BR"). The viewer's preference arrives from a
// settings menu in whatever form that menu chose. Comparing the two literally
// would make "German" fail to match half the German tracks in a real library,
// so both sides are folded onto one canonical code first.
//
// The table covers the languages a self-hosted library realistically carries;
// an unknown tag still matches itself exactly (lowercased, region stripped),
// so a preference for an uncovered language works as long as the file uses
// the same spelling.

// langAliases maps every accepted spelling onto its canonical ISO 639-2/T code.
var langAliases = map[string]string{
	"en": "eng", "eng": "eng",
	"ja": "jpn", "jp": "jpn", "jpn": "jpn",
	"es": "spa", "spa": "spa",
	"fr": "fra", "fre": "fra", "fra": "fra",
	"de": "deu", "ger": "deu", "deu": "deu",
	"it": "ita", "ita": "ita",
	"pt": "por", "por": "por",
	"ru": "rus", "rus": "rus",
	"zh": "zho", "chi": "zho", "zho": "zho",
	"ko": "kor", "kor": "kor",
	"hi": "hin", "hin": "hin",
	"ar": "ara", "ara": "ara",
	"nl": "nld", "dut": "nld", "nld": "nld",
	"sv": "swe", "swe": "swe",
	"no": "nor", "nor": "nor", "nob": "nor", "nno": "nor",
	"da": "dan", "dan": "dan",
	"fi": "fin", "fin": "fin",
	"pl": "pol", "pol": "pol",
	"tr": "tur", "tur": "tur",
	"th": "tha", "tha": "tha",
	"vi": "vie", "vie": "vie",
	"id": "ind", "ind": "ind",
	"cs": "ces", "cze": "ces", "ces": "ces",
	"el": "ell", "gre": "ell", "ell": "ell",
	"he": "heb", "heb": "heb",
	"hu": "hun", "hun": "hun",
	"ro": "ron", "rum": "ron", "ron": "ron",
	"uk": "ukr", "ukr": "ukr",
}

// normalizeLang folds a language tag onto its canonical code. "" (no tag),
// "und" (ffprobe's "undetermined") and "auto" all normalize to "", which never
// matches anything — an untagged track cannot satisfy a language preference,
// and "auto" is the settings menu's spelling of "no preference".
func normalizeLang(tag string) string {
	s := strings.ToLower(strings.TrimSpace(tag))
	if i := strings.IndexAny(s, "-_"); i >= 0 {
		s = s[:i] // en-US, pt_BR → primary subtag only
	}
	switch s {
	case "", "und", "auto", "none":
		return ""
	}
	if canonical, ok := langAliases[s]; ok {
		return canonical
	}
	return s
}
