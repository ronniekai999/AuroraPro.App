package app.aurorapro.tv

import app.aurorapro.tv.data.SkipMarker
import app.aurorapro.tv.playback.*
import org.junit.Assert.*
import org.junit.Test

class SmartSkipTest {
    private val intro = SkipMarker("intro", 30_000, 60_000)
    private val credits = SkipMarker("credits", 90_000, 100_000)

    @Test fun markerContractIgnoresSuppressedUnknownNegativeAndOutOfFileWindows() {
        assertEquals(listOf(intro, credits), validSkipMarkers(listOf(intro, credits, SkipMarker("intro", 0, 0),
            SkipMarker("outro", 10, 20), SkipMarker("intro", -1, 20), SkipMarker("credits", 90_000, 110_000)), 100_000))
    }

    @Test fun resumedHlsUsesReturnedSourceOffsetAndSkipDestination() {
        val timeline = SourceTimeline(28_000, 100_000)
        assertNull(activeSkipMarker(listOf(intro), timeline.sourcePosition(1000), false, 40_000, null))
        assertEquals(intro, activeSkipMarker(listOf(intro), timeline.sourcePosition(3000), false, 40_000, null))
        assertEquals(32_000L, timeline.playerPosition(skipDestination(intro)))
        assertNull(activeSkipMarker(listOf(intro), 59_000, false, 100_000, null))
        assertNull(activeSkipMarker(listOf(intro), 31_000, false, 100_000, intro))
    }

    @Test fun movieCreditsCannotRebuildASequentialTranscodeAtUnproducedEof() {
        assertNull(activeSkipMarker(listOf(credits), 92_000, false, 98_000, null))
        assertEquals(credits, activeSkipMarker(listOf(credits), 92_000, false, 100_000, null))
        assertEquals(99_000L, skipDestination(credits))
        assertEquals(credits, activeSkipMarker(listOf(credits), 92_000, false, null, null))
        assertNull(activeSkipMarker(listOf(credits), 92_000, true, null, null))
    }

    @Test fun creditsCountdownFreezesDuringPauseBufferingAndInteraction() {
        val autoplay = EpisodeAutoplay()
        fun tick(now: Long, playing: Boolean = true, blocked: Boolean = false) =
            autoplay.sample(90_000, 90_000, false, playing, true, true, true, blocked, now)
        assertEquals(5, tick(0).seconds)
        assertEquals(4, tick(1000).seconds)
        autoplay.pause()
        assertEquals(4, tick(20_000, playing = false).seconds)
        assertEquals(4, tick(30_000).seconds)
        assertEquals(3, tick(31_000).seconds)
        assertEquals(3, tick(40_000, blocked = true).seconds)
        assertEquals(3, tick(50_000).seconds)
        assertEquals(2, tick(51_000).seconds)
        assertTrue(tick(53_000).advance)
        assertFalse(tick(60_000).advance)
    }

    @Test fun anUnreadySeekAnUnloadedNextEpisodeAndBackgroundCannotAdvance() {
        val autoplay = EpisodeAutoplay()
        fun tick(now: Long, ready: Boolean, next: Boolean = true, blocked: Boolean = false) =
            autoplay.sample(99_000, 90_000, true, false, ready, next, true, blocked, now)
        assertFalse(tick(0, ready = false).advance)
        assertFalse(tick(1000, ready = true, next = false).advance)
        assertFalse(tick(10_000, ready = true, blocked = true).advance)
        assertTrue(tick(11_000, ready = true).advance)
        assertFalse(tick(12_000, ready = true).advance)
    }

    @Test fun autoplayOffLeavesCreditsAndNaturalEndAsExplicitActions() {
        val autoplay = EpisodeAutoplay()
        val prompt = autoplay.sample(90_000, 90_000, false, true, true, true, false, false, 0)
        assertTrue(prompt.offered)
        assertNull(prompt.seconds)
        assertFalse(autoplay.sample(100_000, 90_000, true, false, true, true, false, false, 60_000).advance)
        assertTrue(autoplay.sample(100_000, 90_000, true, false, true, true, true, false, 61_000).advance)
    }

    @Test fun watchCreditsCancelsTheRestOfThisEpisodeButReplayGetsAFreshCountdown() {
        val autoplay = EpisodeAutoplay()
        autoplay.sample(90_000, 90_000, false, true, true, true, true, false, 0)
        autoplay.cancel()
        assertFalse(autoplay.sample(100_000, 90_000, true, false, true, true, true, false, 10_000).advance)
        autoplay.replay()
        assertEquals(5, autoplay.sample(90_000, 90_000, false, true, true, true, true, false, 20_000).seconds)
    }

    @Test fun seekingBackToTheFinalSceneDisarmsTheCountdown() {
        val autoplay = EpisodeAutoplay()
        autoplay.sample(90_000, 90_000, false, true, true, true, true, false, 0)
        autoplay.sample(91_000, 90_000, false, true, true, true, true, false, 1000)
        assertFalse(autoplay.sample(80_000, 90_000, false, true, true, true, true, false, 2000).offered)
        assertEquals(5, autoplay.sample(90_000, 90_000, false, true, true, true, true, false, 10_000).seconds)
        autoplay.seek()
        assertFalse(autoplay.sample(95_000, 90_000, false, false, false, true, true, true, 20_000).offered)
    }

    @Test fun episodesWithoutMarkersAdvanceOnlyAtTheObservedNaturalEnd() {
        val autoplay = EpisodeAutoplay()
        assertFalse(autoplay.sample(99_999, null, false, true, true, true, true, false, 0).advance)
        assertTrue(autoplay.sample(100_000, null, true, false, true, true, true, false, 1000).advance)
    }
}
