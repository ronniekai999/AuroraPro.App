package app.aurorapro.tv

import android.view.KeyEvent
import androidx.compose.runtime.*
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.media3.common.Player
import androidx.media3.ui.PlayerView
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.platform.app.InstrumentationRegistry
import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.PlayerScreen
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Job
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Source-clock skips and title handoffs run against real Media3 and a local HLS fixture. */
@OptIn(ExperimentalTestApi::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class SmartSkipPlaybackTest {
    @get:Rule val compose = createComposeRule()

    @Test fun skippingAnIntroRebuildsBeyondThePlaylistAtTheSourceTimeAndKeepsPause() = withPlayer(credits = false) { fixture ->
        fixture.ready(1)
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Skip Intro").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Resume").assertIsFocused()
        remote(KeyEvent.KEYCODE_DPAD_UP)
        remote(KeyEvent.KEYCODE_DPAD_UP)
        if (compose.onAllNodes(hasText("Skip Intro") and isFocused()).fetchSemanticsNodes().isEmpty()) {
            remote(KeyEvent.KEYCODE_DPAD_LEFT)
        }
        compose.onNodeWithText("Skip Intro").assertIsFocused()
        remote(KeyEvent.KEYCODE_DPAD_CENTER)
        fixture.ready(2)
        val replacement = fixture.requests.last { it.method == "POST" }
        assertEquals("90", apiJson.parseToJsonElement(replacement.body.clone().readUtf8()).jsonObject["start_sec"]!!.jsonPrimitive.content)
        compose.runOnIdle { assertFalse(fixture.view.player!!.playWhenReady) }
        choose("Back to title")
        compose.waitUntil(10_000) { fixture.requests.any { it.method == "PUT" } }
        val saved = apiJson.parseToJsonElement(fixture.requests.last { it.method == "PUT" }.body.clone().readUtf8()).jsonObject
        assertEquals("7", saved["profile_id"]!!.jsonPrimitive.content)
        assertEquals("101", saved["episode_id"]!!.jsonPrimitive.content)
        assertEquals(90_000L, saved["position_ms"]!!.jsonPrimitive.content.toLong())
    }

    @Test fun watchCreditsCancelsAutoplayAndExplicitNextCreatesAFreshPlayerWithTheSavedPreference() = withPlayer { fixture ->
        fixture.ready(1)
        compose.waitUntil(10_000) { compose.onAllNodes(hasText("Next episode in", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        choose("Watch credits")
        compose.mainClock.advanceTimeBy(8000)
        assertEquals(0, fixture.advances.get())
        compose.onAllNodes(hasText("Next episode in", substring = true)).assertCountEquals(0)
        choose("Settings")
        choose("Auto-play next episode · On")
        compose.onNodeWithText("Auto-play next episode · Off").assertExists()
        choose("Close")
        choose("Next episode")
        fixture.ready(2)
        compose.onNodeWithText("S1E2 · Second").assertExists()
        compose.waitUntil(10_000) { fixture.outgoingSaved?.isCompleted == true }
        assertEquals(1, fixture.advances.get())
        val firstSave = fixture.requests.first { it.method == "PUT" }
        assertEquals("101", apiJson.parseToJsonElement(firstSave.body.clone().readUtf8()).jsonObject["episode_id"]!!.jsonPrimitive.content)
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        choose("Settings")
        compose.onNodeWithText("Auto-play next episode · Off").assertExists()
    }

    @Test fun aCreditsCountdownAdvancesOnceAndSavesTheOutgoingEpisode() = withPlayer { fixture ->
        fixture.ready(1)
        compose.waitUntil(20_000) { fixture.advances.get() == 1 }
        fixture.ready(2)
        compose.waitUntil(10_000) { fixture.outgoingSaved?.isCompleted == true }
        val saved = apiJson.parseToJsonElement(fixture.requests.first { it.method == "PUT" }.body.clone().readUtf8()).jsonObject
        assertEquals("101", saved["episode_id"]!!.jsonPrimitive.content)
        assertTrue(saved["position_ms"]!!.jsonPrimitive.content.toLong() >= 30_000)
        assertEquals(2, fixture.sessions.get())
        assertEquals(1, fixture.advances.get())
    }

    @Test fun anUnloadedResumeCannotArmTheCreditsCountdownOrEnableNext() = withPlayer(holdManifest = true) { fixture ->
        assertTrue(fixture.manifestEntered.await(10, TimeUnit.SECONDS))
        compose.mainClock.advanceTimeBy(10_000)
        compose.onNodeWithText("Next episode").assertIsNotEnabled()
        compose.onAllNodes(hasText("Next episode in", substring = true)).assertCountEquals(0)
        assertEquals(0, fixture.advances.get())
        fixture.releaseManifest.countDown()
    }

    @Test fun aSlowProgressSaveDoesNotStallAutoplayOrLoseTheOutgoingSaveBarrier() =
        withPlayer(holdProgress = true, creditsStartMs = 45_000) { fixture ->
            fixture.ready(1)
            remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
            fixture.holdFirstProgressSave()
            // Keep the real player inside credits with ample media before EOF.
            compose.runOnIdle { fixture.view.player!!.seekTo(17_000) }
            remote(KeyEvent.KEYCODE_MEDIA_PLAY)
            compose.waitUntil(8000) { fixture.advances.get() == 1 }
            compose.runOnIdle { assertFalse(fixture.outgoingSaved!!.isCompleted) }
            assertEquals(1L, fixture.releaseProgress.count)
            fixture.releaseProgress.countDown()
            fixture.ready(2)
            compose.waitUntil(10_000) { fixture.outgoingSaved!!.isCompleted }
            val saves = fixture.requests.filter { it.method == "PUT" }
            assertTrue(saves.size >= 2)
            saves.forEach { request ->
                val saved = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                assertEquals("101", saved["episode_id"]!!.jsonPrimitive.content)
                assertEquals("7", saved["profile_id"]!!.jsonPrimitive.content)
            }
        }

    @Test fun aSlowProgressSaveDoesNotKeepAnExpiredIntroActionVisible() =
        withPlayer(credits = false, holdProgress = true, introEndMs = 47_000) { fixture ->
            fixture.ready(1)
            remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
            fixture.holdFirstProgressSave()
            compose.runOnIdle { fixture.view.player!!.seekTo(22_000) }
            compose.waitUntil(5000) { compose.onAllNodesWithText("Skip Intro").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithText("Next episode").assertExists()
            assertEquals(1L, fixture.releaseProgress.count)
            fixture.releaseProgress.countDown()
        }

    private fun choose(label: String) {
        compose.onNodeWithText(label).performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText(label).performKeyInput { pressKey(Key.DirectionCenter) }
    }
    private fun remote(code: Int) {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(code)
        compose.waitForIdle()
    }
    private fun withPlayer(credits: Boolean = true, holdManifest: Boolean = false, holdProgress: Boolean = false,
                           creditsStartMs: Long = 30_000, introEndMs: Long = 90_000, block: (Fixture) -> Unit) {
        val fixture = Fixture(credits, holdManifest, holdProgress, creditsStartMs, introEndMs)
        try { fixture.open(); block(fixture) } finally { fixture.close() }
    }

    private inner class Fixture(val credits: Boolean, val holdManifest: Boolean, val holdProgress: Boolean,
                                val creditsStartMs: Long, val introEndMs: Long) {
        val server = MockWebServer()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val sessions = AtomicInteger()
        val advances = AtomicInteger()
        val manifestEntered = CountDownLatch(1)
        val releaseManifest = CountDownLatch(1)
        val progressEntered = CountDownLatch(1)
        val releaseProgress = CountDownLatch(1)
        val progressRequests = AtomicInteger()
        @Volatile var outgoingSaved: Job? = null
        var isOpen by mutableStateOf(true)
        var target by mutableStateOf(PlayTarget(Media(20, "Show", "show"), MediaFile(1, durationMs = 180_000), Profile(7, "Viewer"),
            episodeId = 101, resumeMs = 30_000, seasonNumber = 1, episodeNumber = 1, episodeTitle = "First"))
        val next = EpisodeContinuation(Episode(102, 2, "Second", season = 1, files = listOf(MediaFile(2, durationMs = 180_000))),
            MediaFile(2, durationMs = 180_000), 1)
        val preferences = InstrumentationRegistry.getInstrumentation().targetContext.getSharedPreferences("aurora_tv", 0)
        val priorAutoplay = if (preferences.contains("autoplay")) preferences.getBoolean("autoplay", true) else null
        lateinit var api: AuroraClient
        lateinit var view: PlayerView

        fun open() {
            preferences.edit().putBoolean("autoplay", true).commit()
            val segment = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.ts").use { it.readBytes() }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val path = request.requestUrl!!.encodedPath
                    if (holdManifest && path == "/api/stream/hls/smart-1/master.m3u8") {
                        manifestEntered.countDown()
                        check(releaseManifest.await(30, TimeUnit.SECONDS))
                    }
                    if (holdProgress && request.method == "PUT" && progressRequests.incrementAndGet() == 1) {
                        progressEntered.countDown()
                        check(releaseProgress.await(30, TimeUnit.SECONDS))
                    }
                    return when {
                        path.startsWith("/api/stream/info/") -> {
                            val marker = if (path.endsWith("/1")) {
                                if (credits) """[{"kind":"credits","start_ms":$creditsStartMs,"end_ms":180000}]"""
                                else """[{"kind":"intro","start_ms":30000,"end_ms":$introEndMs}]"""
                            } else "[]"
                            json("""{"stream":{"decision":"transcode","duration_ms":180000},"markers":$marker}""")
                        }
                        path == "/api/stream/sessions" -> {
                            val at = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject["start_sec"]!!.jsonPrimitive.content.toLong()
                            val id = sessions.incrementAndGet()
                            json("""{"session_id":"smart-$id","master_playlist":"/api/stream/hls/smart-$id/master.m3u8","start_sec":${(at - 2).coerceAtLeast(0)}}""")
                        }
                        path.endsWith("master.m3u8") -> MockResponse().setHeader("Content-Type", "application/vnd.apple.mpegurl").setBody(
                            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n" +
                                (1..3).joinToString("") { "#EXT-X-DISCONTINUITY\n#EXTINF:10.0,\nplayback.ts\n" } + "#EXT-X-ENDLIST\n")
                        path.endsWith("playback.ts") -> MockResponse().setHeader("Content-Type", "video/mp2t").setBody(Buffer().write(segment))
                        request.method == "PUT" || request.method == "DELETE" || path.endsWith("keepalive") -> json("{}")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start()
            api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), object : CookiePersistence {
                override fun read() = emptyList<String>()
                override fun write(cookies: List<String>) = Unit
            }))
            compose.setContent { AuroraTheme {
                if (isOpen) PlayerScreen(api, target, continuation = next.takeIf { target.episodeId == 101L }, onAdvance = { saved ->
                    if (target.episodeId != 101L) false else {
                        outgoingSaved = saved
                        advances.incrementAndGet()
                        target = PlayTarget(target.media, next.file, target.profile, next.episode.id,
                            seasonNumber = 1, episodeNumber = 2, episodeTitle = "Second")
                        true
                    }
                }) { isOpen = false } else TvAction("Closed", {})
            } }
        }
        fun ready(session: Int) {
            compose.waitForIdle()
            onView(isAssignableFrom(PlayerView::class.java)).check { candidate, failure ->
                if (failure != null) throw failure
                view = candidate as PlayerView
            }
            compose.waitUntil(90_000) {
                var ready = false
                compose.runOnIdle { ready = view.player?.let { it.playbackState == Player.STATE_READY &&
                    it.currentMediaItem?.localConfiguration?.uri.toString().contains("smart-$session/") } == true }
                ready
            }
        }
        fun holdFirstProgressSave() {
            // LaunchedEffect delays use Compose's virtual test clock. A blocking
            // latch wait leaves that clock stopped and never starts the PUT.
            // waitUntil advances frames while allowing the network to respond.
            compose.waitUntil(25_000) { progressEntered.count == 0L }
        }
        fun close() {
            releaseManifest.countDown()
            releaseProgress.countDown()
            compose.runOnIdle { isOpen = false }
            compose.waitUntil(20_000) { requests.count { it.method == "DELETE" } == sessions.get() }
            server.shutdown()
            preferences.edit().apply { if (priorAutoplay == null) remove("autoplay") else putBoolean("autoplay", priorAutoplay) }.commit()
        }
    }
    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
}
