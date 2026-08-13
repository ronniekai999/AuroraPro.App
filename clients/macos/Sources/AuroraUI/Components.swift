import SwiftUI

// The shared component layer.
//
// These take primitives (URL, String, Double) rather than API models, so
// AuroraUI depends on nothing but SwiftUI. That keeps the design system
// previewable and testable on its own, and stops view code and transport code
// growing into each other.
//
// The timing argument for building this now rather than later: there are five
// views today and roughly twenty more on the roadmap. Every one of those
// composes from these instead of open-coding a poster card for the sixth time.

/// Artwork with a stable placeholder.
///
/// A placeholder rather than a spinner on purpose — forty spinners on a rail
/// reads as broken, while forty quiet rectangles read as loading.
public struct AuroraArtwork: View {
    let url: URL?
    let icon: String
    let cornerRadius: CGFloat

    public init(url: URL?, icon: String = "film", cornerRadius: CGFloat = AuroraMetrics.radius) {
        self.url = url
        self.icon = icon
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().aspectRatio(contentMode: .fill)
            default:
                AuroraCardBackground()
                    .overlay {
                        Image(systemName: icon)
                            .font(.system(size: 28))
                            .foregroundStyle(Color.auroraMutedForeground.opacity(0.5))
                    }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

/// A 2:3 poster with title and caption — the library's basic unit.
public struct AuroraPosterCard: View {
    let posterURL: URL?
    let title: String
    let caption: String?
    let isSeries: Bool
    let onTap: () -> Void

    @State private var hovering = false

    public init(
        posterURL: URL?,
        title: String,
        caption: String? = nil,
        isSeries: Bool = false,
        onTap: @escaping () -> Void
    ) {
        self.posterURL = posterURL
        self.title = title
        self.caption = caption
        self.isSeries = isSeries
        self.onTap = onTap
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AuroraArtwork(url: posterURL, icon: isSeries ? "tv" : "film")
                .frame(width: AuroraMetrics.posterWidth, height: AuroraMetrics.posterHeight)
                .auroraGlow(strong: hovering)
                .scaleEffect(hovering ? 1.05 : 1)
                .animation(.spring(response: 0.28, dampingFraction: 0.75), value: hovering)

            Text(title)
                .font(.auroraSans(AuroraType.body, weight: .medium))
                .foregroundStyle(Color.auroraForeground)
                .lineLimit(1)

            if let caption {
                Text(caption)
                    .font(.auroraCaption)
                    .foregroundStyle(Color.auroraTextSecondary)
                    .lineLimit(1)
            }
        }
        .frame(width: AuroraMetrics.posterWidth, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: onTap)
    }
}

/// A 16:9 still with a resume bar — Continue Watching.
public struct AuroraStillCard: View {
    let stillURL: URL?
    let title: String
    let subtitle: String?
    /// 0…1. Drawn only when > 0.
    let progress: Double
    let onTap: () -> Void

    @State private var hovering = false

    public init(
        stillURL: URL?,
        title: String,
        subtitle: String? = nil,
        progress: Double = 0,
        onTap: @escaping () -> Void
    ) {
        self.stillURL = stillURL
        self.title = title
        self.subtitle = subtitle
        self.progress = progress
        self.onTap = onTap
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .bottom) {
                AuroraArtwork(url: stillURL)
                    .frame(width: AuroraMetrics.stillWidth, height: AuroraMetrics.stillHeight)

                if progress > 0 {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(.black.opacity(0.55))
                            Rectangle()
                                .fill(Color.auroraAccent)
                                .frame(width: geo.size.width * min(1, progress))
                        }
                    }
                    .frame(height: 3)
                }

                if hovering {
                    Image(systemName: "play.circle.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.white.opacity(0.95))
                        .shadow(radius: 8)
                        .transition(.opacity.combined(with: .scale))
                }
            }
            .frame(width: AuroraMetrics.stillWidth, height: AuroraMetrics.stillHeight)
            .clipShape(RoundedRectangle(cornerRadius: AuroraMetrics.radius, style: .continuous))
            .auroraGlow(strong: hovering)
            .scaleEffect(hovering ? 1.03 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.75), value: hovering)

            Text(title)
                .font(.auroraSans(AuroraType.body, weight: .medium))
                .foregroundStyle(Color.auroraForeground)
                .lineLimit(1)

            if let subtitle {
                Text(subtitle)
                    .font(.auroraCaption)
                    .foregroundStyle(Color.auroraTextSecondary)
                    .lineLimit(1)
            }
        }
        .frame(width: AuroraMetrics.stillWidth, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: onTap)
    }
}

/// A titled horizontal rail. Generic over its content so any card type fits.
public struct AuroraRail<Content: View>: View {
    let title: String
    let content: Content

    public init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.auroraRailTitle)
                .foregroundStyle(Color.auroraForeground)
                .padding(.horizontal, AuroraMetrics.pageGutter)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: AuroraMetrics.railSpacing) {
                    content
                }
                .padding(.horizontal, AuroraMetrics.pageGutter)
                // Room for the hover scale + glow, which would otherwise be
                // clipped by the ScrollView's bounds.
                .padding(.vertical, 10)
            }
        }
    }
}

/// A page or section heading — --fs-page / --fs-section.
public struct AuroraSectionHeader: View {
    let title: String
    let subtitle: String?
    let display: Bool

    public init(_ title: String, subtitle: String? = nil, display: Bool = false) {
        self.title = title
        self.subtitle = subtitle
        self.display = display
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(display ? .auroraPageTitle : .auroraSection)
                .foregroundStyle(Color.auroraForeground)
            if let subtitle {
                Text(subtitle)
                    .font(.auroraBody)
                    .foregroundStyle(Color.auroraTextSecondary)
            }
        }
    }
}

/// A metadata chip — year, runtime, rating, 4K, HDR.
public struct AuroraPill: View {
    let text: String
    let tinted: Bool

    public init(_ text: String, tinted: Bool = false) {
        self.text = text
        self.tinted = tinted
    }

    public var body: some View {
        Text(text)
            .font(.auroraSans(11, weight: .semibold))
            .foregroundStyle(tinted ? Color.auroraForeground : Color.auroraTextSecondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background {
                Capsule().fill(tinted ? Color.auroraAccent.opacity(0.9) : Color.auroraMuted)
            }
            .overlay {
                Capsule().strokeBorder(
                    tinted ? Color.clear : Color.auroraBorder,
                    lineWidth: 1
                )
            }
    }
}

/// The primary action button — Aurora violet, not system blue.
public struct AuroraButtonStyle: ButtonStyle {
    let prominent: Bool
    public init(prominent: Bool = true) { self.prominent = prominent }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.auroraSans(AuroraType.body, weight: .semibold))
            .foregroundStyle(prominent ? Color.white : Color.auroraForeground)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background {
                RoundedRectangle(cornerRadius: AuroraMetrics.radiusSmall, style: .continuous)
                    .fill(prominent ? Color.auroraAccent : Color.auroraMuted)
            }
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
