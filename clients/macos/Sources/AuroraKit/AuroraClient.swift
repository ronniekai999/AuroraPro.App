import Foundation

/// The Aurora HTTP client.
///
/// One `URLSession` with a cookie jar, `async`/`await` throughout, and a
/// single-flight refresh so a burst of concurrent 401s produces one refresh
/// rather than N.
public actor AuroraClient {
    public let baseURL: URL
    private let session: URLSession
    private let cookies: CookieStore
    private let decoder: JSONDecoder

    /// Capabilities of the CURRENT playback engine. Not a constant: swapping
    /// engines changes what we may honestly claim, and a stale value here is
    /// how you get handed an MKV that AVPlayer cannot open.
    public private(set) var capabilities: ClientCapabilities

    /// Guards against a refresh stampede. Concurrent 401s await the same task.
    private var inFlightRefresh: Task<Bool, Never>?

    public init(baseURL: URL, capabilities: ClientCapabilities = .appleNative) {
        self.baseURL = baseURL
        self.capabilities = capabilities

        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        // Streaming a movie is not a 60-second operation, but an API call is.
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)

        self.cookies = CookieStore(baseURL: baseURL)
        self.decoder = JSONDecoder()
        self.decoder.keyDecodingStrategy = .convertFromSnakeCase
    }

    public func setCapabilities(_ caps: ClientCapabilities) {
        capabilities = caps
    }

    public func restoreSession() async {
        await cookies.restore()
    }

    public func hasPersistedSession() async -> Bool {
        await cookies.hasPersistedSession()
    }

    // MARK: - Auth

    @discardableResult
    public func login(username: String, password: String) async throws -> User? {
        let body = ["username": username, "password": password]
        let response: TokenResponse = try await post("/api/auth/login", json: body, retryOn401: false)
        await cookies.persist(for: baseURL)
        return response.user
    }

    /// Current user, or nil when the session is not valid.
    public func me() async throws -> User {
        try await get("/api/me")
    }

    public func logout() async {
        _ = try? await postRaw("/api/auth/logout", json: [String: String](), retryOn401: false)
        await cookies.clear(for: baseURL)
    }

    /// Exchanges the refresh cookie for a fresh access cookie. Returns whether
    /// the session survived.
    ///
    /// The body is deliberately empty: the handler prefers the refresh COOKIE
    /// and only falls back to a body field, and we have no token to put there
    /// (login never returned one).
    private func refresh() async -> Bool {
        do {
            _ = try await postRaw("/api/auth/refresh", json: [String: String](), retryOn401: false)
            await cookies.persist(for: baseURL)
            return true
        } catch {
            return false
        }
    }

    /// One refresh at a time, shared by every waiter.
    private func refreshOnce() async -> Bool {
        if let existing = inFlightRefresh {
            return await existing.value
        }
        let task = Task<Bool, Never> { await self.refresh() }
        inFlightRefresh = task
        let ok = await task.value
        inFlightRefresh = nil
        return ok
    }

    // MARK: - Content

    public func continueWatching() async throws -> [MediaItem] {
        try await decodeList("/api/progress/continue")
    }

    public func recentlyAdded(limit: Int = 30) async throws -> [MediaItem] {
        try await decodeList("/api/media/recent?limit=\(limit)")
    }

    public func media(id: Int64) async throws -> MediaItem {
        try await get("/api/media/\(id)")
    }

    public func files(forMedia id: Int64) async throws -> [MediaFile] {
        try await decodeList("/api/media/\(id)/files")
    }

    public func search(_ query: String) async throws -> [MediaItem] {
        let escaped = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await decodeList("/api/media/search?q=\(escaped)")
    }

    // MARK: - Playback

    /// Asks the server how to play a file, given what THIS engine can decode.
    ///
    /// The caps string is the entire input to the server's decision engine —
    /// see docs/native-client-caps.md.
    public func streamInfo(fileID: Int64, type: String = "media") async throws -> StreamInfo {
        let caps = capabilities.capsString
            .addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await get("/api/stream/info/\(fileID)?type=\(type)&caps=\(caps)")
    }

    /// URL serving the ORIGINAL file bytes, for a `direct_play` decision.
    ///
    /// Authenticated by cookie like everything else, so it can be handed
    /// straight to a player that uses the shared cookie storage. VLCKit does
    /// not share `HTTPCookieStorage`, which is why `PlaybackRequest` also
    /// carries explicit headers.
    /// `nonisolated` because it only reads `baseURL`, a `let`. SwiftUI view
    /// bodies are synchronous and cannot `await`, so a URL builder that
    /// required actor hopping would be unusable from exactly the place it is
    /// needed.
    public nonisolated func directPlayURL(fileID: Int64, type: String = "media") -> URL {
        baseURL.appending(path: "/api/stream/\(fileID)/direct")
            .appending(queryItems: [URLQueryItem(name: "type", value: type)])
    }

    /// Cookie header value for handing to a player with its own HTTP stack.
    public func cookieHeader() -> String? {
        guard let jar = session.configuration.httpCookieStorage,
              let cookies = jar.cookies(for: baseURL), !cookies.isEmpty else { return nil }
        return cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    public func reportProgress(mediaID: Int64, positionSeconds: Double, durationSeconds: Double) async throws {
        let body: [String: Any] = [
            "position_seconds": positionSeconds,
            "duration_seconds": durationSeconds,
        ]
        _ = try await putRaw("/api/progress/\(mediaID)", json: body)
    }

    public func markWatched(mediaID: Int64) async throws {
        _ = try await postRaw("/api/progress/\(mediaID)/watched", json: [String: String]())
    }

    /// Absolute URL for an artwork path returned by the API.
    /// `nonisolated` for the same reason as `directPlayURL` — every poster in
    /// every rail calls this from a synchronous view body.
    public nonisolated func imageURL(_ path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        return baseURL.appending(path: path.hasPrefix("/") ? path : "/\(path)")
    }

    // MARK: - Transport

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await send(request(path, method: "GET"))
        return try decode(data)
    }

    private func post<T: Decodable>(_ path: String, json: Any, retryOn401: Bool = true) async throws -> T {
        let data = try await postRaw(path, json: json, retryOn401: retryOn401)
        return try decode(data)
    }

    @discardableResult
    private func postRaw(_ path: String, json: Any, retryOn401: Bool = true) async throws -> Data {
        var req = request(path, method: "POST")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(req, retryOn401: retryOn401)
    }

    @discardableResult
    private func putRaw(_ path: String, json: Any) async throws -> Data {
        var req = request(path, method: "PUT")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(req)
    }

    private func request(_ path: String, method: String) -> URLRequest {
        // `path` may already carry a query string, so build by string rather
        // than `appending(path:)` — the latter percent-escapes the "?".
        let url = URL(string: path, relativeTo: baseURL) ?? baseURL
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Aurora-macOS", forHTTPHeaderField: "User-Agent")
        return req
    }

    private func send(_ req: URLRequest, retryOn401: Bool = true) async throws -> Data {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: -1, message: "Not an HTTP response")
        }

        if http.statusCode == 401, retryOn401 {
            // Single-flight: concurrent 401s share one refresh.
            if await refreshOnce() {
                return try await send(req, retryOn401: false)
            }
            await cookies.clear(for: baseURL)
            throw APIError(status: 401, message: "Session expired. Please sign in again.")
        }

        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: Self.errorMessage(from: data, status: http.statusCode))
        }

        // Any response may rotate cookies; snapshot after every success.
        await cookies.persist(for: baseURL)
        return data
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            // Surface WHICH field broke — a bare "dataCorrupted" against 50
            // DTO fields is a bad afternoon.
            throw APIError(status: -2, message: "Could not decode \(T.self): \(error)")
        }
    }

    /// Some list endpoints return a bare array, others an `{items: […]}`
    /// envelope. Callers should never have to know which.
    private func decodeList<T: Decodable & Sendable>(_ path: String) async throws -> [T] {
        let data = try await send(request(path, method: "GET"))
        if let bare = try? decoder.decode([T].self, from: data) { return bare }
        if let envelope = try? decoder.decode(PagedResponse<T>.self, from: data) {
            return envelope.itemsOrEmpty
        }
        throw APIError(status: -2, message: "Could not decode a list of \(T.self) from \(path)")
    }

    private static func errorMessage(from data: Data, status: Int) -> String {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["error", "message", "detail"] {
                if let s = obj[key] as? String, !s.isEmpty { return s }
            }
        }
        switch status {
        case 403: return "You don't have access to this."
        case 404: return "Not found."
        case 429: return "Too many active streams. Stop one and try again."
        case 500...599: return "The server had a problem (\(status))."
        default: return "Request failed (\(status))."
        }
    }
}
