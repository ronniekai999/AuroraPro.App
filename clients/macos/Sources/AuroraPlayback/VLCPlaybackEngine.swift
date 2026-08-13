#if canImport(VLCKit)
import AppKit
import AuroraKit
import VLCKit

/// libVLC-backed engine — the one that makes Tier 1 pay off.
///
/// Measured against a real file (MKV / HEVC Main 10 / E-AC-3 / HDR), the
/// server answers `direct_stream` for the Apple engine and `direct_play` for
/// this one: original bytes, no FFmpeg, and the HDR survives instead of being
/// tone-mapped to SDR by a transcode.
///
/// The whole file is behind `#if canImport(VLCKit)`, so the project builds
/// with or without the dependency and `EngineKind.libVLC.isAvailable` reports
/// the truth at runtime. See README for adding it.
@MainActor
public final class VLCPlaybackEngine: NSObject, PlaybackEngine, VLCMediaPlayerDelegate {
    public static let capabilities = ClientCapabilities.libVLC
    public static let displayName = "VLC (libVLC)"

    public private(set) var state: PlaybackState = .idle {
        didSet { if oldValue != state { onStateChange?(state) } }
    }
    public var onProgress: ((Double, Double) -> Void)?
    public var onStateChange: ((PlaybackState) -> Void)?

    private let player = VLCMediaPlayer()
    private let videoView = NSView()
    private var pendingSeek: Double = 0
    private var knownDuration: Double = 0

    public override init() {
        super.init()
        videoView.wantsLayer = true
        videoView.layer?.backgroundColor = NSColor.black.cgColor
        player.drawable = videoView
        player.delegate = self
    }

    public var currentTime: Double {
        Double(player.time.intValue) / 1000.0
    }

    public var duration: Double {
        let fromMedia = Double(player.media?.length.intValue ?? 0) / 1000.0
        return fromMedia > 0 ? fromMedia : knownDuration
    }

    public func makeView() -> NSView { videoView }

    public func load(_ request: PlaybackRequest) {
        state = .buffering
        pendingSeek = request.startAt

        // VLCMedia's initWithURL: is nonnull (VLCMedia.h is inside
        // NS_ASSUME_NONNULL), so there is nothing to unwrap — a `guard let`
        // here does not compile.
        let media = VLCMedia(url: request.url)

        // libVLC has its own HTTP stack and never sees URLSession's cookie
        // jar, so auth must ride explicitly or every request 401s.
        if let cookie = request.headers["Cookie"] {
            media.addOption(":http-cookies=\(cookie)")
        }
        if let agent = request.headers["User-Agent"] {
            media.addOption(":http-user-agent=\(agent)")
        }
        // Seek before the first frame rather than after. On a direct-play
        // stream this is a range request; on any HLS fallback, seeking after
        // playback starts makes the server rebuild the transcode session.
        if request.startAt > 0 {
            media.addOption(":start-time=\(Int(request.startAt))")
        }
        // Network caching: 1s is VLC's default and is tuned for lossy
        // networks. A media server is usually a LAN or a good WAN link, and
        // the extra buffer just delays first frame.
        media.addOption(":network-caching=1500")

        player.media = media
        player.play()
    }

    public func play() {
        player.play()
        state = .playing
    }

    public func pause() {
        player.pause()
        state = .paused
    }

    public func seek(to seconds: Double) {
        player.time = VLCTime(int: Int32(seconds * 1000))
    }

    public func setVolume(_ volume: Float) {
        player.audio?.volume = Int32(max(0, min(1, volume)) * 100)
    }

    public func stop() {
        player.stop()
        state = .idle
    }

    // MARK: - Tracks
    //
    // VLCKit exposes these as parallel [Any] arrays of NSNumber/NSString
    // bridged from Objective-C, so every read is defensive: a version bump
    // that changes the element type must degrade to "no tracks", never trap.
    // Track ids are libVLC's own — NOT the server's ffmpeg stream indices.

    public var audioTracks: [MediaTrack] {
        zipTracks(indexes: player.audioTrackIndexes, names: player.audioTrackNames)
            // -1 is libVLC's "disabled" pseudo-track; a file always has audio
            // if it is playing, so offering "off" here is just confusing.
            .filter { $0.id >= 0 }
    }

    public var subtitleTracks: [MediaTrack] {
        zipTracks(indexes: player.videoSubTitlesIndexes, names: player.videoSubTitlesNames)
            .filter { $0.id >= 0 }
    }

    public var currentAudioTrack: Int? {
        let i = Int(player.currentAudioTrackIndex)
        return i >= 0 ? i : nil
    }

    public var currentSubtitleTrack: Int? {
        let i = Int(player.currentVideoSubTitleIndex)
        return i >= 0 ? i : nil
    }

    public func selectAudioTrack(_ id: Int) {
        player.currentAudioTrackIndex = Int32(id)
    }

    public func selectSubtitleTrack(_ id: Int?) {
        // -1 disables subtitles in libVLC.
        player.currentVideoSubTitleIndex = Int32(id ?? -1)
    }

    private func zipTracks(indexes: [Any]?, names: [Any]?) -> [MediaTrack] {
        guard let indexes, let names, indexes.count == names.count else { return [] }
        return zip(indexes, names).compactMap { rawIndex, rawName in
            guard let id = (rawIndex as? NSNumber)?.intValue else { return nil }
            let name = (rawName as? String) ?? "Track \(id)"
            return MediaTrack(id: id, name: name)
        }
    }

    // MARK: - VLCMediaPlayerDelegate
    //
    // VLCMediaPlayerDelegate is a nonisolated Objective-C protocol, so a
    // @MainActor method cannot satisfy it (a warning today, an error in Swift
    // 6). The two candidate fixes are not equivalent:
    //
    //   @preconcurrency on the conformance ASSERTS these arrive on the main
    //   thread and traps at runtime if they do not. VLCKit's headers document
    //   what each callback carries but never which thread posts it, so that
    //   would be asserting something unverified.
    //
    //   nonisolated + an explicit hop is correct whichever thread libVLC uses,
    //   at the cost of one enqueue per event.
    //
    // The hop is taken. Note both handlers re-read live state (player.state,
    // currentTime) instead of capturing it at notification time, so even if
    // two hops land out of order the result is still the current truth rather
    // than a stale value applied late.

    public nonisolated func mediaPlayerStateChanged(_ aNotification: Notification) {
        Task { @MainActor in self.handleStateChanged() }
    }

    public nonisolated func mediaPlayerTimeChanged(_ aNotification: Notification) {
        Task { @MainActor in self.handleTimeChanged() }
    }

    private func handleStateChanged() {
        switch player.state {
        case .playing:
            state = .playing
            if pendingSeek > 0 {
                seek(to: pendingSeek)
                pendingSeek = 0
            }
        case .paused:
            state = .paused
        case .buffering, .opening:
            state = .buffering
        case .stopped, .ended:
            state = .ended
        case .error:
            state = .failed(
                "libVLC could not play this stream. If this is a direct play, "
                + "the file may be unreadable by the server."
            )
        default:
            break
        }
    }

    private func handleTimeChanged() {
        let position = currentTime
        let total = duration
        if total > 0 { knownDuration = total }
        guard total > 0 else { return }
        onProgress?(position, total)
    }
}
#endif
