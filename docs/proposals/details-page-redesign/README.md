# Details page — UI redesign mockups

Two design directions for the movie/show details page (`DetailView` in
[`static/redesign/app/src/App.tsx`](../../../static/redesign/app/src/App.tsx)).
These are **static HTML mockups** — no app code is touched. They use the real
Aurora design tokens (Inter + Space Grotesk, purple `#A855F7`, the glass / glow
utilities from `index.css`) and real *Free Willy* artwork so they read as "your
page, but better."

Open either `index.html` in a browser, or use the Launch preview panel.

## What both fix (today's pain points)

| # | Current page | Both mockups |
|---|---|---|
| 1 | 5–7 equal-weight action pills that wrap | One loud primary + tidy secondary grouping |
| 2 | Resolution / codec / channels buried in a text dump at the bottom | Quality chips surfaced up top (`1080p · DTS 5.1 · 13 Subs`) |
| 3 | "Resume at 0:08" is text only | Visual progress bar on the poster **and** in the Resume button |
| 4 | Huge dead space on the right of the hero | Used for a glass Quick-Facts / Details card |
| 5 | A 13-row plain subtitle list dominates | Compact language chip-cloud |

## The two directions

### 1 · Cinematic Spotlight — `cinematic-spotlight/index.html`
An **evolution** of today's immersive single-column hero. Taller backdrop with an
aurora-glow floor, a floating glass **Quick Facts** card filling the old dead
space, a Resume button with an **embedded progress bar**, secondary actions
collapsed into an **icon cluster** (tooltips), premium **portrait cast cards**, a
**More Like This** rail, and a glass **Media Info** spec card. Lowest-risk — it
keeps the current information architecture and just elevates it.

### 2 · Editorial Split-View — `editorial-split/index.html`
A **structural** rethink. A calmer hero banner, then a two-column body: a
**sticky left rail** (poster w/ progress, full action stack, and a
Letterboxd-style **Details** stat table) beside a **tabbed content column**
(Overview · Cast & Crew · Media Info · More Like This) with the **full,
untruncated** synopsis. More organized and information-dense; better for power
users and for TV shows with seasons/episodes.

## Notes
- Stat values shown (studio, release date, "1080p BluRay") illustrate fields the
  layout supports; some aren't in the current API response yet.
- "More Like This" posters beyond *Free Willy* are gradient placeholders.
- Capture procedure / launch config lives in `.claude/launch.json`.
