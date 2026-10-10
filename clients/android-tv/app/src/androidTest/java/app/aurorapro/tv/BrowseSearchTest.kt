package app.aurorapro.tv

import android.app.Application
import android.graphics.Bitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.platform.app.InstrumentationRegistry
import app.aurorapro.tv.data.*
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

@OptIn(ExperimentalTestApi::class)
class BrowseSearchTest {
    @get:Rule val compose = createComposeRule()

    @Test fun focusingHeroActionsKeepsRecommendationAndTitleFullyVisible() = withFixture { fixture ->
        fixture.showHero = true
        compose.runOnIdle { fixture.vm.navigate(Page.HOME) }
        fixture.await(Page.HOME)
        compose.onNodeWithText("View title").performSemanticsAction(SemanticsActions.RequestFocus)
        val reason = compose.onNodeWithText("A pick for your cinema")
        assertUnclipped(reason)
        fixture.capture("home")
    }

    @Test fun remotePaginationFilteringAndDetailReturnKeepAllTitlesAccessible() = withFixture { fixture ->
        compose.runOnIdle { fixture.vm.navigate(Page.MOVIES) }
        fixture.await(Page.MOVIES)
        assertEquals(2, fixture.vm.state.value.items.size)
        compose.onNodeWithText("Load more titles").performScrollTo()
            .performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Load more titles").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy && fixture.vm.state.value.browsePage == 2 }
        assertEquals(listOf(1L, 2L, 3L), fixture.vm.state.value.items.map { it.id })
        compose.onNodeWithText("Movie 3").performScrollTo().performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Movie 3").performKeyInput { pressKey(Key.DirectionCenter) }
        fixture.await(Page.DETAIL)
        compose.onNodeWithText("Back").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Back").performKeyInput { pressKey(Key.DirectionCenter) }
        fixture.await(Page.MOVIES)
        compose.onNodeWithText("Movie 3").assertIsFocused()
        compose.onNodeWithText("Sort: Recent").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Sort: Recent").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.onNodeWithText("Title A–Z").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Title A–Z").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy && fixture.vm.state.value.browseSort == "title" }
        compose.onNodeWithText("Genre: All").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Genre: All").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.onNodeWithText("Comedy").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Comedy").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy && fixture.vm.state.value.browseGenre == "Comedy" }
        val request = fixture.requests.last { it.requestUrl!!.encodedPath == "/api/media/" }.requestUrl!!
        assertEquals("1", request.queryParameter("page"))
        assertEquals("title", request.queryParameter("sort_by"))
        assertEquals("Comedy", request.queryParameter("genre"))
        fixture.capture("movies")
    }

    @Test fun typingDebouncesAndCancelledResultsCannotReplaceTheLatestQuery() = withFixture { fixture ->
        compose.runOnIdle { fixture.vm.navigate(Page.SEARCH) }
        fixture.await(Page.SEARCH)
        compose.runOnIdle { fixture.vm.search("n"); fixture.vm.search("ne"); fixture.vm.search("new") }
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy && fixture.vm.state.value.items.isNotEmpty() }
        assertEquals(listOf("new"), fixture.searchQueries())
        compose.runOnIdle { fixture.vm.search("old", immediate = true) }
        assertTrue(fixture.oldSearchEntered.await(30, TimeUnit.SECONDS))
        compose.runOnIdle { fixture.vm.search("latest", immediate = true) }
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy && fixture.vm.state.value.query == "latest" }
        fixture.releaseOldSearch.countDown()
        compose.waitForIdle()
        assertEquals("Result latest", fixture.vm.state.value.items.first().title)
        compose.runOnIdle { fixture.vm.searchKind("show") }
        compose.onNodeWithText("1 results").assertExists()
        compose.runOnIdle { fixture.vm.search("", immediate = true) }
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy && fixture.vm.state.value.items.isEmpty() }
        assertEquals(3, fixture.searchQueries().size)
    }

    @Test fun continueSeriesMapsRealSeasonIdsAndKeepsEpisodeProgressBinding() = withFixture { fixture ->
        compose.runOnIdle { fixture.vm.detail(Media(20, "Aurora fixture series", "show")) }
        fixture.await(Page.DETAIL)
        assertEquals(2, fixture.vm.state.value.season)
        compose.onNodeWithText("Up next · S2 · E7 · The next episode").assertExists()
        assertUnclipped(compose.onNodeWithText("SERIES"))
        fixture.capture("series")
        compose.runOnIdle { fixture.vm.continueSeries() }
        compose.waitUntil(30_000) { fixture.vm.state.value.page == Page.PLAYER && !fixture.vm.state.value.busy }
        val target = requireNotNull(fixture.vm.state.value.target)
        assertEquals(209L, target.episodeId)
        assertEquals(9L, target.file.id)
        assertEquals(24000L, target.resumeMs)
        val progress = fixture.requests.last { it.requestUrl!!.encodedPath == "/api/progress/20" }.requestUrl!!
        assertEquals("209", progress.queryParameter("episode_id"))
        assertEquals("7", progress.queryParameter("profile_id"))
    }

    @Test fun continueWatchingResumesItsLaterEpisodeDespiteAnEarlierUnfinishedEpisode() = withFixture { fixture ->
        fixture.continuingShow = true
        compose.runOnIdle { fixture.vm.navigate(Page.HOME) }
        fixture.await(Page.HOME)
        compose.onNodeWithText("Aurora fixture series").performScrollTo()
            .performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Aurora fixture series").performKeyInput { pressKey(Key.DirectionCenter) }
        fixture.await(Page.DETAIL)
        assertEquals(2, fixture.vm.state.value.season)
        assertEquals(209L, fixture.vm.state.value.suggestedEpisode?.id)
        compose.onNodeWithText("Continue series").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Continue series").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.waitUntil(30_000) { fixture.vm.state.value.page == Page.PLAYER && !fixture.vm.state.value.busy }
        val target = requireNotNull(fixture.vm.state.value.target)
        assertEquals(209L, target.episodeId)
        assertEquals(24000L, target.resumeMs)
        val progress = fixture.requests.last { it.requestUrl!!.encodedPath == "/api/progress/20" }.requestUrl!!
        assertEquals("209", progress.queryParameter("episode_id"))
    }

    @Test fun selectingAnEpisodeRetainsItsSiblingLibrary4kVersionAndCanonicalProgress() = withFixture { fixture ->
        fixture.aggregateEpisodeVersions = true
        compose.runOnIdle { fixture.vm.detail(Media(20, "Aurora fixture series", "show")) }
        fixture.await(Page.DETAIL)
        choose("S2 · E7 · The next episode")
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy && fixture.vm.state.value.episode?.id == 209L }
        assertEquals(listOf(9L, 10L), fixture.vm.state.value.files.map { it.id })
        choose("Choose version")
        choose("3840×2160 · HEVC")
        compose.onNodeWithText("Source · 3840×2160 · HEVC").assertExists()
        fixture.capture("series-versions")
        choose("Play / Resume")
        fixture.await(Page.PLAYER)
        val target = requireNotNull(fixture.vm.state.value.target)
        assertEquals(10L, target.file.id)
        assertEquals(20L, target.media.id)
        assertEquals(209L, target.episodeId)
        assertEquals(7L, target.profile.id)
        assertEquals("episode", target.fileType)
        val progress = fixture.requests.last { it.requestUrl!!.encodedPath == "/api/progress/20" }.requestUrl!!
        assertEquals("209", progress.queryParameter("episode_id"))
        assertFalse(fixture.requests.any { it.requestUrl!!.encodedPath == "/api/media/episodes/209/files" })
    }

    @Test fun continueSeriesPlaysTheSiblingVersionWhenThePrimaryEpisodeHasNoFile() = withFixture { fixture ->
        fixture.aggregateEpisodeVersions = true
        fixture.primaryEpisodeHasFile = false
        compose.runOnIdle { fixture.vm.detail(Media(20, "Aurora fixture series", "show")) }
        fixture.await(Page.DETAIL)
        choose("Continue series")
        compose.waitUntil(30_000) { !fixture.vm.state.value.busy }
        assertEquals(Page.PLAYER, fixture.vm.state.value.page)
        val target = requireNotNull(fixture.vm.state.value.target)
        assertEquals(10L, target.file.id)
        assertEquals(209L, target.episodeId)
        assertEquals(24000L, target.resumeMs)
        assertNull(fixture.vm.state.value.error)
        assertFalse(fixture.requests.any { it.requestUrl!!.encodedPath == "/api/media/episodes/209/files" })
    }

    private fun choose(text: String) {
        compose.onNodeWithText(text).performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText(text).performKeyInput { pressKey(Key.DirectionCenter) }
    }

    private fun withFixture(block: (Fixture) -> Unit) {
        val fixture = Fixture()
        try { fixture.open(); block(fixture) } finally { fixture.close() }
    }
    private fun assertUnclipped(node: SemanticsNodeInteraction) {
        node.assertIsDisplayed()
        val drawn = node.fetchSemanticsNode().boundsInRoot.height
        val bounds = node.getUnclippedBoundsInRoot()
        val full = (bounds.bottom - bounds.top).value * compose.density.density
        assertTrue("Hero text must remain fully visible when its action has focus", drawn + 1 >= full)
    }

    private inner class Fixture {
        val application = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        private val preferences = application.getSharedPreferences("aurora_tv", 0)
        private val savedServer = preferences.getString("server", null)
        private val owner = ViewModelStore()
        private val server = MockWebServer()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val oldSearchEntered = CountDownLatch(1)
        val releaseOldSearch = CountDownLatch(1)
        @Volatile var showHero = false
        @Volatile var continuingShow = false
        @Volatile var aggregateEpisodeVersions = false
        @Volatile var primaryEpisodeHasFile = true
        lateinit var vm: TvViewModel

        fun open() {
            check(preferences.edit().remove("server").commit())
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val url = request.requestUrl!!
                    val aggregateFiles = if (aggregateEpisodeVersions) ",\"files\":[" +
                        (if (primaryEpisodeHasFile) """{"id":9,"duration_ms":90000,"resolution":"1918x1038","video_codec":"hevc","version_tag":"720p"},""" else "") +
                        """{"id":10,"duration_ms":90000,"resolution":"3840x2160","video_codec":"hevc","version_tag":"2160p"}]""" else ""
                    return when (url.encodedPath) {
                        "/api/health", "/api/profiles/7/activate" -> json("{}")
                        "/api/auth/me", "/api/auth/refresh" -> MockResponse().setResponseCode(401)
                        "/api/auth/login" -> json("""{"user":{"id":7,"username":"Alice"}}""")
                        "/api/profiles/" -> json("""[{"id":7,"name":"Alice","avatar_url":"nebula:aurora","is_default":true},{"id":8,"name":"Kids","avatar_url":"nebula:tidal"}]""")
                        "/api/me/hero" -> if (showHero) json("""{"picks":[{"item":{"id":3,"title":"Aurora cinema","overview":"A generated title for TV layout verification."},"reason":"A pick for your cinema"}]}""")
                            else json("""{"picks":[]}""")
                        "/api/progress/continue" -> if (continuingShow)
                            json("""[{"media_item_id":20,"episode_id":209,"title":"Aurora fixture series","type":"show","season_number":2,"episode_number":7,"position_ms":24000,"duration_ms":90000}]""")
                            else json("[]")
                        "/api/media/recent", "/api/media/3/files" -> json("[]")
                        "/api/media/genres" -> json("""{"genres":["Comedy","Drama"]}""")
                        "/api/media/" -> if (url.queryParameter("page") == "2")
                            json("""{"data":[{"id":2,"title":"Movie 2"},{"id":3,"title":"Movie 3"}],"page":2,"total_items":3,"total_pages":2}""")
                        else json("""{"data":[{"id":1,"title":"Movie 1"},{"id":2,"title":"Movie 2"}],"page":1,"total_items":3,"total_pages":2}""")
                        "/api/media/3" -> json("""{"id":3,"title":"Movie 3","overview":"A generated library fixture."}""")
                        "/api/media/search" -> {
                            val query = url.queryParameter("q")!!
                            if (query == "old") { oldSearchEntered.countDown(); check(releaseOldSearch.await(30, TimeUnit.SECONDS)) }
                            json("""[{"id":3,"title":"Result $query","type":"movie"},{"id":20,"title":"Series $query","type":"show"}]""")
                        }
                        "/api/media/20" -> json("""{"id":20,"title":"Aurora fixture series","type":"show","year":2026,"overview":"A generated series used to verify episode selection and progress."}""")
                        "/api/media/20/seasons" -> json("""[{"id":100,"season_number":1},{"id":101,"season_number":2}]""")
                        "/api/media/20/next-episode" -> if (continuingShow)
                            json("""{"id":101,"season_id":100,"episode_number":1,"title":"The earlier unfinished episode"}""")
                            else json("""{"id":209,"season_id":101,"episode_number":7,"title":"The next episode"$aggregateFiles}""")
                        "/api/media/20/seasons/1/episodes" -> json("""[{"id":101,"season_id":100,"episode_number":1,"title":"The earlier unfinished episode"}]""")
                        "/api/media/20/seasons/2/episodes" -> json("""[{"id":209,"season_id":101,"episode_number":7,"title":"The next episode","runtime_minutes":24,"overview":"A generated episode fixture."$aggregateFiles,"progress":{"position_ms":24000,"duration_ms":90000}}]""")
                        "/api/media/episodes/209/files" -> if (primaryEpisodeHasFile) json("""[{"id":9,"duration_ms":90000,"resolution":"1918x1038","video_codec":"hevc","version_tag":"720p"}]""") else json("[]")
                        "/api/progress/20" -> json("""{"position_ms":24000,"duration_ms":90000}""")
                        else -> MockResponse().setResponseCode(404)
                    }
                }
            }
            server.start()
            val address = server.url("/").toString()
            compose.runOnIdle { vm = TvViewModel(application).also { owner.put("browse-search", it) } }
            compose.setContent { AuroraTheme { AuroraApp(vm) } }
            compose.runOnIdle { vm.connect(address) }
            await(Page.LOGIN)
            capture("login")
            compose.runOnIdle { vm.login("Alice", "fixture-password") }
            await(Page.PROFILES)
            capture("profiles")
            compose.runOnIdle { vm.selectProfile(vm.state.value.profiles.first()) }
            await(Page.HOME)
        }

        fun searchQueries() = requests.filter { it.requestUrl!!.encodedPath == "/api/media/search" }.map { it.requestUrl!!.queryParameter("q")!! }
        fun await(page: Page) { compose.waitUntil(30_000) { vm.state.value.page == page && !vm.state.value.busy }; compose.waitForIdle() }
        fun capture(name: String) {
            val folder = File(application.getExternalFilesDir(null), "tv-review").apply { mkdirs() }
            val bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
            try {
                File(folder, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            } finally { bitmap.recycle() }
        }
        fun close() {
            releaseOldSearch.countDown()
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
