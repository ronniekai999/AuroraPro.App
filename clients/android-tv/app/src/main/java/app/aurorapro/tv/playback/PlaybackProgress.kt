package app.aurorapro.tv.playback

internal data class PlaybackCheckpoint(val positionMs: Long, val durationMs: Long)

/** A requested Media3 start position is not watch progress until that item is ready. */
internal class PlaybackProgress {
    private var ready = false
    private var lastCheckpoint: PlaybackCheckpoint? = null

    fun checkpoint(positionMs: Long, durationMs: Long): PlaybackCheckpoint? {
        if (ready) lastCheckpoint = PlaybackCheckpoint(positionMs, durationMs)
        return lastCheckpoint
    }

    fun beginLoad(positionMs: Long, durationMs: Long) {
        checkpoint(positionMs, durationMs)
        ready = false
    }

    fun onReady() { ready = true }
}
