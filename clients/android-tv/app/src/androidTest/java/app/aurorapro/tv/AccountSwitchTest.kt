package app.aurorapro.tv

import android.app.Application
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import app.aurorapro.tv.data.apiJson
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class AccountSwitchTest {
    @Test fun signOutThenSignInUsesTheNewAccountAndRetiresOldCleanup(): Unit = runBlocking {
        val application = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val preferences = application.getSharedPreferences("aurora_tv", 0)
        val savedServer = preferences.getString("server", null)
        check(preferences.edit().remove("server").commit())
        val owner = ViewModelStore()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val bob = request.getHeader("Cookie").orEmpty().contains("aurora_access=bob")
                val id = if (bob) 8 else 7
                val name = if (bob) "Bob" else "Alice"
                return when (request.requestUrl!!.encodedPath) {
                    "/api/health", "/api/auth/logout" -> json("{}")
                    "/api/auth/refresh" -> MockResponse().setResponseCode(401)
                    "/api/auth/me" -> if (request.getHeader("Cookie").isNullOrBlank()) MockResponse().setResponseCode(401)
                        else json("""{"id":$id,"username":"$name"}""")
                    "/api/profiles/" -> json("""[{"id":$id,"name":"$name"}]""")
                    "/api/auth/login" -> {
                        val username = apiJson.parseToJsonElement(request.body.readUtf8()).jsonObject["username"]!!.jsonPrimitive.content
                        val nextId = if (username == "Bob") 8 else 7
                        val cookie = username.lowercase()
                        json("""{"user":{"id":$nextId,"username":"$username"}}""")
                            .addHeader("Set-Cookie", "aurora_access=$cookie; Path=/; Max-Age=600")
                            .addHeader("Set-Cookie", "aurora_refresh=refresh-$cookie; Path=/api/auth; Max-Age=3600")
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        val address = server.url("/").toString()
        val vm = withContext(Dispatchers.Main) { TvViewModel(application).also { owner.put("account-switch", it) } }
        try {
            withContext(Dispatchers.Main) { vm.connect(address) }
            withTimeout(30_000) { vm.state.first { it.page == Page.LOGIN && !it.busy } }
            withContext(Dispatchers.Main) { vm.login("Alice", "fixture-password") }
            withTimeout(30_000) { vm.state.first { it.page == Page.PROFILES && it.user?.id == 7L && !it.busy } }
            val previous = requireNotNull(vm.client)
            withContext(Dispatchers.Main) { vm.signOut() }
            withTimeout(30_000) { vm.state.first { it.page == Page.LOGIN && !it.busy } }
            withContext(Dispatchers.Main) { vm.login("Bob", "fixture-password") }
            val current = withTimeout(30_000) { vm.state.first { it.page == Page.PROFILES && it.user?.id == 8L && !it.busy } }
            assertEquals(8L, current.profiles.single().id)
            assertEquals(8L, requireNotNull(vm.client).me().id)
            assertTrue(runCatching { previous.me() }.exceptionOrNull() is IOException)
            previous.cookies.clear()
            assertEquals(8L, requireNotNull(vm.client).me().id)
        } finally {
            withContext(Dispatchers.Main) { owner.clear() }
            vm.client?.cookies?.retire()
            val edit = preferences.edit()
            if (savedServer == null) edit.remove("server") else edit.putString("server", savedServer)
            check(edit.commit())
            server.shutdown()
        }
    }

    private fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
}
