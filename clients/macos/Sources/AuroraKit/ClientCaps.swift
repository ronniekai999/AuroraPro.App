import Foundation

/// What this client can decode, in the exact vocabulary the server's
/// `ParseClientCaps` understands.
///
/// **The capability set belongs to the PLAYBACK ENGINE, not to the app.**
///
/// This is the direct consequence of the server's safety model: a client only
/// reaches a direct-play path by *naming* the capability, so naming one the
/// active engine cannot actually decode is how you get a black window instead
/// of a working transcode. The server trusts the claim completely — it has no
/// way to verify it — which makes accuracy here entirely the client's job.
///
/// Concretely: AVFoundation cannot open a Matroska container at all, so the
/// Apple-native engine must never send `mkv_container`. Swapping engines at
/// runtime therefore changes the caps string, and any cached stream decision
/// has to be re-fetched.
///
/// Contract: `docs/native-client-caps.md`. The `libVLC` set below is pinned
/// against that document by a Go test (`TestMacClientCapsMatchDocumentedContract`
/// in internal/streaming), so this file and the server cannot drift apart
/// without CI noticing — on Linux, without a Mac in the loop.
public struct ClientCapabilities: Sendable, Equatable {
    /// Comma-separated keys, sent as the `caps` query parameter.
    public let capsString: String

    public init(keys: [String]) {
        // Sorted so the string is stable across launches: the server ignores
        // order, but a stable string keeps logs and cached decisions comparable.
        self.capsString = keys.sorted().joined(separator: ",")
    }

    /// AVFoundation / AVPlayer.
    ///
    /// Roughly what Safari reports, because it is the same underlying decoder
    /// stack. No Matroska, no DTS/TrueHD/PCM, no Hi10P — claiming any of those
    /// hands us a file AVPlayer opens as a black window with no fallback.
    public static let appleNative = ClientCapabilities(keys: [
        "h264", "hevc", "hevc_main10",
        "aac", "mp3", "ac3", "eac3", "flac",
        "mp4_container",
        "hls_native",
    ])

    /// libVLC (VLCKit).
    ///
    /// The full native contract. Every key here is one libVLC decodes in
    /// software or hardware, and every one unlocks direct play of files the
    /// web app must transcode.
    ///
    /// Deliberately NOT sending `hls_js` — that is a browser flag telling the
    /// server to restrict HLS audio to what hls.js can demux. Its absence is
    /// what selects the native audio projection server-side.
    public static let libVLC = ClientCapabilities(keys: [
        // Video codecs. "h265" is deliberately omitted — the server aliases
        // it to "hevc" in ParseClientCaps, so sending both adds nothing and
        // would only be one more thing to keep in sync with the contract.
        "h264", "hevc", "vp8", "vp9", "av1",
        "mpeg4", "msmpeg4v3", "mpeg2video", "vc1",
        // Profile capabilities — separate keys, because a codec name does not
        // say what profile the decoder stops at.
        "h264_hi10", "hevc_main10",
        // Audio codecs
        "aac", "mp3", "ac3", "eac3", "flac", "opus", "vorbis",
        "dts", "truehd", "mlp", "alac", "mp2",
        "pcm_s16le", "pcm_s24le", "pcm_bluray",
        // Containers
        "mp4_container", "webm_container", "mkv_container",
        "avi_container", "ts_container",
        // Delivery
        "hls_native",
    ])
}
