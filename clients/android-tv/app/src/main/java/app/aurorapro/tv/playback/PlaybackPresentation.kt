package app.aurorapro.tv.playback

import app.aurorapro.tv.data.MediaFile
import app.aurorapro.tv.data.AudioTrack

/** Probed geometry is source quality. A filename/version tag is never output quality. */
fun sourceLabel(file: MediaFile): String {
    val size = sourceVideoSize(file.resolution)
    val dimensions = size?.let { "${it.width}×${it.height}" } ?: "Dimensions unknown"
    val codec = when (file.videoCodec.lowercase()) {
        "hevc", "h265" -> "HEVC"
        "h264", "avc", "avc1" -> "H.264"
        else -> file.videoCodec.uppercase()
    }
    val edition = file.versionTag.trim().takeUnless { it.matches(Regex("(?i)^\\d{3,4}p$")) }.orEmpty()
    return listOf(dimensions, codec, if (edition.isNotBlank()) "Version: $edition" else "")
        .filter { it.isNotBlank() }.joinToString(" · ")
}

fun playbackClock(ms: Long): String {
    val seconds = ms.coerceAtLeast(0) / 1000
    return if (seconds >= 3600) "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
        else "%d:%02d".format(seconds / 60, seconds % 60)
}

fun playbackPathLabel(direct: Boolean, remux: Boolean, audioCopy: Boolean?): String = when {
    direct -> "Direct Play"
    !remux -> "Video transcode"
    audioCopy == true -> "Remux · original video and audio"
    audioCopy == false -> "Audio conversion · original video"
    else -> "Remux · original video"
}

/** FFmpeg maps the probe array's ordinal, not its global stream index or a
 * filtered/reordered Media3 group. Ambiguous metadata must not choose a dub. */
internal fun resolveSourceAudioIndex(source: List<AudioTrack>, language: String?, mimeType: String?, channels: Int, label: String?): Int? {
    val lang = audioLanguage(language)
    val codec = audioCodecFamily(mimeType)
    return source.withIndex().filter { (_, track) ->
        val probeLang = audioLanguage(track.language)
        val probeCodec = audioCodecFamily(track.codec)
        (lang.isBlank() || probeLang.isBlank() || lang == probeLang) &&
            (codec.isBlank() || probeCodec.isBlank() || codec == probeCodec) &&
            (channels <= 0 || track.channels <= 0 || channels == track.channels) &&
            (label.isNullOrBlank() || track.title.isBlank() || label.trim().equals(track.title.trim(), ignoreCase = true))
    }.singleOrNull()?.index
}

private fun audioLanguage(language: String?): String {
    val base = language.orEmpty().trim().lowercase().substringBefore('-').substringBefore('_')
    if (base == "und") return ""
    if (base.length == 2) return runCatching { java.util.Locale.forLanguageTag(base).isO3Language }.getOrDefault(base)
    return when (base) { "ger" -> "deu"; "fre" -> "fra"; "chi" -> "zho"; "dut" -> "nld"; "cze" -> "ces"; else -> base }
}

/** Display names and the generic HLS subtitle role can change with containers. */
internal data class SubtitleIdentity(val language: String, val label: String, val forced: Boolean, val accessibilityRoles: Int, val bitmap: Boolean)

internal fun subtitleIdentity(language: String?, label: String?, forced: Boolean, accessibilityRoles: Int, bitmap: Boolean = false) =
    SubtitleIdentity(audioLanguage(language), label.orEmpty().trim().replace(Regex("(?i)(\\s*\\(Forced\\))+$"), ""), forced, accessibilityRoles, bitmap)

internal fun matchingSubtitleIndex(preference: SubtitleIdentity, candidates: List<SubtitleIdentity>): Int? =
    candidates.withIndex().filter { (_, candidate) ->
        !preference.bitmap && !candidate.bitmap && preference.language == candidate.language && preference.forced == candidate.forced &&
            preference.accessibilityRoles == candidate.accessibilityRoles &&
            (preference.label.isBlank() || candidate.label.isBlank() || preference.label.equals(candidate.label, ignoreCase = true))
    }.singleOrNull()?.index

private fun audioCodecFamily(codec: String?): String = when (val raw = codec.orEmpty().lowercase().removePrefix("audio/")) {
    "mp4a-latm", "aac" -> "aac"
    "eac3", "eac3-joc" -> "eac3"
    "vnd.dts", "vnd.dts.hd", "dts" -> "dts"
    "true-hd", "truehd" -> "truehd"
    "mpeg", "mp3" -> "mp3"
    "raw" -> "pcm"
    else -> if (raw.startsWith("pcm_")) "pcm" else raw
}

/** Short title-page badges from probed geometry and transfer, never from the version tag. */
fun sourceBadges(file: MediaFile): List<String> {
    val size = sourceVideoSize(file.resolution)
    val tier = when {
        size == null -> null
        size.width >= 3200 || size.height >= 2000 -> "4K"
        size.width >= 2400 || size.height >= 1400 -> "1440p"
        size.width >= 1800 || size.height >= 1000 -> "1080p"
        size.width >= 1200 || size.height >= 700 -> "720p"
        else -> "SD"
    }
    val range = when (file.colorTransfer.lowercase()) { "smpte2084" -> "HDR"; "arib-std-b67" -> "HLG"; else -> null }
    return listOfNotNull(tier, range)
}
