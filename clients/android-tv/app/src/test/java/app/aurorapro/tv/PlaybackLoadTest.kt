package app.aurorapro.tv

import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.replacePlaybackLoad
import kotlinx.coroutines.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class PlaybackLoadTest {
    @Test fun cancellingAReplacementStillWaitsForAndDeletesItsPredecessorsLateSession(): Unit = runBlocking {
        MockWebServer().use { server ->
            val creating = CountDownLatch(1)
            val releaseCreation = CountDownLatch(1)
            val deleted = CountDownLatch(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.method) {
                    "POST" -> {
                        creating.countDown()
                        check(releaseCreation.await(10, TimeUnit.SECONDS))
                        MockResponse().setResponseCode(201).setBody("""{"session_id":"late","master_playlist":"/api/stream/hls/late/master.m3u8","start_sec":28}""")
                    }
                    "DELETE" -> { assertEquals("/api/stream/sessions/late", request.path); deleted.countDown(); MockResponse().setBody("{}") }
                    else -> MockResponse().setResponseCode(404)
                }
            }
            server.start()
            val api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            val target = PlayTarget(Media(1, "Fixture"), MediaFile(1), Profile(7, "Viewer"))
            val ownedScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val session = AtomicReference<String>()
            try {
                val predecessor = ownedScope.replacePlaybackLoad(null) {
                    val created = withContext(NonCancellable) { api.createSession(target, StreamDecision("transcode"), 30_000, false) }
                    session.set(created.id)
                    currentCoroutineContext().ensureActive()
                }
                check(creating.await(5, TimeUnit.SECONDS))
                val replacement = ownedScope.replacePlaybackLoad(predecessor) { fail("Cancelled replacement must not create another session") }
                replacement.cancel()
                val cleanup = async(Dispatchers.IO) {
                    replacement.join()
                    session.get()?.let { api.deleteSession(it) }
                }
                assertFalse("Cleanup must retain the pending predecessor", deleted.await(250, TimeUnit.MILLISECONDS))
                releaseCreation.countDown()
                withTimeout(10_000) { cleanup.await() }
                assertTrue("Late creation must be explicitly deleted", deleted.await(1, TimeUnit.SECONDS))
            } finally { releaseCreation.countDown(); ownedScope.cancel() }
        }
    }
}
