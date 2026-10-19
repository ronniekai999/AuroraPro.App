# Parental ceiling: route coverage

What each route does with a profile's `max_age_rating` ceiling, from a
route-by-route audit of `internal/api/router.go` (October 2026). The rules are
in `CLAUDE.md` ("Parental rating ceiling" and "Profile lock"); this page is the
coverage map. Line numbers are left out on purpose: they rot. When you change a
route's gate, change its row here.

Terms:

- **Acting profile**: the session's bound profile (`ResolveActingProfile`),
  or the account default when the session has no binding, or, on an account
  with no default, an unrestricted stand-in with ID 0. A token whose session
  row is gone acts as the account's most restrictive profile.
- **Restricted session**: one whose acting profile has a ceiling.
- **Profile-keyed**: the route takes a profile from `?profile_id=`, a body
  field or a `{profileId}` URL segment, through `resolveRequestProfile` (the
  playback telemetry beacons use the same rule, `pickRequestProfile`, and
  refuse silently). With none it uses the acting profile. A named profile
  must be the account's, and a restricted session may name only itself (403
  `profile_restricted`). An unrestricted session may name any of them, a
  PIN-locked one included: the lock guards switching, not the data.

## Enforced from the acting profile

| Routes | Gate |
|---|---|
| `GET /api/media`, `/api/media/recent`, `/api/media/search` | SQL before LIMIT; fails open to unrestricted on a resolve error (discovery) |
| `GET /api/media/{id}`, `/seasons`, `/seasons/{n}/episodes` | Go `RatingAllowed`; fails closed |
| `GET/HEAD /api/stream/media/{fileID}`, `/episode/{fileID}`, `/{fileID}/direct`, `/direct/{fileID}` | Go; fails closed. A file-bound cast token relies on its mint-time check |
| `POST /api/stream/{fileID}/cast-token`, `POST /api/stream/sessions` | Go at creation; fails closed |
| `GET /api/stream/{fileID}/subtitles`, `GET/HEAD .../subtitles/{trackIdx}` | Go; fails closed |
| `POST /api/collections` (AI seed only) | SQL plus Go re-check; no seed on a resolve error |
| WS `/ws/party-room` `change-media` | Go; **fails open** when the media or profile lookup errors or finds nothing |
| `GET /api/members/{username}` watch strip | SQL before the dedup and LIMIT. A restricted non-default session gets no strip on its own account's page (the strip is the default profile's history) |

## Someone else's ceiling

| Routes | Gate |
|---|---|
| `POST /api/parties/{code}/invites` | The invitee's default profile, at send time only |

## Profile-keyed, with that profile's ceiling

| Routes | Notes |
|---|---|
| `GET /api/me/hero`, `/recommendations`, `/discover`, `/engagement-rails` | Recommender SQL. A ceiling-lookup error builds nothing, and no cache stores the empty result |
| `GET /api/me/anchor-rails` | Items gated; the anchor's own title comes from history and is not |
| `GET /api/me/following/recent` | SQL |
| `GET /api/onboarding/grid`, `/preview`, `POST /api/onboarding/seeds` | SQL; seeds validated against the ceiling |
| `GET /api/progress/continue` | SQL before the dedup and LIMIT |

## Profile-keyed, no ceiling

The profile is scoped, so a restricted session reaches only its own data, but
that data is not filtered. A restricted session can write progress, a rating
or a list entry for any media id, and then read it back here.

- Recaps: `GET /api/media/{id}/recap`, `/recap/status`, `/recap/conversation`,
  `POST .../recap/conversation/turns`.
- Progress: `GET/PUT /api/progress/{id}`, `POST /api/progress/{id}/watched`.
- `POST /api/me/feedback`, `GET/POST /api/me/rating`.
- Watchlist items and My Library: `GET/POST
  /api/profiles/{profileId}/watchlists/{listId}/items`, `GET/POST
  /api/profiles/{profileId}/library`.

These are profile-keyed too, with no title data to filter: `GET
/api/onboarding/status`, `POST /api/onboarding/skip`, `DELETE
/api/onboarding/seeds`, `POST /api/me/recommendation-exposure`, `DELETE
/api/progress/{id}`, both recap `DELETE`s, `GET/POST
/api/profiles/{profileId}/watchlists` and `DELETE .../watchlists/{listId}`,
the watchlist item and My Library `DELETE`s, and the playback telemetry
beacons `POST /api/stream/qoe/start`, `/finish` and `/restamp`.

## Account history

`GET /api/progress/recent` and `/history` list the whole account for an
unrestricted session. For a restricted session they list only its own
profile's rows, under its ceiling, in SQL before LIMIT and in the count.

## No ceiling

- Lookups by id: `GET /api/media/{id}/files`, `/next-episode`,
  `/api/media/episodes/{episodeId}/files`, `/artwork`, `/cast`,
  `/api/stream/info/{fileID}` (tracks and external subtitle filenames).
- Listings: `/api/media/genres` (aggregate), `/api/libraries` (names and
  paths), `/api/calendar`, `/api/collections` and `/api/collections/{id}`,
  `/api/me/notifications`, `/api/parties/active` (every live and scheduled
  party), `GET /api/parties/{code}`, `/api/me/party-invites` (send-time check
  only), `/api/rooms`, and the account's media requests: `GET /api/requests`
  and `GET /api/requests/search`, a TMDB-wide title search with posters and
  overviews, for `POST /api/requests`.
- Enumeration: `POST /api/collections/{id}/items` adds any media id, and the
  collection reads it back.
- Session playback by id: `POST /api/stream/sessions/{sessionID}/cast-token`
  and the session's HLS playlists and segments check account ownership only,
  so another profile's session id on the account plays.
- Parties: `POST /api/parties`, `POST /api/rooms/{id}/parties`, a party's
  `highlight.mp4`, `reactions`, `qr.png` and `card-links`, WS `join-party` on
  both party sockets.
- Realtime: WS `/ws` sends `scan_progress`, with scanned file names, to every
  connected client, every profile's progress events (media ids and
  positions) to all of the account's devices, and, when the opt-in
  `now_playing_enabled` setting is on, `now_playing` events naming what
  everyone is watching to every admin connection. A session acting as a
  restricted profile connects as a user and gets none of the admin events,
  unless no profile on its account is free of a limit; a socket keeps the
  role it connected with until it reconnects.
- Account-level, with no title data: `/api/me/gamification`. Besides XP and
  achievements it returns the top genre and this week's finished-title count
  and runtime, aggregated over every profile on the account.
- Public, with no session to take a ceiling from: `/api/code/{code}/info`,
  party share images and cards, `/p/{code}`, and the path-keyed image proxy.

## Profile management

Handled by the profile lock: switching into a locked profile needs its PIN or
the account password, and a restricted session cannot create, delete or
re-default profiles, change a ceiling or PIN, edit another profile's
settings, link or unlink a sign-in identity, or edit the account's member
profile.

## Admin-only

Library, media, metadata, session, skip-marker, backup and settings
administration are admin-gated and out of scope for a profile ceiling. The
admin role is account-level, but a session acting as a restricted profile is
refused the admin routes (403 `profile_restricted`) and the admin powers
elsewhere, unless no profile on its account is free of a limit (CLAUDE.md,
"The admin role belongs to the account").
