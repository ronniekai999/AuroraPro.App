package io.aurora.tv.core.media

import kotlinx.serialization.Serializable

/**
 * Device capability snapshot — the result of probing the real decoder stack
 * at runtime. This is what we hand the Aurora backend so the server can
 * pre-select direct-play candidates instead of guessing from a static
 * hard-coded device table (the root cause of Jellyfin #5093, #5303 and
 * Plex's Dolby-Vision black-screen bug 915542).
 *
 * Serializable so it can be:
 *  - sent to the server via POST /api/v1/device/probe
 *  - cached locally in DataStore between runs
 *  - attached to crash reports for diagnosing device-specific playback bugs
 */
@Serializable
data class DeviceProfile(
    val deviceModel: String,
    val androidVersion: Int,
    val videoCodecs: List<VideoCodec>,
    val audioCodecs: List<AudioCodec>,
    val hdrFormats: List<HdrFormat>,
    val maxDecoderInstances: Int,
)

@Serializable
data class VideoCodec(
    val mimeType: String,       // e.g. "video/hevc", "video/av01"
    val profile: Int,
    val level: Int,
    val maxWidth: Int,
    val maxHeight: Int,
    val maxFrameRate: Int,
    val isHardwareAccelerated: Boolean,
)

@Serializable
data class AudioCodec(
    val mimeType: String,       // e.g. "audio/eac3-joc" for Atmos
    val maxChannels: Int,
    val isHardwareAccelerated: Boolean,
)

@Serializable
enum class HdrFormat {
    HDR10,
    HDR10_PLUS,
    DOLBY_VISION,
    HLG,
}
