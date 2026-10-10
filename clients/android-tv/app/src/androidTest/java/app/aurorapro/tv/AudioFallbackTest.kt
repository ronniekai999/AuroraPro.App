package app.aurorapro.tv

import androidx.compose.runtime.*
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.ui.PlayerView
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.platform.app.InstrumentationRegistry
import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.PlayerScreen
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class AudioFallbackTest {
    @get:Rule val compose = createComposeRule()

    @Test fun manualAudioAndSubtitlesSurviveFallbackAndAutomaticAudioRestoresItsSource() {
        val server = MockWebServer()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val direct = assets.open("playback-two-audio.mp4").use { it.readBytes() }
        val english = assets.open("playback-english.ts").use { it.readBytes() }
        val spanish = assets.open("playback-spanish.ts").use { it.readBytes() }
        val sequence = AtomicInteger(0)
        val sessionAudio = ConcurrentHashMap<String, Int>()
        val servedSource = ConcurrentHashMap<String, Int>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val id = request.path!!.substringAfter("/api/stream/hls/", "").substringBefore('/')
                return when {
                    request.method == "DELETE" -> { sessionAudio.remove(request.path!!.substringAfterLast('/')); json("{}") }
                    id.isNotBlank() && !sessionAudio.containsKey(id) -> MockResponse().setResponseCode(404)
                    request.path!!.startsWith("/api/stream/info/1") -> json("""{"stream":{"decision":"direct_play","stream_url":"/direct.mp4","duration_ms":90000,"audio_track_index":0},"audio_tracks":[{"index":1,"language":"eng","codec":"aac","channels":1},{"index":2,"language":"spa","codec":"aac","channels":1}]}""")
                    request.path == "/direct.mp4" -> MockResponse().setHeader("Content-Type", "video/mp4").setBody(Buffer().write(direct))
                    // A real extractor error exercises the same bounded
                    // compatibility-replacement path as a decoder error.
                    request.path == "/unreadable.mp4" -> MockResponse().setHeader("Content-Type", "video/mp4").setBody("This is not a media container.")
                    request.path == "/api/stream/sessions" -> {
                        val payload = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                        val next = "audio-fallback-${sequence.incrementAndGet()}"
                        sessionAudio[next] = payload["audio_track_index"]!!.jsonPrimitive.content.toInt()
                        json("""{"session_id":"$next","master_playlist":"/api/stream/hls/$next/master.m3u8","start_sec":${payload["start_sec"]!!.jsonPrimitive.content},"remux":false,"audio_copy":false}""")
                    }
                    request.path!!.endsWith("master.m3u8") -> playlist("#EXTM3U\n" +
                        "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"eng\",LANGUAGE=\"eng\",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI=\"subs_0.m3u8\"\n" +
                        "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"spa\",LANGUAGE=\"spa\",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,URI=\"subs_1.m3u8\"\n" +
                        "#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,CODECS=\"avc1.42c01e,mp4a.40.2\",SUBTITLES=\"subs\"\nvideo.m3u8\n")
                    request.path!!.endsWith(".m3u8") -> playlist("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\n" +
                        (if (request.path!!.endsWith("subs_0.m3u8")) "english.vtt" else if (request.path!!.endsWith("subs_1.m3u8")) "spanish.vtt" else "playback.ts") + "\n#EXT-X-ENDLIST\n")
                    request.path!!.endsWith(".vtt") -> MockResponse().setHeader("Content-Type", "text/vtt").setBody("WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${if (request.path!!.endsWith("english.vtt")) "English" else "Spanish"} fixture captions\n")
                    request.path!!.endsWith("playback.ts") -> {
                        val source = checkNotNull(sessionAudio[id])
                        servedSource[id] = source
                        MockResponse().setHeader("Content-Type", "video/mp2t").setBody(Buffer().write(if (source == 1) spanish else english))
                    }
                    request.method == "PUT" || request.method == "DELETE" || request.path!!.endsWith("keepalive") -> json("{}")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        var open by mutableStateOf(true)
        try {
            val origin = server.url("/")
            val api = AuroraClient(origin, SessionCookies(origin, object : CookiePersistence {
                override fun read() = emptyList<String>()
                override fun write(cookies: List<String>) = Unit
            }))
            compose.setContent { AuroraTheme {
                if (open) PlayerScreen(api, PlayTarget(Media(1, "Audio fixture"), MediaFile(1, videoCodec = "h264", durationMs = 90000), Profile(7, "Viewer")))
                    { open = false } else TvAction("Closed", {})
            } }
            lateinit var view: PlayerView
            onView(isAssignableFrom(PlayerView::class.java)).check { candidate, failure ->
                if (failure != null) throw failure
                view = candidate as PlayerView
            }
            compose.waitUntil(90_000) {
                var ready = false
                compose.runOnIdle { ready = view.player!!.playbackState in setOf(Player.STATE_READY, Player.STATE_ENDED) }
                ready
            }
            compose.runOnIdle { view.player!!.pause() }
            choose("Settings"); choose("Audio"); choose("Spanish")
            compose.waitUntil(30_000) {
                var selected = false
                compose.runOnIdle { selected = view.player!!.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }.any { group ->
                    (0 until group.length).any { group.isTrackSelected(it) && group.getTrackFormat(it).language in setOf("es", "spa") }
                } }
                selected
            }
            choose("Settings"); choose("Subtitles"); choose("Spanish")
            compose.waitUntil(30_000) { selectedLanguage(view, C.TRACK_TYPE_TEXT, setOf("es", "spa")) }
            compose.runOnIdle {
                view.player!!.setMediaItem(MediaItem.fromUri(server.url("/unreadable.mp4").toString()))
                view.player!!.prepare()
            }
            compose.waitUntil(90_000) { requests.any { it.path == "/api/stream/sessions" } }
            val payload = apiJson.parseToJsonElement(requests.first { it.path == "/api/stream/sessions" }.body.clone().readUtf8()).jsonObject
            assertEquals("1", payload["audio_track_index"]!!.jsonPrimitive.content)
            assertEquals("aac", payload["audio_codec_out"]!!.jsonPrimitive.content)
            compose.waitUntil(90_000) {
                var ready = false
                compose.runOnIdle { ready = view.player!!.playbackState in setOf(Player.STATE_READY, Player.STATE_ENDED) &&
                    view.player!!.currentMediaItem!!.localConfiguration!!.uri.toString().contains("audio-fallback-1/") }
                ready
            }
            compose.runOnIdle {
                assertFalse("Fallback must preserve explicit Pause", view.player!!.playWhenReady)
            }
            // Aurora's muxed HLS master has no audio LANGUAGE attribute. Media3
            // can omit the PMT language in its merged format: check the mapped
            // source, served tone fixture and actual selected AAC track instead.
            assertEquals(1, servedSource["audio-fallback-1"])
            assertTrue(selectedAac(view))
            compose.waitUntil(30_000) { selectedLanguage(view, C.TRACK_TYPE_TEXT, setOf("es", "spa")) }
            compose.runOnIdle { view.player!!.seekTo(4000) }
            choose("Settings"); choose("Audio"); choose("Automatic · en")
            compose.waitUntil(90_000) { requests.count { it.path == "/api/stream/sessions" } == 2 }
            val automatic = apiJson.parseToJsonElement(requests.filter { it.path == "/api/stream/sessions" }[1].body.clone().readUtf8()).jsonObject
            assertEquals("0", automatic["audio_track_index"]!!.jsonPrimitive.content)
            assertEquals("4", automatic["start_sec"]!!.jsonPrimitive.content)
            compose.waitUntil(90_000) {
                var ready = false
                compose.runOnIdle { ready = view.player!!.playbackState in setOf(Player.STATE_READY, Player.STATE_ENDED) &&
                    view.player!!.currentMediaItem!!.localConfiguration!!.uri.toString().contains("audio-fallback-2/") }
                ready
            }
            compose.runOnIdle { assertFalse("Automatic audio must preserve explicit Pause", view.player!!.playWhenReady) }
            assertEquals(0, servedSource["audio-fallback-2"])
            assertTrue(selectedAac(view))
            compose.waitUntil(30_000) { selectedLanguage(view, C.TRACK_TYPE_TEXT, setOf("es", "spa")) }
            choose("Back to title")
            compose.waitUntil(20_000) { requests.count { it.method == "DELETE" } == 2 }
        } finally {
            compose.runOnIdle { open = false }
            compose.waitForIdle()
            server.shutdown()
        }
    }

    private fun selectedLanguage(view: PlayerView, type: Int, languages: Set<String>): Boolean {
        var selected = false
        compose.runOnIdle { selected = view.player!!.currentTracks.groups.filter { it.type == type }.any { group ->
            (0 until group.length).any { group.isTrackSelected(it) && group.getTrackFormat(it).language in languages }
        } }
        return selected
    }

    private fun selectedAac(view: PlayerView): Boolean {
        var selected = false
        compose.runOnIdle { selected = view.player!!.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }.any { group ->
            (0 until group.length).any { group.isTrackSelected(it) && group.getTrackFormat(it).sampleMimeType == "audio/mp4a-latm" }
        } }
        return selected
    }

    private fun choose(text: String) {
        compose.onNodeWithText(text).performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText(text).performKeyInput { pressKey(Key.DirectionCenter) }
    }
    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    private fun playlist(body: String) = MockResponse().setHeader("Content-Type", "application/vnd.apple.mpegurl").setBody(body)
}
