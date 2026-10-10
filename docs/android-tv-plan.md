# AuroraPro Android TV Implementation Plan

**Status:** Scope approved; first native build in verification.
**Date:** October 10, 2026

Build a native Android TV and Google TV client that brings AuroraPro's web capabilities to the living room. Keep Aurora's visual identity and shared server data, and adapt every flow for a directional remote. The launch goal is full web feature parity for each account role. Earlier milestones deliver usable builds so playback and navigation can be evaluated before the entire app is finished.

Approval of this proposal starts implementation with the first milestone below. Public distribution and production rollout follow a separate release decision after a tested build is available.

## Product scope

The existing Go server remains the source of truth for accounts, profiles, libraries, recommendations, progress, parties, requests, and calendar data. The Android client lives in `clients/android-tv/`, alongside the existing macOS client. Its screens, player, and remote interactions use native Android components.

The initial device proposal is Android TV 9 and newer, including Google TV. Confirm the actual target TVs before setting the minimum SDK. Start with a sideloadable APK for testing, then prepare a signed release and Google Play TV distribution if desired. A phone provides optional help with login, typing, sharing, and party voice; normal browsing, playback, requests, calendar actions, and party controls remain available on the TV.

### Feature parity

| Web capability | Android TV implementation | Delivery milestone |
| --- | --- | --- |
| Server connection and authentication | Server URL entry, saved connection, remote keyboard login, registration and invite codes, optional QR or short-code pairing through a signed-in browser, configured OAuth providers | 1 foundation, 4 complete account flows |
| Profiles and personalization | Profile picker and management, session-bound activation, avatars, language and subtitle preferences, parental ceiling, taste onboarding | 1 selection, 2 preferences, 4 full management |
| Home and discovery | Hero artwork, personalized rails, Match %, continue watching, recently added, ratings, recommendation feedback, surprise picks | 1 basic home, 2 full discovery |
| Browse and search | Movies and TV Shows, genres, sorting and filters, keyword and semantic search, on-screen keyboard and supported voice input | 2 |
| Title details and viewing | Cast and artwork, file or version selection, seasons and episodes, resume, watched state, next episode, playback controls, quality, audio and subtitles, Smart Skip | 2 |
| My Library and organization | Saved titles, named watchlists, collections, add and remove actions, viewing history management | 2 |
| Requests | Movie and show search, configured standard or 4K requests, existing approval rules, duplicate handling, progress, errors and permitted cancellation or deletion | 3 |
| Calendar | Upcoming episodes and scheduled parties, list and month views, date and month navigation, title details, party RSVP and join actions | 3 |
| Watch parties | Create, join, host, invite members, schedule, RSVP, lobby countdown, synchronized playback, seek and pause, media changes, episode advancement, host succession and reconnect | 3 |
| Party communication and sharing | Chat, reactions, participants, supported microphone voice, companion QR, invitation cards and links, highlight viewing and export | 3 core communication, 4 complete sharing and voice |
| Social and achievements | Member directory and profiles, follows, following activity, editable bio and handles, watch-history sharing controls, XP, streaks and achievements | 4 |
| AI features | Catch Me Up and Ask Previously with the same spoiler boundaries; semantic search and recommendation features respect server configuration | 2 search, 4 recaps and questions |
| Notifications | In-app inbox, read state, request outcomes, party invites and reminders, highlight readiness and applicable admin alerts | 3 inbox, 4 notification preferences |
| Account and appearance | Password and OAuth linking controls, referral prompt, privacy settings, appearance choices, playback defaults, sign-out behavior | 4 |
| Administration | Users and invitations, roles, libraries and scans, metadata review, request approvals, active streams and rooms, activity and logs, server and integration settings, backups and restore, updates | 3 request approvals, 4 complete admin surface |
| Support and device integration | Bug reports and supported screenshot or recording attachments, TV launcher assets, system media controls, deep links, playback handoff and sharing where a target supports them | 4 support, 5 platform validation |

This table is the starting inventory. Milestone 0 expands it into individual web actions, including secondary dialogs, account flows and admin operations. Each action gets a native destination, applicable role, API contract, verification scenario and milestone. A feature is not counted as parity merely because its data can be displayed. Deferrals or hardware-dependent substitutions remain explicit and require agreement before a full-parity launch.

### TV experience

Preserve Aurora's dark canvas, purple and cyan accents, cinematic artwork, hero composition, poster rails, Bricolage Grotesque display type and Inter body type. Reuse the existing brand assets and translate design tokens into the TV theme. These choices come from the current web styles; spacing and type sizes change for viewing across a room.

Use a focusable navigation rail with the familiar destinations: Home, Movies, TV Shows, Collections, Calendar, My Library and Requests. Add an easy Watch Parties entry, with Search, notifications and the active profile always reachable. Members, Settings and role-gated Admin remain easy to find. Prototype this shell before committing every screen to it.

Every action must work with Up, Down, Left, Right, Select and Back. Focus stays visible over artwork, returns to the selected poster after leaving a title, and survives data refreshes. Dialogs own focus while open and return it when dismissed. Back closes the nearest overlay, then returns through navigation history. Loading, empty and error screens provide a useful focused action. Support large readable labels, screen-reader semantics, high contrast and reduced motion.

