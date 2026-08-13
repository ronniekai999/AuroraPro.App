import AppKit
import AuroraKit
import Foundation

/// Everything a player needs to start a stream.
public struct PlaybackRequest: Sendable {
    public let url: URL
    /// Headers a player with its own HTTP stack must send. VLCKit does not
    /// share `URLSession`'s cookie jar, so the auth cookie has to ride here.
    public let headers: [String: String]
    public let startAt: Double
    public let title: String

    public init(url: URL, headers: [String: String] = [:], startAt: Double = 0, title: String = "") {
        self.url = url
        self.headers = headers
        self.startAt = startAt
        self.title = title
    }
}

public enum PlaybackState: Equatable, Sendable {
    case idle
    case buffering
    case playing
    case paused
    case ended
    case failed(String)
}

/// A concrete video player.
///
/// This protocol exists because the engine determines the CAPABILITIES the app
/// may claim (see `ClientCapabilities`), and those must move together. Adding
/// an engine means adding a capability set alongside it — never reusing
/// another engine's.
///
/// `@MainActor` because both implementations touch AppKit views.
@MainActor
public protocol PlaybackEngine: AnyObject {
    /// Capabilities this engine can honestly claim to the server.
    static var capabilities: ClientCapabilities { get }
    /// Human-readable, for the UI and for diagnostics.
    static var displayName: String { get }

    var state: PlaybackState { get }
    var currentTime: Double { get }
    var duration: Double { get }

    /// The view to embed. Owned by the engine.
    func makeView() -> NSView

    func load(_ request: PlaybackRequest)
    func play()
    func pause()
    func seek(to seconds: Double)
    func setVolume(_ volume: Float)
    func stop()

    /// Called roughly once a second with (position, duration).
    var onProgress: ((Double, Double) -> Void)? { get set }
    var onStateChange: ((PlaybackState) -> Void)? { get set }
}

/// Which engine the app is running.
///
/// Milestone 1 ships `.appleNative` so the project builds with no third-party
/// dependency — the first build then tells you whether the CODE is right,
/// instead of whether SwiftPM could resolve a binary framework.
///
/// `.libVLC` is what makes Tier 1 pay off: it is the engine that can actually
/// decode the MKV/DTS/TrueHD/Hi10P files the server will now hand over
/// untranscoded.
public enum EngineKind: String, CaseIterable, Sendable {
    case appleNative
    case libVLC

    public var displayName: String {
        switch self {
        case .appleNative: return "Apple (AVFoundation)"
        case .libVLC: return "VLC (libVLC)"
        }
    }

    public var capabilities: ClientCapabilities {
        switch self {
        case .appleNative: return .appleNative
        case .libVLC: return .libVLC
        }
    }

    /// Whether this build actually has the engine compiled in.
    public var isAvailable: Bool {
        switch self {
        case .appleNative:
            return true
        case .libVLC:
            #if canImport(VLCKit)
            return true
            #else
            return false
            #endif
        }
    }

    public static var bestAvailable: EngineKind {
        allCases.last { $0.isAvailable } ?? .appleNative
    }

    @MainActor
    public func makeEngine() -> any PlaybackEngine {
        switch self {
        case .libVLC:
            #if canImport(VLCKit)
            return VLCPlaybackEngine()
            #else
            return AVPlaybackEngine()
            #endif
        case .appleNative:
            return AVPlaybackEngine()
        }
    }
}
