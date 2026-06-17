// App-local media types shared by App and the lazy view chunks (BrowseView,
// and later DetailView / LibraryView). Extracted from App.tsx (2026-06-17
// app split, Phase 2.4) so the lazy chunks can type their props without
// reaching back into App. Distinct from @/lib/api's UIMedia (the server-
// shaped item) — do NOT reconcile the two here; Media is the app-side
// shape handleSelect/select normalize server items into.

export interface Media {
  id: number
  title: string
  year: number
  rating: number
  duration: string
  genre: string
  type: 'movie' | 'show' | 'anime'
  poster: string
  backdrop?: string
  description: string
  progress?: number
  episodes?: Episode[]
  cast?: string[]
  tags?: string[]
  // LLM-generated per-pick reason. Populated for items that came from
  // a personalized endpoint (Hero rerank, Discover rails). MediaCard
  // surfaces this as a hover tooltip on cards in those rails.
  reason?: string
}

export interface Episode {
  id: number
  title: string
  number: number
  duration: string
  description: string
  thumb: string
}