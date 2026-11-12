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

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || layers.length === 0) return
  // Capture phase on window, so nothing below has seen it yet; stopped for
  // the app's handler and for any other listener on window.
  e.stopImmediatePropagation()
  layers[layers.length - 1]()
}

/** Register something Escape should close. Returns the function that
 *  unregisters it (when it closes for any reason, or unmounts). */
export function pushEscapeLayer(close: Close): () => void {
  layers.push(close)
  if (layers.length === 1) window.addEventListener('keydown', onKeyDown, true)
  return () => {
    const i = layers.lastIndexOf(close)
    if (i >= 0) layers.splice(i, 1)
    if (layers.length === 0) window.removeEventListener('keydown', onKeyDown, true)
  }
}
