package app.aurorapro.tv.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

@Serializable
data class User(val id: Long, val username: String, val role: String = "user")

@Serializable
data class LoginResponse(val user: User? = null)

@Serializable
data class Profile(
    val id: Long,
    val name: String,
    @SerialName("is_default") val isDefault: Boolean = false,
    val language: String = "en",
    @SerialName("subtitle_lang") val subtitleLang: String = "",
    @SerialName("subtitle_mode") val subtitleMode: String = "off",
    @SerialName("max_age_rating") val maxAgeRating: String = "",
    @SerialName("avatar_url") val avatarUrl: String = "",
    // Switching to a locked profile needs its PIN (or the account password).
    @SerialName("has_pin") val hasPin: Boolean = false,
)

@Serializable
data class Media(
    val id: Long,
    val title: String,
    val type: String = "movie",
    val year: Int? = null,
    val overview: String = "",
    val rating: Double? = null,
    @SerialName("content_rating") val contentRating: String = "",
    @SerialName("poster_path") val posterPath: String = "",
    @SerialName("backdrop_path") val backdropPath: String = "",
    val genres: List<String> = emptyList(),
    @SerialName("user_progress") val userProgress: Progress? = null,
    @SerialName("runtime_minutes") val runtimeMinutes: Int = 0,
    // Continue Watching supplies this hint; the detail endpoint does not.
    @Transient val resumeSeason: Int? = null,
) {
    val isShow: Boolean get() = type == "show"
}

@Serializable
data class MediaFile(
    val id: Long,
    @SerialName("video_codec") val videoCodec: String = "",
    @SerialName("video_profile") val videoProfile: String = "",
    @SerialName("video_pix_fmt") val videoPixFmt: String = "",
    @SerialName("video_fps") val videoFps: Double = 0.0,
    @SerialName("color_transfer") val colorTransfer: String = "",
    @SerialName("audio_codec") val audioCodec: String = "",
    val resolution: String = "",
    val container: String = "",
    @SerialName("duration_ms") val durationMs: Long = 0,
    @SerialName("version_tag") val versionTag: String = "",
)

@Serializable
data class Season(@SerialName("season_number") val number: Int, val title: String = "",
    @SerialName("episode_count") val episodeCount: Int = 0, val id: Long = 0)

@Serializable
data class Episode(
    val id: Long,
    @SerialName("episode_number") val number: Int = 0,
    val title: String = "",
    val overview: String = "",
    @SerialName("season_number") val season: Int? = null,
    @SerialName("season_id") val seasonId: Long = 0,
    @SerialName("still_path") val stillPath: String = "",
    @SerialName("runtime_minutes") val runtimeMinutes: Int = 0,
    val progress: Progress? = null,
    val files: List<MediaFile> = emptyList(),
)

@Serializable
data class Progress(
    @SerialName("position_ms") val positionMs: Long = 0,
    @SerialName("duration_ms") val durationMs: Long = 0,
    val completed: Boolean = false,
    @SerialName("episode_id") val episodeId: Long? = null,
)

@Serializable
data class ContinueItem(
    @SerialName("media_item_id") val mediaId: Long,
    @SerialName("episode_id") val episodeId: Long? = null,
    val title: String,
    val type: String = "movie",
    @SerialName("position_ms") val positionMs: Long = 0,
    @SerialName("duration_ms") val durationMs: Long = 0,
    @SerialName("poster_path") val posterPath: String = "",
    @SerialName("backdrop_path") val backdropPath: String = "",
    @SerialName("season_number") val season: Int? = null,
    @SerialName("episode_number") val episode: Int? = null,
) {
    fun media() = Media(id = mediaId, title = title, type = type,
        posterPath = posterPath, backdropPath = backdropPath, userProgress = Progress(positionMs, durationMs, episodeId = episodeId),
        resumeSeason = season)
}

@Serializable
data class MediaPage(val data: List<Media> = emptyList(), val page: Int = 1,
    @SerialName("total_items") val totalItems: Long = 0,
    @SerialName("total_pages") val totalPages: Int = 1)

@Serializable
data class HeroPick(val item: Media, val reason: String = "", val match: Int = 0)

@Serializable
data class HeroResponse(val picks: List<HeroPick> = emptyList())

@Serializable
data class StreamInfo(
    val stream: StreamDecision,
    val subtitles: List<Subtitle> = emptyList(),
    @SerialName("audio_tracks") val audioTracks: List<AudioTrack> = emptyList(),
    val markers: List<SkipMarker> = emptyList(),
)

@Serializable
data class SkipMarker(val kind: String, @SerialName("start_ms") val startMs: Long,
    @SerialName("end_ms") val endMs: Long)

@Serializable
data class StreamDecision(
    val decision: String,
    @SerialName("stream_url") val streamUrl: String = "",
    @SerialName("duration_ms") val durationMs: Long = 0,
    @SerialName("audio_track_index") val audioTrackIndex: Int = -1,
    @SerialName("audio_passthrough") val audioPassthrough: Boolean = false,
    @SerialName("audio_channels") val audioChannels: Int = 2,
    @SerialName("audio_codec_out") val audioCodecOut: String = "aac",
    @SerialName("video_codec_out") val videoCodecOut: String = "h264",
    @SerialName("video_codec") val videoCodec: String = "",
    @SerialName("hdr_tonemap") val hdrTonemap: Boolean = false,
    val remux: Boolean = false,
    @SerialName("transcode_reason") val transcodeReason: String = "",
    @SerialName("reason_code") val reasonCode: String = "",
)

@Serializable
data class Subtitle(
    val index: Int,
    val language: String = "",
    val title: String = "",
    val codec: String = "",
    val forced: Boolean = false,
    val bitmap: Boolean = false,
)

@Serializable
data class AudioTrack(val index: Int, val language: String = "", val codec: String = "",
    val channels: Int = 0, val title: String = "")

@Serializable
data class StreamSession(
    @SerialName("session_id") val id: String,
    @SerialName("master_playlist") val playlist: String,
    @SerialName("start_sec") val startSec: Long = 0,
    val profiles: List<QualityProfile> = emptyList(),
    val remux: Boolean? = null,
    @SerialName("audio_passthrough") val audioPassthrough: Boolean? = null,
    @SerialName("audio_copy") val audioCopy: Boolean? = null,
)

@Serializable
data class QualityProfile(val name: String, val width: Int, val height: Int)

@Serializable
data class DeviceGrant(
    @SerialName("device_code") val deviceCode: String,
    @SerialName("user_code") val userCode: String,
    @SerialName("verification_uri") val verificationUri: String,
    @SerialName("expires_in") val expiresIn: Int,
    val interval: Int = 5,
)

@Serializable
data class DevicePoll(val status: String, val user: User? = null)

data class HomeData(val recent: List<Media>, val continuing: List<ContinueItem>, val hero: HeroPick?)

data class PlayTarget(
    val media: Media,
    val file: MediaFile,
    val profile: Profile,
    val episodeId: Long? = null,
    val resumeMs: Long = 0,
    val seasonNumber: Int? = null,
    val episodeNumber: Int? = null,
    val episodeTitle: String = "",
) {
    val fileType: String get() = if (episodeId == null) "media" else "episode"
}

data class EpisodeContinuation(val episode: Episode, val file: MediaFile, val season: Int) {
    val label: String get() = "S${season}E${episode.number}" + episode.title.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
}
