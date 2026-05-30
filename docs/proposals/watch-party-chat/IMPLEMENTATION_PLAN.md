# Watch Party Chat — Mobile Companion & Cinematic Overlay

**Implementation plan + mockups**
Status: proposal / for decision · Author: prepared for Ronnie · Date: 2026-05-30

Mockups (open in any browser, no build needed):
- [`mockup-mobile-companion.html`](./mockup-mobile-companion.html) — Feature 1
- [`mockup-cinematic-overlay.html`](./mockup-cinematic-overlay.html) — Feature 2

---

## TL;DR

You asked for two things:

1. A **mobile companion** — a participant opens a URL, enters the code, and gets text + audio + emoji chat from their phone.
2. An **on-screen, translucent, Aurora-branded chat** (text + mic + emoji) that floats over the movie without interrupting it.

**The good news: Aurora already ships ~70-80% of the plumbing.** Watch parties today have a two-socket WebSocket protocol, text chat, a WebRTC **voice mesh**, **emoji reactions**, 6-character join codes, presence, rate limiting, and even server-side share-image generation. Both of your features are mostly **new front-end surfaces over existing back-end systems** — not greenfield.

The two features are really **one chat system with two front-ends**:

| | Feature 2 — Cinematic Overlay | Feature 1 — Mobile Companion |
|---|---|---|
| Device | The screen playing the movie (TV/desktop) | A second screen (phone) |
| Shows video? | Yes (chat floats over it) | No (chat only; video is on the big screen) |
| Net-new work | Mostly **visual** (restyle `PartyPanel` to translucent/floating + a minimal mode) | A **new mobile route** + **low-friction join** + **voice-at-scale** |
| Backend changes | ~none | Guest auth (optional) + voice SFU (for big parties) |
| Rough size | **Small–Medium** | **Medium–Large** |

