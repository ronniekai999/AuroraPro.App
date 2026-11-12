// The reactions a watch party offers, on the big screen's picker and on the
// phone companion.
//
// The server accepts a reaction only from its own list (allowedReactions in
// internal/watchparty/manager.go) and refuses anything else, after it has
// counted the press against the sender's rate limit. So each one here is on
// that list, as the exact characters the server holds: reactions.test.ts
// reads the list out of the server's source and fails when this offers one
// it would refuse.

/** What is SENT for the heart: the bare character, which is what the server
 *  lists. Drawn through drawnReaction, never as it is. */
const HEART = '\u2764'

/** The nine offered, in the order they are shown, as sent. */
export const QUICK_REACTIONS: readonly string[] = ['😂', '😱', '🔥', HEART, '👏', '😮', '😭', '👍', '🎉']

/** A reaction as it is DRAWN. A bare heart is a text glyph on some systems
 *  (a small black heart); the variation selector asks for the emoji. For a
 *  reaction this app sent and for one received from anyone. */
export function drawnReaction(emoji: string): string {
  return emoji === HEART ? `${HEART}\uFE0F` : emoji
}
