# Documentation

The repository keeps current operating and engineering contracts here. Product
proposals, implementation diaries, and standalone design mockups live in Git
history rather than in the working tree once their decision has been made.

## Operate Aurora

- [`bug-report-setup.md`](bug-report-setup.md) — configure the optional in-app
  GitHub issue reporter.
- [`moving-media-paths.md`](moving-media-paths.md) — safely move an existing
  library without discarding catalog-linked history.
- [`library-type.md`](library-type.md) — spot a library created with the wrong
  type, and change it.
- [`push.md`](push.md) — Web Push behavior, controls, rotation, and retention.
- [`server-testing.md`](server-testing.md) — exercise a deployed server over
  HTTPS.
- [`updater-recovery.md`](updater-recovery.md) — diagnose and recover failed
  automatic updates.
- [`reverse-proxy/`](reverse-proxy/) — example Caddy and nginx configurations.

## Develop Aurora

- [`dev-workflow.md`](dev-workflow.md) — required branch, verification, and
  independent-review workflow.
- [`native-client-caps.md`](native-client-caps.md) — direct-play capability
  contract shared by the server and native clients.
- [`parental-ceiling.md`](parental-ceiling.md) — which routes apply a
  profile's parental rating ceiling, which take the profile from the session,
  and which apply none.
- [`match-report.md`](match-report.md) — privacy-bounded recommender calibration
  report.
- [`playback-casting-review-2026-09.md`](playback-casting-review-2026-09.md) —
  September 2026 bug review and phased remediation plan for playback,
  transcoding, casting, and watch-party sync, plus a technology-stack
  assessment, a finding-by-finding verification ledger, and smaller release
  slices. All findings remain open; delete after required fixes land and optional
  enhancement decisions are recorded.

Start with the repository [`README`](../README.md) for installation,
configuration, architecture, and build commands. Agent-specific invariants and
known limits are maintained in [`CLAUDE.md`](../CLAUDE.md); they are not general
operator documentation.
