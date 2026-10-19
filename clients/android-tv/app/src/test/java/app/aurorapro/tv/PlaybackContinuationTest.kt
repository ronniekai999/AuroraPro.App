package app.aurorapro.tv

import android.app.Application
import android.content.SharedPreferences
import androidx.lifecycle.viewModelScope
import app.aurorapro.tv.data.*
import java.lang.reflect.Proxy
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PlaybackContinuationTest {
    @Test fun advancingReplacesTheEpisodeAtZeroAndPreservesProfileAndEdition() = withFixture {
        openShow()
        act { it.episode(it.state.value.episodes.first()) }; idle()
        act { it.play(it.state.value.files.last()) }; idle(); continuationIdle()
        val outgoing = requireNotNull(vm.state.value.target)
        val saved = CompletableDeferred<Unit>()
        var advanced = false
        act { advanced = it.advanceEpisode(outgoing, saved) }
        assertTrue(advanced)
        val next = requireNotNull(vm.state.value.target)
        assertEquals(102L, next.episodeId)
        assertEquals(1102L, next.file.id)
        assertEquals("Extended", next.file.versionTag)
        assertEquals(0L, next.resumeMs)
        assertEquals(outgoing.profile, next.profile)
        assertEquals(1, next.seasonNumber)
        assertEquals(2, next.episodeNumber)
        act { assertFalse(it.advanceEpisode(outgoing, CompletableDeferred(Unit))) }
        saved.complete(Unit)
        continuationIdle()
        assertNull(vm.state.value.continuation)
    }

    @Test fun closingTheNextEpisodeWaitsForBothOutgoingProgressSaves() = withFixture {
        openShow()
        act { it.continueSeries() }; idle(); continuationIdle()
        val outgoing = requireNotNull(vm.state.value.target)
        val firstSave = CompletableDeferred<Unit>()
        act { assertTrue(it.advanceEpisode(outgoing, firstSave)) }
        continuationIdle()
        val current = requireNotNull(vm.state.value.target)
        api.saveFinalProgress(current, 20_000, 60_000)
        act { it.playbackClosed(CompletableDeferred(Unit)) }
        delay(100)
        assertTrue(vm.state.value.busy)
        assertNull(vm.state.value.home)
        api.saveFinalProgress(outgoing, 60_000, 60_000)
        firstSave.complete(Unit)
        idle()
        assertEquals(102L, vm.state.value.suggestedEpisode?.id)
        assertEquals(20_000L, vm.state.value.episode?.progress?.positionMs)
        assertEquals(listOf(102L), requireNotNull(vm.state.value.home).continuing.map { it.episodeId })
    }

    @Test fun closingDuringANextEpisodeLookupCannotRestoreStalePlayerState() = withFixture {
        openShow()
        act { it.episode(it.state.value.episodes.first()) }; idle()
        blockFollowing = true
        act { it.play(it.state.value.files.first()) }; idle()
        assertTrue(followingEntered.await(5, TimeUnit.SECONDS))
        blockFollowing = false
        act { it.playbackClosed(CompletableDeferred(Unit)) }; idle()
        releaseFollowing.countDown()
        delay(100)
        assertEquals(Page.DETAIL, vm.state.value.page)
        assertNull(vm.state.value.target)
        assertNull(vm.state.value.continuation)
        assertFalse(vm.state.value.continuationLoading)
    }

    @Test fun failedNextEpisodeLookupCanBeRetriedWithoutRestartingPlayback() = withFixture {
        openShow()
        act { it.episode(it.state.value.episodes.first()) }; idle()
        followingFailure = true
        act { it.play(it.state.value.files.first()) }; idle(); continuationIdle()
        val target = requireNotNull(vm.state.value.target)
        assertNotNull(vm.state.value.continuationError)
        assertNull(vm.state.value.continuation)
        act { assertFalse(it.advanceEpisode(target, CompletableDeferred(Unit))) }
        followingFailure = false
        act { it.retryContinuation() }; continuationIdle()
        assertSame(target, vm.state.value.target)
        assertEquals(102L, vm.state.value.continuation?.episode?.id)
        assertNull(vm.state.value.continuationError)
    }

    @Test fun completedPlaybackRefreshesContinuationEpisodeProgressAndHomeWithoutChangingTheVersion() = withFixture {
        openShow()
        act { it.episode(it.state.value.episodes.first()) }; idle()
        val files = vm.state.value.files
        act { it.play(files.last()) }; idle()
        val target = requireNotNull(vm.state.value.target)
        val saved = CompletableDeferred<Unit>()
        act { it.playbackClosed(saved) }
        assertEquals(Page.DETAIL, vm.state.value.page)
        assertTrue(vm.state.value.busy)
        assertNull(vm.state.value.suggestedEpisode)
        assertNull(vm.state.value.home)
        // Disposal has not even started its PUT yet. No continuation read may
        // overtake that save just because the row mutex is currently free.
        val readsBeforeSave = requests.size
        delay(100)
        assertEquals(readsBeforeSave, requests.size)
        api.saveFinalProgress(target, 60_000, 60_000)
        saved.complete(Unit)
        idle()
        assertEquals(102L, vm.state.value.suggestedEpisode?.id)
        assertEquals(true, vm.state.value.episode?.progress?.completed)
        assertEquals(true, vm.state.value.episodes.first().progress?.completed)
        assertEquals(files, vm.state.value.files)
        assertEquals(1, vm.state.value.season)
        assertTrue(requireNotNull(vm.state.value.home).continuing.isEmpty())
        act { it.season(1) }; idle()
        act { it.continueSeries() }; idle()
        assertEquals(102L, vm.state.value.target?.episodeId)
    }

    @Test fun backToHomeDuringTheFinalPutWaitsForFreshContinueWatching() = withFixture {
        openShow()
        act { it.continueSeries() }; idle()
        blockSave = true
        val target = requireNotNull(vm.state.value.target)
        val saving = CoroutineScope(currentCoroutineContext()).launch(Dispatchers.IO) { api.saveFinalProgress(target, 60_000, 60_000) }
        assertTrue(saveEntered.await(5, TimeUnit.SECONDS))
        val homeReads = requests.count { it.requestUrl!!.encodedPath == "/api/progress/continue" }
        act { it.playbackClosed(saving); it.back() }
        assertEquals(Page.HOME, vm.state.value.page)
        assertNull(vm.state.value.home)
        delay(100)
        assertEquals(homeReads, requests.count { it.requestUrl!!.encodedPath == "/api/progress/continue" })
        releaseSave.countDown()
        idle()
        assertTrue(requireNotNull(vm.state.value.home).continuing.isEmpty())
        act { it.detail(Media(20, "Show", "show")) }; idle()
        assertEquals(102L, vm.state.value.suggestedEpisode?.id)
    }

    @Test fun aPartiallyWatchedLaterEpisodeRemainsTheContinuationAheadOfAnEarlierUnfinishedOne() = withFixture {
        openShow()
        act { it.episode(it.state.value.episodes.last()) }; idle()
        act { it.play(it.state.value.files.first()) }; idle()
        val target = requireNotNull(vm.state.value.target)
        api.saveFinalProgress(target, 25_000, 60_000)
        act { it.playbackClosed(CompletableDeferred(Unit)) }; idle()
        assertEquals(102L, vm.state.value.suggestedEpisode?.id)
        assertEquals(25_000L, vm.state.value.episode?.progress?.positionMs)
        act { it.season(1) }; idle()
        act { it.continueSeries() }; idle()
        assertEquals(102L, vm.state.value.target?.episodeId)
        assertEquals(25_000L, vm.state.value.target?.resumeMs)
    }

    @Test fun finishingTheLastEpisodeClearsTheSuggestion() = withFixture {
        progress[101] = Progress(60_000, 60_000, completed = true)
        openShow()
        act { it.continueSeries() }; idle()
        api.saveFinalProgress(requireNotNull(vm.state.value.target), 60_000, 60_000)
        act { it.playbackClosed(CompletableDeferred(Unit)) }; idle()
        assertNull(vm.state.value.suggestedEpisode)
        assertTrue(requireNotNull(vm.state.value.home).continuing.isEmpty())
    }

    @Test fun aNewDetailNavigationCannotBeOverwrittenByTheCancelledPlaybackRefresh() = withFixture {
        openShow()
        act { it.continueSeries() }; idle()
        val saved = CompletableDeferred<Unit>()
        act { it.playbackClosed(saved); it.detail(Media(30, "Movie")) }
        saved.complete(Unit)
        idle()
        assertEquals(Page.DETAIL, vm.state.value.page)
        assertEquals(30L, vm.state.value.detail?.id)
        assertNull(vm.state.value.episode)
        assertNull(vm.state.value.suggestedEpisode)
    }

    @Test fun changingServerWhileTheFinalSaveIsPendingCannotRestoreOldContent() = withFixture {
        openShow()
        act { it.continueSeries() }; idle()
        val saved = CompletableDeferred<Unit>()
        act { it.playbackClosed(saved); it.changeServer() }
        saved.complete(Unit)
        delay(100)
        assertEquals(Page.SERVER, vm.state.value.page)
        assertNull(vm.state.value.detail)
        assertNull(vm.state.value.home)
    }

    // The outgoing title's final save names the profile that was playing. Once
    // the session is bound to a restricted profile the server refuses a write
    // for any other one, so activation must wait for that save.
    @Test fun switchingProfileWaitsForTheOutgoingFinalSave() = withFixture {
        openShow()
        act { it.continueSeries() }; idle()
        val target = requireNotNull(vm.state.value.target)
        val saved = CompletableDeferred<Unit>()
        act { it.playbackClosed(saved) }
        act { it.navigate(Page.PROFILES) }; idle()
        act { it.selectProfile(Profile(8, "Kid")) }
        delay(100)
        assertTrue("No activation while the final save is pending",
            requests.none { it.requestUrl!!.encodedPath == "/api/profiles/8/activate" })
        api.saveFinalProgress(target, 60_000, 60_000)
        saved.complete(Unit)
        idle()
        val paths = requests.map { it.method + " " + it.requestUrl!!.encodedPath }
        val put = paths.lastIndexOf("PUT /api/progress/20")
        val activation = paths.indexOf("POST /api/profiles/8/activate")
        assertTrue("The final save ($put) lands before the activation ($activation)", put in 0 until activation)
        assertEquals(8L, vm.state.value.profile?.id)
    }

    @Test fun returningFromProfilesRestartsARefreshCancelledBeforeTheFinalSave() = returnFromProfiles(savePending = true)

    @Test fun returningFromProfilesRestartsARefreshCancelledAfterTheFinalSave() = returnFromProfiles(savePending = false)

    private fun returnFromProfiles(savePending: Boolean) = withFixture {
        openShow()
        act { it.continueSeries() }; idle()
        val files = vm.state.value.files
        val target = requireNotNull(vm.state.value.target)
        val saved = CompletableDeferred<Unit>()
        if (!savePending) {
            api.saveFinalProgress(target, 60_000, 60_000)
            saved.complete(Unit)
            blockDetail = true
        }
        act { it.playbackClosed(saved) }
        if (!savePending) assertTrue(detailEntered.await(5, TimeUnit.SECONDS))
        act { it.navigate(Page.PROFILES) }; idle()
        assertEquals(Page.PROFILES, vm.state.value.page)
        if (savePending) {
            api.saveFinalProgress(target, 60_000, 60_000)
            saved.complete(Unit)
        }
        releaseDetail.countDown()
        act { it.back() }; idle()
        assertEquals(Page.DETAIL, vm.state.value.page)
        assertNull(vm.state.value.profileReturnPage)
        assertEquals(102L, vm.state.value.suggestedEpisode?.id)
        assertEquals(true, vm.state.value.episode?.progress?.completed)
        assertTrue(requireNotNull(vm.state.value.home).continuing.isEmpty())
        assertEquals(files, vm.state.value.files)
        act { it.back() }; idle()
        assertEquals(Page.HOME, vm.state.value.page)
    }

    private fun withFixture(block: suspend Fixture.() -> Unit): Unit = runBlocking {
        val main = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val mainThread = withContext(main) { Thread.currentThread() }
        // Match Android's Main.immediate: ViewModel actions start inline when
        // invoked on the UI thread, including two consecutive Back presses.
        Dispatchers.setMain(object : MainCoroutineDispatcher() {
            override val immediate get() = this
            override fun isDispatchNeeded(context: CoroutineContext) = Thread.currentThread() !== mainThread
            override fun dispatch(context: CoroutineContext, block: Runnable) = main.dispatch(context, block)
        })
        val fixture = Fixture()
        try { fixture.open(); fixture.block() }
        finally {
            fixture.releaseSave.countDown()
            fixture.releaseDetail.countDown()
            fixture.releaseFollowing.countDown()
            fixture.closeViewModel()
            fixture.server.shutdown()
            Dispatchers.resetMain()
            main.close()
        }
    }

    private class Fixture {
        val server = MockWebServer()
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val progress = ConcurrentHashMap<Long, Progress>().apply { put(101, Progress(30_000, 60_000)) }
        val saveEntered = CountDownLatch(1)
        val releaseSave = CountDownLatch(1)
        @Volatile var blockSave = false
        val detailEntered = CountDownLatch(1)
        val releaseDetail = CountDownLatch(1)
        @Volatile var blockDetail = false
        val followingEntered = CountDownLatch(1)
        val releaseFollowing = CountDownLatch(1)
        @Volatile var blockFollowing = false
        @Volatile var followingFailure = false
        lateinit var api: AuroraClient
        lateinit var vm: TvViewModel

        private fun episode(id: Long) = Episode(id, number = (id - 100).toInt(), title = "Episode $id", seasonId = 10,
            progress = progress[id] ?: Progress(), files = listOf(MediaFile(id, durationMs = 60_000),
                MediaFile(id + 1000, durationMs = 60_000, versionTag = "Extended")))

        suspend fun open() {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val path = request.requestUrl!!.encodedPath
                    val body = when (path) {
                        "/api/profiles/7/activate", "/api/profiles/8/activate" -> "{}"
                        "/api/profiles/" -> """[{"id":7,"name":"Viewer"}]"""
                        "/api/media/recent" -> "[]"
                        "/api/me/hero" -> """{"picks":[]}"""
                        "/api/progress/continue" -> apiJson.encodeToString(progress.entries.filter { !it.value.completed && it.value.positionMs > 0 }.map {
                            ContinueItem(20, it.key, "Show", "show", it.value.positionMs, 60_000, season = 1, episode = (it.key - 100).toInt())
                        })
                        "/api/media/20" -> {
                            if (blockDetail) {
                                detailEntered.countDown()
                                check(releaseDetail.await(10, TimeUnit.SECONDS))
                            }
                            """{"id":20,"title":"Show","type":"show"}"""
                        }
                        "/api/media/30" -> """{"id":30,"title":"Movie"}"""
                        "/api/media/30/files" -> """[{"id":30,"duration_ms":60000}]"""
                        "/api/media/20/seasons" -> """[{"id":10,"season_number":1}]"""
                        "/api/media/20/seasons/1/episodes" -> {
                            if (blockFollowing) {
                                followingEntered.countDown()
                                check(releaseFollowing.await(10, TimeUnit.SECONDS))
                            }
                            if (followingFailure) return MockResponse().setResponseCode(500)
                            apiJson.encodeToString(listOf(episode(101), episode(102)))
                        }
                        "/api/media/20/next-episode" -> {
                            val id = listOf(101L, 102L).firstOrNull { progress[it]?.completed != true }
                                ?: return MockResponse().setResponseCode(404)
                            apiJson.encodeToString(episode(id))
                        }
                        "/api/progress/20" -> if (request.method == "PUT") {
                            saveEntered.countDown()
                            if (blockSave) check(releaseSave.await(10, TimeUnit.SECONDS))
                            val values = apiJson.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                            val id = values["episode_id"]!!.jsonPrimitive.content.toLong()
                            val position = values["position_ms"]!!.jsonPrimitive.content.toLong()
                            progress[id] = Progress(position, 60_000, completed = position >= 54_000)
                            "{}"
                        } else apiJson.encodeToString(progress[request.requestUrl!!.queryParameter("episode_id")!!.toLong()] ?: Progress())
                        else -> return MockResponse().setResponseCode(404)
                    }
                    return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                }
            }
            server.start()
            api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            withContext(Dispatchers.Main) {
                vm = TvViewModel(object : Application() {
                    override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                        Proxy.newProxyInstance(SharedPreferences::class.java.classLoader, arrayOf(SharedPreferences::class.java)) { _, method, args ->
                            if (method.name == "getString") args?.get(1) else null
                        } as SharedPreferences
                })
                TvViewModel::class.java.getDeclaredField("client").apply { isAccessible = true }.set(vm, api)
                vm.selectProfile(Profile(7, "Viewer"))
            }
            idle()
        }

        suspend fun act(block: (TvViewModel) -> Unit) = withContext(Dispatchers.Main) { block(vm) }
        suspend fun closeViewModel() = withContext(Dispatchers.Main) { if (::vm.isInitialized) vm.viewModelScope.cancel() }
        suspend fun idle() {
            withTimeout(5_000) { while (vm.state.value.busy) delay(10) }
            assertNull(vm.state.value.error)
        }
        suspend fun continuationIdle() { withTimeout(5_000) { while (vm.state.value.continuationLoading) delay(10) } }
        suspend fun openShow() { act { it.detail(Media(20, "Show", "show")) }; idle() }
    }
}
