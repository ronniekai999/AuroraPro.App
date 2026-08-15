import SwiftUI

// Aurora's design tokens, ported from the SPA's source of truth:
// static/redesign/app/src/index.css
//
// This is a TRANSLATION, not a redesign. The values below are the same ones
// the web app ships, written in the same units the CSS uses so the two can be
// diffed by eye. Where the CSS says `--accent: 270 91% 65%`, the Swift says
// `hsl(270, 91, 65)`.
//
// Why it matters: before this existed the Mac app was using SwiftUI defaults —
// system blue, SF Pro, 24pt gutters — against Aurora's violet, Bricolage
// Grotesque and 48px gutters. It did not look undesigned so much as designed
// as generic macOS.

/// Builds a Color from CSS-style HSL so the token values can be copied across
/// unchanged.
///
/// NOT SwiftUI's `Color(hue:saturation:brightness:)` — that is HSB, a
/// different model that would silently shift every colour. CSS `hsl(270 91%
/// 65%)` and HSB(270, 91%, 65%) are not the same colour.
func hsl(_ h: Double, _ s: Double, _ l: Double, opacity: Double = 1) -> Color {
    let s = s / 100, l = l / 100
    let c = (1 - abs(2 * l - 1)) * s
    let hp = h / 60
    let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
    let (r1, g1, b1): (Double, Double, Double)
    switch hp {
    case ..<1: (r1, g1, b1) = (c, x, 0)
    case ..<2: (r1, g1, b1) = (x, c, 0)
    case ..<3: (r1, g1, b1) = (0, c, x)
    case ..<4: (r1, g1, b1) = (0, x, c)
    case ..<5: (r1, g1, b1) = (x, 0, c)
    default:   (r1, g1, b1) = (c, 0, x)
    }
    let m = l - c / 2
    return Color(.sRGB, red: r1 + m, green: g1 + m, blue: b1 + m, opacity: opacity)
}

public extension Color {
    // Core palette — :root in index.css
    static let auroraBackground = hsl(0, 0, 2)        // --background
    static let auroraForeground = hsl(0, 0, 100)      // --foreground
    static let auroraCard = hsl(0, 0, 6.7)            // --card
    static let auroraSecondary = hsl(0, 0, 8)         // --secondary
    static let auroraMuted = hsl(0, 0, 12)            // --muted
    static let auroraMutedForeground = hsl(0, 0, 60)  // --muted-foreground
    static let auroraBorder = hsl(0, 0, 14)           // --border
    static let auroraAccent = hsl(270, 91, 65)        // --accent / --primary / --ring
    static let auroraDestructive = hsl(0, 84, 60)     // --destructive

    /// --text-secondary: rgba(220, 220, 232, 0.65). Deliberately a separate
    /// token from mutedForeground — the CSS keeps both.
    static let auroraTextSecondary = Color(.sRGB, red: 220/255, green: 220/255, blue: 232/255, opacity: 0.65)

    // Stage accents — the cinematic palette
    static let auroraPurple = Color(hex: 0xA855F7)     // --stage-purple
    static let auroraPurpleDeep = Color(hex: 0x7C3AED) // --stage-purple-2
    static let auroraPurpleLight = Color(hex: 0xD8B4FE) // --stage-purple-lt
    static let auroraCyan = Color(hex: 0x22D3EE)       // --stage-cyan
    static let auroraStar = Color(hex: 0xFACC15)       // --stage-star

    // Glow — --glow-border / --glow-border-strong
    static let auroraGlowBorder = Color(.sRGB, red: 220/255, green: 200/255, blue: 255/255, opacity: 0.22)
    static let auroraGlowBorderStrong = Color(.sRGB, red: 220/255, green: 200/255, blue: 255/255, opacity: 0.45)

    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

/// Layout metrics. CSS px map 1:1 to SwiftUI points here — both are logical
/// units that scale with display density.
public enum AuroraMetrics {
    public static let pageGutter: CGFloat = 48   // --page-gutter
    public static let pageMax: CGFloat = 1920    // --page-max
    public static let chromeHeight: CGFloat = 64 // --chrome-h / --topnav-h
    /// --radius: 0.625rem = 10px
    public static let radius: CGFloat = 10
    public static let radiusSmall: CGFloat = 6
    public static let radiusLarge: CGFloat = 16

    /// Rail poster. 2:3 is the TMDB poster aspect.
    public static let posterWidth: CGFloat = 150
    public static let posterHeight: CGFloat = 225
    /// Continue Watching uses a 16:9 still rather than a poster.
    public static let stillWidth: CGFloat = 268
    public static let stillHeight: CGFloat = 151

    public static let railSpacing: CGFloat = 14
    public static let sectionSpacing: CGFloat = 32
}

/// The type scale, from the --fs-* tokens.
///
/// The CSS sizes are fluid (`clamp(2.5rem, min(6vw, 9vh), 5.25rem)`) because a
/// browser window can be any shape. A resizable Mac window has the same
/// problem, so `hero(for:)` reproduces the clamp against the actual view size
/// rather than freezing a single value.
public enum AuroraType {
    public static let detail: CGFloat = 56   // --fs-detail, 48–64px
    public static let browse: CGFloat = 52   // --fs-browse
    public static let page: CGFloat = 38     // --fs-page
    public static let section: CGFloat = 24  // --fs-section
    public static let rail: CGFloat = 21     // --fs-rail
    public static let body: CGFloat = 14
    public static let caption: CGFloat = 12

    /// --lh-hero / --lh-detail: 0.98. SwiftUI has no line-height multiplier,
    /// so this is applied as negative spacing where it matters.
    public static let displayLineSpacing: CGFloat = -0.02

    /// --fs-hero: clamp(2.5rem, min(6vw, 9vh), 5.25rem) → 40…84pt.
    public static func hero(for size: CGSize) -> CGFloat {
        min(max(40, min(size.width * 0.06, size.height * 0.09)), 84)
    }
}
