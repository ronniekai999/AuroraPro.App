package app.aurorapro.tv

import app.aurorapro.tv.data.*
import kotlinx.coroutines.*
import okhttp3.Cookie
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class ProfileRotationTest {
    @Test fun activationFinishesBeforeConcurrentRefreshCopiesTheProfile(): Unit = runBlocking {
        MockWebServer().use { server ->
            val activationEntered = CountDownLatch(1)
            val releaseActivation = CountDownLatch(1)
            val unauthorized = CountDownLatch(1)
            val refreshEntered = CountDownLatch(1)
            val oldProfile = AtomicLong(1)
            val newProfile = AtomicLong(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                    "/api/profiles/7/activate" -> {
                        activationEntered.countDown()
                        check(releaseActivation.await(10, TimeUnit.SECONDS))
                        oldProfile.set(7)
                        MockResponse().setBody("{}")
                    }
                    "/api/auth/refresh" -> {
                        newProfile.set(oldProfile.get())
                        refreshEntered.countDown()
                        refreshed()
                    }
                    else -> if (request.getHeader("Cookie").orEmpty().contains("aurora_access=new")) user()
                        else { unauthorized.countDown(); MockResponse().setResponseCode(401) }
                }
            }
            server.start()
            val api = client(server)
            try {
                val activation = async(Dispatchers.IO) { api.activate(Profile(7, "Kids")) }
                check(activationEntered.await(5, TimeUnit.SECONDS))
                val background = async(Dispatchers.IO) { api.me() }
                check(unauthorized.await(5, TimeUnit.SECONDS))
                assertFalse("Refresh must wait for the admitted activation", refreshEntered.await(250, TimeUnit.MILLISECONDS))
                releaseActivation.countDown()
                withTimeout(10_000) { activation.await(); background.await() }
                assertEquals("Replacement must carry the selected profile", 7L, newProfile.get())
            } finally { releaseActivation.countDown() }
        }
    }

    @Test fun activationWaitsForPendingRefreshAndBindsTheReplacement(): Unit = runBlocking {
        MockWebServer().use { server ->
            val refreshEntered = CountDownLatch(1)
            val releaseRefresh = CountDownLatch(1)
            val activationEntered = CountDownLatch(1)
            val oldProfile = AtomicLong(1)
            val newProfile = AtomicLong(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val fresh = request.getHeader("Cookie").orEmpty().contains("aurora_access=new")
                    return when (request.requestUrl!!.encodedPath) {
                        "/api/auth/refresh" -> {
                            val copied = oldProfile.get()
                            refreshEntered.countDown()
                            check(releaseRefresh.await(10, TimeUnit.SECONDS))
                            newProfile.set(copied)
                            refreshed()
                        }
                        "/api/profiles/7/activate" -> {
                            activationEntered.countDown()
                            if (fresh) newProfile.set(7) else oldProfile.set(7)
                            MockResponse().setBody("{}")
                        }
                        else -> if (fresh) user() else MockResponse().setResponseCode(401)
                    }
                }
            }
            server.start()
            val api = client(server)
            try {
                val background = async(Dispatchers.IO) { api.me() }
                check(refreshEntered.await(5, TimeUnit.SECONDS))
                val activation = async(Dispatchers.IO) { api.activate(Profile(7, "Kids")) }
                assertFalse("Activation must wait for replacement cookies", activationEntered.await(250, TimeUnit.MILLISECONDS))
                releaseRefresh.countDown()
                withTimeout(10_000) { background.await(); activation.await() }
                assertEquals("Activation must target the replacement", 7L, newProfile.get())
                assertEquals(1L, oldProfile.get())
            } finally { releaseRefresh.countDown() }
        }
    }

    @Test fun activationCanRefreshItsOwnExpiredAccessWithoutDeadlock(): Unit = runBlocking {
        MockWebServer().use { server ->
            val selected = AtomicLong(1)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.requestUrl!!.encodedPath == "/api/auth/refresh") return refreshed()
                    if (!request.getHeader("Cookie").orEmpty().contains("aurora_access=new")) return MockResponse().setResponseCode(401)
                    selected.set(7)
                    return MockResponse().setBody("{}")
                }
            }
            server.start()
            withTimeout(10_000) { client(server).activate(Profile(7, "Kids")) }
            assertEquals(7L, selected.get())
        }
    }

    private fun client(server: MockWebServer): AuroraClient {
        val origin = server.url("/")
        val jar = SessionCookies(origin, MemoryCookies())
        val url = server.url("/api/auth/login")
        jar.saveFromResponse(url, listOf(Cookie.parse(url, "aurora_access=old; Path=/; Max-Age=600")!!,
            Cookie.parse(url, "aurora_refresh=renew; Path=/api/auth; Max-Age=3600")!!))
        return AuroraClient(origin, jar)
    }

    private fun user() = MockResponse().setBody("""{"id":7,"username":"Viewer"}""")
    private fun refreshed() = MockResponse().setBody("{}")
        .addHeader("Set-Cookie", "aurora_access=new; Path=/; Max-Age=600")
        .addHeader("Set-Cookie", "aurora_refresh=replacement; Path=/api/auth; Max-Age=3600")
}
