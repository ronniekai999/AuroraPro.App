package app.aurorapro.tv.playback

import app.aurorapro.tv.data.MediaFile

internal data class SourceVideoSize(val width: Int, val height: Int)

internal fun sourceVideoSize(resolution: String): SourceVideoSize? {
    val match = Regex("^([1-9][0-9]*)x([1-9][0-9]*)$").matchEntire(resolution.trim().lowercase()) ?: return null
    val width = match.groupValues[1].toIntOrNull() ?: return null
    val height = match.groupValues[2].toIntOrNull() ?: return null
    return SourceVideoSize(width, height)
}

internal fun supportsSourceVideo(file: MediaFile, decoderSupports: (Int, Int, Double) -> Boolean): Boolean {
    // Height-only labels cannot establish source width. Unknown geometry or frame
    // rate must take the server path, rather than bypass a TV's decoder limits.
    val size = sourceVideoSize(file.resolution) ?: return false
    if (!file.videoFps.isFinite() || file.videoFps <= 0) return false
    return runCatching { decoderSupports(size.width, size.height, file.videoFps) }.getOrDefault(false)
}

internal enum class VideoSourceProfile(val mime: String, val cap: String) {
    AVC_BASELINE("video/avc", "h264"), AVC_CONSTRAINED_BASELINE("video/avc", "h264"),
    AVC_MAIN("video/avc", "h264"), AVC_HIGH("video/avc", "h264"),
    HEVC_MAIN("video/hevc", "hevc"), HEVC_MAIN10("video/hevc", "hevc"),
    VP8_MAIN("video/x-vnd.on2.vp8", "vp8"), VP9_PROFILE0("video/x-vnd.on2.vp9", "vp9"),
    AV1_MAIN8("video/av01", "av1"),
}

internal fun sourceVideoProfile(file: MediaFile): VideoSourceProfile? {
    val profile = file.videoProfile.trim().lowercase().replace(" ", "")
    val format = file.videoPixFmt.lowercase()
    val eightBit420 = format in setOf("yuv420p", "yuvj420p")
    // The wire contract cannot represent 4:2:2/4:4:4, unsupported bit depths,
    // or unknown profile/format combinations. Do not claim those sources.
    return when (file.videoCodec.lowercase()) {
        "h264", "avc", "avc1" -> if (!eightBit420) null else when (profile) {
            "baseline" -> VideoSourceProfile.AVC_BASELINE
            "constrainedbaseline" -> VideoSourceProfile.AVC_CONSTRAINED_BASELINE
            "main" -> VideoSourceProfile.AVC_MAIN
            "high" -> VideoSourceProfile.AVC_HIGH
            else -> null
        }
        "hevc", "h265" -> when {
            profile == "main" && eightBit420 -> VideoSourceProfile.HEVC_MAIN
            profile == "main10" && format in setOf("yuv420p10le", "yuv420p10be", "p010le", "p010be") -> VideoSourceProfile.HEVC_MAIN10
            else -> null
        }
        "vp8" -> if (eightBit420 && profile in setOf("0", "profile0")) VideoSourceProfile.VP8_MAIN else null
        "vp9" -> if (eightBit420 && profile in setOf("0", "profile0")) VideoSourceProfile.VP9_PROFILE0 else null
        "av1" -> if (eightBit420 && profile == "main") VideoSourceProfile.AV1_MAIN8 else null
        else -> null
    }
}
