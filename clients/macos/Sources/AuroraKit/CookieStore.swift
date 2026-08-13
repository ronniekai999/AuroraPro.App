import Foundation
// Keychain (SecItem*) lives in Security; Foundation does not re-export it.
import Security

/// Persists Aurora's auth cookies across launches.
///
/// The server authenticates browsers and native clients the same way: `POST
/// /api/auth/login` sets httpOnly `Secure` cookies and returns **no tokens in
/// the body** (internal/models/models.go says so explicitly — "non-browser /
/// API / CLI clients must use the cookies"). So the Mac app is a cookie
/// client, and needs no server change at all.
///
/// `URLSession` will hold those cookies in memory automatically. It will not
/// reliably persist them for a non-bundled executable, and `HTTPCookieStorage`
/// on macOS writes to a plist in the app container — fine for a session
/// cookie, wrong for a long-lived refresh token. So the cookie jar is
/// round-tripped through the Keychain instead.
///
/// Only the two Aurora auth cookies are persisted; anything else the server
/// sets stays in memory for the session.
public actor CookieStore {
    private let service = "app.aurorapro.mac"
    private let account: String
    private let storage: HTTPCookieStorage

    /// Cookie names from internal/auth — the access token and the refresh
    /// token. Names are matched loosely (prefix) so a server-side rename to
    /// e.g. `__Host-aurora_access` still round-trips.
    private static let persistedPrefixes = ["aurora_access", "aurora_refresh", "__Host-aurora"]

    public init(baseURL: URL, storage: HTTPCookieStorage = .shared) {
        // Keyed by host so switching between a LAN address and the public
        // hostname doesn't cross-contaminate sessions.
        self.account = "cookies:\(baseURL.host ?? "unknown")"
        self.storage = storage
    }

    /// Load persisted cookies into the shared storage. Call once at launch,
    /// before the first request.
    public func restore() {
        guard let data = keychainRead() else { return }
        guard let raw = try? JSONDecoder().decode([CookieRecord].self, from: data) else {
            // A decode failure means a format change or corruption. Drop it —
            // the cost is one re-login, whereas leaving it wedges every launch.
            keychainDelete()
            return
        }
        for record in raw {
            if let cookie = record.toHTTPCookie() {
                storage.setCookie(cookie)
            }
        }
    }

    /// Snapshot the current auth cookies to the Keychain. Call after any
    /// response that may have rotated them (login, refresh, logout).
    public func persist(for url: URL) {
        let cookies = (storage.cookies(for: url) ?? []).filter { cookie in
            Self.persistedPrefixes.contains { cookie.name.hasPrefix($0) }
        }
        guard !cookies.isEmpty else { return }
        let records = cookies.map(CookieRecord.init(cookie:))
        guard let data = try? JSONEncoder().encode(records) else { return }
        keychainWrite(data)
    }

    /// Forget everything — used by sign-out and by a 401 that refresh could
    /// not recover.
    public func clear(for url: URL) {
        for cookie in storage.cookies(for: url) ?? [] {
            storage.deleteCookie(cookie)
        }
        keychainDelete()
    }

    public func hasPersistedSession() -> Bool { keychainRead() != nil }

    // MARK: - Keychain

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func keychainRead() -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
        return out as? Data
    }

    private func keychainWrite(_ data: Data) {
        let query = baseQuery()
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            // Session survives reboot but never leaves this Mac.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var insert = query
            insert.merge(attrs) { current, _ in current }
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    private func keychainDelete() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}

/// `HTTPCookie` is not Codable, so persist the properties that matter.
private struct CookieRecord: Codable {
    let name: String
    let value: String
    let domain: String
    let path: String
    let expiresAt: Date?
    let isSecure: Bool
    let isHTTPOnly: Bool

    init(cookie: HTTPCookie) {
        self.name = cookie.name
        self.value = cookie.value
        self.domain = cookie.domain
        self.path = cookie.path
        self.expiresAt = cookie.expiresDate
        self.isSecure = cookie.isSecure
        self.isHTTPOnly = cookie.isHTTPOnly
    }

    func toHTTPCookie() -> HTTPCookie? {
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: name,
            .value: value,
            .domain: domain,
            .path: path,
        ]
        if let expiresAt { props[.expires] = expiresAt }
        if isSecure { props[.secure] = "TRUE" }
        // HTTPOnly has no public HTTPCookiePropertyKey; it is a server-side
        // directive and irrelevant once the cookie is back in our own jar.
        return HTTPCookie(properties: props)
    }
}
