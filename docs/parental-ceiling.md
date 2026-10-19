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
- **By-id gate**: `internal/api/ceiling_gate.go`. Checks a title or episode
  id against a profile's ceiling and fails closed. Under a ceiling a missing
  id gets the same 404 body as an over-ceiling one.

## Enforced from the acting profile

| Routes | Gate |
|---|---|
| `GET /api/media`, `/api/media/recent`, `/api/media/search` | SQL before LIMIT; fails open to unrestricted on a resolve error (discovery) |
| `GET /api/media/{id}`, `/seasons`, `/seasons/{n}/episodes` | By-id gate on seasons and episodes. The detail checks the title it loads (`RatingAllowed`), with the same 404 body as a missing id; it always looks the title up, and a lookup error is a 500. The detail and a season's episodes also list other libraries' copies of the title (same TMDB id) without checking those copies' ratings; streaming one is still refused |
| `GET /api/media/{id}/files`, `/artwork`, `/cast`, `/next-episode`, `/api/media/episodes/{episodeId}/files` | By-id gate (an episode by its show's rating). Files and the next episode also list other libraries' copies of the title (same TMDB id) without checking those copies' ratings; streaming one is still refused |
| `GET /api/stream/info/{fileID}` | Go, the stream routes' file check; fails closed, same 404 as a missing file |
| `GET/HEAD /api/stream/media/{fileID}`, `/episode/{fileID}`, `/{fileID}/direct`, `/direct/{fileID}` | Go; fails closed. A file-bound cast token relies on its mint-time check |
| `POST /api/stream/{fileID}/cast-token`, `POST /api/stream/sessions` | Go at creation; fails closed |
| `GET /api/stream/{fileID}/subtitles`, `GET/HEAD .../subtitles/{trackIdx}` | Go; fails closed |
| `POST /api/collections` (AI seed) | SQL plus Go re-check; no seed on a resolve error |
| `GET /api/collections`, `/api/collections/{id}` | SQL: items, counts, the poster mosaic and the cover leave out members over the ceiling (under a ceiling the cover is the first allowed member's poster); fails open on a resolve error (discovery). Names, descriptions and AI prompts are shown as written |
| `POST /api/collections/{id}/items` | By-id gate. Removing is ungated |
| `GET /api/calendar` | SQL before LIMIT; fails open on a resolve error (discovery) |
| `GET /api/parties/active` | Go, on the id of each party's current title; fails open on a resolve error, and lists none when the ratings cannot be read. A party whose title cannot be found is left out. The title text and poster shown are the host's own for room starts and media changes, and party names are the host's free text |
| `GET /api/me/party-invites` | SQL, on the title id recorded in the party's row, which a media change updates in the background (best effort), so it can lag the title playing; fails open on a resolve error. Party names are the host's free text. Sending still checks only the invitee's default profile, and the invite's notification is not filtered |
| `GET /api/parties/{code}/highlight.mp4` | By-id gate on the title the party's row records, for admins too, after the membership check (which a session with admin powers skips). The reel is cut from the same title. When a party ends, its row records the final title while that title exists: with its episode, name and poster when the episode is the title's own, and alone otherwise; without the name and poster when the database refuses their text. When the title is gone, or no write of it lands, the row keeps its last saved title and the reel is cut from that. A reel cut before this change was cut from the final title, which its row may not record |
| WS `/ws/party-room` `change-media` | Go, with the profile resolved when the socket connected; **fails open** when the media or profile lookup errors or finds nothing. A missing id and an over-ceiling one get different errors |
| `GET /api/members/{username}` watch strip | SQL before the dedup and LIMIT. A restricted non-default session gets no strip on its own account's page (the strip is the default profile's history) |

## Someone else's ceiling

| Routes | Gate |
|---|---|
| `POST /api/parties/{code}/invites` | The invitee's default profile, at send time only. Listing invites applies the reading session's own ceiling (above) |

## Profile-keyed, with that profile's ceiling

| Routes | Notes |
|---|---|
| `GET /api/me/hero`, `/recommendations`, `/discover`, `/engagement-rails` | Recommender SQL. A ceiling-lookup error builds nothing, and no cache stores the empty result. Anchors come from history with no ceiling: `/recommendations` captions name them, and the LLM blurb prompts include them |
| `GET /api/me/anchor-rails` | Items gated; the anchor's own title comes from history and is not |
| `GET /api/me/following/recent` | SQL |
| `GET /api/onboarding/grid`, `/preview`, `POST /api/onboarding/seeds` | SQL; seeds validated against the ceiling, and a `selected` pick counts toward the grid's and preview's taste vector only when the ceiling allows it |
| `GET /api/progress/continue` | SQL before the dedup and LIMIT |
| `GET /api/media/{id}/recap`, `/recap/status`, `/recap/conversation`, `POST .../recap/conversation/turns` | By-id gate on the show. The two `DELETE` clears are ungated |
| `GET/PUT /api/progress/{id}`, `POST /api/progress/{id}/watched` | By-id gate on the title, and on a named episode's own show. `DELETE` is ungated |
| `POST /api/me/feedback` (up, down), `POST /api/me/rating` (1 to 5 stars) | By-id gate. Clearing either is ungated |
| `POST /api/profiles/{profileId}/watchlists/{listId}/items`, `POST .../library` | By-id gate. Removing is ungated |
| `GET /api/profiles/{profileId}/watchlists/{listId}/items`, `GET .../library` | SQL, before LIMIT and in the count |
| `GET /api/profiles/{profileId}/watchlists` | Each list's `item_count` counts only titles under the ceiling |

The ungated deletes and clears let a profile remove data recorded before its
ceiling, which it can no longer see, where it can name it. A watchlist's item
DELETE (any list but My Library) takes a row id that the filtered read no
longer returns, so those entries go only with the whole list.

## Profile-keyed, no ceiling

- `GET /api/me/rating` returns the profile's own stars for any media id. It
  carries no title data.

These are profile-keyed too, with no title data to filter: `GET
/api/onboarding/status`, `POST /api/onboarding/skip`, `DELETE
/api/onboarding/seeds`, `POST /api/me/recommendation-exposure`, `DELETE
/api/progress/{id}`, both recap `DELETE`s, `POST
/api/profiles/{profileId}/watchlists` and `DELETE .../watchlists/{listId}`,
the watchlist item and My Library `DELETE`s, and the playback telemetry
beacons `POST /api/stream/qoe/start`, `/finish` and `/restamp`.

## Account history

`GET /api/progress/recent` and `/history` list the whole account for an
unrestricted session. For a restricted session they list only its own
profile's rows, under its ceiling, in SQL before LIMIT and in the count.

## No ceiling

- Listings: `/api/media/genres` (aggregate), `/api/libraries` (names and
  paths), `/api/me/notifications` (party invites, RSVPs, reminders and reel
  notices carry the title in their stored text), `GET /api/parties/{code}` (the
  party's title and poster for anyone with the code), `/api/rooms`, and the
  account's media requests: `GET /api/requests` and `GET
  /api/requests/search`, a TMDB-wide title search with posters and
  overviews, for `POST /api/requests`.
- Session playback by id: `POST /api/stream/sessions/{sessionID}/cast-token`
  and the session's HLS playlists and segments check account ownership only,
  so another profile's session id on the account plays.
- Parties: `POST /api/parties`, `POST /api/rooms/{id}/parties`, a party's
  `reactions`, `qr.png` and `card-links`, WS `join-party` on both party
  sockets.
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