**The one decision that drives everything** (Feature 1): *do mobile guests need an Aurora account, or do we let "anyone with the link" in?* See [§4](#4-the-pivotal-decision-who-can-join). My recommendation: ship v1 **account-required with one-tap OAuth** (you already have Google/Discord/Twitch/Facebook/Twitter), then add a **scoped guest token** as a fast-follow.

---

## 1. What already exists (so we don't rebuild it)

From a read of the codebase:

**Backend (Go)**
- **Two-socket protocol** — `internal/api/party_ws_v3_room.go` (`/ws/party-room`: membership, chat, reactions, presence, voice signaling) and `party_ws_v3_sync.go` (`/ws/party-sync`: playback). Both share one `PartyState` in `internal/watchparty/manager.go`.
- **Chat** — `chat` in / `chat-message` out, with a per-user rate limiter (`chatRates` in the room handler) and chat history replayed to late joiners.
- **Voice signaling relay** — `voice-join` / `voice-offer` / `voice-answer` / `voice-ice` are already relayed through the room socket, with their own (wider) rate limiter (`voiceRates`). `GET /api/voice/ice-servers` serves STUN/TURN config.
- **Reactions** — `reaction` in/out, `GET /api/parties/{code}/reactions`, and an auto-generated **highlight reel** (`/api/parties/{code}/highlight.mp4`).
- **Join codes** — 6-char `[A-Z0-9]`, with a preflight (`GET /api/code/{code}/info`) that distinguishes a live party from an offline persistent room.
- **Persistent rooms** — `internal/api/room_handlers.go`, `/api/rooms` — stable codes that survive across sessions ("My Rooms").
- **Share images** — `internal/api/party_share.go` already renders PNGs server-side with `golang.org/x/image` (a precedent for **server-rendered QR codes**).
- **Auth** — JWT access/refresh, **5 OAuth providers** (`oauth_google.go`, `oauth_discord.go`, `oauth_twitch.go`, `oauth_facebook.go`, `oauth_twitter.go`), invite codes, and a **scoped-token precedent**: `ScopeCast` in `internal/auth/auth.go` (`CreateCastToken` / `ValidateCastToken`) — a JWT bound to a single resource. A party-guest token would follow this exact pattern.

**Frontend (React + TS + Vite + Tailwind + shadcn/ui, `static/redesign/app`)**
- `components/PartyPanel.tsx` — the existing chat/members/voice/reactions/ready panel (a fixed, fairly opaque 340px right-edge panel — `bg-[#0a0a0f]/95`).
- `components/ReactionOverlay.tsx` — Twitch-style floating emoji + the 9-emoji `ReactionPicker` (`😂 😱 🔥 ❤️ 👏 🤯 😭 💀 🎉`).
- `lib/voice.ts` — a complete WebRTC **mesh** voice controller: mute-by-default, "newcomer initiates," per-peer speaking meters, ICE restart. **Documents its own limit: ~4 participants before fan-out hurts; SFU is noted as future work.**
- `lib/party.ts` — the full wire protocol types; `hooks/useParty.tsx` — state orchestration.
- `components/PartyHubModal.tsx` — the join UX (recently-in / my-rooms / enter-code).
- Routing: **react-router** (`BrowserRouter` in `main.tsx`) + a large state-driven `App.tsx`; `hooks/use-mobile.ts` (768px breakpoint).

**What does *not* exist yet:** a mobile-first route, QR generation, any non-account ("guest") identity, and a voice path that scales past a handful of people.

---

## 2. Architecture — one backend, two surfaces

```
                       ┌─────────────────────────────────────────┐
                       │  Go server  (internal/watchparty/        │
                       │  manager.go — one PartyState per code)   │
                       │                                          │
   /ws/party-room ─────┤  chat · reactions · presence · ready ·   │
   (membership/chat/   │  voice signaling relay (SDP/ICE)         │
    voice signaling)   │                                          │
   /ws/party-sync ─────┤  playback (hello/tick/pause/seek)        │
   (playback)          └───────────────┬──────────────────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
 ┌──────▼───────┐               ┌───────▼────────┐              ┌────────▼────────┐
 │ Big screen   │               │  Big screen    │              │  Phone(s)       │
 │ VIDEO PLAYER │               │  CINEMATIC     │              │  MOBILE         │
 │ (sync socket)│               │  OVERLAY       │              │  COMPANION      │
 │              │               │  (room socket) │              │  (room socket   │
 │              │               │  Feature 2     │              │   only; NO sync)│
 └──────────────┘               └────────────────┘              │  Feature 1      │
                                                                 └─────────────────┘
        ▲                                                                 │
        └──── voice mesh today (≤4) ──── future: audio SFU (N peers) ─────┘
```

Key point: **the mobile companion opens only the room socket.** It doesn't decode video, so it never needs `/ws/party-sync` (it can optionally *read* "now playing / position" for the synced strip, but it never drives playback). That keeps the phone light and avoids HLS/transcode entirely on mobile.

---

## 3. Feature 2 first (Cinematic Overlay) — it's the cheaper win

Because it's mostly a re-skin of `PartyPanel`, this is the fastest way to get something shippable and learn the UX. See [`mockup-cinematic-overlay.html`](./mockup-cinematic-overlay.html).

**Mode A — Docked glass rail.** The current `PartyPanel` already has members, chat, voice strip, ready, reactions. The change is *visual*:
- Drop the opaque `bg-[#0a0a0f]/95` to a translucent glass (`rgba(12,10,20,~0.4)` + `backdrop-blur` + the purple glow-halo tokens already in `index.css`).
- Lift it off the screen edge so it reads as floating, not bolted-on.
- This is **CSS + a couple of layout props.** No protocol or state changes.

**Mode B — Cinematic minimal.** New, but small:
- A lower-third **chat ticker** that fades messages in and auto-dismisses after a few seconds (a thin new component reading the same `state.chat`).
- A **corner voice pill** — condensed view of the existing voice state (talking-avatars from `voice.peers`).
- A pill **mini-dock** (emoji + mic + quick reply).
- A **dock ⇄ minimal** toggle (one piece of view state).

**Cross-cutting for the overlay:**
- **Performance** — heavy `backdrop-filter` over *playing* video is a real GPU cost; Aurora's own `index.css` already calls this out (the media-card blur was dropped for exactly this reason). Budget a perf pass: cap blur radius, avoid stacking blurred layers, and offer a "reduce transparency" setting (it can ride the existing `data-glow` subtle/heavy theme system).
- **Accessibility** — honor `prefers-reduced-motion` (kill the reaction-rise + ticker slide), maintain the WCAG-AA contrast the codebase already tracks, keyboard/focus for the composer.
- **Auto-hide** — fade the overlay on input-idle (like player controls) so "just the movie" is the resting state.

---

## 4. The pivotal decision: who can join?

Today, **joining requires a real Aurora account** — `/ws/party-room` calls `requireQueryTokenClaims`, which needs a JWT with a `UserID`. There is no guest/anonymous identity anywhere in the backend. Your phrasing — *"enters a URL and our code and they get to chat right from there"* — implies low friction, so this is the decision to make:

| Option | Friction for guest | Eng effort | Trade-offs |
|---|---|---|---|
| **A. Account required** (recommended v1) | Sign in once — **one-tap via existing OAuth** (Google/Discord/Twitch/…) | **Low** — reuses all auth | Real identity, moderation, rate limits all "just work." A friend with no account must sign up (one tap). |
| **B. Scoped guest token** (recommended fast-follow) | Just type a display name | **Medium** | True "anyone with the link." New work: a `ScopePartyGuest` JWT bound to one party code (mirrors `ScopeCast`), name sanitization, guest-specific rate limits + abuse controls, host "allow guests?" toggle, and deciding what a guest *can't* do (no library access, no host powers). |
| **C. Magic-link invite** | Click host's link, no code typing | Medium | Nice UX layer on top of A or B; not a standalone auth model. |

**Recommendation:** Ship **A** first (mobile route + QR + one-tap OAuth gets you a working companion fast and safely), then add **B** as a deliberate, security-reviewed follow-up if you want open-link parties. This sequencing means Feature 1 v1 has *no risky new auth surface*.

> This is the main thing I'd want your call on before building Feature 1. Everything else has a sensible default.

---

## 5. Feature 1 (Mobile Companion) — detail

See [`mockup-mobile-companion.html`](./mockup-mobile-companion.html).

**5.1 The mobile route**
- Add a `/join` (and `/join/:code`) route in the existing react-router setup. It renders a standalone mobile shell — *not* the full app chrome, *not* the video player.
- It opens **only** `/ws/party-room` and reuses `useParty` (or a trimmed `useCompanion`) for chat/reactions/voice. No HLS, no sync socket driving playback.
- Optional "now playing" strip: read the party's media title + position from `party-state` for a synced read-only indicator.

**5.2 Join flow**
- Big OTP-style 6-box code entry (the app already validates `^[A-Z0-9]{6}$`), with the live "now playing" preview from the existing `GET /api/code/{code}/info` preflight.
- **QR** path: host screen shows a QR encoding `https://host/join/<CODE>`; phone scans → lands pre-filled. QR can be generated client-side (tiny JS lib) or **server-side reusing the `party_share.go` image pipeline** (so it can be embedded in the existing share image too).
- Auth per [§4](#4-the-pivotal-decision-who-can-join).

**5.3 Voice on mobile**
- The existing `lib/voice.ts` mesh works in mobile Safari/Chrome (`getUserMedia` + WebRTC) — but its **~4-peer ceiling is the real constraint.** A 6–10 person movie night needs a server-side **audio SFU** (each client sends one upstream, receives one mixed/forwarded downstream). This is the single biggest backend lift; see [§7](#7-voice-at-scale-meshsfu).
- Mobile-specific care: background-tab / screen-lock audio behavior, `playsinline`, the existing OS-vs-browser mic-permission messaging (already handled in `voice.ts`).

**5.4 Reactions & chat** — reused as-is. Reactions fired from a phone broadcast to everyone, including the Feature-2 overlay on the big screen. That cross-device loop is the "magic moment."

---

## 6. Data model & API additions

Most of this exists. Net-new is small:

- **Guest identity (only if Option B):** a `party_guest` token scope + a lightweight guest participant record (display name, color, no user row) in `PartyState`. Touches `auth.go`, `manager.go` participant handling, and the room handler's identity extraction.
- **QR / deep-link:** a `GET /api/parties/{code}/qr.png` (or fold into `party_share.go`), plus the `/join/:code` route. No DB change.
- **Companion presence flag (nice-to-have):** mark a participant as `companion: true` so the UI can show "📱 on phone" and so a companion's disconnect doesn't trigger host-style cleanup.
- **Host controls (Option B):** an "allow guests" boolean + optional "approve to join" on the party/room record.

No schema changes are required for Feature 2 or for Feature 1 under Option A.

---

## 7. Voice at scale (mesh→SFU)

`lib/voice.ts` is explicit: full-mesh is fine to ~4, then upstream bandwidth scales O(n) per client. Options, cheapest first:
1. **Keep mesh, cap voice at ~4**, with a clear "voice full" state. Zero backend work; ships now. Fine for small movie nights.
2. **Integrate an SFU** (e.g. Pion-based, since the stack is already Go; or LiveKit/mediasoup as a sidecar). Clients send one stream up, get others down. Moderate-to-large backend project; unlocks big parties and is the right long-term home for mobile voice.

Recommendation: **ship on the mesh (capped)**, and treat the SFU as its own milestone once companion voice has real usage.

---

## 8. Security, moderation, abuse

- **Reuse** the existing chat + voice **rate limiters** (`chatRates`, `voiceRates`) and WS **origin checks** for both new surfaces.
- **Guests (Option B)** widen the attack surface: sanitize/limit display names, scope the token to one code with a short TTL, add per-guest rate limits, and give the host a kick/mute + "lock party" control.
- **Reuse** the `ReactionOverlay` `data-screenshot-exclude` pattern so companion/overlay chat doesn't leak into bug-report screenshots.
- **Don't** expose feature-flag or party state to unauthenticated callers (the codebase already follows this for feedback config).

---

## 9. Phasing & rough effort

Sizing is relative (S ≈ a few days, M ≈ 1–2 weeks, L ≈ multiple weeks), assuming one engineer familiar with the stack. Each phase is independently shippable.

| Phase | Scope | Size | Net-new vs reuse |
|---|---|---|---|
| **0. Spike** | Confirm mobile Safari/Chrome WebRTC + room socket from a phone on the LAN; validate the [§4](#4-the-pivotal-decision-who-can-join) auth choice | **S** | — |
| **1. Cinematic overlay – Mode A** | Restyle `PartyPanel` to translucent/floating glass; perf + reduced-motion pass | **S–M** | mostly reuse |
| **2. Cinematic overlay – Mode B** | Minimal ticker, corner voice pill, mini-dock, dock⇄minimal toggle, auto-hide | **M** | new UI, reused data |
| **3. Mobile companion – shell** | `/join` route + mobile shell + room-socket-only `useCompanion`; chat + reactions + now-playing strip | **M** | new surface, reused protocol |
| **4. Join polish** | QR generation + `/join/:code` deep link + OAuth one-tap join | **S–M** | new, reuses `party_share` + OAuth |
| **5. Companion voice** | Mic toggle / push-to-talk on mobile via existing mesh (capped ~4) | **S–M** | reuse `voice.ts` |
| **6. (Decision) Guest tokens** | `ScopePartyGuest`, name handling, host allow/lock, guest rate limits | **M** | new backend |
| **7. (Decision) Audio SFU** | Server-side audio forwarding for big parties | **L** | new backend |

A natural **v1** is Phases 1–5 (overlay + an account-based mobile companion with small-party voice). Phases 6–7 are the "open it up / scale it up" investments, gated on your call in [§4](#4-the-pivotal-decision-who-can-join) and [§7](#7-voice-at-scale-meshsfu).

---

## 10. Risks & open questions

**Risks**
- **Blur-over-video perf** on weak GPUs / TVs — mitigate with a blur budget + a "reduce transparency" toggle (the codebase already worries about this).
- **Mobile WebRTC reliability** across NAT/proxies — depends on TURN being configured (`/api/voice/ice-servers`); the LAN-only fallback STUN won't traverse all networks.
- **Voice fan-out** past 4 without the SFU — set expectations / cap clearly.
- **Guest abuse** (Option B) — names, spam, scraping — needs the moderation controls above before it's public.

**Open questions for you**
1. **Auth model for the companion** — Option A (account + one-tap OAuth, recommended v1) vs B (open guest links)? *(the one real blocker)*
2. **Party size** you want to support for **voice** — does the small-party mesh cover your use, or is a big-party SFU in scope?
3. **Companion scope** — phone is chat/voice/emoji only (assumed), or do you also want phone-side transport controls (pause/seek the big screen)?
4. **Overlay default** — should the big screen default to Mode A (rail) or Mode B (minimal)?

---

## 11. Suggested next step

If you want to proceed, the lowest-risk, highest-signal start is **Phase 1 (translucent overlay restyle)** — it's small, ships visible value, and validates the aesthetic on real video — run in parallel with the **Phase 0 spike** to lock the [§4](#4-the-pivotal-decision-who-can-join) auth decision before any companion backend work. All of this would go through the standard fix-request pipeline (branch → implement + tests → build/test → deep-debug review → merge).

*Nothing here is committed — these are proposal docs + static mockups. Say the word and I'll turn a phase into a real branch.*
