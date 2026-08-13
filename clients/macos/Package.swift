// swift-tools-version: 5.9
import PackageDescription
import Foundation

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

// --- VLCKit, detected rather than assumed -----------------------------------
//
// libVLC is what makes direct play worth having: measured against a real file
// in the library (MKV / HEVC Main 10 / E-AC-3 / HDR), the server answers
// `direct_stream` for the Apple engine and `direct_play` for libVLC — original
// bytes, no FFmpeg, HDR preserved instead of tone-mapped.
//
// It is NOT pinned to a URL here. VideoLAN distributes VLCKit as a binary
// XCFramework whose location, version and checksum move between releases, and
// a stale hard-coded URL fails at dependency resolution — the one failure that
// says nothing about whether the code is right. Instead: drop the XCFramework
// into Frameworks/ (see README, or run scripts/fetch-vlckit.sh) and this
// manifest picks it up. Without it the package still builds and runs on the
// Apple engine, and VLCPlaybackEngine compiles out via #if canImport(VLCKit).
let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let vlcKitPath = "Frameworks/VLCKit.xcframework"
let hasVLCKit = FileManager.default.fileExists(
    atPath: packageRoot.appendingPathComponent(vlcKitPath).path
)

var playbackDependencies: [Target.Dependency] = ["AuroraKit"]
var extraTargets: [Target] = []
if hasVLCKit {
    playbackDependencies.append("VLCKit")
    extraTargets.append(.binaryTarget(name: "VLCKit", path: vlcKitPath))
}

let package = Package(
    name: "Aurora",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "AuroraKit", targets: ["AuroraKit"]),
        .library(name: "AuroraUI", targets: ["AuroraUI"]),
        .library(name: "AuroraPlayback", targets: ["AuroraPlayback"]),
        .executable(name: "Aurora", targets: ["AuroraApp"]),
    ],
    targets: [
        .target(name: "AuroraKit"),
        // Design system: tokens ported from the SPA's index.css, plus the
        // shared components every view composes from. Depends on SwiftUI
        // only — no API types — so it stays previewable in isolation.
        //
        // The fonts are RESOURCES, which is what generates Bundle.module for
        // this target; AuroraFonts.register() reads them from there.
        .target(
            name: "AuroraUI",
            resources: [.process("Resources/Fonts")]
        ),
        .target(name: "AuroraPlayback", dependencies: playbackDependencies),
        .executableTarget(name: "AuroraApp", dependencies: ["AuroraKit", "AuroraPlayback", "AuroraUI"]),
        .testTarget(name: "AuroraKitTests", dependencies: ["AuroraKit"]),
    ] + extraTargets
)
