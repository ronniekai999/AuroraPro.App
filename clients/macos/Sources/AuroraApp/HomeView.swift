import AuroraKit
import AuroraPlayback
import AuroraUI
import SwiftUI

struct HomeView: View {
    @Environment(AppState.self) private var state
    @State private var selected: MediaItem?

    var body: some View {
        @Bindable var state = state

        ZStack {
            // The tinted wash sits behind everything, once per window. This is
            // most of what separates "dark app" from Aurora.
            AuroraBackdrop()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: AuroraMetrics.sectionSpacing) {
                    if !state.continueWatching.isEmpty {
                        AuroraRail("Continue Watching") {
                            ForEach(state.continueWatching) { entry in
                                AuroraStillCard(
                                    stillURL: state.client.imageURL(
                                        entry.backdropPath ?? entry.posterPath, size: .w342
                                    ),
                                    title: entry.title,
                                    subtitle: entry.subtitle ?? timeRemaining(entry),
                                    progress: entry.fraction
                                ) {
                                    // Continue rows carry media_item_id, not a
                                    // whole MediaItem, so fetch what the sheet
                                    // needs.
                                    Task { selected = try? await state.client.media(id: entry.mediaItemId) }
                                }
                            }
                        }
                    }

                    if !state.recentlyAdded.isEmpty {
                        AuroraRail("Recently Added") {
                            ForEach(state.recentlyAdded) { item in
                                AuroraPosterCard(
                                    posterURL: state.client.imageURL(item.posterPath, size: .w342),
                                    title: item.title,
                                    caption: item.subtitleCaption ?? item.year.map(String.init),
                                    isSeries: item.type.isSeries
                                ) {
                                    selected = item
                                }
                            }
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
                .padding(.vertical, 28)
            }
            .scrollContentBackground(.hidden)

            if state.isLoading && state.recentlyAdded.isEmpty {
                ProgressView().controlSize(.large)
            }
        }
        .navigationTitle("Aurora")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                // A bare Picker rendered as an empty pill here — its label is
                // hidden in a toolbar and the selection text got clipped. An
                // explicit Menu always shows which engine is active, which
                // matters because the engine decides what can direct-play.
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
        .sheet(item: $selected) { item in
            DetailView(item: item)
                .environment(state)
                .frame(minWidth: 760, minHeight: 560)
        }
    }

    private func timeRemaining(_ entry: ContinueWatchingItem) -> String? {
        let left = max(0, entry.durationSeconds - entry.positionSeconds)
        guard left > 60 else { return nil }
        return "\(Int(left / 60)) min left"
    }
}
