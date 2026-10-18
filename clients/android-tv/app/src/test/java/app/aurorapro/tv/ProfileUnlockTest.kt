package app.aurorapro.tv

import android.app.Application
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.aurorapro.tv.data.AuroraException
import java.util.Collections
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The profile lock on the TV: a locked profile asks for its PIN before any
 * activation, a refused PIN keeps asking, and only an accepted one opens Home.
 * The server decides; the client must never show a locked profile's content
 * on its own say-so.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35])
class ProfileUnlockTest {
    private val application = ApplicationProvider.getApplicationContext<Application>()
    private val server = MockWebServer()
    private val activations = Collections.synchronizedList(mutableListOf<Pair<String, String>>())
    private lateinit var vm: TvViewModel

    @Before fun start() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path == "/api/health" -> json("{}")
                    path == "/api/auth/me" || path == "/api/auth/refresh" -> MockResponse().setResponseCode(401)
                    path == "/api/auth/login" -> json("""{"user":{"id":1,"username":"ronnie"}}""")
                    path == "/api/profiles/" -> json(PROFILES)
                    path.endsWith("/activate") -> {
                        val body = request.body.readUtf8()
                        activations += path to body
                        when {
                            path != "/api/profiles/1/activate" -> json("{}")
                            "\"pin\":\"1234\"" in body || "\"password\":\"hunter2\"" in body -> json("{}")
                            "\"pin\"" in body || "\"password\"" in body -> refusal(403, "profile_pin_invalid")
                            else -> refusal(403, "profile_pin_required")
                        }
                    }
                    path == "/api/me/hero" -> json("""{"picks":[]}""")
                    path == "/api/progress/continue" || path == "/api/media/recent" -> json("[]")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        vm = TvViewModel(application)
        vm.connect(server.url("/").toString())
        awaitState { it.page == Page.LOGIN }
        vm.login("ronnie", "fixture-password")
        awaitState { it.page == Page.PROFILES }
    }

    @After fun stop() { server.shutdown() }

    @Test fun aLockedProfileAsksBeforeAnyActivation() {
        vm.selectProfile(parent())
        val prompted = awaitState { it.pinPrompt != null }
        assertEquals(1L, prompted.pinPrompt?.id)
        assertEquals(Page.PROFILES, prompted.page)
        assertTrue("No activation before a PIN is entered", activations.isEmpty())
    }

    @Test fun aWrongPinKeepsAskingAndShowsNothing() {
        vm.selectProfile(parent())
        awaitState { it.pinPrompt != null }
        vm.submitUnlock("0000", usePassword = false)
        val refused = awaitState { it.pinError != null }
        assertEquals("That PIN is not right.", refused.pinError)
        assertEquals(Page.PROFILES, refused.page)
        assertNull(refused.profile)
        assertNull("A refusal is not a page-level error", refused.error)
        assertEquals("/api/profiles/1/activate" to """{"pin":"0000"}""", activations.single())
    }

    @Test fun theRightPinOpensTheProfile() {
        vm.selectProfile(parent())
        awaitState { it.pinPrompt != null }
        vm.submitUnlock("0000", usePassword = false)
        awaitState { it.pinError != null }
        vm.submitUnlock("1234", usePassword = false)
        val opened = awaitState { it.page == Page.HOME }
        assertEquals(1L, opened.profile?.id)
        assertNull(opened.pinPrompt)
        assertNull(opened.pinError)
    }

    @Test fun theAccountPasswordStandsInForThePin() {
        vm.selectProfile(parent())
        awaitState { it.pinPrompt != null }
        vm.submitUnlock("hunter2", usePassword = true)
        awaitState { it.page == Page.HOME }
        assertEquals("/api/profiles/1/activate" to """{"password":"hunter2"}""", activations.single())
    }

    @Test fun backCancelsThePrompt() {
        vm.selectProfile(parent())
        awaitState { it.pinPrompt != null }
        vm.back()
        val cancelled = awaitState { it.pinPrompt == null }
        assertEquals(Page.PROFILES, cancelled.page)
        assertTrue(activations.isEmpty())
    }

    @Test fun anUnlockedProfileActivatesWithAnEmptyBody() {
        vm.selectProfile(vm.state.value.profiles.first { it.id == 2L })
        awaitState { it.page == Page.HOME }
        assertEquals("/api/profiles/2/activate" to "{}", activations.single())
    }

    @Test fun aPinTheProfileListDidNotKnowAboutStillPrompts() {
        // The list said unlocked; the server says otherwise.
        vm.selectProfile(parent().copy(hasPin = false))
        val prompted = awaitState { it.pinPrompt != null }
        assertEquals(1L, prompted.pinPrompt?.id)
        assertNull(prompted.pinError)
        assertNull(prompted.error)
    }

    @Test fun theReasonTravelsOnTheException() {
        val client = requireNotNull(vm.client)
        val error = runCatching { kotlinx.coroutines.runBlocking { client.activate(parent(), pin = "9999") } }.exceptionOrNull()
        assertTrue(error is AuroraException)
        assertEquals("profile_pin_invalid", (error as AuroraException).reason)
        assertEquals(403, error.status)
    }

    private fun parent() = vm.state.value.profiles.first { it.id == 1L }.also { assertTrue(it.hasPin) }

    private fun awaitState(condition: (TvState) -> Boolean): TvState {
        val deadline = System.currentTimeMillis() + 20_000
        while (true) {
            shadowOf(Looper.getMainLooper()).idle()
            val state = vm.state.value
            if (condition(state) && !state.busy) return state
            check(System.currentTimeMillis() < deadline) { "Timed out; state was $state" }
            Thread.sleep(10)
        }
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
    private fun refusal(status: Int, reason: String) = json(
        """{"error":{"code":$status,"message":"refused","reason":"$reason"}}""").setResponseCode(status)

    private companion object {
        const val PROFILES = """[{"id":1,"name":"Ronnie","is_default":true,"has_pin":true},
            {"id":2,"name":"Kids","max_age_rating":"PG"}]"""
    }
}
