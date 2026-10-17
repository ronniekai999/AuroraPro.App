# Android TV feature parity checklist

The first implementation is an installable native login-to-playback client.
Full web parity remains the release gate in [the delivery plan](android-tv-plan.md),
except server administration, which stays in the web app as an
[approved exception](android-tv-plan.md#scope-exceptions).
Target: a TV with built-in Android TV, initially Android TV 9+ and Google TV.

**Status:** implemented means the operation is connected in the first client;
device acceptance remains pending until exercised on the user's TV. Planned
actions have an assigned milestone and must retain their existing role and
profile restrictions. Optional integrations retain their configured availability.

| User action | Server contract / existing source of truth | Role | TV status |
| --- | --- | --- | --- |
| Connect server; password login; refresh; logout | `/api/health`, `/api/auth/login`, `/refresh`, `/logout`, `/me` | All accounts | Implemented; encrypted cookies; account-wide logout disclosed |
| Sign in through existing OAuth providers | Browser OAuth + `/api/auth/device/*`, `/v2/device` | All accounts | Implemented browser-assisted pairing |
| Choose an existing profile | `/api/profiles/`, `/{id}/activate` | Profile owner | Implemented; saved avatar/orb; session-bound activation precedes browsing |
| Create/edit/delete profiles; language, captions, rating ceiling, avatar, taste setup | Profile handlers; web Settings/profile onboarding | Profile owner | Milestone 4; existing playback preferences read now |
| View Home, recent additions, Continue Watching, hero recommendations | `/api/media/recent`, `/api/progress/continue`, `/api/me/hero` with profile ID | All accounts | Implemented basic Home; optional hero can be unavailable |
| Browse/search titles; open details and versions | `/api/media/`, `/search`, `/{id}`, `/{id}/files` | All accounts; rating ceiling applies | Implemented pagination, sorting, genre/type filters, debounced search and Aurora details |
| Navigate seasons, specials and episodes | `/{id}/seasons`, `/{id}/seasons/{season}/episodes`, `/episodes/{id}/files` | All accounts; rating ceiling applies | Implemented; season zero follows numbered seasons |
| Resume a show; choose next unfinished episode | `/api/media/{id}/next-episode`; profile-specific progress | All accounts | Implemented resume; separate chronological in-player Next and cancellable autoplay in 0.3.0; device acceptance pending |
| Play/pause/seek/resume; leave or sleep | Stream-info, direct byte-range and HLS session handlers | All accounts; server authorization remains enforced | Implemented; source-time progress; real-device codec/lifecycle gate pending |
| Select audio and subtitles | Stream-info tracks; profile prefs; direct embedded tracks and HLS manifests | All accounts | Basic native track controls; full language/forced/bitmap handling in 2 |
| Select quality, skip intro/recap/credits, playback preferences and diagnostics | Web player, stream markers, QoE and diagnostics APIs | All accounts | Quality, source/output/decoder diagnostics, Smart Skip and persistent TV autoplay implemented; other preferences and QoE in 2; device acceptance pending |
| Mark watched/unwatched; ratings and feedback | Progress and rating handlers | All accounts | Milestone 2; automatic playback progress implemented |
| Save/remove titles; saved Library and watchlists | Profile library/watchlist handlers; LibraryView | Profile owner | Milestone 2 |
| Create/edit/delete/reorder collections; add/remove/share titles | Collection handlers and CollectionsView | Owner; shared reads as allowed | Milestone 2 |
| Discover personalized picks, refresh heroes and recommendation feedback | Recommendation handlers; web Home/search rails | All accounts; integration availability | Milestone 2; first hero read implemented |
| Request a movie/show; inspect status; cancel eligible requests | Request handlers; RequestsView; configured ARR integrations | Member / owner | Milestone 3 |
| Approve/deny/manage requests; choose server libraries/quality | Admin request and ARR handlers | Administrator | Web app only (approved exception) |
| View upcoming episodes; month/list navigation; open title | Calendar handlers; CalendarView | All accounts | Milestone 3 |
| Host/create/join/leave/end a watch party; schedule or restart it | Party handlers; V3 lifecycle and two authenticated sockets | Party participant / host | Milestone 3 |
| Pick party media/version/episode; play/pause/seek with host rules | V3 identity/revision/state/clock contracts; source-time mapping | Party participant / host | Milestone 3; shared playback timeline foundation exists |
| Invite friends; accept/decline/maybe; inspect invitations and lobby | Party invite handlers; web party calendar/inbox | Invitee / host | Milestone 3 |
| Party chat, reactions, participant state and supported voice | Party messages/reactions/sockets; voice ICE configuration | Party participant | Milestone 3; voice/hardware compatibility decision in 4 |
| Notifications, read state, deep links and device push preferences | Notification/push handlers; web notification inbox | Recipient | Milestone 3 |
| Member directory, profiles, follow/unfollow and social activity | Social handlers; MembersView/UserProfileView | All accounts; privacy rules | Milestone 4 |
| Recap catch-up; ask a question; save/share or react to results | Recap handlers and dialogs; optional AI integration | All accounts; configuration/permissions | Milestone 4 |
| Achievements, referrals, invitations, account links and sharing | Existing achievement/referral/invite/QR handlers | Account owner / permitted issuer | Milestone 4 |
| Account settings, password, avatar, linked OAuth identities and support | Auth/account/feedback handlers; SettingsView | Account owner | Milestone 4 |
| Appearance, accessibility, notification and playback settings | Web preference model plus native device preferences | Account/device owner | Milestone 4; TV focus/theme foundation implemented |
| Dashboard, users/roles, invites and account administration | Admin handlers and AdminView | Administrator | Web app only (approved exception); TV account menu points administrators there |
| Libraries, scanning, paths, metadata matches, rematches and health | Library, scanner, matching and health handlers | Administrator | Web app only (approved exception) |
| Server settings, integrations, AI/search and recommendation configuration | Admin settings / LLM / ARR handlers | Administrator | Web app only (approved exception) |
| Active streams, sessions, jobs, logs and activity | Session/admin/activity handlers | Administrator | Web app only (approved exception) |
| Backups, restore, updates and destructive maintenance | Existing admin/operator APIs and confirmation contracts | Administrator | Web app only (approved exception) |
| TV launcher, remote accessibility, memory/performance, signing and distribution | Android manifest, native focus/MediaSession, Android build/release | Device owner / release operator | Debug launcher/build and CI implemented; release validation in 5 |

The web remains the contract source for actions within each row. Before closing
a row, enumerate its concrete buttons/forms and conditional states from the
named view and handler, exercise every one for applicable roles, and record
normal, disabled-integration, error and recovery results. An API helper existing
does not prove its TV action exists. No row marked planned is represented as
available by a placeholder TV destination.

Playback and authentication checks must include a normal member, administrator,
restricted profile, changed password, server restart and revoked session. Party
acceptance requires mixed web/TV participants and the existing paused-room
invariants; the first solo-player APK does not validate party synchronization.

## Playback parity acceptance for 0.3.0

JVM contract/state tests cover marker decoding, chronological advancement across
season gaps, missing files, rewatch, edition selection, lookup retry/cancellation,
countdown readiness/pause/cancellation and outgoing-save barriers. Media3/D-pad
instrumentation covers source-time intro skipping, a cancelled and automatic
credits countdown, fresh player ownership, persistent autoplay and marker/countdown
updates while a progress save is delayed. Intro skipping includes D-pad traversal
from the transport controls. Instrumentation
must run on a connected TV/emulator before device acceptance; compilation alone
does not close this gate.

| Device scenario | Expected result |
| --- | --- |
| Resume HLS inside an intro; skip beyond the produced playlist | New session uses the source marker end; returned source anchor is respected; Pause remains paused |
| Enter episode credits; pause, buffer, open settings, scrub or sleep | Five-second countdown runs only while the ready stream plays without interaction; return from sleep remains paused |
| Choose Watch credits, then reach the natural end | This episode stays open; explicit Next still works; Replay resets the cancellation |
| Turn autoplay Off; switch episodes and restart the app | Preference stays Off on this TV; explicit Next works; no passive advance |
| Rewatch, skip a fileless episode, cross a season gap, reach the finale | Advance chronologically through playable files; retain the edition when available; leave the final frame open at the end |
| Next lookup fails or returns after closing/changing the title | Retry keeps the current stream; late results cannot restore the outgoing player |
| Progress saves are slow while playback continues | The source clock keeps updating; expired skip actions disappear and autoplay advances on time |
| Advance and immediately leave while the outgoing save is delayed | Home/detail refresh waits for every outgoing save; progress keeps the captured profile and episode |
| Movie credits in a growing HLS playlist | Skip appears only when the destination is produced; no rebuild at approximate EOF |

Full viewing parity still requires saved Library/watchlists, collections,
ratings/watched actions, discovery refinements, additional subtitle paths and QoE.
Connected viewing, account/social flows and release validation retain their
milestones above; administration stays in the web app.
