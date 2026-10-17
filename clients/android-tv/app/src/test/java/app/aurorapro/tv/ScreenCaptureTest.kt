package app.aurorapro.tv

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.Looper
import androidx.compose.ui.semantics.SemanticsActions
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.aurorapro.tv.data.Media
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.imageDecoderEnabled
import coil3.request.allowHardware
import java.io.ByteArrayOutputStream
import java.io.File
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the real app against a fixture server on the JVM, for reviewing the TV
 * design where no emulator is available. Opt in with `-Paurora.screenshots`;
 * PNGs land in `app/build/outputs/screens`. Set `-Paurora.screenshots.art=DIR`
 * to serve real artwork by file name instead of generated gradients.
 *
 * These captures are design evidence only. D-pad behavior, playback and the
 * device itself are verified by the instrumentation suite and on a real TV.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w960dp-h540dp-land-television-xhdpi")
class ScreenCaptureTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val application = ApplicationProvider.getApplicationContext<Application>()
    private val owner = ViewModelStore()
    private val server = MockWebServer()
    private val output = File(System.getProperty("aurora.screenshots.dir") ?: "build/outputs/screens").apply { mkdirs() }
    private val art = System.getProperty("aurora.screenshots.art")?.takeIf { it.isNotBlank() }?.let(::File)
    private lateinit var vm: TvViewModel

    @After fun close() {
        compose.runOnIdle { owner.clear() }
        server.shutdown()
    }

    @Test fun captureEveryScreen() {
        // The capture draws into a software canvas, which cannot draw hardware bitmaps,
        // and Robolectric's ImageDecoder cannot read files; BitmapFactory can.
        SingletonImageLoader.setUnsafe(ImageLoader.Builder(application).allowHardware(false).imageDecoderEnabled(false).build())
        server.dispatcher = FixtureDispatcher()
        server.start()
        compose.runOnIdle { vm = TvViewModel(application).also { owner.put("screens", it) } }
        compose.setContent { AuroraTheme { AuroraApp(vm) } }
        compose.runOnIdle { vm.connect(server.url("/").toString()) }
        await(Page.LOGIN); capture("01-sign-in")
        compose.runOnIdle { vm.pair() }
        await(Page.PAIR); capture("02-pair")
        compose.runOnIdle { vm.back(); vm.login("ronnie", "fixture-password") }
        await(Page.PROFILES); capture("03-profiles")
        compose.runOnIdle { vm.selectProfile(vm.state.value.profiles.first()) }
        await(Page.HOME); focus(HERO_ACTIONS); capture("04-home")
        focus("Elephants Dream"); capture("05-home-rails")
        compose.runOnIdle { vm.navigate(Page.MOVIES) }
        await(Page.MOVIES); focus("Sintel"); capture("06-movies")
        compose.runOnIdle { vm.navigate(Page.SEARCH); vm.search("the", immediate = true) }
        await(Page.SEARCH); capture("07-search")
        compose.runOnIdle { vm.detail(Media(101, "Sintel")) }
        await(Page.DETAIL); focus(DETAIL_ACTIONS); capture("08-movie-detail")
        compose.runOnIdle { vm.detail(Media(201, "The Long Orbit", "show")) }
        await(Page.DETAIL); focus(DETAIL_ACTIONS); capture("09-series-detail")
        compose.runOnIdle { vm.detail(Media(101, "Sintel")) }
        await(Page.DETAIL)
        compose.runOnIdle { vm.play(vm.state.value.files.first()) }
        await(Page.PLAYER); capture("11-player")
        compose.runOnIdle { vm.changeServer() }
        await(Page.SERVER); capture("10-server")
    }

    // Robolectric pauses the main looper, so network continuations only run when it is idled.
    private fun await(page: Page) {
        val deadline = System.currentTimeMillis() + 30_000
        while (vm.state.value.page != page || vm.state.value.busy) {
            check(System.currentTimeMillis() < deadline) { "Timed out waiting for $page: ${vm.state.value}" }
            pump()
        }
        settle()
    }

    private fun pump() { Thread.sleep(20); shadowOf(Looper.getMainLooper()).idle(); compose.waitForIdle() }

    /** Coil decodes off the main thread; give artwork time to arrive before capture. */
    private fun settle() {
        repeat(25) { pump(); compose.mainClock.advanceTimeBy(50) }
    }

    private fun focus(labels: List<String>) { labels.firstOrNull { runCatching { focus(it) }.isSuccess } }
    private fun focus(label: String) {
        compose.onNodeWithText(label).performSemanticsAction(SemanticsActions.RequestFocus)
        settle()
    }

    // captureToImage() waits for a hardware frame Robolectric never produces; draw the view tree instead.
    private fun capture(name: String) {
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private inner class FixtureDispatcher : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val url = request.requestUrl!!
            val path = url.encodedPath
            return when {
                path.startsWith("/api/images/") -> image(path.substringAfterLast('/'), path.split('/')[3])
                path == "/api/health" || path.endsWith("/activate") -> json("{}")
                path == "/api/auth/me" || path == "/api/auth/refresh" -> MockResponse().setResponseCode(401)
                path == "/api/auth/login" -> json("""{"user":{"id":1,"username":"ronnie","role":"admin"}}""")
                path == "/api/auth/device/start" -> json("""{"device_code":"fixture-device","user_code":"K7MQ-4XPL","verification_uri":"/v2/device","expires_in":600,"interval":5}""")
                path == "/api/auth/device/poll" -> json("""{"status":"authorization_pending"}""")
                path == "/api/profiles/" -> json(PROFILES)
                path == "/api/me/hero" -> json("""{"picks":[{"item":${SINTEL},"reason":"Because you finished Elephants Dream","match":92}]}""")
                path == "/api/progress/continue" -> json(CONTINUING)
                path == "/api/media/recent" -> json("[${LIBRARY.joinToString(",")}]")
                path == "/api/media/genres" -> json("""{"genres":["Adventure","Animation","Drama","Fantasy","Mystery","Science Fiction"]}""")
                path == "/api/media/" -> {
                    val type = url.queryParameter("type")
                    val items = LIBRARY.filter { "\"type\":\"$type\"" in it }
                    json("""{"data":[${items.joinToString(",")}],"page":1,"total_items":${items.size},"total_pages":1}""")
                }
                path == "/api/media/search" -> json("[${LIBRARY.filter { "\"title\":\"The" in it }.joinToString(",")}]")
                path == "/api/media/101" -> json(SINTEL)
                path == "/api/media/101/files" -> json(SINTEL_FILES)
                path == "/api/media/201" -> json(LIBRARY.first { "\"id\":201," in it })
                path == "/api/media/201/seasons" -> json("""[{"id":31,"season_number":1,"episode_count":8},{"id":32,"season_number":2,"episode_count":6},{"id":30,"season_number":0,"episode_count":2}]""")
                path == "/api/media/201/seasons/2/episodes" -> json(EPISODES)
                path.matches(Regex("/api/media/201/seasons/\\d+/episodes")) -> json("[]")
                path == "/api/media/201/next-episode" -> json(NEXT_EPISODE)
                // No decoder runs on the JVM, so hold the stream open and capture the overlay as it prepares.
                path.startsWith("/api/stream/info/") -> MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
                path == "/api/progress/101" -> json("""{"position_ms":421000,"duration_ms":888000}""")
                path.startsWith("/api/progress/") -> json("""{"position_ms":1220000,"duration_ms":2700000}""")
                else -> MockResponse().setResponseCode(404)
            }
        }

        private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)

        private fun image(name: String, size: String): MockResponse {
            val file = art?.let { File(it, name) }?.takeIf { it.isFile }
            val bytes = file?.readBytes() ?: generated(name, wide = size.startsWith("w1280") || "backdrop" in name || "still" in name)
            return MockResponse().setHeader("Content-Type", if (file != null) "image/jpeg" else "image/png").setBody(Buffer().write(bytes))
        }

        /** Deterministic abstract artwork, so layouts can be judged without real posters. */
        private fun generated(name: String, wide: Boolean): ByteArray {
            val (width, height) = if (wide) 960 to 540 else 400 to 600
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            val palette = PALETTES[Math.floorMod(name.hashCode(), PALETTES.size)]
            canvas.drawPaint(Paint().apply { shader = LinearGradient(0f, 0f, width.toFloat(), height.toFloat(), palette[0], palette[1], Shader.TileMode.CLAMP) })
            listOf(.25f to .3f, .78f to .62f, .4f to .9f).forEachIndexed { i, (x, y) ->
                canvas.drawPaint(Paint().apply { shader = RadialGradient(width * x, height * y, width * (.55f - i * .1f),
                    palette[2 - i % 2] and 0x00FFFFFF or (0x88 shl 24), 0, Shader.TileMode.CLAMP) })
            }
            return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        }
    }

    private companion object {
        val HERO_ACTIONS = listOf("Play", "View title")
        val DETAIL_ACTIONS = listOf("Play / Resume", "Play / Resume episode", "Continue series", "Back")
        val PALETTES = listOf(
            intArrayOf(0xFF1E1036.toInt(), 0xFF0B3B4A.toInt(), 0xFFA855F7.toInt()),
            intArrayOf(0xFF2A0F1F.toInt(), 0xFF3B1D0B.toInt(), 0xFFF59E0B.toInt()),
            intArrayOf(0xFF071C2B.toInt(), 0xFF0F3B33.toInt(), 0xFF22D3EE.toInt()),
            intArrayOf(0xFF1B0B2E.toInt(), 0xFF2E0B21.toInt(), 0xFFEC4899.toInt()),
            intArrayOf(0xFF0A1A12.toInt(), 0xFF1B2E0B.toInt(), 0xFF10B981.toInt()),
        )
        const val PROFILES = """[{"id":1,"name":"Ronnie","avatar_url":"nebula:aurora","is_default":true},
            {"id":2,"name":"Maya","avatar_url":"nebula:tidal","subtitle_mode":"on"},
            {"id":3,"name":"Kids","avatar_url":"nebula:ember","max_age_rating":"PG"},
            {"id":4,"name":"Guest","avatar_url":"nebula:cobalt"}]"""
        const val SINTEL = """{"id":101,"title":"Sintel","type":"movie","year":2010,"content_rating":"PG-13","runtime_minutes":15,
            "rating":7.4,"genres":["Fantasy","Adventure"],"poster_path":"/sintel-poster.jpg","backdrop_path":"/sintel-backdrop.jpg",
            "overview":"A young woman crosses frozen peaks and burning cliffs to find the baby dragon she raised, and learns too late what the search has made of her."}"""
        val LIBRARY = listOf(
            SINTEL,
            """{"id":102,"title":"Elephants Dream","type":"movie","year":2006,"content_rating":"PG","runtime_minutes":11,"genres":["Animation","Science Fiction"],
                "poster_path":"/elephants-poster.jpg","backdrop_path":"/elephants-backdrop.jpg","overview":"Two men wander an endless machine that one of them believes he invented.",
                "user_progress":{"position_ms":330000,"duration_ms":654000}}""",
            """{"id":201,"title":"The Long Orbit","type":"show","year":2025,"content_rating":"TV-14","genres":["Science Fiction","Drama"],
                "poster_path":"/long-orbit-poster.jpg","backdrop_path":"/long-orbit-backdrop.jpg","overview":"The crew of a slow cargo ring learns their delivery was never meant to arrive."}""",
            """{"id":103,"title":"The Quiet Meridian","type":"movie","year":2024,"content_rating":"PG-13","runtime_minutes":118,"genres":["Mystery","Drama"],
                "poster_path":"/meridian-poster.jpg","backdrop_path":"/meridian-backdrop.jpg","overview":"A lighthouse keeper's logbook starts recording tomorrow's weather."}""",
            """{"id":202,"title":"Low Tide Radio","type":"show","year":2023,"content_rating":"TV-PG","genres":["Drama"],
                "poster_path":"/low-tide-poster.jpg","backdrop_path":"/low-tide-backdrop.jpg","overview":"A pirate station on a tidal pier only broadcasts while the water is out."}""",
            """{"id":104,"title":"Cinder Atlas","type":"movie","year":2022,"content_rating":"PG-13","runtime_minutes":104,"genres":["Adventure"],
                "poster_path":"/cinder-poster.jpg","backdrop_path":"/cinder-backdrop.jpg","overview":"Mapmakers chase a volcano that moves a mile every night."}""",
            """{"id":105,"title":"Ninefold","type":"movie","year":2021,"content_rating":"R","runtime_minutes":97,"genres":["Science Fiction"],
                "poster_path":"/ninefold-poster.jpg","backdrop_path":"/ninefold-backdrop.jpg","overview":"Nine copies of one engineer disagree about which of them is real."}""",
            """{"id":203,"title":"The Saltwater Static","type":"show","year":2026,"content_rating":"TV-14","genres":["Mystery"],
                "poster_path":"/saltwater-poster.jpg","backdrop_path":"/saltwater-backdrop.jpg","overview":"A sound engineer hears a voice in the noise floor of every coastal recording."}""",
            """{"id":106,"title":"Harbor Lights at Four","type":"movie","year":2019,"content_rating":"G","runtime_minutes":92,"genres":["Animation","Family"],
                "poster_path":"/harbor-poster.jpg","backdrop_path":"/harbor-backdrop.jpg","overview":"Three fishing boats race a storm home before the harbor lights go out."}""",
        )
        const val CONTINUING = """[
            {"media_item_id":201,"episode_id":2205,"title":"The Long Orbit","type":"show","season_number":2,"episode_number":5,"position_ms":1220000,"duration_ms":2700000,
             "poster_path":"/long-orbit-poster.jpg","backdrop_path":"/long-orbit-backdrop.jpg"},
            {"media_item_id":102,"title":"Elephants Dream","type":"movie","position_ms":330000,"duration_ms":654000,
             "poster_path":"/elephants-poster.jpg","backdrop_path":"/elephants-backdrop.jpg"},
            {"media_item_id":203,"episode_id":2302,"title":"The Saltwater Static","type":"show","season_number":1,"episode_number":2,"position_ms":600000,"duration_ms":2500000,
             "poster_path":"/saltwater-poster.jpg","backdrop_path":"/saltwater-backdrop.jpg"}]"""
        const val SINTEL_FILES = """[
            {"id":1001,"video_codec":"h264","resolution":"1920x818","audio_codec":"aac","container":"mkv","duration_ms":888000,"version_tag":"1080p","video_fps":24.0},
            {"id":1002,"video_codec":"hevc","video_profile":"Main","resolution":"4096x1744","audio_codec":"flac","container":"mkv","duration_ms":888000,"version_tag":"4K","video_fps":24.0}]"""
        const val NEXT_EPISODE = """{"id":2205,"season_id":32,"episode_number":5,"title":"Perihelion","runtime_minutes":45,"still_path":"/orbit-still-5.jpg",
             "overview":"The ring passes close enough to the sun to read the cargo manifest's second page.","progress":{"position_ms":1220000,"duration_ms":2700000},
             "files":[{"id":3205,"video_codec":"hevc","resolution":"3840x2160","color_transfer":"smpte2084","audio_codec":"eac3","duration_ms":2700000}]}"""
        const val EPISODES = """[
            {"id":2201,"season_id":32,"episode_number":1,"title":"Slow Burn","runtime_minutes":47,"still_path":"/orbit-still-1.jpg",
             "overview":"A routine course correction leaves the ring a day behind its own schedule.","progress":{"position_ms":2820000,"duration_ms":2820000,"completed":true}},
            {"id":2202,"season_id":32,"episode_number":2,"title":"Mass Driver","runtime_minutes":44,"still_path":"/orbit-still-2.jpg",
             "overview":"Engineering finds a launch rail that is not on any of the station plans.","progress":{"position_ms":2640000,"duration_ms":2640000,"completed":true}},
            {"id":2203,"season_id":32,"episode_number":3,"title":"Dead Reckoning","runtime_minutes":46,"still_path":"/orbit-still-3.jpg",
             "overview":"With navigation offline, the crew steers by the stars their grandparents named.","progress":{"position_ms":2760000,"duration_ms":2760000,"completed":true}},
            {"id":2204,"season_id":32,"episode_number":4,"title":"The Second Manifest","runtime_minutes":49,"still_path":"/orbit-still-4.jpg",
             "overview":"The captain reads what the ring is actually carrying, and tells no one.","progress":{"position_ms":2940000,"duration_ms":2940000,"completed":true}},
            $NEXT_EPISODE,
            {"id":2206,"season_id":32,"episode_number":6,"title":"Aphelion","runtime_minutes":52,"still_path":"/orbit-still-6.jpg",
             "overview":"The season ends where the orbit is coldest and the truth is out."}]"""
    }
}
