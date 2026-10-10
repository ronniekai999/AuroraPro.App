package app.aurorapro.tv.playback

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.view.Display
import app.aurorapro.tv.data.MediaFile

/** Probe this TV and this source. Never infer a Hi10P decoder from ordinary H.264 support. */
fun deviceCapabilities(context: Context, file: MediaFile): String = deviceCapabilityReport(context, file).caps

data class DeviceCapabilityReport(val caps: String, val explanation: String, val decoderNames: String)

fun deviceCapabilityReport(context: Context, file: MediaFile): DeviceCapabilityReport {
    val codecs = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }
    val hdrType = when (file.colorTransfer) {
        "smpte2084" -> Display.HdrCapabilities.HDR_TYPE_HDR10
        "arib-std-b67" -> Display.HdrCapabilities.HDR_TYPE_HLG
        else -> null
    }
    val display = (context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY)
    val hdrOkay = hdrType == null || display?.hdrCapabilities?.supportedHdrTypes?.contains(hdrType) == true

    fun capabilities(mime: String): List<PlaybackDecoder> = codecs.mapNotNull { info ->
        if (!info.supportedTypes.any { it.equals(mime, true) }) return@mapNotNull null
        runCatching { info.getCapabilitiesForType(mime) }.getOrNull()?.let { caps ->
            PlaybackDecoder(
                profiles = caps.profileLevels.map { it.profile }.toSet(),
                hardwareAccelerated = if (Build.VERSION.SDK_INT >= 29) info.isHardwareAccelerated
                    else !info.name.startsWith("OMX.google.") && !info.name.startsWith("c2.android."),
                requiresSecure = caps.isFeatureRequired(MediaCodecInfo.CodecCapabilities.FEATURE_SecurePlayback),
                requiresTunneled = caps.isFeatureRequired(MediaCodecInfo.CodecCapabilities.FEATURE_TunneledPlayback),
                supportsVideo = { width, height, fps -> caps.videoCapabilities?.areSizeAndRateSupported(width, height, fps) == true },
                name = info.name,
            )
        }
    }
    val result = playbackCapabilities(file, hdrOkay, ::capabilities)
    val profile = sourceVideoProfile(file)
    val decoders = profile?.let { capabilities(it.mime) }.orEmpty()
    val explanation = when {
        profile == null -> "Source codec/profile metadata is missing or unsupported. Compatibility playback is used."
        sourceVideoSize(file.resolution) == null || !file.videoFps.isFinite() || file.videoFps <= 0 ->
            "Source dimensions or frame rate are missing. Refresh the title's metadata to evaluate original playback."
        !hdrOkay -> "This display does not report the source HDR format. An SDR conversion is needed."
        profile.cap in result.split(',') -> "The device reports a matching hardware video decoder."
        decoders.none { it.hardwareAccelerated && !it.requiresSecure && !it.requiresTunneled } ->
            "No ordinary hardware decoder is reported for this source. An emulator's display resolution does not establish codec support."
        else -> "The device does not report support for this source's profile, dimensions and frame rate."
    }
    return DeviceCapabilityReport(result, explanation, decoders.joinToString { it.name }.ifBlank { "None reported" })
}

internal data class PlaybackDecoder(
    val profiles: Set<Int> = emptySet(),
    val hardwareAccelerated: Boolean = false,
    val requiresSecure: Boolean = false,
    val requiresTunneled: Boolean = false,
    val supportsVideo: (Int, Int, Double) -> Boolean = { _, _, _ -> false },
    val name: String = "",
)

/** Special playback features are not enabled in this player, for video or audio. */
internal fun playbackCapabilities(file: MediaFile, hdrOkay: Boolean, decoders: (String) -> List<PlaybackDecoder>): String {
    fun ordinaryDecoders(mime: String) = decoders(mime).filter { !it.requiresSecure && !it.requiresTunneled }
    val caps = mutableListOf("mp4_container", "mkv_container", "webm_container", "ts_container", "hls_native")
    val sourceProfile = sourceVideoProfile(file)
    val decoderProfiles = when (sourceProfile) {
        VideoSourceProfile.AVC_BASELINE -> setOf(MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline)
        VideoSourceProfile.AVC_CONSTRAINED_BASELINE -> setOf(MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline,
            MediaCodecInfo.CodecProfileLevel.AVCProfileConstrainedBaseline)
        VideoSourceProfile.AVC_MAIN -> setOf(MediaCodecInfo.CodecProfileLevel.AVCProfileMain)
        VideoSourceProfile.AVC_HIGH -> setOf(MediaCodecInfo.CodecProfileLevel.AVCProfileHigh)
        VideoSourceProfile.HEVC_MAIN -> setOf(MediaCodecInfo.CodecProfileLevel.HEVCProfileMain)
        VideoSourceProfile.HEVC_MAIN10 -> setOf(MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10,
            MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10, MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10Plus)
        VideoSourceProfile.VP8_MAIN -> setOf(MediaCodecInfo.CodecProfileLevel.VP8ProfileMain)
        VideoSourceProfile.VP9_PROFILE0 -> setOf(MediaCodecInfo.CodecProfileLevel.VP9Profile0)
        VideoSourceProfile.AV1_MAIN8 -> if (Build.VERSION.SDK_INT >= 29) setOf(MediaCodecInfo.CodecProfileLevel.AV1ProfileMain8) else emptySet()
        null -> emptySet()
    }
    if (sourceProfile != null && hdrOkay && ordinaryDecoders(sourceProfile.mime).any { decoder ->
            decoder.hardwareAccelerated && decoder.profiles.any { it in decoderProfiles } &&
                supportsSourceVideo(file, decoder.supportsVideo)
        }) {
        caps += sourceProfile.cap
        if (sourceProfile == VideoSourceProfile.HEVC_MAIN10) caps += "hevc_main10"
    }
    listOf("aac" to "audio/mp4a-latm", "mp3" to "audio/mpeg", "flac" to "audio/flac", "opus" to "audio/opus",
        "vorbis" to "audio/vorbis", "ac3" to "audio/ac3", "eac3" to "audio/eac3").forEach { (name, mime) ->
        if (ordinaryDecoders(mime).isNotEmpty()) caps += name
    }
    return caps.joinToString(",")
}
