import XCTest
@testable import AuroraKit

/// Swift-side tests. These run on a Mac (`swift test`).
///
/// Note what is deliberately NOT here: the capability contract itself. That is
/// pinned server-side in `internal/streaming/macclient_caps_test.go`, which
/// reads this package's ClientCaps.swift as text — so it is enforced by Linux
/// CI on every server change, not only when someone remembers to run the Swift
/// tests. These cover what Go cannot see: decoding behavior and formatting.
final class ClientCapabilitiesTests: XCTestCase {
    func testCapsStringIsSortedAndCommaSeparated() {
        let caps = ClientCapabilities(keys: ["mkv_container", "aac", "h264"])
        XCTAssertEqual(caps.capsString, "aac,h264,mkv_container")
    }

    func testAppleNativeClaimsNoNativeOnlyCapability() {
        let apple = Set(ClientCapabilities.appleNative.capsString.split(separator: ",").map(String.init))
        // AVFoundation cannot open any of these; claiming one earns a
        // direct-play decision it would render as a black window.
        for forbidden in ["mkv_container", "avi_container", "ts_container",
                          "dts", "truehd", "mlp", "alac", "mp2",
                          "h264_hi10", "mpeg4", "mpeg2video", "vc1"] {
            XCTAssertFalse(apple.contains(forbidden), "Apple engine must not claim \(forbidden)")
        }
    }

    func testNeitherEngineSendsTheBrowserHLSFlag() {
        for caps in [ClientCapabilities.appleNative, .libVLC] {
            XCTAssertFalse(
                caps.capsString.split(separator: ",").contains("hls_js"),
                "hls_js is a browser flag; its absence selects the native audio path server-side"
            )
        }
    }

    func testLibVLCIsASupersetOfAppleNative() {
        let apple = Set(ClientCapabilities.appleNative.capsString.split(separator: ","))
        let vlc = Set(ClientCapabilities.libVLC.capsString.split(separator: ","))
        XCTAssertTrue(apple.isSubset(of: vlc))
    }
}

final class DecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: Data(json.utf8))
    }

    /// Every `omitempty` field on the Go side must be Optional here. A
    /// non-optional property for an absent field fails the WHOLE decode, which
    /// turns "this movie has no year" into "the library screen is empty".
    func testMediaItemDecodesWithOnlyRequiredFields() throws {
        let item = try decode(#"{"id":7,"library_id":1,"type":"movie","title":"Arrival"}"#, as: MediaItem.self)
        XCTAssertEqual(item.id, 7)
        XCTAssertEqual(item.title, "Arrival")
        XCTAssertNil(item.year)
        XCTAssertNil(item.posterPath)
    }

    func testUnknownMediaTypeDoesNotThrow() throws {
        let item = try decode(#"{"id":1,"library_id":1,"type":"audiobook","title":"X"}"#, as: MediaItem.self)
        XCTAssertEqual(item.type, .movie, "an unknown type should degrade, not blank the library")
    }

    /// The real envelope, copied from the handler's own `writeJSON` call
    /// (internal/api/phase2_handlers.go) rather than from an assumption about
    /// what it returns.
    ///
    /// This is the test that was missing. The original fixture decoded a BARE
    /// StreamInfo, which passed happily while the app was broken, because the
    /// server actually nests the decision under "stream". A fixture written
    /// from the endpoint would have caught it before it ever ran.
    func testStreamInfoEnvelopeMatchesTheServerShape() throws {
        let json = #"""
        {"stream":{"file_id":42,"direct_play":false,"direct_stream":true,
                   "decision":"direct_stream","stream_url":"/api/stream/media/42",
                   "container":"mkv","video_codec":"h264","audio_codec":"ac3",
                   "resolution":"1080p","duration_ms":7980000,
                   "transcode_reason":"container \"mkv\" not natively supported",
                   "reason_code":"container","audio_track_index":0,"remux":true,
                   "audio_channels":6,"audio_codec_out":"ac3"},
         "subtitles":[{"index":2,"language":"eng","codec":"subrip","title":"English"}],
         "audio_tracks":[{"index":0,"codec":"ac3","language":"eng","channels":6,"is_default":true},
                         {"index":1,"codec":"aac","language":"jpn","channels":2}],
         "markers":[]}
        """#
        let response = try decode(json, as: StreamInfoResponse.self)
        XCTAssertEqual(response.stream.decision, "direct_stream")
        XCTAssertFalse(response.stream.isDirectPlay)
        XCTAssertEqual(response.stream.summary, "Remuxing (no re-encode)")
        XCTAssertEqual(response.stream.remux, true)
        XCTAssertEqual(response.audioTracks?.count, 2)
        XCTAssertEqual(response.audioTracks?.first?.displayName, "ENG · AC3 · 6.1")
        XCTAssertEqual(response.subtitles?.first?.displayName, "English")
    }

    /// A direct-play envelope, the case the whole Tier 1 change exists for.
    func testStreamInfoEnvelopeDirectPlay() throws {
        let json = #"""
        {"stream":{"file_id":7,"direct_play":true,"direct_stream":false,
                   "decision":"direct_play","stream_url":"/api/stream/7/direct?type=media",
                   "container":"mkv","video_codec":"hevc","audio_codec":"truehd",
                   "audio_track_index":0,"audio_passthrough":true},
         "subtitles":[],"audio_tracks":[],"markers":[]}
        """#
        let response = try decode(json, as: StreamInfoResponse.self)
        XCTAssertTrue(response.stream.isDirectPlay)
        XCTAssertEqual(response.stream.summary, "Direct Play")
        XCTAssertNil(response.stream.transcodeReason)
    }

    func testStreamInfoDirectPlay() throws {
        let info = try decode(#"{"decision":"direct_play","audio_track_index":0}"#, as: StreamInfo.self)
        XCTAssertTrue(info.isDirectPlay)
        XCTAssertNil(info.transcodeReason)
    }

    func testStreamInfoTranscodeCarriesReason() throws {
        let json = #"{"decision":"transcode","transcode_reason":"container \"mkv\" not natively supported"}"#
        let info = try decode(json, as: StreamInfo.self)
        XCTAssertFalse(info.isDirectPlay)
        XCTAssertEqual(info.transcodeReason, #"container "mkv" not natively supported"#)
    }

    /// The server sets httpOnly cookies and returns no tokens in the body.
    func testTokenResponseDecodesWithoutTokens() throws {
        let json = #"{"expires_in":900,"user":{"id":1,"username":"ronnie"}}"#
        let response = try decode(json, as: TokenResponse.self)
        XCTAssertNil(response.accessToken)
        XCTAssertEqual(response.user?.username, "ronnie")
    }

    func testCaptionPrefersLLMReasonOverAnchor() throws {
        let json = #"""
        {"id":1,"library_id":1,"type":"tv","title":"Severance",
         "reason":"Because you finished Dark","nearest_anchor":{"title":"Dark","year":2017}}
        """#
        XCTAssertEqual(try decode(json, as: MediaItem.self).subtitleCaption, "Because you finished Dark")
    }

    func testCaptionFallsBackToAnchor() throws {
        let json = #"""
        {"id":1,"library_id":1,"type":"tv","title":"Severance",
         "nearest_anchor":{"title":"Dark","year":2017}}
        """#
        XCTAssertEqual(try decode(json, as: MediaItem.self).subtitleCaption, "Because you watched Dark (2017)")
    }
}
