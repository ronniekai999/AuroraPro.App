package app.aurorapro.tv

import android.app.Application
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.aurorapro.tv.data.AuroraException
import app.aurorapro.tv.data.Media
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
    // What GET /api/profiles/active answers; null answers 404, an unknown binding.
    @Volatile private var activeProfile: String? = null
    // While set, the kid's activation waits on it.
    @Volatile private var holdKid: java.util.concurrent.CountDownLatch? = null
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
                    path == "/api/profiles/active" -> activeProfile?.let { json(it) } ?: MockResponse().setResponseCode(404)
                    path == "/api/media/30" -> json("""{"id":30,"title":"Movie"}""")
                    path == "/api/media/30/files" -> json("""[{"id":30,"duration_ms":60000}]""")
                    path.endsWith("/activate") -> {
                        val body = request.body.readUtf8()
                        activations += path to body
                        if (path == "/api/profiles/2/activate") holdKid?.await(10, java.util.concurrent.TimeUnit.SECONDS)
                        when {
                            path != "/api/profiles/1/activate" -> json("{}")
                            // The server skips the PIN for the profile the session acts as.
                            activeProfile != null -> json("{}")
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

    @Test fun aRefusedUnlockKeepsTheProfileTheSessionIsActingAs() {
        // Acting as the kid, open the picker from Home and try the parent.
        vm.selectProfile(vm.state.value.profiles.first { it.id == 2L })
        awaitState { it.page == Page.HOME }
        vm.navigate(Page.PROFILES)
        awaitState { it.page == Page.PROFILES }
        vm.selectProfile(parent())
        awaitState { it.pinPrompt != null }
        vm.submitUnlock("0000", usePassword = false)
        val refused = awaitState { it.pinError != null }
        assertEquals("The picker still shows the kid as selected", 2L, refused.profile?.id)
        assertEquals(Page.HOME, refused.profileReturnPage)
        vm.cancelUnlock()
        vm.back()
        assertEquals(Page.HOME, awaitState { it.page == Page.HOME }.page)
    }

    @Test fun aRefusedUnlockPutsBackThePageBehindThePicker() {
        // Acting as the kid, open the picker from a title's page and try the parent.
        vm.selectProfile(vm.state.value.profiles.first { it.id == 2L })
        awaitState { it.page == Page.HOME }
        vm.detail(Media(30, "Movie"))
        awaitState { it.page == Page.DETAIL && it.files.isNotEmpty() }
        vm.navigate(Page.PROFILES)
        awaitState { it.page == Page.PROFILES }
        vm.selectProfile(parent())
        awaitState { it.pinPrompt != null }
        vm.submitUnlock("0000", usePassword = false)
        awaitState { it.pinError != null }
        vm.cancelUnlock()
        vm.back()
        val back = awaitState { it.page == Page.DETAIL }
        assertEquals("The title's page is back, not an empty one", 30L, back.detail?.id)
    }

    @Test fun theProfileTheSessionIsBoundToNeedsNoPin() {
        // A fresh sign-in binds the account default. Asking for its PIN would
        // accept any digits, since the server does not check the session's own.
        activeProfile = """{"id":1,"name":"Ronnie","is_default":true,"has_pin":true}"""
        vm.login("ronnie", "fixture-password")
        awaitState { it.page == Page.PROFILES && it.boundProfileId == 1L }
        vm.selectProfile(parent())
        val opened = awaitState { it.page == Page.HOME }
        assertNull("No PIN prompt for the bound profile", opened.pinPrompt)
        assertEquals("/api/profiles/1/activate" to "{}", activations.single())
    }

    @Test fun aSwitchRecordsTheNewBinding() {
        // Bound to the parent at sign-in; switching to the kid moves the
        // binding, so going back to the parent asks for its PIN again.
        activeProfile = """{"id":1,"name":"Ronnie","is_default":true,"has_pin":true}"""
        vm.login("ronnie", "fixture-password")
        awaitState { it.page == Page.PROFILES && it.boundProfileId == 1L }
        vm.selectProfile(vm.state.value.profiles.first { it.id == 2L })
        awaitState { it.page == Page.HOME && it.boundProfileId == 2L }
        vm.navigate(Page.PROFILES)
        awaitState { it.page == Page.PROFILES }
        vm.selectProfile(parent())
        val prompted = awaitState { it.pinPrompt != null }
        assertEquals(1L, prompted.pinPrompt?.id)
        assertTrue("No activation of the parent before its PIN",
            activations.none { it.first == "/api/profiles/1/activate" })
    }

    @Test fun theProfileShowsOnlyOnceTheServerHasBoundIt() {
        val hold = java.util.concurrent.CountDownLatch(1)
        holdKid = hold
        vm.selectProfile(vm.state.value.profiles.first { it.id == 2L })
        val deadline = System.currentTimeMillis() + 5_000
        while (activations.none { it.first == "/api/profiles/2/activate" }) {
            shadowOf(Looper.getMainLooper()).idle()
            check(System.currentTimeMillis() < deadline) { "the activation never reached the server" }
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idle()
        val pending = vm.state.value
        assertNull("No profile shown while the activation is pending", pending.profile)
        assertEquals(Page.PROFILES, pending.page)
        hold.countDown()
        assertEquals(2L, awaitState { it.page == Page.HOME }.profile?.id)
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
