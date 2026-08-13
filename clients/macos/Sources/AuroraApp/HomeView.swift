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
                        MediaRailView(title: "Continue Watching", items: state.continueWatching) {
                            selected = $0
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
                    Picker("Player", selection: $state.engine) {
                        ForEach(EngineKind.allCases, id: \.self) { kind in
                            Text(kind.displayName + (kind.isAvailable ? "" : " (not installed)"))
                                .tag(kind)
                        }
                    }
                    .pickerStyle(.menu)
                    // Selecting an unavailable engine would over-claim
                    // capabilities to the server; see ClientCapabilities.
                    .help("The player engine decides which files can be played without transcoding.")
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
            AsyncImage(url: state.client.imageURL(item.posterPath)) { phase in
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
                    .stroke(.white.opacity(hovering ? 0.6 : 0), lineWidth: 2)
            }
            .scaleEffect(hovering ? 1.04 : 1)
            .animation(.easeOut(duration: 0.15), value: hovering)

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
