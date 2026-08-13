import AuroraKit
import AuroraPlayback
import SwiftUI

struct HomeView: View {
    @Environment(AppState.self) private var state
    @State private var selected: MediaItem?

    var body: some View {
        @Bindable var state = state

        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if !state.continueWatching.isEmpty {
                        ContinueRailView(items: state.continueWatching) { entry in
                            // Continue rows carry media_item_id, not a whole
                            // MediaItem, so fetch the item the sheet needs.
                            Task { selected = try? await state.client.media(id: entry.mediaItemId) }
                        }
                    }
                    if !state.recentlyAdded.isEmpty {
                        MediaRailView(title: "Recently Added", items: state.recentlyAdded) {
                            selected = $0
                        }
                    }
                    if let error = state.loadError {
                        ContentUnavailableView(
                            "Nothing to show",
                            systemImage: "film.stack",
                            description: Text(error)
                        )
                        .padding(.top, 60)
                    }
                }
                .padding(.vertical, 24)
            }
            .navigationTitle("Aurora")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    // A bare Picker rendered as an empty pill here — the label
                    // is hidden in a toolbar and the selection text got
                    // clipped. An explicit Menu label always shows which
                    // engine is active, which matters: the engine determines
                    // what can direct-play.
                    Menu {
                        ForEach(EngineKind.allCases, id: \.self) { kind in
                            Button {
                                state.engine = kind
                            } label: {
                                HStack {
                                    Text(kind.displayName)
                                    if kind == state.engine { Image(systemName: "checkmark") }
                                    if !kind.isAvailable { Text("(not installed)") }
                                }
                            }
                            .disabled(!kind.isAvailable)
                        }
                    } label: {
                        Label(state.engine == .libVLC ? "VLC" : "Apple", systemImage: "play.rectangle")
                    }
                    .help("The player engine decides which files can play without transcoding.")
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if let user = state.user {
                            Text("Signed in as \(user.username)")
                        }
                        Button("Reload") { Task { await state.loadHome() } }
                        Divider()
                        Button("Sign Out") { Task { await state.signOut() } }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            .overlay {
                if state.isLoading && state.recentlyAdded.isEmpty {
                    ProgressView()
                }
            }
        }
        .sheet(item: $selected) { item in
            DetailView(item: item)
                .environment(state)
                .frame(minWidth: 720, minHeight: 480)
        }
    }
}

/// Continue Watching, with the resume position the rows actually carry.
struct ContinueRailView: View {
    let items: [ContinueWatchingItem]
    let onSelect: (ContinueWatchingItem) -> Void

    @Environment(AppState.self) private var state
    @State private var hoveringID: Int64?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Continue Watching")
                .font(.title2.weight(.semibold))
                .padding(.horizontal, 24)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 14) {
                    ForEach(items) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            ZStack(alignment: .bottom) {
                                AsyncImage(url: state.client.imageURL(entry.backdropPath ?? entry.posterPath, size: .w342)) { phase in
                                    if case .success(let image) = phase {
                                        image.resizable().aspectRatio(contentMode: .fill)
                                    } else {
                                        Rectangle().fill(.quaternary)
                                    }
                                }
                                .frame(width: 260, height: 146)

                                // Resume bar — the whole reason this rail exists.
                                GeometryReader { geo in
                                    ZStack(alignment: .leading) {
                                        Rectangle().fill(.black.opacity(0.55))
                                        Rectangle().fill(Color.accentColor)
                                            .frame(width: geo.size.width * entry.fraction)
                                    }
                                }
                                .frame(height: 4)
                            }
                            .frame(width: 260, height: 146)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .shadow(color: .black.opacity(hoveringID == entry.id ? 0.5 : 0.25),
                                    radius: hoveringID == entry.id ? 14 : 6, y: 4)
                            .scaleEffect(hoveringID == entry.id ? 1.03 : 1)
                            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: hoveringID)

                            Text(entry.title).font(.callout).lineLimit(1)
                            Text(entry.subtitle ?? timeRemaining(entry))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .frame(width: 260)
                        .onHover { hoveringID = $0 ? entry.id : nil }
                        .onTapGesture { onSelect(entry) }
                    }
                }
                .padding(.horizontal, 24)
            }
        }
    }

    private func timeRemaining(_ entry: ContinueWatchingItem) -> String {
        let left = max(0, entry.durationSeconds - entry.positionSeconds)
        guard left > 0 else { return "" }
        return "\(Int(left / 60)) min left"
    }
}

struct MediaRailView: View {
    let title: String
    let items: [MediaItem]
    let onSelect: (MediaItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.title2.weight(.semibold))
                .padding(.horizontal, 24)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 14) {
                    ForEach(items) { item in
                        PosterCard(item: item)
                            .onTapGesture { onSelect(item) }
                    }
                }
                .padding(.horizontal, 24)
            }
        }
    }
}

struct PosterCard: View {
    let item: MediaItem
    @Environment(AppState.self) private var state
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            AsyncImage(url: state.client.imageURL(item.posterPath, size: .w342)) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().aspectRatio(contentMode: .fill)
                default:
                    // Placeholder rather than a spinner: a wall of spinners on
                    // a 40-item rail reads as broken.
                    Rectangle()
                        .fill(.quaternary)
                        .overlay {
                            Image(systemName: item.type == .movie ? "film" : "tv")
                                .font(.largeTitle)
                                .foregroundStyle(.tertiary)
                        }
                }
            }
            .frame(width: 150, height: 225)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(.white.opacity(hovering ? 0.7 : 0.08), lineWidth: hovering ? 2 : 1)
            }
            .shadow(color: .black.opacity(hovering ? 0.5 : 0.25), radius: hovering ? 14 : 6, y: hovering ? 8 : 3)
            .scaleEffect(hovering ? 1.05 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: hovering)

            Text(item.title)
                .font(.callout)
                .lineLimit(1)
            if let caption = item.subtitleCaption {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .italic()
                    .lineLimit(1)
            } else if let year = item.year {
                Text(String(year))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 150)
        .onHover { hovering = $0 }
    }
}
