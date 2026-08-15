import Foundation

// DTOs mirroring internal/models/models.go. Field names match the Go `json`
// tags exactly; the decoder is configured with .convertFromSnakeCase, so
// `poster_path` arrives as `posterPath` and needs no CodingKeys.
//
// Every field the server marks `omitempty` is Optional here. That is not
// defensive style — a non-optional Swift property for an omitempty Go field
// fails the WHOLE decode when the value is absent, which turns "this movie has
// no year" into "the library screen is empty".

/// Mirrors `models.MediaType`: the server's constants are exactly "movie" and
/// "show".
///
/// This said `tv`, which nothing ever sends — so every series decoded through
/// the unknown-value fallback and was labelled a movie. The fallback is
/// deliberate (a new server type must not blank the library) but it also hides
/// exactly this kind of mistake, so the cases have to match the Go constants
/// rather than read plausibly.
public enum MediaType: String, Codable, Sendable {
    case movie
    case show
    /// Not a `media_items.type` value — only appears where an endpoint labels
    /// a row as an episode (e.g. Continue Watching).
    case episode

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MediaType(rawValue: raw.lowercased()) ?? .movie
    }

    /// A series holds no files of its own — episodes do. Playback has to walk
    /// seasons → episodes → episode files instead of asking for /files.
    public var isSeries: Bool { self == .show }
}

public struct User: Codable, Sendable, Identifiable {
    public let id: Int64
    public let username: String
    public let email: String?
    public let role: String?
    public let avatarUrl: String?
    public let displayName: String?
}

public struct TokenResponse: Codable, Sendable {
    /// Always absent in practice — the server sets httpOnly cookies and
    /// returns no tokens in the body (see models.go). Kept because the field
    /// exists in the contract.
    public let accessToken: String?
    public let refreshToken: String?
    public let expiresIn: Int64
    public let user: User?
}

public struct AnchorRef: Codable, Sendable, Hashable {
    public let title: String
    public let year: Int?
}

public struct MediaItem: Codable, Sendable, Identifiable, Hashable {
    public let id: Int64
    public let libraryId: Int64
    public let type: MediaType
    public let title: String
    public let sortTitle: String?
    public let year: Int?
    public let overview: String?
    public let rating: Double?
    public let runtimeMinutes: Int?
    public let contentRating: String?
    public let posterPath: String?
    public let backdropPath: String?
    public let studio: String?
    public let network: String?
    public let releaseDate: String?
    public let genres: [String]?
    public let has4k: Bool?
    public let hasHdr: Bool?
    /// Transient LLM-generated caption ("Because you finished Severance").
    public let reason: String?
    public let nearestAnchor: AnchorRef?

    public static func == (a: MediaItem, b: MediaItem) -> Bool { a.id == b.id }
    public func hash(into h: inout Hasher) { h.combine(id) }

    /// "Because you watched X" caption, preferring the LLM reason like the SPA.
    public var subtitleCaption: String? {
        if let reason, !reason.isEmpty { return reason }
        if let anchor = nearestAnchor {
            return anchor.year.map { "Because you watched \(anchor.title) (\($0))" }
                ?? "Because you watched \(anchor.title)"
        }
        return nil
    }
}

/// Mirrors the shape /api/media/{id}/files actually returns.
///
/// There is no width/height — the server sends `resolution` as "1920x800".
/// `path` is never serialized (`json:"-"`). The colour fields are what make
/// HDR visible to the client: a direct-played HDR file keeps its HDR, where a
/// transcode tone-maps it to SDR, and that is worth showing.
public struct MediaFile: Codable, Sendable, Identifiable {
    public let id: Int64
    public let mediaItemId: Int64?
    public let container: String?
    public let videoCodec: String?
    public let audioCodec: String?
    public let resolution: String?
    public let versionTag: String?
    public let bitrate: Int64?
    public let durationMs: Int64?
    public let sizeBytes: Int64?
    public let videoProfile: String?
    public let videoPixFmt: String?
    public let colorTransfer: String?
    public let colorPrimaries: String?

