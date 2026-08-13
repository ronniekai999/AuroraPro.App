import AuroraKit
import AuroraPlayback
import SwiftUI

struct DetailView: View {
    let item: MediaItem

    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var playable: PlayableFile?
    @State private var info: StreamInfoResponse?
    @State private var error: String?
    @State private var loading = true
    @State private var playing: PlaybackTarget?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                hero
                VStack(alignment: .leading, spacing: 18) {
                    if let overview = item.overview, !overview.isEmpty {
                        Text(overview)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    playbackSection
                }
                .padding(28)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { dismiss() }
            }
        }
        .task { await load() }
        .sheet(item: $playing) { target in
            PlayerView(target: target)
                .environment(state)
                .frame(minWidth: 960, minHeight: 540)
        }
    }

    // MARK: - Hero

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            // Backdrop, dimmed, with a scrim so text stays readable.
            AsyncImage(url: state.client.backdropURL(item.backdropPath)) { phase in
                if case .success(let image) = phase {
                    image.resizable().aspectRatio(contentMode: .fill)
                } else {
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.35), .black.opacity(0.6)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                }
            }
            .frame(height: 300)
            .clipped()
            .overlay {
                LinearGradient(
                    colors: [.black.opacity(0.15), .black.opacity(0.85)],
                    startPoint: .top, endPoint: .bottom
                )
            }

            HStack(alignment: .bottom, spacing: 20) {
                AsyncImage(url: state.client.imageURL(item.posterPath, size: .w342)) { phase in
                    if case .success(let image) = phase {
                        image.resizable().aspectRatio(contentMode: .fill)
                    } else {
                        Rectangle().fill(.ultraThinMaterial)
                            .overlay { Image(systemName: "film").font(.largeTitle).foregroundStyle(.tertiary) }
                    }
                }
                .frame(width: 150, height: 225)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .shadow(color: .black.opacity(0.5), radius: 14, y: 6)

                VStack(alignment: .leading, spacing: 10) {
                    Text(item.title)
                        .font(.system(size: 34, weight: .bold))
                        .foregroundStyle(.white)
                        .shadow(radius: 6)
                        .lineLimit(2)

                    HStack(spacing: 8) {
                        if let year = item.year { Pill(String(year)) }
                        if let runtime = item.runtimeMinutes { Pill("\(runtime) min") }
                        if let rated = item.contentRating, !rated.isEmpty { Pill(rated) }
                        if item.has4k == true { Pill("4K", tinted: true) }
                        if item.hasHdr == true { Pill("HDR", tinted: true) }
                    }

                    if let genres = item.genres, !genres.isEmpty {
                        Text(genres.prefix(3).joined(separator: " · "))
                            .font(.callout)
                            .foregroundStyle(.white.opacity(0.75))
                    }

                    Button(action: play) {
                        Label("Play", systemImage: "play.fill")
                            .frame(width: 110)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!canPlay)
                    .padding(.top, 4)
                }
                Spacer(minLength: 0)
            }
            .padding(24)
        }
    }

    // MARK: - Playback state

    @ViewBuilder
    private var playbackSection: some View {
        if loading {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Checking playback…").font(.callout).foregroundStyle(.secondary)
            }
        } else if let error {
            // Errors are SHOWN, never swallowed. The previous version used
            // `try?` here, so a failed stream-info left the Play button inert
            // with nothing on screen to explain why.
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.orange)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        } else if let stream = info?.stream {
            VStack(alignment: .leading, spacing: 10) {
                if let summary = playable?.file.mediaSummary, !summary.isEmpty {
                    Text(summary)
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                }
                PlaybackDecisionBadge(info: stream, engine: state.engine, tracks: info?.audioTracks ?? [])
            }
        }
    }

    private var canPlay: Bool { info?.stream != nil }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            // Walks seasons → episodes for a series; a show holds no files of
            // its own, which previously read as "no playable file attached"
            // for every series in the library.
            guard let found = try await state.client.firstPlayableFile(for: item) else {
                error = item.type.isSeries
                    ? "No episode files were found for this series."
                    : "No playable file is attached to this title."
                return
            }
            playable = found
            info = try await state.client.streamInfo(fileID: found.file.id, type: found.type)
        } catch let e as APIError {
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func play() {
        guard let found = playable, let stream = info?.stream else { return }
        playing = PlaybackTarget(
            mediaID: item.id, fileID: found.file.id, fileType: found.type,
            episodeID: found.episodeID, title: item.title, info: stream
        )
    }
}

struct Pill: View {
    let text: String
    var tinted = false
    init(_ text: String, tinted: Bool = false) {
        self.text = text
        self.tinted = tinted
    }
    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(
                tinted ? AnyShapeStyle(Color.accentColor.opacity(0.9)) : AnyShapeStyle(.ultraThinMaterial),
                in: Capsule()
            )
            .foregroundStyle(.white)
    }
}

/// Shows what the server decided and — when it isn't direct play — why.
///
/// This is the feedback loop for the whole Tier 1 change: it makes the
/// difference between "played the original file" and "spun up FFmpeg" visible
/// instead of invisible, which is exactly what you want while validating a
/// capability contract.
struct PlaybackDecisionBadge: View {
    let info: StreamInfo
    let engine: EngineKind
    var tracks: [AudioTrack] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: info.isDirectPlay ? "bolt.fill" : "arrow.triangle.2.circlepath")
                    .foregroundStyle(info.isDirectPlay ? .green : .orange)
                Text(info.summary).font(.callout.weight(.semibold))
                Spacer()
                Text(engine.displayName).font(.caption).foregroundStyle(.tertiary)
            }
            if let reason = info.transcodeReason, !reason.isEmpty {
                Text(reason).font(.caption).foregroundStyle(.secondary)
            }
            if !info.isDirectPlay, engine == .appleNative {
                Text(EngineKind.libVLC.isAvailable
                     ? "The VLC engine can likely play this without transcoding."
                     : "Adding the VLC engine would let this play without transcoding.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if tracks.count > 1 {
                Text("\(tracks.count) audio tracks · " + tracks.prefix(3).map(\.displayName).joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }
}
