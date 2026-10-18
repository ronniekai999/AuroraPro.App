// Calls onChange whenever the session's profile changes after it was first
// seen, to or from unknown (null) included. The server filters what it
// returns by the session's profile when it is fetched, so anything the app
// kept from before a switch was filtered for the previous profile.

import { useEffect, useRef } from 'react'

export function useOnProfileChange(activeProfileId: number | null, onChange: () => void) {
  // null until the first render; then the profile last seen.
  const seenRef = useRef<{ id: number | null } | null>(null)
  useEffect(() => {
    const seen = seenRef.current
    seenRef.current = { id: activeProfileId }
    if (seen === null || seen.id === activeProfileId) return
    onChange()
  }, [activeProfileId, onChange])
}
