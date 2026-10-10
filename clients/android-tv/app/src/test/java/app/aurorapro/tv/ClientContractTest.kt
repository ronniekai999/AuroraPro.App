package app.aurorapro.tv

import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.SourceTimeline
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class MemoryCookies : CookiePersistence {
    @Volatile var saved = emptyList<String>()
    override fun read() = saved
    override fun write(cookies: List<String>) { saved = cookies }
}

class ClientContractTest {
    @Test fun serverNormalizationAndOriginIsolation() {
        assertEquals("https://aurora.example/", serverAddress("aurora.example/v2/").toString())
        assertEquals("http://192.168.1.2:8080/", serverAddress("http://192.168.1.2:8080").toString())
        for (address in listOf("http://aurora.example", "https://user:secret@aurora.example", "https://aurora.example/path", "https://aurora.example/?secret=x")) {
            assertThrows(IllegalArgumentException::class.java) { serverAddress(address) }
        }
        val origin = "https://aurora.example/".toHttpUrl()
        val persistence = MemoryCookies()
        val jar = SessionCookies(origin, persistence)
        val login = origin.resolve("/api/auth/login")!!
        jar.saveFromResponse(login, listOf(
            Cookie.parse(login, "aurora_access=access; Path=/; Secure; HttpOnly; Max-Age=600")!!,
            Cookie.parse(login, "aurora_refresh=refresh; Path=/api/auth; Secure; HttpOnly; Max-Age=3600")!!))
        assertEquals(1, jar.loadForRequest(origin.resolve("/api/media/")!!).size)
        assertEquals(2, jar.loadForRequest(login).size)
        assertTrue(jar.loadForRequest("https://images.example/api/auth".toHttpUrl()).isEmpty())
        assertTrue(jar.loadForRequest("https://aurora.example:8443/api/auth".toHttpUrl()).isEmpty())
        assertTrue(jar.loadForRequest("http://aurora.example/api/auth".toHttpUrl()).isEmpty())
        assertEquals(2, SessionCookies(origin, persistence).loadForRequest(login).size)
        jar.clear()
        assertTrue(persistence.saved.isEmpty())
    }

