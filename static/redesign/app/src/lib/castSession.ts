// Aurora V2 — which transcode session the CAST RECEIVER is streaming.
//
// This is bookkeeping, not transport, and it is the whole of the fix for a
// leak that could take local playback down with it — so it lives here, as a
// plain state machine over two slots, rather than as four refs and some
// ordering luck inside VideoPlayer's 5000 lines.
//
// WHY IT EXISTS. Every cast-token mint asks the server for a cast-safe clone,
// and CloneForCast creates a NEW session each time — it never reuses one, and
// it clones for ANY subtitle track, so cloning is the normal path. Nothing on
// the server deletes a clone; it only ages out, and once a session is on the
// 30-minute cast lease that wait is long. The per-user session cap is 3, so
// stranding one clone per re-point (next episode, seek-while-casting rebuild,
// token renewal) exhausts the cap within one sitting: the next mint 429s, the
// cast dies, and because the same cap gates ordinary playback, LOCAL playback
// starts failing too.
//
// The client is the only party that can fix this, because it is the only one
// that knows when the receiver has actually moved off a session — it is the
// one issuing loadMedia.
//
// WHY TWO SLOTS. "The session we minted" and "the session the receiver is on"
// are different facts, and conflating them leaks in both directions:
//
//   - promote at MINT time and a failed load (a load_failed, a receiver
//     stall, a token assertion throwing) leaves a session the receiver never
//     touched pinned by the keepalive ping for the rest of the viewing;
//   - never promote and there is nothing to release when the next re-point
//     lands.
//
// So `pending` is written at mint, and only a resolved loadMedia promotes it
// to `committed` — at which point whatever it replaced is released.

export interface CastSessionTrackerDeps {
  // The session the LOCAL <video> is playing, read fresh on every call.
  // Never released here: that one is the player teardown's to dispose of,
  // and deleting it would tear down local playback. When the server decides
  // no clone is needed (H.264 + AAC, no subtitle tracks) the receiver shares
  // it, which is exactly when this guard earns its keep.
  localSessionId: () => string | null
  // Fire-and-forget DELETE. Best-effort by contract — the server's idle
  // sweep remains the backstop for a sender frozen or killed before it could
  // call this.
  release: (sessionId: string) => void
}

export interface CastSessionTracker {
  // A cast token was just minted for `id` (null = the playlist URL was not a
  // shape we recognize; treated as "no separate cast session").
  notePending: (id: string | null) => void
  // loadMedia resolved: the receiver is now on the pending session.
  commit: () => void
  // The load failed. The receiver never touched the pending session, so
  // nothing will ever fetch it.
  abandon: () => void
  // The cast is over (receiver disconnected, user stopped it). Nothing will
  // fetch either slot again.
  end: () => void
  // The session the receiver is on, or null. This — not the pending one — is
  // what the keepalive ping and the teardown guard key off.
  committed: () => string | null
}

export function createCastSessionTracker(deps: CastSessionTrackerDeps): CastSessionTracker {
  let pending: string | null = null
  let committed: string | null = null

  const release = (id: string | null) => {
    // Nothing to do for the empty case, and never the local session.
    if (!id || id === deps.localSessionId()) return
    deps.release(id)
  }

  return {
    notePending(id) {
      // A pending mint that is still here when the next one arrives was
      // superseded without ever being loaded. Callers serialize their loads
      // precisely so this cannot happen (see VideoPlayer's cast-load gate),
      // which makes this the defensive branch — but silently dropping the
      // reference is how the leak this file exists to close got in, so
      // release it rather than trust the caller.
      if (pending && pending !== id && pending !== committed) release(pending)
      pending = id
    },
    commit() {
      const next = pending
      pending = null
      // A re-mint that resolved to the same session (the shared-session case,
      // or a server that handed back the original) replaces nothing.
      if (!next || next === committed) return
      const previous = committed
      // Advance FIRST. A release is asynchronous and an in-flight keepalive
      // may be settling against the old id; anything reading `committed`
      // mid-flight must already see the new one, or it will read our own
      // DELETE as a server-side death and tear down a healthy cast.
      committed = next
      release(previous)
    },
    abandon() {
      const stillborn = pending
      pending = null
      if (stillborn !== committed) release(stillborn)
    },
    end() {
      const wasPending = pending
      const finished = committed
      pending = null
      committed = null
      if (wasPending !== finished) release(wasPending)
      release(finished)
    },
    committed: () => committed,
  }
}
