package app.aurorapro.tv

import app.aurorapro.tv.data.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

class EpisodeOrderTest {
    private val target = PlayTarget(Media(20, "Show", "show"), MediaFile(102, versionTag = "Extended"), Profile(7, "Viewer"),
        episodeId = 102, seasonNumber = 1, episodeNumber = 2)
    private fun episode(id: Long, number: Int, files: List<MediaFile> = listOf(MediaFile(id))) =
        Episode(id, number, progress = Progress(completed = true), files = files)

    @Test fun advancementIsChronologicalEvenOnRewatchAndSkipsFilelessEpisodes() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(apiJson.encodeToString(listOf(episode(105, 5), episode(101, 1),
                episode(104, 4), episode(103, 3, emptyList())))))
            server.start()
            val api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            assertEquals(104L, api.followingEpisode(target)?.episode?.id)
            assertEquals("/api/media/20/seasons/1/episodes", server.takeRequest().path)
            assertEquals(1, server.requestCount)
        }
    }

    @Test fun advancementCrossesSeasonGapsAndRetainsTheSelectedEditionWhenAvailable() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(apiJson.encodeToString(listOf(episode(102, 2)))))
            server.enqueue(MockResponse().setBody("""[{"season_number":4},{"season_number":0},{"season_number":2},{"season_number":1}]"""))
            server.enqueue(MockResponse().setBody(apiJson.encodeToString(listOf(episode(201, 1, emptyList())))))
            val laterEpisodes = listOf(episode(402, 2), episode(401, 1, listOf(MediaFile(11), MediaFile(12, versionTag = "Extended"))))
            server.enqueue(MockResponse().setBody(apiJson.encodeToString(laterEpisodes)))
            server.start()
            val api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            val next = requireNotNull(api.followingEpisode(target))
            assertEquals(401L, next.episode.id)
            assertEquals(4, next.season)
            assertEquals(12L, next.file.id)
            assertEquals(listOf("/api/media/20/seasons/1/episodes", "/api/media/20/seasons", "/api/media/20/seasons/2/episodes",
                "/api/media/20/seasons/4/episodes"), (1..4).map { server.takeRequest().path })
        }
    }

    @Test fun seriesEndAndIncompleteIdentityDoNotInventANextEpisode() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(apiJson.encodeToString(listOf(episode(102, 2)))))
            server.enqueue(MockResponse().setBody("""[{"season_number":1}]"""))
            server.start()
            val api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            assertNull(api.followingEpisode(target))
            assertNull(api.followingEpisode(target.copy(seasonNumber = null)))
            assertNull(api.followingEpisode(target.copy(episodeNumber = null)))
            assertNull(api.followingEpisode(target.copy(episodeId = null)))
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun episodeLookupFailureIsRetryableRatherThanAFalseSeriesEnd() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(500))
            server.start()
            val api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            assertEquals(500, (runCatching { api.followingEpisode(target) }.exceptionOrNull() as AuroraException).status)
        }
    }

    @Test fun streamInfoReadsSourceMarkersAndKeepsOlderServersPlayable() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"stream":{"decision":"direct_play"},"markers":[{"kind":"intro","start_ms":28000,"end_ms":60000,"confidence":0.9,"detector":"manual"}]}"""))
            server.enqueue(MockResponse().setBody("""{"stream":{"decision":"direct_play"}}"""))
            server.start()
            val api = AuroraClient(server.url("/"), SessionCookies(server.url("/"), MemoryCookies()))
            assertEquals(listOf(SkipMarker("intro", 28_000, 60_000)), api.streamInfo(target, "h264,aac").markers)
            assertTrue(api.streamInfo(target, "h264,aac").markers.isEmpty())
        }
    }
}