Calendar defaults to an agenda suitable for a remote, while retaining an accessible month grid. Request search leads to a short form with the available quality choices. Party controls sit over the player without hiding the film behind chat; reactions use a small selectable tray. TV text input remains available even when a companion shortcut exists.

## Technical approach

Use Kotlin, Jetpack Compose for TV, AndroidX Media3 ExoPlayer and MediaSession. Compose for TV provides components intended for remote navigation and visible focus. Media3 handles the native video player and integration with system transport controls. Use current compatible stable dependencies when scaffolding, and pin them in the project. See the official [Compose for TV guidance](https://developer.android.com/training/tv/playback/compose) and [Media3 TV controls](https://developer.android.com/media/media3/ui/androidtv).

Organize the client around shared API models, authentication, profile state, feature repositories and a single playback coordinator. Screens observe lifecycle-aware state through ViewModels and Kotlin coroutines. Use an HTTP client and shared cookie handling across REST, playback and WebSockets; store persistent session material with Android Keystore protection. Cache artwork and lightweight preferences locally. Server records remain authoritative, and unavailable network operations have explicit retry states rather than speculative offline mutations.

Start with these logical boundaries without creating a separate Gradle module for every screen:

- App shell, theme, focus, navigation and account/profile state.
- API models, HTTP, authentication, caching and realtime transport.
- Playback decisions, Media3, source-time mapping, progress and session lifecycle.
- Party state and synchronization, room communication and optional voice.
- Feature screens for discovery, library, requests, calendar, social, settings and administration.

### Authentication and shared state

Aurora login and refresh currently set HTTP-only cookies and do not return access tokens in the response body. Reuse that contract, including one refresh operation shared by concurrent requests. Cookies must reach direct files, HLS manifests and segments, subtitle requests, and both party sockets. Test expiry during playback as well as ordinary API calls. Native WebSockets can use the existing no-Origin path with authentication; browser Origin checks remain intact.

Add a device pairing flow for comfortable TV sign-in. The TV displays an expiring QR and short code; the user authorizes that device from an authenticated Aurora browser, including existing OAuth sign-in where configured. The server issues a distinct session to the TV. Grant creation, authorization and polling need server endpoints, single-use grants, expiry, rate limits and explicit device identification. Keep the existing browser cookie behavior unchanged.

Use the existing profile activation endpoint and explicit profile parameters where required. Playback captures the acting profile and media identity so a later profile switch cannot attribute old progress to someone else. Preserve current sign-out semantics: Aurora logout presently invalidates the account's other sessions too. A per-device logout or session-management redesign would be a separate auth decision.

### Native playback

Follow Aurora's [native playback capability contract](native-client-caps.md): request stream information, use the authenticated range-request endpoint for direct play, and use the existing session flow for remux or transcode. Report `hls_native` and only containers and codecs the actual device and build support. Do not copy the macOS client's broad capability list or send the browser's `hls_js` flag.

Codec support depends on the device's decoders, display and audio route; container support alone does not prove that a file will play. Check profiles, bit depth, size, frame rate and output support. Where Aurora's compact caps cannot represent a limit, use conservative decisions or an isolated additive server change. Provide a bounded HLS transcode fallback for a failed direct-play attempt, preserving the title, profile, selected tracks and source position. HDR and surround sound are validated on supported hardware, with a playable fallback for other devices. See [Media3 supported formats](https://developer.android.com/media/media3/exoplayer/supported-formats).

Translate player time into absolute source time once, in the playback coordinator. Reuse that mapping for progress, resumes, Smart Skip, subtitles and party synchronization. HLS sessions may start at a nonzero source offset, and their growing playlist duration cannot substitute for the film's duration. Keepalive and cleanup apply to HLS sessions; direct-file playback has no transcode session to keep alive. Cancel old playback work when changing media, and prevent late callbacks from advancing or completing a replacement title.

Respect preferred spoken language when selecting tracks or falling back to HLS. Validate embedded and external subtitles against the formats Aurora serves and Media3 renders. Unsupported tracks need an explained fallback; any new subtitle conversion or burn-in behavior requires its own server work.

### Watch parties and notifications

Implement Aurora's current V3 protocol using both `/ws/party-sync` and `/ws/party-room`. The server controls canonical Running or Paused intent; local buffering describes readiness. Apply clock offset, source position, state revisions and media identity before accepting updates. Use the server's drift thresholds, bounded rate correction and hard seeking. Suppress remote-command echoes, reject stale media messages, and preserve explicit Pause through automatic episode transitions.

Reconnect must refresh credentials when necessary, rejoin both transports and adopt canonical server state. Test host succession, scheduled-party restart survival, seek during buffering, media changes and the same account using TV plus the phone companion. Voice uses native WebRTC only with a usable microphone and compatible audio path. TVs without an accessible microphone use the existing companion for voice; remote voice-search microphones must not be assumed available for party calls.

Use the server notification inbox and realtime events for the first TV builds. Existing Web Push subscriptions are browser subscriptions; they are not automatically an Android notification service. Background native alerts need a separate delivery decision. Preserve invite RSVP and reminders inside the TV app, and retain configured browser/phone delivery in the meantime.

## Delivery milestones

| Milestone | Work | Reviewable result and completion gate |
| --- | --- | --- |
| 0 Scope and contracts | Inventory every web action, map endpoints and roles, confirm target devices, define focus and navigation behavior, identify pairing and native capability gaps | Agreed parity checklist, TV screen map and architecture notes; remaining estimates updated |
| 1 First working TV build | Create `clients/android-tv/`, TV launcher setup, theme and navigation, server connection, login and pairing, profile selection, basic Home and details, direct and HLS playback | Installable APK on a real TV; connect, sign in, choose a profile, play, pause, leave and resume the same title on the web |
| 2 Complete viewing experience | Browse, search, recommendations, saved titles, watchlists, collections, seasons, audio, subtitles, quality, skip markers, progress and episode continuation | Viewer beta with complete remote navigation and proven direct/remux/transcode behavior |
| 3 Connected viewing | Requests and approvals, calendar, party creation and scheduling, invites, RSVP, lobby, V3 sync, chat, reactions, notification inbox | A web user and TV user watch together; TV can request a title, track it, and join a scheduled party from Calendar |
| 4 Full web parity | Social, recaps and questions, achievements, account and profile management, appearance, complete admin actions, support, sharing and voice on suitable hardware | All inventory actions pass for their applicable role; any exception is explicitly reviewed |
| 5 Release validation | Device and codec matrix, lifecycle and network recovery, accessibility, performance, launcher/deep-link integration, signing, update behavior and release instructions | Tested signed build and release checklist, independent review records, known hardware limits and rollout recommendation |

**First implementation target:** Milestone 1's complete login-to-playback flow, followed by Milestone 2. This proves the app's foundation while keeping watch parties, requests and calendar on the committed delivery path. The first APK is an early milestone, not the full-parity release.

Allow roughly **13–21 engineering weeks** for all milestones with one experienced Android engineer, reusable server APIs and access to representative physical TVs. This is an initial scope estimate, not a delivery-date commitment. Pairing, codec limits, native voice, admin forms and device validation can materially change it. Re-estimate after Milestone 0 and again after the first working TV playback build; measure progress by the gates above.

## Verification and release gates

Maintain the web-to-TV checklist throughout implementation. Each item must be exercised from its screen through the actual server operation and back to the resulting UI state. Include a normal member, an administrator and a restricted profile. Optional integrations have enabled, disabled and unavailable states; their absence must not break the app.

| Area | Required evidence |
| --- | --- |
| Remote and accessibility | Every destination and action reachable without touch or a phone; no focus traps; reliable Back and focus restoration; readable artwork overlays; accessibility and motion checks |
| Playback | H.264/AAC baseline, MKV, supported HEVC/Main10 and HDR, surround or stereo fallback, preferred audio, supported subtitle types, resumed HLS, seeking, quality changes and next episode |
| Shared data | Watch on TV and resume on web; change watchlists, ratings, requests and RSVP on either surface and observe the correct result on the other |
| Party synchronization | TV/web mix, initial join, source offsets, pause/play/seek, buffering, reconnection, host departure, scheduled restart, media changes and episode advancement without stale commands |
| Authentication and profiles | Login, pairing expiry and reuse rejection, refresh, revocation, restart, account switching, profile isolation and parental behavior; clear indication of existing server restrictions |
| Resilience | Network loss, server restart, expired credentials, process death, sleep/wake, long viewing sessions and resource cleanup |
| Administration | Role enforcement for each action, meaningful previews and confirmations for destructive operations, backup export/restore handling, bounded logs and activity views |
| Build and review | Android lint, unit/contract tests and D-pad instrumentation for meaningful flows; applicable Go and web checks for shared changes; fresh independent review of each final code diff |

Use emulator runs for navigation coverage and physical devices for decoder, HDR, sound, voice and performance claims. Start with an Android TV or Google TV streaming device and a representative TV with fewer resources, then expand to the actual household/device targets. Record the tested device, server revision and media fixtures.

Apply the existing October playback contracts and triage the remaining [playback and casting review](playback-casting-review-2026-09.md) for issues that block native TV playback. Preserve existing profile attribution and party Pause behavior. Do not treat the Android client as completion of the broader casting, GPU or paused-encoder backlog.

Implement on feature branches and follow [the repository development workflow](dev-workflow.md). Behavior-changing diffs require a fresh independent agent review, fixes for high or critical findings, and a verdict recorded against the final reviewed commit. Report builds, device testing and review results separately.

## Approval decision

Approve this scope and milestone order, with these proposed defaults: a Kotlin/Compose native client in the existing repository, Android TV 9+ subject to the target-device check, the existing Aurora backend and profile model, optional phone assistance, sideloaded test builds first, and full web parity as the launch gate.

After approval, begin Milestone 0 and build the Milestone 1 native shell, sign-in, profile, Home, details and playback flow. Review that APK on a real TV before expanding into the remaining screens. Distribution choices and any proposed feature exceptions stay visible as separate decisions.
