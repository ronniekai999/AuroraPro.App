import AuroraKit
import AuroraPlayback
import SwiftUI

struct DetailView: View {
    let item: MediaItem

    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var files: [MediaFile] = []
    @State private var streamInfo: StreamInfo?
    @State private var error: String?
    @State private var playing: PlaybackTarget?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if let overview = item.overview, !overview.isEmpty {
                    Text(overview).font(.body)
                }
                if let info = streamInfo {
                    PlaybackDecisionBadge(info: info, engine: state.engine)
                }
                if let error {
                    Text(error).font(.callout).foregroundStyle(.red)
                }
            }
            .padding(28)
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { dismiss() }
            }
        }
        .task { await loadFiles() }
        .sheet(item: $playing) { target in
            PlayerView(target: target)
                .environment(state)
                .frame(minWidth: 960, minHeight: 540)
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 20) {
            AsyncImage(url: state.client.imageURL(item.posterPath)) { image in
                image.resizable().aspectRatio(contentMode: .fill)
            } placeholder: {
                Rectangle().fill(.quaternary)
            }
            .frame(width: 180, height: 270)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 8) {
                Text(item.title).font(.largeTitle.weight(.bold))

                HStack(spacing: 10) {
                    if let year = item.year { Text(String(year)) }
                    if let runtime = item.runtimeMinutes { Text("\(runtime) min") }
                    if let rated = item.contentRating { Text(rated) }
                    if item.has4k == true { Tag("4K") }
                    if item.hasHdr == true { Tag("HDR") }
                }
                .font(.callout)
                .foregroundStyle(.secondary)

                if let genres = item.genres, !genres.isEmpty {
                    Text(genres.joined(separator: " · "))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                Button {
                    startPlayback()
                } label: {
                    Label("Play", systemImage: "play.fill")
                        .frame(width: 120)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(files.isEmpty)
            }
            Spacer()
        }
    }

    private func loadFiles() async {
        do {
            files = try await state.client.files(forMedia: item.id)
            if let first = files.first {
                streamInfo = try? await state.client.streamInfo(fileID: first.id)
            } else {
                error = "No playable file is attached to this title."
            }
        } catch let e as APIError {
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func startPlayback() {
        guard let file = files.first, let info = streamInfo else { return }
        playing = PlaybackTarget(
            mediaID: item.id,
            fileID: file.id,
            title: item.title,
            info: info
        )
    }
}

struct Tag: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.caption.weight(.bold))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(.tertiary, in: RoundedRectangle(cornerRadius: 4))
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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: info.isDirectPlay ? "bolt.fill" : "arrow.triangle.2.circlepath")
                    .foregroundStyle(info.isDirectPlay ? .green : .orange)
                Text(info.isDirectPlay ? "Direct Play" : label)
                    .font(.callout.weight(.semibold))
            }
            if let reason = info.transcodeReason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !info.isDirectPlay, engine == .appleNative, EngineKind.libVLC.isAvailable {
                Text("The VLC engine may be able to play this without transcoding.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }

    private var label: String {
        info.decision == "direct_stream" ? "Remuxing (no re-encode)" : "Transcoding"
    }
}
