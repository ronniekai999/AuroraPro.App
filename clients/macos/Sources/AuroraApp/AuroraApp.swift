import AppKit
import AuroraKit
import AuroraPlayback
import AuroraUI
import SwiftUI

/// Makes `swift run Aurora` behave like a real app.
///
/// A SwiftPM executable is not a `.app` bundle, so macOS launches it with the
/// ACCESSORY activation policy: the window draws, but the process never
/// becomes the active application. It therefore never gets a key window, and
/// every keystroke — including into the login fields — is discarded. The
/// symptom looks like a broken text field; the cause is that nothing has
/// keyboard focus because nothing is frontmost.
///
/// Promoting to `.regular` and activating fixes it, and costs nothing once the
/// app IS bundled (a bundled app is already `.regular`, so these calls are
/// no-ops). Keeping them means the terminal dev loop and the packaged app
/// behave the same.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Before any view renders: an unregistered face makes SwiftUI silently
        // substitute the system font, which looks like a design problem rather
        // than a loading one.
        AuroraFonts.register()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
    }

    /// Terminal dev loop convenience: closing the window should end the
    /// process rather than leave a dockless executable running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
struct AuroraApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

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
