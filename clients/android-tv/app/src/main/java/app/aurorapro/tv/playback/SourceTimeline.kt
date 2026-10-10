package app.aurorapro.tv.playback

/** HLS time starts at zero after FFmpeg's -ss; progress always uses source milliseconds. */
data class SourceTimeline(val offsetMs: Long, val durationMs: Long) {
    fun sourcePosition(playerMs: Long): Long = (offsetMs + playerMs.coerceAtLeast(0)).let {
        if (durationMs > 0) it.coerceAtMost(durationMs) else it
    }
    fun playerPosition(sourceMs: Long): Long = (sourceMs - offsetMs).coerceAtLeast(0)
    fun seekPosition(sourceMs: Long): Long = if (durationMs > 0) sourceMs.coerceIn(0, (durationMs - 1000).coerceAtLeast(0))
        else sourceMs.coerceAtLeast(0)
}
