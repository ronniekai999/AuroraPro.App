package app.aurorapro.tv

import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.*
import org.junit.Assert.*
import org.junit.Test

class PlaybackPresentationTest {
    @Test fun misleadingVersionTagsCannotLabelSourceOrOutputQuality() {
        val source = MediaFile(1, videoCodec = "hevc", resolution = "1918x1038", versionTag = "720p")
        assertEquals("1918×1038 · HEVC", sourceLabel(source))
        assertEquals("3840×2160 · HEVC", sourceLabel(source.copy(resolution = "3840x2160", versionTag = "1080p")))
        assertEquals("1918×1038 · HEVC · Version: Director's Cut", sourceLabel(source.copy(versionTag = "Director's Cut")))
        assertEquals("Dimensions unknown · HEVC", sourceLabel(source.copy(resolution = "1080p")))
    }

    @Test fun titleBadgesComeFromProbedGeometryAndTransferNeverTheVersionTag() {
        val source = MediaFile(1, videoCodec = "hevc", resolution = "1918x1038", versionTag = "720p")
        assertEquals(listOf("1080p"), sourceBadges(source))
        assertEquals(listOf("4K", "HDR"), sourceBadges(source.copy(resolution = "3840x2160", colorTransfer = "smpte2084", versionTag = "1080p")))
        assertEquals(listOf("4K", "HLG"), sourceBadges(source.copy(resolution = "4096x1716", colorTransfer = "arib-std-b67")))
        assertEquals(listOf("1440p"), sourceBadges(source.copy(resolution = "2560x1440")))
        assertEquals(listOf("720p"), sourceBadges(source.copy(resolution = "1280x536")))
        assertEquals(listOf("SD"), sourceBadges(source.copy(resolution = "720x480", colorTransfer = "bt709")))
        // A height-only label is not geometry; show no tier rather than trust it.
        assertEquals(emptyList<String>(), sourceBadges(source.copy(resolution = "2160p", versionTag = "4K")))
    }

    @Test fun realProfileAndEpisodeDtosKeepOrbSeasonAndProgressIdentity() {
        val profile = apiJson.decodeFromString<Profile>("""{"id":7,"name":"Alice","avatar_url":"nebula:aurora"}""")
        assertEquals("nebula:aurora", profile.avatarUrl)
        val seasons = apiJson.decodeFromString<List<Season>>("""[{"id":101,"season_number":2}]""")
        // The real EpisodeDTO has season_id, without a season_number field.
        val episode = apiJson.decodeFromString<Episode>("""{"id":209,"season_id":101,"episode_number":7,"title":"Up next","still_path":"/still.jpg","progress":{"position_ms":12000,"duration_ms":60000}}""")
        assertEquals(2, episodeSeason(episode, seasons))
        assertEquals("S2 · E7 · Up next", episodeName(episode, episodeSeason(episode, seasons)))
        assertEquals("/still.jpg", episode.stillPath)
        assertEquals(12000L, episode.progress?.positionMs)
        assertNull(episodeSeason(episode.copy(seasonId = 999), seasons))
        val continuing = ContinueItem(7, episode.id, "Show", "show", 12000, 60000).media().userProgress!!
        assertEquals(episode.id, continuing.episodeId)
        assertEquals(12000L, continuing.positionMs)
        assertEquals(60000L, continuing.durationMs)
        assertEquals(2, ContinueItem(7, episode.id, "Show", "show", season = 2).media().resumeSeason)
    }

    @Test fun sessionCopyFactsDistinguishRemuxFromAudioConversionWithoutGuessingOnOldServers() {
        val copied = apiJson.decodeFromString<StreamSession>("""{"session_id":"copy","master_playlist":"/master.m3u8","remux":true,"audio_passthrough":false,"audio_copy":true}""")
        assertEquals("Remux · original video and audio", playbackPathLabel(false, copied.remux!!, copied.audioCopy))
        val converted = apiJson.decodeFromString<StreamSession>("""{"session_id":"convert","master_playlist":"/master.m3u8","remux":true,"audio_passthrough":false,"audio_copy":false}""")
        assertEquals("Audio conversion · original video", playbackPathLabel(false, converted.remux!!, converted.audioCopy))
        val legacy = apiJson.decodeFromString<StreamSession>("""{"session_id":"old","master_playlist":"/master.m3u8","remux":true,"audio_passthrough":false}""")
        assertEquals("Remux · original video", playbackPathLabel(false, legacy.remux!!, legacy.audioCopy))
    }

    @Test fun originalAudioIdentityUsesProbeOrdinalsAndRejectsAmbiguousMetadata() {
        val source = listOf(AudioTrack(1, "eng", "aac", 2), AudioTrack(2, "ger", "dts", 6), AudioTrack(3, "spa", "aac", 1))
        // An unsupported DTS choice can disappear from Media3's menu without
        // renumbering the selected Spanish source stream from 0:a:2 to 0:a:1.
        assertEquals(2, resolveSourceAudioIndex(source, "es", "audio/mp4a-latm", 1, null))
        assertEquals(1, resolveSourceAudioIndex(source, "de", "audio/vnd.dts.hd", 6, null))
        assertNull(resolveSourceAudioIndex(emptyList(), "es", "audio/mp4a-latm", 1, null))
        val duplicates = listOf(AudioTrack(1, "eng", "aac", 2), AudioTrack(2, "eng", "aac", 2))
        assertNull(resolveSourceAudioIndex(duplicates, "en", "audio/mp4a-latm", 2, null))
        assertEquals(1, resolveSourceAudioIndex(duplicates.mapIndexed { i, track -> track.copy(title = if (i == 0) "Main" else "Commentary") },
            "en", "audio/mp4a-latm", 2, "Commentary"))
    }

    @Test fun subtitleIdentitySurvivesMp4ToHlsLanguageAndDisplayNameChanges() {
        val chosen = subtitleIdentity("es", null, false, 0)
        val hls = listOf(subtitleIdentity("eng", "English", false, 0), subtitleIdentity("spa", "Spanish", false, 0))
        assertEquals(1, matchingSubtitleIndex(chosen, hls))
        assertNull(matchingSubtitleIndex(chosen, listOf(subtitleIdentity("spa", "Spanish (Forced)", true, 0))))
        assertNull(matchingSubtitleIndex(chosen, listOf(subtitleIdentity("spa", "Spanish SDH", false, 1))))
        assertEquals(0, matchingSubtitleIndex(subtitleIdentity("es", "Spanish", true, 0),
            listOf(subtitleIdentity("spa", "Spanish (Forced)", true, 0))))
        assertEquals(0, matchingSubtitleIndex(subtitleIdentity("es", "Spanish (Forced)", true, 0),
            listOf(subtitleIdentity("spa", "Spanish (Forced) (Forced)", true, 0))))
    }

    @Test fun ambiguousSubtitlesNeverChooseADifferentSameLanguageTrack() {
        val hls = listOf(subtitleIdentity("eng", "English", false, 0), subtitleIdentity("eng", "English SDH", false, 0))
        assertNull(matchingSubtitleIndex(subtitleIdentity("en", null, false, 0), hls))
        assertEquals(1, matchingSubtitleIndex(subtitleIdentity("en", "English SDH", false, 0), hls))
        assertNull(matchingSubtitleIndex(subtitleIdentity("en", null, false, 0, bitmap = true), hls.take(1)))
    }
}
