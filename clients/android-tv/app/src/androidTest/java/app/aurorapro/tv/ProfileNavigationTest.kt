package app.aurorapro.tv

import android.app.Application
import android.view.KeyEvent
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Exercise the production BackHandler and profile binding with real Android Back keys. */
class ProfileNavigationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun cancellingAnIdleProfilePickerReturnsToItsEntryScreen() = withFixture { fixture ->
        for (page in listOf(Page.HOME, Page.MOVIES, Page.SEARCH)) {
            compose.runOnIdle { fixture.vm.navigate(page) }
            fixture.awaitPage(page)
            compose.runOnIdle { fixture.vm.navigate(Page.PROFILES) }
            fixture.awaitPage(Page.PROFILES)
            pressBack()
            fixture.awaitPage(page)
            assertEquals(7L, fixture.vm.state.value.profile?.id)
            assertEquals(7L, fixture.activeProfile.get())
        }
    }

    @Test fun backCannotCancelAnActivationThatHasAlreadyCommittedOnTheServer() = withFixture { fixture ->
        compose.runOnIdle { fixture.vm.navigate(Page.MOVIES) }
        fixture.awaitPage(Page.MOVIES)
        compose.runOnIdle { fixture.vm.navigate(Page.PROFILES) }
        fixture.awaitPage(Page.PROFILES)
        compose.runOnIdle { fixture.vm.selectProfile(fixture.vm.state.value.profiles.last()) }
        assertTrue("Activation request reached the server", fixture.activationEntered.await(30, TimeUnit.SECONDS))
        compose.waitForIdle()
        // Server binding changed, but its successful response has not arrived.
        assertEquals(8L, fixture.activeProfile.get())
        pressBack()
        val pending = fixture.vm.state.value
        assertEquals(Page.PROFILES, pending.page)
        assertTrue(pending.busy)
        assertNull("Do not display the old profile after an uncertain activation", pending.profile)
        fixture.releaseActivation.countDown()
        fixture.awaitPage(Page.HOME)
        assertEquals(8L, fixture.vm.state.value.profile?.id)
        assertEquals(8L, fixture.lastHomeProfile.get())
    }

    @Test fun navigationAndBackCannotInterruptDelayedSignOut() = withFixture { fixture ->
        compose.runOnIdle { fixture.vm.navigate(Page.MOVIES) }
        fixture.awaitPage(Page.MOVIES)
        val previous = requireNotNull(fixture.vm.client)
        compose.runOnIdle { fixture.vm.signOut() }
        assertTrue(fixture.logoutEntered.await(30, TimeUnit.SECONDS))
        compose.waitForIdle()
        compose.onNodeWithText("Home").assertIsNotEnabled()
        compose.runOnIdle { fixture.vm.navigate(Page.HOME) }
        pressBack()
        assertTrue(fixture.vm.state.value.signingOut)
        assertEquals(Page.MOVIES, fixture.vm.state.value.page)
        fixture.releaseLogout.countDown()
        fixture.awaitPage(Page.LOGIN)
        assertFalse(fixture.vm.state.value.signingOut)
        assertNotSame(previous, fixture.vm.client)
    }

    private fun pressBack() {
        InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
    }

    private fun withFixture(block: (Fixture) -> Unit) {
        val fixture = Fixture()
        try {
            fixture.open()
            block(fixture)
        } finally { fixture.close() }
    }

    private inner class Fixture {
        private val application = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        private val preferences = application.getSharedPreferences("aurora_tv", 0)
        private val savedServer = preferences.getString("server", null)
        private val owner = ViewModelStore()
        private val server = MockWebServer()
        val activationEntered = CountDownLatch(1)
        val releaseActivation = CountDownLatch(1)
        val logoutEntered = CountDownLatch(1)
        val releaseLogout = CountDownLatch(1)
        val activeProfile = AtomicLong(0)
        val lastHomeProfile = AtomicLong(0)
        lateinit var vm: TvViewModel

        fun open() {
            check(preferences.edit().remove("server").commit())
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    return when {
                        path == "/api/health" -> json("{}")
                        path == "/api/auth/refresh" -> MockResponse().setResponseCode(401)
                        path == "/api/auth/me" -> MockResponse().setResponseCode(401)
                        path == "/api/auth/logout" -> {
                            logoutEntered.countDown()
                            check(releaseLogout.await(30, TimeUnit.SECONDS))
                            json("{}")
                        }
                        path == "/api/auth/login" -> json("""{"user":{"id":7,"username":"Alice"}}""")
                            .addHeader("Set-Cookie", "aurora_access=alice; Path=/; Max-Age=600")
                            .addHeader("Set-Cookie", "aurora_refresh=refresh-alice; Path=/api/auth; Max-Age=3600")
                        path == "/api/profiles/" -> json("""[{"id":7,"name":"Alice"},{"id":8,"name":"Kids"}]""")
                        path.endsWith("/activate") -> {
                            val id = request.requestUrl!!.pathSegments[2].toLong()
                            activeProfile.set(id)
                            if (id == 8L) {
                                activationEntered.countDown()
                                check(releaseActivation.await(30, TimeUnit.SECONDS))
                            }
                            json("{}")
                        }
                        path == "/api/me/hero" -> json("""{"picks":[]}""")
                        path == "/api/media/recent" -> {
                            lastHomeProfile.set(request.requestUrl!!.queryParameter("profile_id")!!.toLong())
                            json("[]")
                        }
                        path == "/api/progress/continue" || path == "/api/media/" || path == "/api/media/search" -> json("[]")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start()
            val address = server.url("/").toString()
            compose.runOnIdle { vm = TvViewModel(application).also { owner.put("profile-navigation", it) } }
            compose.setContent { AuroraTheme { AuroraApp(vm) } }
            compose.runOnIdle { vm.connect(address) }
            awaitPage(Page.LOGIN)
            compose.runOnIdle { vm.login("Alice", "fixture-password") }
            awaitPage(Page.PROFILES)
            compose.runOnIdle { vm.selectProfile(vm.state.value.profiles.first()) }
            awaitPage(Page.HOME)
        }

        fun awaitPage(page: Page) {
            compose.waitUntil(timeoutMillis = 30_000) { vm.state.value.page == page && !vm.state.value.busy }
            compose.waitForIdle()
        }

        fun close() {
            releaseActivation.countDown()
            releaseLogout.countDown()
            compose.runOnIdle { owner.clear() }
            if (::vm.isInitialized) vm.client?.cookies?.retire()
            val edit = preferences.edit()
            if (savedServer == null) edit.remove("server") else edit.putString("server", savedServer)
            check(edit.commit())
            server.shutdown()
        }
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
}
