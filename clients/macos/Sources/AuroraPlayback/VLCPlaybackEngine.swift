#if canImport(VLCKit)
import AppKit
import AuroraKit
import VLCKit

/// libVLC-backed engine — the one that makes Tier 1 worth having.
///
/// Plays Matroska, DTS, TrueHD, PCM, Hi10P, MPEG-4 Part 2, MPEG-2 and VC-1
/// directly, so the server can hand over original bytes instead of spawning
/// FFmpeg. Claims `ClientCapabilities.libVLC`.
///
/// The whole file is behind `#if canImport(VLCKit)`, so the project builds
/// with or without the dependency and `EngineKind.libVLC.isAvailable` reports
/// the truth at runtime. Adding the dependency is documented in README.md.
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

        let media = VLCMedia(url: request.url)

        // libVLC has its own HTTP stack and never sees URLSession's cookie
        // jar, so auth must be passed explicitly or every request 401s.
        if let cookie = request.headers["Cookie"] {
            media.addOption(":http-cookies=\(cookie)")
        }
        if let agent = request.headers["User-Agent"] {
            media.addOption(":http-user-agent=\(agent)")
        }
        // Seek before the first frame rather than after: starting at 0 and
        // then seeking makes the server rebuild the transcode session on a
        // non-direct-play path.
        if request.startAt > 0 {
            media.addOption(":start-time=\(Int(request.startAt))")
        }

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

    // MARK: - VLCMediaPlayerDelegate

    public func mediaPlayerStateChanged(_ notification: Notification) {
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
            state = .failed("libVLC could not play this stream.")
        default:
            break
        }
    }

    public func mediaPlayerTimeChanged(_ notification: Notification) {
        let position = currentTime
        let total = duration
        if total > 0 { knownDuration = total }
        guard total > 0 else { return }
        onProgress?(position, total)
    }
}
#endif
