import AuroraKit
import AuroraPlayback
import Foundation
import Observation

/// UserDefaults keys live outside AppState on purpose: a `static let` inside a
/// `@MainActor` type is itself MainActor-isolated, so the nonisolated
/// initializer could not read one.
enum DefaultsKey {
    static let server = "aurora.serverURL"
    static let engine = "aurora.engine"
}

/// App-wide state: server, session, engine, and the home content.
@MainActor
@Observable
public final class AppState {
    public enum Phase: Equatable {
        case launching
        case signedOut(error: String?)
        case signedIn
    }

    public private(set) var phase: Phase = .launching
    public private(set) var user: User?
    public private(set) var continueWatching: [ContinueWatchingItem] = []
    public private(set) var recentlyAdded: [MediaItem] = []
    public private(set) var loadError: String?
    public private(set) var isLoading = false

    public private(set) var client: AuroraClient
    public private(set) var serverURL: URL

    /// Chosen engine. Changing it re-derives the capability string sent to the
    /// server — they are one decision, not two (see ClientCapabilities).
    public var engine: EngineKind {
        didSet {
            guard engine != oldValue else { return }
            UserDefaults.standard.set(engine.rawValue, forKey: DefaultsKey.engine)
            let caps = engine.capabilities
            Task { await client.setCapabilities(caps) }
        }
    }

    public nonisolated static var savedServerURL: URL? {
        UserDefaults.standard.string(forKey: DefaultsKey.server).flatMap(URL.init(string:))
    }

    /// Stays MainActor-isolated, like the rest of the class.
    ///
    /// An earlier version marked this `nonisolated` to make
    /// `@State private var state = AppState(...)` work in the App struct. That
    /// was both wrong and unnecessary: Swift counts the assignments below as
    /// mutations of MainActor-isolated properties, so a nonisolated init
    /// cannot perform them — and SwiftUI's `App` protocol is itself
    /// `@MainActor`, so the conforming struct's property initializers are
    /// already on the main actor and can call this directly.
    public init(serverURL: URL) {
        self.serverURL = serverURL
        let saved = UserDefaults.standard.string(forKey: DefaultsKey.engine)
            .flatMap(EngineKind.init(rawValue:))
        // Never silently fall back to an engine this build lacks: the caps
        // string would then over-claim and the server would hand over files
        // the player cannot open.
        let resolved = (saved?.isAvailable == true) ? saved! : EngineKind.bestAvailable
        self.engine = resolved
        self.client = AuroraClient(baseURL: serverURL, capabilities: resolved.capabilities)
    }

    /// Restore a persisted session, if there is one.
    public func start() async {
        await client.restoreSession()
        guard await client.hasPersistedSession() else {
            phase = .signedOut(error: nil)
            return
        }
        do {
            user = try await client.me()
            phase = .signedIn
            await loadHome()
        } catch {
            // A stale cookie is the common case here, not a real failure —
            // don't greet the user with an error for it.
            phase = .signedOut(error: nil)
        }
    }

    public func signIn(username: String, password: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            user = try await client.login(username: username, password: password)
            if user == nil { user = try? await client.me() }
            phase = .signedIn
            await loadHome()
        } catch let error as APIError {
            phase = .signedOut(error: error.message)
        } catch {
            phase = .signedOut(error: error.localizedDescription)
        }
    }

    public func signOut() async {
        await client.logout()
        user = nil
        continueWatching = []
        recentlyAdded = []
        phase = .signedOut(error: nil)
    }

    public func changeServer(to url: URL) async {
        UserDefaults.standard.set(url.absoluteString, forKey: DefaultsKey.server)
        serverURL = url
        client = AuroraClient(baseURL: url, capabilities: engine.capabilities)
        await start()
    }

    public func loadHome() async {
        isLoading = true
        loadError = nil
        defer { isLoading = false }

        // Concurrent, and one rail failing must not blank the other — a
        // brand-new account has no continue-watching but plenty of library.
        // `async let` still needs an explicit `await` on the call itself when
        // the expression is wrapped in `try?`.
        async let continuing = try? await client.continueWatching()
        async let recent = try? await client.recentlyAdded()

        continueWatching = (await continuing) ?? []
        recentlyAdded = (await recent) ?? []

        if continueWatching.isEmpty && recentlyAdded.isEmpty {
            loadError = "No titles came back. Check that the server has a scanned library."
        }
    }
}