    /// Matches the server's IsHDRColorTransfer: PQ (HDR10) or HLG.
    public var isHDR: Bool {
        guard let t = colorTransfer?.lowercased() else { return false }
        return t == "smpte2084" || t == "arib-std-b67"
    }

    public var isTenBit: Bool {
        guard let f = videoPixFmt else { return false }
        return f.contains("10") || f.contains("12")
    }

    /// "MKV · HEVC Main 10 · E-AC-3 · HDR" — the line that tells you at a
    /// glance why a file did or did not direct-play.
    public var mediaSummary: String {
        var parts: [String] = []
        if let c = container { parts.append(c.uppercased()) }
        if let v = videoCodec {
            parts.append(videoProfile.map { "\(v.uppercased()) \($0)" } ?? v.uppercased())
        }
        if let a = audioCodec { parts.append(a.uppercased()) }
        if let r = resolution { parts.append(r) }
        if isHDR { parts.append("HDR") }
        return parts.joined(separator: " · ")
    }
}

/// Response of GET /api/stream/info/{fileID}?caps=…
///
/// `decision` is the whole point of Tier 1: "direct_play" means fetch the
/// original bytes and hand them to the player.
public struct StreamInfo: Codable, Sendable {
    public let decision: String
    public let transcodeReason: String?
    public let audioTrackIndex: Int?
    public let audioPassthrough: Bool?
    public let audioCodecOut: String?
    public let videoCodecOut: String?
    public let remux: Bool?
    public let hdrTonemap: Bool?

    public var isDirectPlay: Bool { decision == "direct_play" }

    /// Human-readable summary for the UI.
    public var summary: String {
        switch decision {
        case "direct_play": return "Direct Play"
        case "direct_stream": return "Remuxing (no re-encode)"
        default: return "Transcoding"
        }
    }
}

/// GET /api/stream/info/{id} does NOT return a bare StreamInfo — it returns an
/// envelope, and the decision lives under "stream":
///
///     {"stream": {...}, "subtitles": [...], "audio_tracks": [...], "markers": [...]}
///
/// Decoding the top level as StreamInfo throws (no "decision" key), which is
/// exactly what happened: the throw was swallowed by a `try?`, leaving the
/// Play button silently inert with nothing on screen to explain it.
public struct StreamInfoResponse: Decodable, Sendable {
    public let stream: StreamInfo
    public let subtitles: [SubtitleTrack]?
    public let audioTracks: [AudioTrack]?
}

public struct SubtitleTrack: Decodable, Sendable, Identifiable {
    public let index: Int?
    public let language: String?
    public let title: String?
    public let codec: String?
    public let external: Bool?
    public let bitmap: Bool?
    public var id: Int { index ?? -1 }

    public var displayName: String {
        if let title, !title.isEmpty { return title }
        if let language, !language.isEmpty { return language.uppercased() }
        return "Track \(index ?? 0)"
    }
}

public struct AudioTrack: Decodable, Sendable, Identifiable {
    public let index: Int?
    public let codec: String?
    public let language: String?
    public let channels: Int?
    public let isDefault: Bool?
    public var id: Int { index ?? -1 }

    public var displayName: String {
        var parts: [String] = []
        if let language, !language.isEmpty { parts.append(language.uppercased()) }
        if let codec, !codec.isEmpty { parts.append(codec.uppercased()) }
        if let channels {
            parts.append(channels > 2 ? "\(channels).1" : "Stereo")
        }
        return parts.isEmpty ? "Track \(index ?? 0)" : parts.joined(separator: " · ")
    }
}

