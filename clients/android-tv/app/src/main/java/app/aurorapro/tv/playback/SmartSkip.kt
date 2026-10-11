package app.aurorapro.tv.playback

import app.aurorapro.tv.data.SkipMarker

internal fun validSkipMarkers(markers: List<SkipMarker>, durationMs: Long): List<SkipMarker> = markers.filter {
    it.kind in setOf("recap", "intro", "credits") && it.startMs >= 0 && it.endMs > it.startMs &&
        (durationMs <= 0 || it.endMs <= durationMs)
}

internal fun skipDestination(marker: SkipMarker): Long =
    if (marker.kind == "credits") maxOf(marker.startMs, marker.endMs - 1000) else marker.endMs

internal fun activeSkipMarker(markers: List<SkipMarker>, positionMs: Long, episode: Boolean,
                              bufferedSourceMs: Long?, dismissed: SkipMarker?): SkipMarker? = markers.firstOrNull {
    it != dismissed && (it.kind != "credits" || !episode) && positionMs >= it.startMs && it.endMs - positionMs > 1000 &&
        // A sequential HLS encoder may not have produced the movie's tail.
        // Never rebuild at approximate EOF just to skip credits.
        (it.kind != "credits" || bufferedSourceMs == null || skipDestination(it) <= bufferedSourceMs - 1000)
}

internal fun SkipMarker.label(): String = when (kind) {
    "recap" -> "Skip Recap"
    "credits" -> "Skip Credits"
    else -> "Skip Intro"
}

internal data class EpisodePrompt(val offered: Boolean = false, val seconds: Int? = null, val advance: Boolean = false)

/** One episode's autoplay intent. Time runs only while observed playback runs. */
internal class EpisodeAutoplay {
    private var armed = false
    private var cancelled = false
    private var spent = false
    private var remainingMs = 5000L
    private var lastTick: Long? = null

    fun pause() { lastTick = null }
    fun cancel() { cancelled = true; armed = false; lastTick = null }
    fun consume() { spent = true; armed = false; lastTick = null }
    fun seek() { armed = false; remainingMs = 5000; lastTick = null }
    fun replay() { cancelled = false; spent = false; seek() }

    fun sample(positionMs: Long, creditsStartMs: Long?, ended: Boolean, playing: Boolean,
               ready: Boolean, canAdvance: Boolean, autoplay: Boolean, blocked: Boolean, nowMs: Long): EpisodePrompt {
        if (spent || cancelled) { lastTick = null; return EpisodePrompt() }
        if (creditsStartMs == null || positionMs < creditsStartMs - 1000) seek()
        val eligible = ready && canAdvance && !blocked
        if (ended && eligible && autoplay) { consume(); return EpisodePrompt(advance = true) }
        if (!armed && eligible && (playing || ended) && (ended || (creditsStartMs != null && positionMs >= creditsStartMs))) {
            armed = true; remainingMs = 5000; lastTick = null
        }
        val ticking = armed && eligible && playing && autoplay
        if (ticking) {
            lastTick?.let { remainingMs = (remainingMs - (nowMs - it).coerceAtLeast(0)).coerceAtLeast(0) }
            lastTick = nowMs
            if (remainingMs == 0L) { consume(); return EpisodePrompt(advance = true) }
        } else lastTick = null
        return EpisodePrompt(offered = armed, seconds = if (armed && autoplay) ((remainingMs + 999) / 1000).toInt() else null)
    }
}
