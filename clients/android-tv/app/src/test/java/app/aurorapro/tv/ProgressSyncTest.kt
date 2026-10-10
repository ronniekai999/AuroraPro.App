package app.aurorapro.tv

import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.syncProgress
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class ProgressSyncTest {
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