    @Test fun envelopesNullsAndContinueIdentity(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val client = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            server.enqueue(MockResponse().setBody("null"))
            assertTrue(client.files(7).isEmpty())
            server.enqueue(MockResponse().setBody("{\"data\":[{\"id\":7,\"title\":\"Show\",\"type\":\"show\",\"genres\":null,\"poster_path\":null}],\"page\":1,\"per_page\":80,\"total_items\":1,\"total_pages\":1}"))
            val media = client.browse("show", 4).single()
            assertTrue(media.isShow)
            assertEquals(emptyList<String>(), media.genres)
            assertEquals("", media.posterPath)
            val row = apiJson.decodeFromString<ContinueItem>("""{"id":999,"media_item_id":7,"episode_id":8,"title":"Show","type":"show","position_ms":123456}""")
            assertEquals(7L, row.media().id)
            assertEquals(123456L, row.positionMs)
            assertThrows(IllegalArgumentException::class.java) { client.endpoint("https://other.example/steal") }
        }
    }

    @Test fun concurrentUnauthorizedRequestsShareCookieRefresh() = runBlocking {
        MockWebServer().use { server ->
            val refreshes = AtomicInteger()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.path == "/api/auth/refresh") {
                        refreshes.incrementAndGet()
                        assertTrue(request.getHeader("Cookie").orEmpty().contains("aurora_refresh=renew"))
                        return MockResponse().setBody("{}").addHeader("Set-Cookie", "aurora_access=fresh; Path=/; Max-Age=600")
                    }
                    if (!request.getHeader("Cookie").orEmpty().contains("aurora_access=fresh")) return MockResponse().setResponseCode(401)
                    assertFalse(request.getHeader("Cookie").orEmpty().contains("aurora_refresh"))
                    return MockResponse().setBody("{\"id\":7,\"title\":\"Movie\"}")
                }
            }
            server.start()
            val jar = SessionCookies(server.url("/"), MemoryCookies())
            val login = server.url("/api/auth/login")
            jar.saveFromResponse(login, listOf(Cookie.parse(login, "aurora_access=old; Path=/; Max-Age=600")!!,
                Cookie.parse(login, "aurora_refresh=renew; Path=/api/auth; Max-Age=3600")!!))
            val client = AuroraClient(server.url("/"), jar)
            val items = (1..8).map { async { client.media(7) } }.awaitAll()
            assertEquals(8, items.size)
            assertEquals(1, refreshes.get())
        }
    }

    @Test fun logoutWaitsForRotationAndRetiredResponsesCannotReplaceNextAccount(): Unit = runBlocking {
        MockWebServer().use { server ->
            val refreshing = CountDownLatch(1)
            val releaseRefresh = CountDownLatch(1)
            val lateStarted = CountDownLatch(1)
            val releaseLate = CountDownLatch(1)
            val logoutCalled = CountDownLatch(1)
            val logoutReceived = CountDownLatch(1)
            val logoutCookie = AtomicReference<String>()
            val refreshes = AtomicInteger()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                    "/api/health" -> {
                        lateStarted.countDown()
                        check(releaseLate.await(10, TimeUnit.SECONDS))
                        MockResponse().setBody("{}").addHeader("Set-Cookie", "aurora_access=late-old-account; Path=/; Max-Age=600")
                    }
                    "/api/auth/refresh" -> {
                        refreshes.incrementAndGet()
                        refreshing.countDown()
                        check(releaseRefresh.await(10, TimeUnit.SECONDS))
                        MockResponse().setBody("{}")
                            .addHeader("Set-Cookie", "aurora_access=fresh-a; Path=/; Max-Age=600")
                            .addHeader("Set-Cookie", "aurora_refresh=rotated-a; Path=/api/auth; Max-Age=3600")
                    }
                    "/api/auth/logout" -> {
                        logoutCookie.set(request.getHeader("Cookie").orEmpty())
                        logoutReceived.countDown()
                        MockResponse().setBody("{}")
                    }
                    "/api/auth/login" -> MockResponse().setBody("""{"user":{"id":8,"username":"Bob"}}""")
                        .addHeader("Set-Cookie", "aurora_access=account-b; Path=/; Max-Age=600")
                        .addHeader("Set-Cookie", "aurora_refresh=refresh-b; Path=/api/auth; Max-Age=3600")
                    else -> if (request.getHeader("Cookie").orEmpty().contains("aurora_access=old-a"))
                        MockResponse().setResponseCode(401)
                    else MockResponse().setBody("""{"id":7,"title":"Movie"}""")
                }
            }
            server.start()
            val origin = server.url("/")
            val persistence = MemoryCookies()
            val jar = SessionCookies(origin, persistence)
            val login = server.url("/api/auth/login")
            jar.saveFromResponse(login, listOf(
                Cookie.parse(login, "aurora_access=old-a; Path=/; Max-Age=600")!!,
                Cookie.parse(login, "aurora_refresh=refresh-a; Path=/api/auth; Max-Age=3600")!!))
            val previous = AuroraClient(origin, jar)
            try {
                val late = async(Dispatchers.Default) { runCatching { previous.checkServer() } }
                withContext(Dispatchers.IO) { assertTrue(lateStarted.await(5, TimeUnit.SECONDS)) }
                val cleanup = async(Dispatchers.Default) { runCatching { previous.media(7) } }
                withContext(Dispatchers.IO) { assertTrue(refreshing.await(5, TimeUnit.SECONDS)) }
                val signingOut = async(Dispatchers.Default) { logoutCalled.countDown(); previous.logout() }
                withContext(Dispatchers.IO) {
                    assertTrue(logoutCalled.await(5, TimeUnit.SECONDS))
                    assertFalse("Logout must wait for the rotating refresh token", logoutReceived.await(250, TimeUnit.MILLISECONDS))
                }
                releaseRefresh.countDown()
                withTimeout(10_000) { signingOut.await(); cleanup.await() }
                assertTrue(logoutCookie.get().contains("aurora_refresh=rotated-a"))
                assertTrue(persistence.saved.isEmpty())
                val next = previous.nextSession()
                assertEquals(8L, next.login("Bob", "password").id)
                releaseLate.countDown()
                withTimeout(10_000) { late.await() }
                // Even clearing or delivering cookies to the old generation cannot
                // mutate the new account's persistence or authenticate old cleanup.
                jar.clear()
                assertTrue(SessionCookies(origin, persistence).header(login).contains("aurora_access=account-b"))
                assertFalse(persistence.saved.any { it.contains("late-old-account") })
                assertTrue(runCatching { previous.checkServer() }.exceptionOrNull() is IOException)
                assertEquals(7L, next.media(7).id)
                assertEquals(1, refreshes.get())
            } finally { releaseRefresh.countDown(); releaseLate.countDown() }
        }
    }

    @Test fun changingConnectionRetiresOldClientButPreservesSavedSignIn(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val origin = server.url("/")
            val persistence = MemoryCookies()
            val jar = SessionCookies(origin, persistence)
            val login = server.url("/api/auth/login")
            jar.saveFromResponse(login, listOf(Cookie.parse(login, "aurora_access=saved; Path=/; Max-Age=600")!!))
            val previous = AuroraClient(origin, jar)
            previous.disconnect()
            val next = previous.nextSession()
            jar.saveFromResponse(login, listOf(Cookie.parse(login, "aurora_access=late; Path=/; Max-Age=600")!!))
            assertTrue(next.cookies.header(login).contains("aurora_access=saved"))
            assertTrue(runCatching { previous.checkServer() }.exceptionOrNull() is IOException)
            server.enqueue(MockResponse().setBody("{}"))
            next.checkServer()
            assertEquals("aurora_access=saved", server.takeRequest().getHeader("Cookie"))
        }
    }

    @Test fun sessionAndProgressKeepProfileEpisodeLanguageAndSourceTime() = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val client = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            val target = PlayTarget(Media(7, "Show", "show"), MediaFile(9, videoCodec = "hevc", colorTransfer = "smpte2084"),
                Profile(4, "Alice", language = "ja"), episodeId = 8, resumeMs = 23456)
            server.enqueue(MockResponse().setBody("""{"stream":{"decision":"direct_stream","audio_track_index":2,"remux":true,"audio_passthrough":true}}"""))
            val info = client.streamInfo(target, "h264,aac,hls_native")
            val request = server.takeRequest()
            assertTrue(request.path.orEmpty().contains("audio_lang=ja"))
            assertTrue(request.path.orEmpty().contains("type=episode"))
            server.enqueue(MockResponse().setBody("""{"session_id":"abc","master_playlist":"/api/stream/hls/abc/master.m3u8","start_sec":17}"""))
            val session = client.createSession(target, info.stream, 23456, force = true)
            val payload = server.takeRequest().body.readUtf8()
            assertTrue(payload.contains("\"start_sec\":23"))
            assertTrue(payload.contains("\"audio_track_index\":2"))
            assertTrue(payload.contains("\"remux\":false"))
            assertTrue(payload.contains("\"audio_passthrough\":false"))
            assertTrue(payload.contains("\"hdr_tonemap\":true"))
            val timeline = SourceTimeline(session.startSec * 1000, 100000)
            assertEquals(29000L, timeline.sourcePosition(12000))
            assertEquals(6456L, timeline.playerPosition(23456))
            server.enqueue(MockResponse().setBody("{}"))
            client.saveProgress(target, timeline.sourcePosition(12000), timeline.durationMs)
            val progress = server.takeRequest()
            assertEquals("/api/progress/7", progress.path)
            assertEquals("PUT", progress.method)
            assertTrue(progress.body.readUtf8().let { it.contains("\"profile_id\":4") && it.contains("\"episode_id\":8") && it.contains("\"position_ms\":29000") })
        }
    }

    @Test fun sourceTimelineClampsOffsetsAndEndSeeks() {
        val timeline = SourceTimeline(17000, 100000)
        assertEquals(17000L, timeline.sourcePosition(-1))
        assertEquals(100000L, timeline.sourcePosition(999999))
        assertEquals(0L, timeline.playerPosition(12000))
        assertEquals(99000L, timeline.seekPosition(150000))
        assertEquals(0L, timeline.seekPosition(-30))
        assertEquals(123L, SourceTimeline(0, 0).sourcePosition(123))
    }

    @Test fun recommendationOutageLeavesHomeLibraryAvailable() = runBlocking {
        MockWebServer().use { server ->
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when {
                    request.path.orEmpty().startsWith("/api/media/recent") -> MockResponse().setBody("""[{"id":7,"title":"Movie"}]""")
                    request.path.orEmpty().startsWith("/api/progress/continue") -> MockResponse().setBody("[]")
                    else -> MockResponse().setResponseCode(500).setBody("""{"error":{"message":"recommendations unavailable"}}""")
                }
            }
            server.start()
            val api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            val home = api.home(4)
            assertEquals(7L, home.recent.single().id)
            assertNull(home.hero)
        }
    }
}
