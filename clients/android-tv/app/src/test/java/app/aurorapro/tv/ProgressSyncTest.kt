package app.aurorapro.tv

import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.syncProgress
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.RecordedRequest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.CopyOnWriteArrayList

class ProgressSyncTest {
    @Test fun delayedFinalSaveFinishesBeforeReentryReadsOrWritesTheSameProgressRow(): Unit = runBlocking {
        MockWebServer().use { server ->
            val finalEntered = CountDownLatch(1)
            val releaseFinal = CountDownLatch(1)
            val saved = AtomicLong(0)
            val requests = CopyOnWriteArrayList<RecordedRequest>()
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    if (request.method == "PUT") {
                        val position = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject["position_ms"]!!.jsonPrimitive.content.toLong()
                        if (position == 30000L) { finalEntered.countDown(); check(releaseFinal.await(5, TimeUnit.SECONDS)) }
                        saved.set(position)
                        return MockResponse().setBody("{}")
                    }
                    return MockResponse().setBody("""{"position_ms":${saved.get()},"duration_ms":90000}""")
                }
            }
            server.start()
            val origin = server.url("/")
            val api = AuroraClient(origin, SessionCookies(origin, MemoryCookies()))
            val target = PlayTarget(Media(1, "Episode"), MediaFile(1, durationMs = 90000), Profile(7, "Viewer"), episodeId = 209)
            try {
                // Player disposal starts this before allowing another screen
                // to read Resume. Exercise that ordering through real HTTP.
                val outgoing = launch(start = CoroutineStart.UNDISPATCHED) { api.saveFinalProgress(target, 30000, 90000) }
                assertTrue(finalEntered.await(5, TimeUnit.SECONDS))
                val reopened = async(Dispatchers.Default) {
                    val resume = api.progress(1, 7, 209).positionMs
                    api.saveProgress(target, 10000, 90000) // Start over/seek in the new player.
                    resume
                }
                delay(100)
                assertFalse(reopened.isCompleted)
                assertFalse(requests.any { it.method == "GET" && it.requestUrl!!.queryParameter("profile_id") == "7" })
                // A different profile or episode must not wait for this row.
                withTimeout(2000) { api.progress(1, 8, 209); api.progress(1, 7, 210) }
                releaseFinal.countDown()
                assertEquals(30000L, withTimeout(5000) { reopened.await() })
                outgoing.join()
                assertEquals(10000L, api.progress(1, 7, 209).positionMs)
            } finally { releaseFinal.countDown() }
        }
    }

    @Test fun timedOutPutCanBeFollowedBySuccessfulProgressSync(): Unit = runBlocking {
        MockWebServer().use { server ->
            server.start()
            val origin = server.url("/")
            val api = AuroraClient(origin, SessionCookies(origin, MemoryCookies()))
            val target = PlayTarget(Media(1, "Movie"), MediaFile(1, durationMs = 90000), Profile(7, "Viewer"))
            server.enqueue(MockResponse().setBody("{}").setBodyDelay(1, TimeUnit.SECONDS))
            assertFalse(syncProgress(timeoutMs = 250) { api.saveProgress(target, 30000, 90000) })
            val failed = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertEquals("PUT", failed.method)
            assertEquals("/api/progress/1", failed.path)
            server.enqueue(MockResponse().setBody("{}"))
            assertTrue(syncProgress { api.saveProgress(target, 34000, 90000) })
            val recovered = server.takeRequest(5, TimeUnit.SECONDS)!!
            assertTrue(recovered.body.readUtf8().let { it.contains("\"position_ms\":34000") && it.contains("\"profile_id\":7") })
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun ownerCancellationStillCancelsThePeriodicLoop(): Unit = runTest {
        val entered = CompletableDeferred<Unit>()
        var continued = false
        val owner = launch {
            syncProgress(timeoutMs = 1000) { entered.complete(Unit); awaitCancellation() }
            continued = true
        }
        entered.await()
        owner.cancel()
        advanceUntilIdle()
        owner.join()
        assertTrue(owner.isCancelled)
        assertFalse(continued)
    }
}
