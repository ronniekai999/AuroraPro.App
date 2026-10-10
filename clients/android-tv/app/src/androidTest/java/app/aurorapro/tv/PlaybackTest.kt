package app.aurorapro.tv

import androidx.compose.runtime.*
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.media3.common.Player
import androidx.media3.ui.PlayerView
import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.PlayerScreen
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test

/** A generated color/tone fixture exercises real Media3 HTTP loading and Android decoding. */
@OptIn(ExperimentalTestApi::class)
class PlaybackTest {
    @get:Rule val compose = createComposeRule()

    @Test fun hlsPlaysFromReturnedAnchorAndFlushesSourceProgressOnExit() {
        val server = MockWebServer()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val fixture = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.ts").use { it.readBytes() }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when {
                    request.path!!.startsWith("/api/stream/info/1") -> json("""{"stream":{"decision":"transcode","duration_ms":90000}}""")
                    request.path == "/api/stream/sessions" -> json("""{"session_id":"test-session","master_playlist":"/api/stream/hls/test-session/master.m3u8","start_sec":28}""").setResponseCode(201)
                    request.path!!.endsWith("master.m3u8") -> MockResponse().setHeader("Content-Type", "application/vnd.apple.mpegurl").setBody(
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nplayback.ts\n#EXT-X-ENDLIST\n")
                    request.path!!.endsWith("playback.ts") -> MockResponse().setHeader("Content-Type", "video/mp2t").setBody(Buffer().write(fixture))
                    request.method == "PUT" || request.method == "DELETE" || request.path!!.endsWith("keepalive") -> json("{}")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        try {
            val origin = server.url("/")
            val api = AuroraClient(origin, SessionCookies(origin, object : CookiePersistence {
                override fun read() = emptyList<String>()
                override fun write(cookies: List<String>) = Unit
            }))
            val target = PlayTarget(Media(1, "Playback fixture"), MediaFile(1, durationMs = 90000), Profile(7, "Viewer"), resumeMs = 30000)
            compose.setContent { AuroraTheme {
                var open by remember { mutableStateOf(true) }
                if (open) PlayerScreen(api, target) { open = false } else TvAction("Closed", {})
            } }
            // Playback must advance, rather than merely displaying the requested resume position.
            compose.waitUntil(90_000) {
                requests.filter { it.method == "PUT" }.any { saved ->
                    val progress = apiJson.parseToJsonElement(saved.body.clone().readUtf8()).jsonObject
                    progress["position_ms"]!!.jsonPrimitive.content.toLong() >= 31000
                }
            }
            compose.onNodeWithText("Back to title").performSemanticsAction(SemanticsActions.RequestFocus)
            compose.onNodeWithText("Back to title").performKeyInput { pressKey(Key.DirectionCenter) }
            compose.onNodeWithText("Closed").assertExists()
            compose.waitUntil(20_000) { requests.any { it.method == "DELETE" && it.path == "/api/stream/sessions/test-session" } }
            val progress = apiJson.parseToJsonElement(requests.last { it.method == "PUT" }.body.readUtf8()).jsonObject
            assertEquals("7", progress["profile_id"]!!.jsonPrimitive.content)
            assertEquals("90000", progress["duration_ms"]!!.jsonPrimitive.content)
            assertTrue(progress["position_ms"]!!.jsonPrimitive.content.toLong() >= 31000)
            assertTrue(requests.any { it.path!!.endsWith("playback.ts") })
        } finally {
            server.shutdown()
        }
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    @Test fun hlsSessionRecreationPreservesPauseAndResumeIntent() {
        val server = MockWebServer()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val fixture = InstrumentationRegistry.getInstrumentation().context.assets.open("playback.ts").use { it.readBytes() }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when {
                    request.path!!.startsWith("/api/stream/info/1") -> json("""{"stream":{"decision":"transcode","duration_ms":90000}}""")
                    request.path == "/api/stream/sessions" -> {
                        val at = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject["start_sec"]!!.jsonPrimitive.content.toLong()
                        val id = "seek-$at"
                        json("""{"session_id":"$id","master_playlist":"/api/stream/hls/$id/master.m3u8","start_sec":${at - 2}}""").setResponseCode(201)
                    }
                    request.path!!.endsWith("master.m3u8") -> MockResponse().setHeader("Content-Type", "application/vnd.apple.mpegurl").setBody(
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nplayback.ts\n#EXT-X-ENDLIST\n")
                    request.path!!.endsWith("playback.ts") -> MockResponse().setHeader("Content-Type", "video/mp2t").setBody(Buffer().write(fixture))
                    request.method == "PUT" || request.method == "DELETE" || request.path!!.endsWith("keepalive") -> json("{}")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        try {
            val origin = server.url("/")
            val api = AuroraClient(origin, SessionCookies(origin, object : CookiePersistence {
                override fun read() = emptyList<String>()
                override fun write(cookies: List<String>) = Unit
            }))
            val target = PlayTarget(Media(1, "Paused seek fixture"), MediaFile(1, durationMs = 90000), Profile(7, "Viewer"), resumeMs = 30000)
            compose.setContent { AuroraTheme {
                var open by remember { mutableStateOf(true) }
                if (open) PlayerScreen(api, target) { open = false } else TvAction("Closed", {})
            } }
            lateinit var view: PlayerView
            onView(isAssignableFrom(PlayerView::class.java)).check { candidate, failure ->
                if (failure != null) throw failure
                view = candidate as PlayerView
            }
            fun isPreparedInSession(index: Int): Boolean {
                val created = requests.filter { it.path == "/api/stream/sessions" }.getOrNull(index) ?: return false
                val at = apiJson.parseToJsonElement(created.body.clone().readUtf8()).jsonObject["start_sec"]!!.jsonPrimitive.content
                val expected = server.url("/api/stream/hls/seek-$at/master.m3u8").toString()
                var prepared = false
                compose.runOnIdle {
                    val player = view.player!!
                    // A short clip can finish while a software emulator handles
                    // the remote input. Ended still proves the new item loaded.
                    prepared = player.currentMediaItem?.localConfiguration?.uri.toString() == expected &&
                        player.playbackState in setOf(Player.STATE_READY, Player.STATE_ENDED)
                }
                return prepared
            }
            compose.waitUntil(90_000) {
                var ready = false
                compose.runOnIdle { ready = view.player!!.playbackState in setOf(Player.STATE_READY, Player.STATE_ENDED) }
                ready
            }
            compose.runOnIdle { view.player!!.pause(); assertFalse(view.player!!.playWhenReady) }
            compose.onNodeWithText("+30 sec").performSemanticsAction(SemanticsActions.RequestFocus)
            compose.onNodeWithText("+30 sec").performKeyInput { pressKey(Key.DirectionCenter) }
            compose.waitUntil(30_000) { requests.count { it.path == "/api/stream/sessions" } == 2 }
            compose.waitUntil(90_000) { isPreparedInSession(1) }
            compose.runOnIdle { assertFalse("Session recreation must preserve Pause", view.player!!.playWhenReady) }
            compose.runOnIdle { view.player!!.play() }
            compose.onNodeWithText("−30 sec").performSemanticsAction(SemanticsActions.RequestFocus)
            compose.onNodeWithText("−30 sec").performKeyInput { pressKey(Key.DirectionCenter) }
            compose.waitUntil(30_000) { requests.count { it.path == "/api/stream/sessions" } == 3 }
            compose.waitUntil(90_000) { isPreparedInSession(2) }
            compose.runOnIdle { assertTrue("Session recreation must preserve Resume", view.player!!.playWhenReady) }
            compose.onNodeWithText("Back to title").performSemanticsAction(SemanticsActions.RequestFocus)
            compose.onNodeWithText("Back to title").performKeyInput { pressKey(Key.DirectionCenter) }
            compose.onNodeWithText("Closed").assertExists()
            compose.waitUntil(20_000) { requests.count { it.method == "DELETE" } == 3 }
        } finally { server.shutdown() }
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
}
