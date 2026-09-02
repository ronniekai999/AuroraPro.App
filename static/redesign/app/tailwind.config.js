/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  // Aurora Stage display type scale. These live in `@layer utilities` in
  // index.css, which Tailwind tree-shakes against scanned content — so
  // .type-detail / .type-section / .type-rail were emitting NOTHING (Phase 4
  // only uses hero/browse/page), and the two that did ship only did so
  // because their names appear in a code comment. Safelisting makes the whole
  // scale available to later phases, including via a computed class name,
  // instead of depending on whether some comment happens to mention it.
  safelist: [
    'type-hero', 'type-detail', 'type-browse',
    'type-page', 'type-section',
    // type-rail was safelisted too, but its rule never had a consumer (rail
    // titles use .rail-title) and was removed with the other dead CSS.
  ],
  theme: {
    extend: {
      fontFamily: {
        // Map the `font-sans` utility (and Tailwind's preflight base
        // font) to the active typeface system so EVERY element — not
        // just `body` / `.font-display` — follows Settings → Appearance
        // → Typeface. `--font-sans` is defined on :root in index.css and
        // swapped via the data-font attribute. (.font-display stays a
        // bespoke utility on `--font-display`; intentionally not mapped
        // here so it doesn't collide with that class.)
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive) / <alpha-value>)",
          foreground: "hsl(var(--destructive-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xs: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
      },
      // One motion curve for the whole app: the ~225 `transition-*`
      // utilities in TSX now ease on the same tokens the hand-written CSS
      // uses (index.css :root), instead of Tailwind's own literal curve.
      // Values are identical to Tailwind's defaults, so nothing moves; the
      // point is that changing the token changes both systems together.
      transitionTimingFunction: {
        DEFAULT: "var(--ease-standard)",
      },
      transitionDuration: {
        DEFAULT: "var(--dur-fast)",
      },
      // The accordion-down/up and caret-blink keyframes that shipped with
      // the shadcn scaffold went with ui/accordion.tsx and ui/input-otp.tsx,
      // their only consumers. tailwindcss-animate (the plugin below) is what
      // the live dialog / alert-dialog use for animate-in/out.
    },
  },
  plugins: [require("tailwindcss-animate")],
}