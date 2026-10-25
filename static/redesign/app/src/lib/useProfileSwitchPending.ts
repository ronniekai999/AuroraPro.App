// True on the render that changes the session's profile, until the effects of
// that commit have run.
//
// App clears what it kept for the previous profile in PASSIVE effects: the
// hero reset, the home-rails effect's cold load, resetForProfileChange (the
// grids, Continue Watching, the conversational rail, an open title) and the My
// Library snapshot swap. The commit that changes `activeProfileId` already
// shows the new profile's name in the top bar, and a switch lands from a
// resolved promise, which React renders at default priority: it may let the
// browser paint before it runs that commit's passive effects. That frame showed
// the previous profile's hero, rails and lists under the new profile's name (a
// review saw it on about half of all switches in the built app), and what it
// shows was fetched under the previous profile's ceiling.
//
// Views pass their cold state while this is true. It flips back in the same
// passive flush as those resets (its own effect runs beside them, and React
// batches the state they set into one render), so the next commit shows the
// cleared state itself.
//
// The startup binding arriving is not a switch: null to an id before the
// startup load has settled is not pending, and the resets skip it too. After
// it has settled, null to an id is a pick from the picker the app opens when
// the binding could not be read. The catalog behind that picker was fetched
// under the binding the server does have, so that pick is pending, and the
// resets treat it as the switch it is. `startupSettled` is App's
// profilesSettled.

import { useEffect, useState } from 'react'

export function useProfileSwitchPending(activeProfileId: number | null, startupSettled: boolean): boolean {
  // The profile whose switch effects have run, and whether the startup load
  // had settled when they did.
  const [seen, setSeen] = useState({ id: activeProfileId, startupSettled })
  useEffect(() => {
    // The same object when nothing changed, so mounting costs App no render.
    setSeen(prev => (prev.id === activeProfileId && prev.startupSettled === startupSettled
      ? prev : { id: activeProfileId, startupSettled }))
  }, [activeProfileId, startupSettled])
  return seen.id !== activeProfileId && (seen.id !== null || seen.startupSettled)
}
