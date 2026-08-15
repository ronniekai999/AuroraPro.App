import AppKit
import CoreText
import SwiftUI

/// Bundled typefaces, registered at launch.
///
/// Both faces ship with the app (SIL OFL, licences alongside the TTFs in
/// Resources/Fonts) because matching the SPA means matching its type, and
/// neither Inter nor Bricolage Grotesque is a system font.
///
/// **The family names are not what you would guess**, which is why they are
/// read from the fonts' own name tables rather than assumed:
///
/// | file                    | family (name ID 1)                   | PostScript (ID 6)                |
/// |-------------------------|--------------------------------------|----------------------------------|
/// | InterVariable.ttf       | `Inter Variable`                     | `InterVariable`                  |
/// | BricolageGrotesque.ttf  | `Bricolage Grotesque 96pt ExtraBold` | `BricolageGrotesque-96ptExtraBold` |
///
/// Asking for "Inter" or "Bricolage Grotesque" yields nothing and SwiftUI
/// silently substitutes the system font — a failure with no error, which is
/// the worst kind. PostScript names are used throughout because they are
/// exact.
public enum AuroraFonts {
    /// PostScript names, verified against the shipped files' name tables.
    static let sansPostScript = "InterVariable"
    static let displayPostScript = "BricolageGrotesque-96ptExtraBold"

    private static var didRegister = false

    /// Registers the bundled fonts. Idempotent; call once at launch before the
    /// first view renders.
    ///
    /// Returns false if either font failed to register, in which case every
    /// helper below falls back to the system face. A missing font should make
    /// the app look wrong, never make it crash or blank.
    @discardableResult
    public static func register() -> Bool {
        guard !didRegister else { return true }
        didRegister = true

        var allOK = true
        for name in ["InterVariable", "BricolageGrotesque"] {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf") else {
                NSLog("[AuroraFonts] \(name).ttf missing from bundle")
                allOK = false
                continue
            }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                // Already-registered is benign (a second app launch in the
                // same process during tests); anything else is worth logging.
                let code = error?.takeUnretainedValue().localizedDescription ?? "unknown"
                NSLog("[AuroraFonts] could not register \(name): \(code)")
                allOK = false
            }
        }
        return allOK
    }

    /// True when the named face actually resolved. Used to decide whether to
    /// fall back rather than render Helvetica and call it Aurora.
    static func isAvailable(_ postScriptName: String) -> Bool {
        NSFont(name: postScriptName, size: 12) != nil
    }
}

public extension Font {
    /// Body/UI face — Inter. Variable wght axis defaults to 400, so `.weight()`
    /// behaves as expected.
    static func auroraSans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard AuroraFonts.isAvailable(AuroraFonts.sansPostScript) else {
            return .system(size: size, weight: weight)
        }
        return .custom(AuroraFonts.sansPostScript, fixedSize: size).weight(weight)
    }

    /// Display face — Bricolage Grotesque, for hero and title text only, which
    /// is exactly where the SPA's `.font-display` utility is applied.
    ///
    /// Note this variable font's DEFAULT instance is wght 800 / opsz 96, so it
    /// renders ExtraBold without further coaxing. That suits large titles (the
    /// SPA pairs the face with font-weight: 700) and is why no weight argument
    /// is offered — asking for a light Bricolage here would silently give you
    /// ExtraBold anyway.
    static func auroraDisplay(_ size: CGFloat) -> Font {
        guard AuroraFonts.isAvailable(AuroraFonts.displayPostScript) else {
            return .system(size: size, weight: .bold, design: .rounded)
        }
        return .custom(AuroraFonts.displayPostScript, fixedSize: size)
    }

    // Named roles, matching the --fs-* tokens.
    static var auroraSection: Font { .auroraSans(AuroraType.section, weight: .semibold) }
    static var auroraRailTitle: Font { .auroraSans(AuroraType.rail, weight: .semibold) }
    static var auroraPageTitle: Font { .auroraDisplay(AuroraType.page) }
    static var auroraBody: Font { .auroraSans(AuroraType.body) }
    static var auroraCaption: Font { .auroraSans(AuroraType.caption) }
}
