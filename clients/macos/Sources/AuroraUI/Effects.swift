import SwiftUI

// The parts of Aurora's look that are effects rather than values: the glow
// treatment, the card fill, and the tinted backdrop. All ported from
// index.css.

/// --glow-halo, as a stack of three shadows:
///
///     0 0 0 1px  rgba(220, 200, 255, 0.14)
///     0 0 28px   rgba(168,  85, 247, 0.12)
///     0 0 56px   rgba(255, 255, 255, 0.05)
///
/// CSS's first shadow is a spread-only ring, which SwiftUI has no equivalent
/// for — it is drawn as a stroked border instead, which is what a 1px spread
/// with zero blur actually is.
public struct AuroraGlow: ViewModifier {
    public var strong: Bool
    public var radius: CGFloat

    public init(strong: Bool = false, radius: CGFloat = AuroraMetrics.radius) {
        self.strong = strong
        self.radius = radius
    }

    public func body(content: Content) -> some View {
        content
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(
                        strong ? Color.auroraGlowBorderStrong : Color.auroraGlowBorder,
                        lineWidth: 1
                    )
            }
            .shadow(color: .auroraPurple.opacity(strong ? 0.22 : 0.12), radius: 28 / 2)
            .shadow(color: .white.opacity(strong ? 0.08 : 0.05), radius: 56 / 2)
    }
}

/// --card-bg:
///     linear-gradient(180deg, rgba(28,25,42,0.55) 0%, rgba(14,12,22,0.85) 100%)
public struct AuroraCardBackground: View {
    public init() {}
    public var body: some View {
        LinearGradient(
            colors: [
                Color(.sRGB, red: 28/255, green: 25/255, blue: 42/255, opacity: 0.55),
                Color(.sRGB, red: 14/255, green: 12/255, blue: 22/255, opacity: 0.85),
            ],
            startPoint: .top, endPoint: .bottom
        )
    }
}

/// The page wash: near-black with three large radial tints over it
/// (--tint-1/2/3). This is most of what makes the web app feel cinematic
/// rather than merely dark, and its absence is most of why the Mac app read
/// as flat.
///
///     tint-1: radial(1100×700 at 70% -8%)  rgba(124, 58,237,0.22)
///     tint-2: radial( 800×600 at -5% 40%)  rgba( 30, 27, 75,0.50)
///     tint-3: radial( 900×700 at105% 85%)  rgba( 14,116,144,0.10)
///
/// SwiftUI's RadialGradient is circular, so each CSS ellipse is drawn as a
/// circle sized on its larger axis and positioned by the same unit point. At
/// these radii and opacities the difference is not perceptible; the alternative
/// is scaling an ellipse layer per tint for no visible gain.
public struct AuroraBackdrop: View {
    public init() {}

    public var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                Color.auroraBackground

                tint(
                    color: Color(.sRGB, red: 124/255, green: 58/255, blue: 237/255, opacity: 0.22),
                    center: UnitPoint(x: 0.70, y: -0.08), diameter: 1100, w: w, h: h
                )
                tint(
                    color: Color(.sRGB, red: 30/255, green: 27/255, blue: 75/255, opacity: 0.50),
                    center: UnitPoint(x: -0.05, y: 0.40), diameter: 800, w: w, h: h
                )
                tint(
                    color: Color(.sRGB, red: 14/255, green: 116/255, blue: 144/255, opacity: 0.10),
                    center: UnitPoint(x: 1.05, y: 0.85), diameter: 900, w: w, h: h
                )
            }
            .ignoresSafeArea()
        }
    }

    private func tint(color: Color, center: UnitPoint, diameter: CGFloat, w: CGFloat, h: CGFloat) -> some View {
        RadialGradient(
            gradient: Gradient(colors: [color, color.opacity(0)]),
            center: center,
            startRadius: 0,
            endRadius: diameter / 2
        )
        .frame(width: w, height: h)
        .blendMode(.plusLighter)
    }
}

/// .text-gradient — purple → light purple → purple, at 135°.
public struct AuroraTextGradient: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        // foregroundStyle takes any ShapeStyle, gradients included, and does
        // not participate in layout.
        //
        // The obvious alternatives both misbehave. Overlaying the gradient on
        // the text and then clearing the text clears the overlay too and
        // renders nothing. Masking the gradient with the text renders
        // correctly but sizes wrong: LinearGradient is GREEDY — it expands to
        // fill whatever space it is offered, and .mask() clips its appearance
        // without shrinking its frame. On the login screen that made the
        // "Aurora" title claim the entire window height and push the fields to
        // the bottom edge.
        content.foregroundStyle(
            LinearGradient(
                colors: [.auroraPurple, .auroraPurpleLight, .auroraPurple],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
        )
    }
}

public extension View {
    /// Aurora's glow treatment: a light violet hairline plus a soft purple halo.
    func auroraGlow(strong: Bool = false, radius: CGFloat = AuroraMetrics.radius) -> some View {
        modifier(AuroraGlow(strong: strong, radius: radius))
    }

    /// The tinted page backdrop. Apply once per window, behind everything.
    func auroraBackdrop() -> some View {
        background(AuroraBackdrop())
    }

    func auroraTextGradient() -> some View {
        modifier(AuroraTextGradient())
    }

    /// Horizontal page insets: --page-gutter, capped at --page-max the way
    /// `--page-pad-x: max(gutter, (100% - max) / 2)` does.
    func auroraPageInsets() -> some View {
        frame(maxWidth: AuroraMetrics.pageMax)
            .padding(.horizontal, AuroraMetrics.pageGutter)
            .frame(maxWidth: .infinity)
    }
}
