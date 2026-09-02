package streaming

import (
	"strings"

	"github.com/aurora-media/aurora/internal/models"
)

// Audio-language matching for the viewer's preferred spoken language.
//
// Track language tags come from ffprobe, which passes through whatever the
// container carried: Matroska mandates ISO 639-2 but muxers write both the
// bibliographic ("ger", "fre", "chi") and terminology ("deu", "fra", "zho")
// codes, MP4 files sometimes carry 639-1 ("en"), and hand-tagged files carry
// region suffixes ("en-US", "pt_BR"). The viewer's preference arrives from a
// settings menu or a native client in whatever form that chose. Comparing the
// two literally would make "German" fail to match half the German tracks in a
// real library, so both sides are folded onto one canonical code first.
//
// The fold is the whole standard, not a shortlist (second review finding —
// the client contract promises "639-1 or 639-2 form", and a shortlist left
// fa/per/fas, nb/nob, sk/slo/slk and every uncovered 639-1↔639-2 pair
// silently unmatched): every ISO 639-1 code maps onto its 639-2/T code, the
// twenty bibliographic 639-2/B codes map onto their T twins, and a few
// spellings real tags carry map on top. An unknown tag still matches itself
// exactly (lowercased, region stripped), so a 639-3 code the tables do not
// know works as long as the file uses the same spelling.

// iso6391To6392T maps every ISO 639-1 code onto its ISO 639-2/T code.
var iso6391To6392T = map[string]string{
	"aa": "aar", "ab": "abk", "ae": "ave", "af": "afr", "ak": "aka", "am": "amh",
	"an": "arg", "ar": "ara", "as": "asm", "av": "ava", "ay": "aym", "az": "aze",
	"ba": "bak", "be": "bel", "bg": "bul", "bh": "bih", "bi": "bis", "bm": "bam",
	"bn": "ben", "bo": "bod", "br": "bre", "bs": "bos",
	"ca": "cat", "ce": "che", "ch": "cha", "co": "cos", "cr": "cre", "cs": "ces",
	"cu": "chu", "cv": "chv", "cy": "cym",
	"da": "dan", "de": "deu", "dv": "div", "dz": "dzo",
	"ee": "ewe", "el": "ell", "en": "eng", "eo": "epo", "es": "spa", "et": "est",
	"eu": "eus",
	"fa": "fas", "ff": "ful", "fi": "fin", "fj": "fij", "fo": "fao", "fr": "fra",
	"fy": "fry",
	"ga": "gle", "gd": "gla", "gl": "glg", "gn": "grn", "gu": "guj", "gv": "glv",
	"ha": "hau", "he": "heb", "hi": "hin", "ho": "hmo", "hr": "hrv", "ht": "hat",
	"hu": "hun", "hy": "hye", "hz": "her",
	"ia": "ina", "id": "ind", "ie": "ile", "ig": "ibo", "ii": "iii", "ik": "ipk",
	"io": "ido", "is": "isl", "it": "ita", "iu": "iku",
	"ja": "jpn", "jv": "jav",
	"ka": "kat", "kg": "kon", "ki": "kik", "kj": "kua", "kk": "kaz", "kl": "kal",
	"km": "khm", "kn": "kan", "ko": "kor", "kr": "kau", "ks": "kas", "ku": "kur",
	"kv": "kom", "kw": "cor", "ky": "kir",
	"la": "lat", "lb": "ltz", "lg": "lug", "li": "lim", "ln": "lin", "lo": "lao",
	"lt": "lit", "lu": "lub", "lv": "lav",
	"mg": "mlg", "mh": "mah", "mi": "mri", "mk": "mkd", "ml": "mal", "mn": "mon",
	"mr": "mar", "ms": "msa", "mt": "mlt", "my": "mya",
	"na": "nau", "nb": "nob", "nd": "nde", "ne": "nep", "ng": "ndo", "nl": "nld",
	"nn": "nno", "no": "nor", "nr": "nbl", "nv": "nav", "ny": "nya",
	"oc": "oci", "oj": "oji", "om": "orm", "or": "ori", "os": "oss",
	"pa": "pan", "pi": "pli", "pl": "pol", "ps": "pus", "pt": "por",
	"qu": "que",
	"rm": "roh", "rn": "run", "ro": "ron", "ru": "rus", "rw": "kin",
	"sa": "san", "sc": "srd", "sd": "snd", "se": "sme", "sg": "sag", "si": "sin",
	"sk": "slk", "sl": "slv", "sm": "smo", "sn": "sna", "so": "som", "sq": "sqi",
	"sr": "srp", "ss": "ssw", "st": "sot", "su": "sun", "sv": "swe", "sw": "swa",
	"ta": "tam", "te": "tel", "tg": "tgk", "th": "tha", "ti": "tir", "tk": "tuk",
	"tl": "tgl", "tn": "tsn", "to": "ton", "tr": "tur", "ts": "tso", "tt": "tat",
	"tw": "twi", "ty": "tah",
	"ug": "uig", "uk": "ukr", "ur": "urd", "uz": "uzb",
	"ve": "ven", "vi": "vie", "vo": "vol",
	"wa": "wln", "wo": "wol",
	"xh": "xho",
	"yi": "yid", "yo": "yor",
	"za": "zha", "zh": "zho", "zu": "zul",
}

// iso6392BToT maps the twenty ISO 639-2 bibliographic codes onto the
// terminology codes the table above resolves to.
var iso6392BToT = map[string]string{
	"alb": "sqi", "arm": "hye", "baq": "eus", "bur": "mya", "chi": "zho",
	"cze": "ces", "dut": "nld", "fre": "fra", "geo": "kat", "ger": "deu",
	"gre": "ell", "ice": "isl", "mac": "mkd", "mao": "mri", "may": "msa",
	"per": "fas", "rum": "ron", "slo": "slk", "tib": "bod", "wel": "cym",
}

// langExtraFolds are spellings outside the two standard tables that real
// tags carry, applied after them. Deliberate policy, not standard:
//   - "jp" is not a 639 code but is common in fan-tagged files;
//   - "cmn" (639-3 Mandarin) is what a "zh" preference means in practice;
//   - Bokmål and Nynorsk fold onto Norwegian, so one preference — "no" —
//     covers both written forms, and "nb"/"nn" match a track tagged "nor";
//   - "fil" (Filipino) folds onto Tagalog: files carry either tag for the
//     same dub, and 639-1 has only "tl".
var langExtraFolds = map[string]string{
	"jp":  "jpn",
	"cmn": "zho",
	"nob": "nor",
	"nno": "nor",
	"fil": "tgl",
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
	if t, ok := iso6391To6392T[s]; ok {
		s = t
	}
	if t, ok := iso6392BToT[s]; ok {
		s = t
	}
	if t, ok := langExtraFolds[s]; ok {
		s = t
	}
	return s
}

// preferredLanguageTrack returns the track a language preference selects
// REGARDLESS of codec — the effective default when it is in that language,
// otherwise the first track in that language — or -1 when the file has none
// (or there is no preference). It is what DecidePlaybackFor's two language
// gates share: findBestAudioTrack ranks only tracks a delivery path can play,
// and a preferred track it cannot play must withhold direct play and be
// re-encoded on the HLS path rather than passed over.
func preferredLanguageTrack(tracks []models.AudioTrack, pref string) int {
	pref = normalizeLang(pref)
	if pref == "" {
		return -1
	}
	first := -1
	for i, t := range tracks {
		if normalizeLang(t.Language) != pref {
			continue
		}
		if effectiveDefaultTrack(tracks, i) {
			return i
		}
		if first < 0 {
			first = i
		}
	}
	return first
}
