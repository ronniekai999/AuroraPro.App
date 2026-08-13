import AuroraKit
import AuroraPlayback
import SwiftUI

struct PlaybackTarget: Identifiable {
    let mediaID: Int64
    let fileID: Int64
    /// "media" or "episode" — the direct endpoint and stream-info both need
    /// it, and a series resolves to an EPISODE file.
    let fileType: String
    /// Set for episodes; progress updates are keyed by MEDIA id with the
    /// episode in the body.
    let episodeID: Int64?
    let title: String
    let info: StreamInfo
    var id: Int64 { fileID }
}

struct PlayerView: View {
    let target: PlaybackTarget

    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var engine: (any PlaybackEngine)?
    @State private var position: Double = 0
    @State private var duration: Double = 0
    @State private var playbackState: PlaybackState = .idle
    @State private var scrubbing = false
    @State private var lastReported: Double = 0
    // Tracks only exist once the demuxer has opened the media, so they are
    // read on the transition to .playing rather than at load time.
    @State private var audioTracks: [MediaTrack] = []
    @State private var subtitleTracks: [MediaTrack] = []
    @State private var currentSubtitle: Int?
    @State private var currentAudio: Int?

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if let engine {
                    PlayerSurface(engine: engine)
                } else {
                    ProgressView().controlSize(.large)
                }
                if case .failed(let message) = playbackState {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.largeTitle).foregroundStyle(.orange)
                        Text(message)
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 40)
                    }
                }
                if playbackState == .buffering {
                    ProgressView().controlSize(.large)
                }
            }
            controls
        }
        .task { await startPlayback() }
        .onDisappear { teardown() }
    }

    private var controls: some View {
        VStack(spacing: 6) {
            Slider(
                value: $position,
                in: 0...max(duration, 1),
                onEditingChanged: { editing in
                    scrubbing = editing
                    if !editing { engine?.seek(to: position) }
                }
            )
            HStack {
                Button {
                    guard let engine else { return }
                    playbackState == .playing ? engine.pause() : engine.play()
                } label: {
                    Image(systemName: playbackState == .playing ? "pause.fill" : "play.fill")
                }
                .keyboardShortcut(.space, modifiers: [])

                Text("\(format(position)) / \(format(duration))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)

                Spacer()

                // Track pickers. Populated only by engines that can enumerate
                // them — on the direct-play path libVLC reads the embedded
                // tracks straight from the container, so a file with a dozen
                // subtitle streams is fully usable with no server involvement.
                if !subtitleTracks.isEmpty {
                    Menu {
                        Button("Off") { selectSubtitle(nil) }
                        Divider()
                        ForEach(subtitleTracks) { track in
                            Button {
                                selectSubtitle(track.id)
                            } label: {
                                HStack {
                                    Text(track.name)
                                    if currentSubtitle == track.id { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: currentSubtitle == nil
                              ? "captions.bubble" : "captions.bubble.fill")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Subtitles (\(subtitleTracks.count) available)")
                }

                if audioTracks.count > 1 {
                    Menu {
                        ForEach(audioTracks) { track in
                            Button {
                                engine?.selectAudioTrack(track.id)
                                currentAudio = track.id
                            } label: {
                                HStack {
                                    Text(track.name)
                                    if currentAudio == track.id { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "waveform")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Audio track (\(audioTracks.count) available)")
                }

                Label(
                    target.info.isDirectPlay ? "Direct Play" : "Transcoding",
                    systemImage: target.info.isDirectPlay ? "bolt.fill" : "arrow.triangle.2.circlepath"
                )
                .font(.caption)
                .foregroundStyle(target.info.isDirectPlay ? .green : .orange)

                Button("Done") {
                    Task { await reportProgress(force: true) }
                    dismiss()
                }
            }
        }
        .padding(12)
        .background(.bar)
    }

    private func startPlayback() async {
        let engine = state.engine.makeEngine()

        engine.onStateChange = { newState in
            Task { @MainActor in
                playbackState = newState
                if newState == .playing { refreshTracks() }
                if newState == .ended {
                    try? await state.client.markWatched(mediaID: target.mediaID)
                    dismiss()
                }
            }
        }
        engine.onProgress = { pos, dur in
            Task { @MainActor in
                duration = dur
                if !scrubbing { position = pos }
                await reportProgress()
            }
        }

        // Direct play fetches the ORIGINAL bytes. Anything else goes through
        // the HLS session flow, which Milestone 1 does not implement yet —
        // fail loudly rather than silently playing the wrong thing.
        guard target.info.isDirectPlay else {
            playbackState = .failed(
                """
                This title needs \(target.info.decision == "direct_stream" ? "remuxing" : "transcoding"), \
                and HLS session playback lands in Milestone 2.

                \(target.info.transcodeReason ?? "")

                Switching to the VLC engine may make this direct-play.
                """
            )
            return
        }

        var headers: [String: String] = ["User-Agent": "Aurora-macOS"]
        if let cookie = await state.client.cookieHeader() {
            headers["Cookie"] = cookie
        }

        let url = state.client.directPlayURL(fileID: target.fileID, type: target.fileType)
        engine.load(PlaybackRequest(url: url, headers: headers, startAt: 0, title: target.title))
        self.engine = engine
    }

    /// Throttled to once every 10s — the SPA reports at a similar cadence and
    /// the endpoint is a DB write, not a no-op.
    private func reportProgress(force: Bool = false) async {
        guard duration > 0 else { return }
        guard force || abs(position - lastReported) >= 10 else { return }
        lastReported = position
        try? await state.client.reportProgress(
            mediaID: target.mediaID,
            positionSeconds: position,
            durationSeconds: duration,
            episodeID: target.episodeID
        )
    }

    /// Track lists are only valid once the media is open.
    private func refreshTracks() {
        guard let engine else { return }
        audioTracks = engine.audioTracks
        subtitleTracks = engine.subtitleTracks
        currentAudio = engine.currentAudioTrack
        currentSubtitle = engine.currentSubtitleTrack
    }

    private func selectSubtitle(_ id: Int?) {
        engine?.selectSubtitleTrack(id)
        currentSubtitle = id
    }

    private func teardown() {
        engine?.stop()
        engine = nil
    }

    private func format(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let total = Int(seconds)
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0
            ? String(format: "%d:%02d:%02d", h, m, s)
            : String(format: "%d:%02d", m, s)
    }
}

/// Hosts the engine's AppKit view inside SwiftUI.
struct PlayerSurface: NSViewRepresentable {
    let engine: any PlaybackEngine

    func makeNSView(context: Context) -> NSView { engine.makeView() }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
