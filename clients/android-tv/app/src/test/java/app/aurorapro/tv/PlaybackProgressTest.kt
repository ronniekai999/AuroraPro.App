package app.aurorapro.tv

import app.aurorapro.tv.playback.PlaybackCheckpoint
import app.aurorapro.tv.playback.PlaybackProgress
import org.junit.Assert.*
import org.junit.Test

class PlaybackProgressTest {
    @Test fun anInitialResumeThatNeverBecomesReadyDoesNotCreateWatchProgress() {
        val progress = PlaybackProgress()
        progress.beginLoad(350_000, 360_000)
        assertNull(progress.checkpoint(350_000, 360_000))
    }

    @Test fun aReplacementAwaitingItsPlaylistKeepsTheLastPlayablePositionForPeriodicAndFinalSaves() {
        val progress = PlaybackProgress()
        progress.onReady()
        progress.beginLoad(32_000, 360_000)
        // Media3 exposes the requested 99% seek before it can load any media.
        val outgoing = PlaybackCheckpoint(32_000, 360_000)
        assertEquals(outgoing, progress.checkpoint(356_000, 360_000))
        assertEquals(outgoing, progress.checkpoint(356_000, 360_000))
    }

    @Test fun failedReplacementsAndFallbackRetriesCannotOverwriteTheOutgoingCheckpoint() {
        val progress = PlaybackProgress()
        progress.onReady()
        progress.beginLoad(32_000, 360_000)
        repeat(3) {
            progress.beginLoad(356_000, 400_000)
            assertEquals(PlaybackCheckpoint(32_000, 360_000), progress.checkpoint(356_000, 400_000))
        }
    }

    @Test fun aReadyReplacementCanCommitItsOwnSourcePositionAndDuration() {
        val progress = PlaybackProgress()
        progress.onReady()
        progress.beginLoad(32_000, 360_000)
        progress.onReady()
        assertEquals(PlaybackCheckpoint(356_000, 400_000), progress.checkpoint(356_000, 400_000))
    }
}