/// A row from GET /api/progress/continue (`models.ContinueWatchingItem`).
///
/// NOT a MediaItem, which is what this used to decode as. It is a progress
/// row with display fields grafted on — no `library_id`, and the media id
/// lives in `media_item_id`. The mismatch made every decode fail, and a `try?`
/// in loadHome turned that into "Continue Watching is always empty" with no
/// error anywhere.
///
/// Times are MILLISECONDS, matching the server. The client's own progress
/// reporting was sending seconds under second-suffixed keys the server does
/// not read — so every position saved as zero.
public struct ContinueWatchingItem: Decodable, Sendable, Identifiable {
    public let id: Int64
    public let mediaItemId: Int64
    public let episodeId: Int64?
    public let positionMs: Int64
    public let durationMs: Int64
    public let completed: Bool?
    public let title: String
    public let posterPath: String?
    public let backdropPath: String?
    public let type: MediaType?
    public let year: Int?
    public let rating: Double?
    public let episodeTitle: String?
    public let seasonNumber: Int?
    public let episodeNumber: Int?
    public let percentComplete: Double?

    public var positionSeconds: Double { Double(positionMs) / 1000 }
    public var durationSeconds: Double { Double(durationMs) / 1000 }

    /// 0…1 for a progress bar. Prefers the server's own percentage.
    public var fraction: Double {
        if let p = percentComplete, p > 0 { return min(1, p / 100) }
        guard durationMs > 0 else { return 0 }
        return min(1, Double(positionMs) / Double(durationMs))
    }

    /// "S2E5 · The Title" for episodes, plain title for films.
    public var subtitle: String? {
        guard let s = seasonNumber, let e = episodeNumber else { return nil }
        let code = "S\(s)E\(e)"
        if let episodeTitle, !episodeTitle.isEmpty { return "\(code) · \(episodeTitle)" }
        return code
    }
}

/// A resolved playable file plus the context the stream endpoints need.
///
/// A named type rather than a tuple: it is stored in SwiftUI @State, passed
/// between views, and has to carry the episode id so progress reporting can
/// attribute an episode correctly.
public struct PlayableFile: Sendable {
    public let file: MediaFile
    /// "media" or "episode" — required by both /api/stream/info and the
    /// direct endpoint.
    public let type: String
    /// Set when this resolved to an episode; progress updates need it, since
    /// the endpoint is keyed by MEDIA id with the episode in the body.
    public let episodeID: Int64?

    public init(file: MediaFile, type: String, episodeID: Int64? = nil) {
        self.file = file
        self.type = type
        self.episodeID = episodeID
    }
}

public struct Season: Decodable, Sendable, Identifiable {
    public let id: Int64
    public let mediaItemId: Int64
    public let seasonNumber: Int
    public let title: String?
    public let overview: String?
    public let episodeCount: Int?
}

public struct Episode: Decodable, Sendable, Identifiable {
    public let id: Int64
    public let seasonId: Int64
    public let mediaItemId: Int64
    public let episodeNumber: Int
    public let title: String?
    public let overview: String?
    public let runtimeMinutes: Int?

    public var displayTitle: String {
        let name = (title?.isEmpty == false) ? title! : "Episode \(episodeNumber)"
        return "\(episodeNumber). \(name)"
    }
}

/// A home-screen rail. The home endpoint returns these as a list.
public struct MediaRail: Codable, Sendable, Identifiable {
    public let title: String
    public let items: [MediaItem]
    public var id: String { title }
}

/// Envelope used by the paginated list endpoints.
///
/// Decodable, NOT Codable: the client only ever reads these. Requiring
/// Encodable here forced the same requirement onto every caller's generic
/// parameter, which is what broke `decodeList<T: Decodable>`.
public struct PagedResponse<T: Decodable & Sendable>: Decodable, Sendable {
    public let items: [T]?
    public let total: Int?

    /// The list endpoints are not perfectly uniform — some return a bare
    /// array, some an envelope. `AuroraClient.decodeList` handles both so
    /// callers never branch on it.
    public var itemsOrEmpty: [T] { items ?? [] }
}

public struct APIError: Error, LocalizedError, Sendable {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }

    /// The session is gone and re-login is required — distinct from a
    /// permission error, which re-login would not fix.
    public var isUnauthorized: Bool { status == 401 }
    public var isForbidden: Bool { status == 403 }
}
