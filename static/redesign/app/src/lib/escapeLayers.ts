// One Escape closes one thing: the layer opened last.
//
// The player's menus, the reaction picker and the party's leave confirmation
// can be open together, and each has to close on Escape without the key
// reaching the app's own handler (which closes the player or leaves the
// page). When each listened on window for itself, one press closed all of
// them at once: stopping propagation does not stop the other listeners on
// the same node. They register here instead, and a single listener hands the
// key to the newest layer only.

type Close = () => void

const layers: Close[] = []

/** Marks a surface whose layers register here: the player, the party's leave
 *  confirmation, the trailer. */
export const ESCAPE_LAYERS_ATTR = 'data-escape-layers'

/** Whether a key's target sits in a dialog that is none of those surfaces: a
 *  prompt the app opened above them from somewhere else (the profile picker
 *  or a PIN prompt, when another tab switches the profile). Its keys are its
 *  own: taking its Escape would close a layer underneath it and leave it up,
 *  and pulling its Tab would take focus out from under it. */
export function inForeignDialog(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest('[role="dialog"], [role="alertdialog"]') && !target.closest(`[${ESCAPE_LAYERS_ATTR}]`)
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || layers.length === 0) return
  if (inForeignDialog(e.target)) return
  // Capture phase on window, so nothing below has seen it yet. Stopped for
  // the app's handler and for the listeners on window registered after this
  // one; a capture listener added to window EARLIER has already run.
  e.stopImmediatePropagation()
  layers[layers.length - 1]()
}

/** Register something Escape should close. Returns the function that
 *  unregisters it (when it closes for any reason, or unmounts). */
export function pushEscapeLayer(close: Close): () => void {
  // Each registration is its own entry, so the same function registered
  // twice is two layers, and calling an unregister twice removes one.
  const entry: Close = () => close()
  layers.push(entry)
  if (layers.length === 1) window.addEventListener('keydown', onKeyDown, true)
  return () => {
    const i = layers.indexOf(entry)
    if (i < 0) return
    layers.splice(i, 1)
    if (layers.length === 0) window.removeEventListener('keydown', onKeyDown, true)
  }
}
