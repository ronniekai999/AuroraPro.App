import AuroraKit
import AuroraPlayback
import SwiftUI

@main
struct AuroraApp: App {
    @State private var state = AppState(
        serverURL: AppState.savedServerURL ?? URL(string: "https://aurorapro.app")!
    )

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(state)
                .frame(minWidth: 900, minHeight: 600)
                .task { await state.start() }
        }
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {} // no "New Window"
            CommandGroup(after: .toolbar) {
                Button("Reload Library") {
                    Task { await state.loadHome() }
                }
                .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        switch state.phase {
        case .launching:
            ProgressView("Connecting…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signedOut(let error):
            LoginView(error: error)
        case .signedIn:
            HomeView()
        }
    }
}
