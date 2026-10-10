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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackControlsTest {
    @get:Rule val compose = createComposeRule()

    @Test fun oneOverlayHidesReturnsWithTheRemoteAndStaysVisibleWhenPausedOrInSettings() = withPlayer { fixture ->
        compose.waitUntil(30_000) {
            var playing = false
            compose.runOnIdle { playing = fixture.view.player!!.isPlaying }
            playing
        }
        // LaunchedEffect timers use Compose's virtual clock in instrumentation.
        // Real sleeps alone do not advance the five-second overlay deadline.
        compose.mainClock.advanceTimeBy(6000)
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Back to title").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithText("Controls fixture").assertDoesNotExist()
        compose.onNodeWithText("−30 sec").assertDoesNotExist()
        compose.onNodeWithText("+30 sec").assertDoesNotExist()
        compose.runOnIdle { assertFalse(fixture.view.useController); assertTrue(fixture.view.player!!.playWhenReady) }
        remote(KeyEvent.KEYCODE_DPAD_CENTER)
        compose.onNodeWithText("Back to title").assertExists()
        compose.onNodeWithContentDescription("Playback timeline").assertExists()
        compose.runOnIdle { assertTrue("Reveal must not also pause playback", fixture.view.player!!.playWhenReady) }
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        compose.mainClock.advanceTimeBy(6000)
        compose.onNodeWithText("Resume").assertExists()
        compose.onNodeWithText("Controls fixture").assertExists()
        remote(KeyEvent.KEYCODE_MEDIA_PLAY)
        choose("Settings")
        compose.mainClock.advanceTimeBy(6000)
        compose.onNodeWithText("Playback settings").assertExists()
        choose("Close")
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        choose("Back to title")
        compose.onNodeWithText("Closed").assertExists()
        compose.waitUntil(20_000) { fixture.requests.any { it.method == "DELETE" } }
    }

    @Test fun qualitySwitchStartsAtSourceTimeKeepsPauseAndCleansUpBothSessions() = withPlayer { fixture ->
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        choose("Settings")
        choose("Quality")
        choose("low · 160×90")
        compose.waitUntil(30_000) { fixture.sessions().size == 2 }
        compose.waitUntil(90_000) { fixture.readyInSession(2) }
        compose.onNodeWithText("Playback stopped. Check your connection, then choose Retry.").assertDoesNotExist()
        compose.runOnIdle {
            assertFalse("Quality changes must preserve Pause", fixture.view.player!!.playWhenReady)
            assertTrue(fixture.view.player!!.trackSelectionParameters.overrides.values.any { override ->
                override.mediaTrackGroup.getFormat(override.trackIndices.single()).let { it.width == 160 && it.height == 90 }
            })
        }
        val requested = apiJson.parseToJsonElement(fixture.sessions()[1].body.clone().readUtf8()).jsonObject
        assertTrue("Seek uses the source anchor, not the short HLS timeline", requested["start_sec"]!!.jsonPrimitive.content.toLong() >= 30)
        choose("Settings")
        choose("Quality")
        choose("high · 320×180")
        compose.waitUntil(30_000) { fixture.sessions().size == 3 }
        compose.waitUntil(90_000) { fixture.readyInSession(3) }
        compose.onNodeWithText("Playback stopped. Check your connection, then choose Retry.").assertDoesNotExist()
        compose.runOnIdle { assertFalse(fixture.view.player!!.playWhenReady) }
        choose("Back to title")
        compose.waitUntil(20_000) { fixture.requests.count { it.method == "DELETE" } == 3 }
    }

    @Test fun exitDuringDelayedQualityCreationSavesTheOutgoingPositionBeforeResume() =
        exitDuringReplacement("POST", seek = false)

    @Test fun exitDuringDelayedSeekDeletionSavesThePlayedPositionRatherThanTheUnconfirmedSeek() =
        exitDuringReplacement("DELETE", seek = true)

    @Test fun periodicAndFinalSavesDuringReplacementPlaylistLoadingKeepThePlayedCheckpoint() =
        exitBeforeReplacementReady("PLAYLIST")

    @Test fun periodicAndFinalSavesDuringReplacementSegmentLoadingKeepThePlayedCheckpoint() =
        exitBeforeReplacementReady("SEGMENT")

    @Test fun periodicAndFinalSavesAfterReplacementPlaylistFailureKeepThePlayedCheckpoint() =
        exitBeforeReplacementReady("FAILED_PLAYLIST")

    private fun exitBeforeReplacementReady(blockedStage: String) = withPlayer(blockedStage) { fixture ->
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        var playedPosition = 0L
        compose.runOnIdle { playedPosition = 28_000 + fixture.view.player!!.currentPosition }
        compose.onNodeWithContentDescription("Playback timeline")
            .performSemanticsAction(SemanticsActions.SetProgress) { it(.99f) }
        compose.waitUntil(30_000) { fixture.replacementStarted.count == 0L }
        assertEquals(2, fixture.sessions().size)
        compose.runOnIdle { assertNotEquals(Player.STATE_READY, fixture.view.player!!.playbackState) }
        if (blockedStage == "FAILED_PLAYLIST") compose.waitUntil(30_000) {
            compose.onAllNodesWithText("Playback stopped. Check your connection, then choose Retry.").fetchSemanticsNodes().isNotEmpty()
        }
        fun assertCheckpoint() {
            val saved = apiJson.parseToJsonElement(fixture.requests.last { it.method == "PUT" }.body.clone().readUtf8()).jsonObject
            val checkpoint = saved["position_ms"]!!.jsonPrimitive.content.toLong()
            assertTrue("A successful session POST cannot commit the unplayable 99% seek", checkpoint in playedPosition..(playedPosition + 2000))
            assertEquals(360_000L, saved["duration_ms"]!!.jsonPrimitive.content.toLong())
        }
        val previousSaves = fixture.requests.count { it.method == "PUT" }
        compose.mainClock.advanceTimeBy(16_000)
        compose.waitUntil(20_000) { fixture.requests.count { it.method == "PUT" } > previousSaves }
        assertCheckpoint()
        val periodicSaves = fixture.requests.count { it.method == "PUT" }
        choose("Back to title")
        compose.waitUntil(20_000) { fixture.requests.count { it.method == "PUT" } > periodicSaves }
        assertCheckpoint()
        fixture.replacementGate.countDown()
        compose.waitUntil(20_000) { fixture.requests.count { it.method == "DELETE" } == 2 }
    }

    private fun exitDuringReplacement(blockedMethod: String, seek: Boolean) = withPlayer(blockedMethod) { fixture ->
        remote(KeyEvent.KEYCODE_MEDIA_PAUSE)
        var playedPosition = 0L
        compose.runOnIdle { playedPosition = 28_000 + fixture.view.player!!.currentPosition }
        val previousSaves = fixture.requests.count { it.method == "PUT" }
        if (seek) {
            compose.onNodeWithContentDescription("Playback timeline")
                .performSemanticsAction(SemanticsActions.SetProgress) { it(.99f) }
        } else {
            choose("Settings"); choose("Quality"); choose("low · 160×90")
        }
        compose.waitUntil(30_000) { fixture.replacementStarted.count == 0L }
        var stoppedPosition = 0L
        compose.runOnIdle { stoppedPosition = 28_000 + fixture.view.player!!.currentPosition }
        compose.onNodeWithText("Preparing your stream…").assertExists()
        choose("Back to title")
        compose.onNodeWithText("Closed").assertExists()
        // Final progress must be independent of the delayed session request.
        compose.waitUntil(20_000) { fixture.requests.count { it.method == "PUT" } > previousSaves }
        val saved = apiJson.parseToJsonElement(fixture.requests.last { it.method == "PUT" }.body.clone().readUtf8()).jsonObject
        val checkpoint = saved["position_ms"]!!.jsonPrimitive.content.toLong()
        // Media3 acknowledges Pause on its playback thread; the outgoing item
        // can advance between the remote press and stopping for replacement.
        assertTrue("Save an observed outgoing position, never an unconfirmed seek", checkpoint in playedPosition..stoppedPosition)
        assertEquals(360_000L, saved["duration_ms"]!!.jsonPrimitive.content.toLong())
        assertEquals(1L, fixture.replacementGate.count)
        assertEquals("Reopening must see the outgoing checkpoint while replacement is pending", checkpoint,
            runBlocking { fixture.api.progress(1, 7, null).positionMs })
        fixture.replacementGate.countDown()
        val expectedDeletes = if (blockedMethod == "POST") 2 else 1
        compose.waitUntil(20_000) { fixture.requests.count { it.method == "DELETE" } == expectedDeletes }
    }

    private fun choose(text: String) {
        compose.onNodeWithText(text).performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText(text).performKeyInput { pressKey(Key.DirectionCenter) }
    }
    private fun remote(code: Int) {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(code)
        compose.waitForIdle()
    }
    private fun withPlayer(blockReplacement: String? = null, block: (Fixture) -> Unit) {
        val fixture = Fixture(blockReplacement)
        try { fixture.open(); block(fixture) } finally { fixture.close() }
    }
    private inner class Fixture(private val blockReplacement: String? = null) {
        private val server = MockWebServer()
        private var isOpen by mutableStateOf(true)
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        private val retired = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        val replacementStarted = CountDownLatch(1)
        val replacementGate = CountDownLatch(1)
        @Volatile private var savedPosition = 0L
        lateinit var api: AuroraClient
        lateinit var view: PlayerView
        fun sessions() = requests.filter { it.path == "/api/stream/sessions" }
        fun open() {
            val assets = InstrumentationRegistry.getInstrumentation().context.assets
            val low = assets.open("playback.ts").use { it.readBytes() }
            val high = assets.open("playback-high.ts").use { it.readBytes() }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val replacementMedia = request.path!!.startsWith("/api/stream/hls/controls-2/")
                    if (replacementMedia && blockReplacement == "FAILED_PLAYLIST") {
                        replacementStarted.countDown()
                        return MockResponse().setResponseCode(404)
                    }
                    if ((blockReplacement == "DELETE" && request.method == "DELETE" && request.path == "/api/stream/sessions/controls-1") ||
                        (blockReplacement == "POST" && request.path == "/api/stream/sessions" && sessions().size == 2) ||
                        (replacementMedia && blockReplacement == "PLAYLIST" && request.path!!.endsWith("master.m3u8")) ||
                        (replacementMedia && blockReplacement == "SEGMENT" && request.path!!.endsWith(".ts"))) {
                        replacementStarted.countDown()
                        replacementGate.await(30, TimeUnit.SECONDS)
                    }
                    return when {
                        request.method == "PUT" -> {
                            savedPosition = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject["position_ms"]!!.jsonPrimitive.content.toLong()
                            json("{}")
                        }
                        request.path!!.startsWith("/api/progress/1?") -> json("""{"position_ms":$savedPosition,"duration_ms":360000}""")
                        request.method == "DELETE" -> {
                            retired += request.path!!.substringAfterLast('/')
                            json("{}")
                        }
                        request.path!!.startsWith("/api/stream/hls/") &&
                            request.path!!.substringAfter("/api/stream/hls/").substringBefore('/') in retired -> MockResponse().setResponseCode(404)
                        request.path!!.startsWith("/api/stream/info/1") -> json("""{"stream":{"decision":"transcode","duration_ms":360000,"transcode_reason":"Fixture decoder requires compatibility playback"}}""")
                        request.path == "/api/stream/sessions" -> {
                            val at = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject["start_sec"]!!.jsonPrimitive.content.toLong()
                            val id = sessions().size
                            json("""{"session_id":"controls-$id","master_playlist":"/api/stream/hls/controls-$id/master.m3u8","start_sec":${at - 2},"profiles":[{"name":"low","width":160,"height":90},{"name":"high","width":320,"height":180}],"remux":false}""")
                        }
                        request.path!!.endsWith("master.m3u8") -> playlist("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS=\"avc1.42c01e,mp4a.40.2\"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS=\"avc1.42c01e,mp4a.40.2\"\nhigh.m3u8\n")
                        request.path!!.endsWith(".m3u8") -> playlist("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n" +
                            (0..29).joinToString("") { "#EXT-X-DISCONTINUITY\n#EXTINF:10.0,\n${if (request.path!!.endsWith("high.m3u8")) "high" else "low"}.ts\n" } + "#EXT-X-ENDLIST\n")
                        request.path!!.endsWith(".ts") -> MockResponse().setHeader("Content-Type", "video/mp2t").setBody(Buffer().write(if (request.path!!.endsWith("high.ts")) high else low))
                        request.path!!.endsWith("keepalive") -> json("{}")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start()
            val origin = server.url("/")
            api = AuroraClient(origin, SessionCookies(origin, object : CookiePersistence {
                override fun read() = emptyList<String>()
                override fun write(cookies: List<String>) = Unit
            }))
            compose.setContent { AuroraTheme {
                if (isOpen) PlayerScreen(api, PlayTarget(Media(1, "Controls fixture"), MediaFile(1, durationMs = 360000), Profile(7, "Viewer"), resumeMs = 30000))
                    { isOpen = false } else TvAction("Closed", {})
            } }
            onView(isAssignableFrom(PlayerView::class.java)).check { candidate, failure ->
                if (failure != null) throw failure
                view = candidate as PlayerView
            }
            compose.waitUntil(90_000) { readyInSession(1) }
        }
        fun readyInSession(index: Int): Boolean {
            var ready = false
            compose.runOnIdle { ready = view.player?.let { it.playbackState == Player.STATE_READY &&
                it.currentMediaItem?.localConfiguration?.uri.toString().contains("controls-$index/") } == true }
            return ready
        }
        fun close() { replacementGate.countDown(); compose.runOnIdle { isOpen = false }; compose.waitForIdle(); server.shutdown() }
    }
    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    private fun playlist(body: String) = MockResponse().setHeader("Content-Type", "application/vnd.apple.mpegurl").setBody(body)
}
