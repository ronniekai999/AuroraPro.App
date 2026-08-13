// swift-tools-version: 5.9
import PackageDescription

// Aurora's native macOS client.
//
// Deliberately a SwiftPM package rather than a checked-in .xcodeproj: `swift
// build` / `swift test` run from the terminal with no Xcode project state to
// drift, and the pure-logic targets (AuroraKit) stay testable without a UI
// host. See README.md for turning this into a distributable .app.
//
// macOS 14 is the floor, for @Observable and the modern SwiftUI navigation
// stack. Lowering it means reverting AppState to ObservableObject/@Published;
// nothing else here depends on 14.
let package = Package(
    name: "Aurora",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "AuroraKit", targets: ["AuroraKit"]),
        .library(name: "AuroraPlayback", targets: ["AuroraPlayback"]),
        .executable(name: "Aurora", targets: ["AuroraApp"]),
    ],
    dependencies: [
        // Intentionally empty for Milestone 1.
        //
        // The app builds and runs with zero third-party code, so the first
        // build cannot fail on dependency resolution — the one failure mode
        // that tells you nothing about whether the code is right. VLCKit
        // arrives in the same milestone as a second engine behind
        // PlaybackEngine; see AuroraPlayback/VLCPlaybackEngine.swift.
    ],
    targets: [
        .target(name: "AuroraKit"),
        .target(name: "AuroraPlayback", dependencies: ["AuroraKit"]),
        .executableTarget(name: "AuroraApp", dependencies: ["AuroraKit", "AuroraPlayback"]),
        .testTarget(name: "AuroraKitTests", dependencies: ["AuroraKit"]),
    ]
)
