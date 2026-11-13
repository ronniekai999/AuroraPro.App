// The Undo on "Removed <title> from My Library."
//
// It puts the title back, and does only that. Whether it may is one
// question with two halves, asked when Undo is pressed:
//
//   - The list on screen is still the one the title was removed from: the
//     same account and profile (`ownerThen`, the list's key at the removal,
//     against `ownerNow`). The request that puts it back names the profile
//     it was removed for, so on another profile's list Undo would edit a
//     list its viewer is not looking at.
//   - The title is not in that list. If it is (the removal failed and was
//     taken back, or its viewer saved it again by hand), there is nothing to
//     undo, and a toggle here would remove it.
//
// App drops a toast when the profile or the account changes, so the first
// half is a second line behind that one.

export function undoMayRestore(
  ownerNow: string | null,
  ownerThen: string | null,
  list: readonly { id: number }[],
  mediaId: number,
): boolean {
  if (ownerThen === null || ownerNow !== ownerThen) return false
  return !list.some(i => i.id === mediaId)
}
