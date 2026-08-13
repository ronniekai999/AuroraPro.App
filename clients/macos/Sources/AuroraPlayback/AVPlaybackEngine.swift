import AVFoundation
// AVPlayerView is AVKit, not AVFoundation.
import AVKit
import AppKit
import AuroraKit

/// AVFoundation-backed engine. Zero third-party dependencies, so the project
/// builds and runs the moment it is checked out.
///
/// Deliberately limited: AVFoundation cannot open Matroska, DTS, TrueHD, PCM,
/// or H.264 Hi10P. It claims `ClientCapabilities.appleNative`, so the server
/// transcodes those rather than handing over an original this engine would
/// fail on. That is the correct trade for a first build — and precisely the
/// limitation `VLCPlaybackEngine` removes.
@MainActor
public final class AVPlaybackEngine: NSObject, PlaybackEngine {
    public static let capabilities = ClientCapabilities.appleNative
    public static let displayName = "Apple (AVFoundation)"

    public private(set) var state: PlaybackState = .idle {
        didSet { if oldValue != state { onStateChange?(state) } }
    }
    public var onProgress: ((Double, Double) -> Void)?
    public var onStateChange: ((PlaybackState) -> Void)?

    private let player = AVPlayer()
    private lazy var playerView: AVPlayerView = {
        let view = AVPlayerView()
        view.player = player
        view.controlsStyle = .none // the app draws its own controls
        view.videoGravity = .resizeAspect
        return view
    }()

    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var pendingSeek: Double = 0

    public override init() {
        super.init()
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 1, preferredTimescale: 1),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }
            let position = time.seconds
            let total = self.duration
            guard position.isFinite, total.isFinite, total > 0 else { return }
            self.onProgress?(position, total)
        }
    }

    // No deinit: this class is @MainActor, and a deinit is nonisolated, so
    // touching `player` there is a concurrency error under Swift 5.9+.
    // Observer teardown lives in stop(), which PlayerView calls on disappear.

    public var currentTime: Double {
        let t = player.currentTime().seconds
        return t.isFinite ? t : 0
    }

    public var duration: Double {
        guard let d = player.currentItem?.duration.seconds, d.isFinite else { return 0 }
        return d
    }

    public func makeView() -> NSView { playerView }

    public func load(_ request: PlaybackRequest) {
        state = .buffering
        pendingSeek = request.startAt

        // Cookies ride as an explicit header: AVURLAsset has its own loader
        // and does not consult HTTPCookieStorage for every request shape.
        let options: [String: Any] = request.headers.isEmpty
            ? [:]
            : ["AVURLAssetHTTPHeaderFieldsKey": request.headers]

        let asset = AVURLAsset(url: request.url, options: options)
        let item = AVPlayerItem(asset: asset)

        statusObservation?.invalidate()
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            Task { @MainActor in
                guard let self else { return }
                switch item.status {
                case .readyToPlay:
                    if self.pendingSeek > 0 {
                        self.seek(to: self.pendingSeek)
                        self.pendingSeek = 0
                    }
                    self.player.play()
                    self.state = .playing
                case .failed:
                    let reason = item.error?.localizedDescription ?? "Unknown playback error"
                    // The most likely cause by far, so name it rather than
                    // leaving the user with AVFoundation's opaque -11828.
                    self.state = .failed(
                        "\(reason)\n\nAVFoundation cannot open every container. "
                        + "Switching to the VLC engine plays formats this one cannot."
                    )
                default:
                    break
                }
            }
        }

        NotificationCenter.default.addObserver(
            self, selector: #selector(didPlayToEnd),
            name: .AVPlayerItemDidPlayToEndTime, object: item
        )

        player.replaceCurrentItem(with: item)
    }

    @objc private func didPlayToEnd() { state = .ended }

    public func play() {
        player.play()
        state = .playing
    }

    public func pause() {
        player.pause()
        state = .paused
    }

    public func seek(to seconds: Double) {
        player.seek(
            to: CMTime(seconds: seconds, preferredTimescale: 600),
            toleranceBefore: .zero, toleranceAfter: .zero
        )
    }

    public func setVolume(_ volume: Float) { player.volume = volume }

    public func stop() {
        player.pause()
        if let timeObserver {
            // The periodic block retains self until removed.
            player.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
        statusObservation?.invalidate()
        statusObservation = nil
        NotificationCenter.default.removeObserver(self)
        player.replaceCurrentItem(with: nil)
        state = .idle
    }
}
