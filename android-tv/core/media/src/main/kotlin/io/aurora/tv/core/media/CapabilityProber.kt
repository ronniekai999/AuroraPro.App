package io.aurora.tv.core.media

import android.media.MediaCodecInfo
import android.media.MediaCodecInfo.CodecCapabilities
import android.media.MediaCodecList
import android.os.Build
import android.view.Display
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Runtime device capability probing.
 *
 * === WHY THIS MODULE EXISTS ===
 * The research report identified Plex's 2025.15 Dolby Vision black-screen
 * bug and Jellyfin's 0.19.2 HEVC/DV transcoding regressions as stemming
 * from the same root cause: BOTH apps decide what a device can decode by
 * looking up a hard-coded static table keyed on device model. When that
 * table is wrong (new model, OEM firmware variant, Android update changes
 * codec availability), every user of that device gets broken playback.
 *
 * Aurora's approach: ask the MediaCodec API what the device actually
 * supports, at runtime, per session. The answer is authoritative —
 * MediaCodecList enumerates only codecs the OS will hand MediaCodec /
 * ExoPlayer at playback time. No guessing, no device-model string
 * matching.
 *
 * === COST ===
 * The probe takes ~40-120ms on most Android TV devices (one-time per app
 * startup). Result is cached for the session; re-probed on system update.
 *
 * === HDR DETECTION ===
 * HDR support comes from Display.hdrCapabilities (API 24+), which is a
 * separate axis from codec support — a device may decode HEVC Main10
 * perfectly but not actually have an HDR-capable panel. The backend
 * should combine both signals before choosing a direct-play profile.
 */
@Singleton
class CapabilityProber @Inject constructor() {

    /**
     * Probes the device's video + audio decoders. Call from a background
     * thread — MediaCodecList enumeration touches the hardware list and
     * blocks briefly on some OEM firmwares.
     *
     * [display] optional — pass the activity's default display to pick up
     * HDR panel capabilities. Null falls back to "no HDR" which is safe.
     */
    fun probe(display: Display? = null): DeviceProfile {
        val list = MediaCodecList(MediaCodecList.REGULAR_CODECS)

        val video = mutableListOf<VideoCodec>()
        val audio = mutableListOf<AudioCodec>()

        for (info in list.codecInfos) {
            if (info.isEncoder) continue
            for (mime in info.supportedTypes) {
                val caps = runCatching { info.getCapabilitiesForType(mime) }.getOrNull() ?: continue
                when {
                    mime.startsWith("video/") -> caps.toVideoCodecs(mime, info).also(video::addAll)
                    mime.startsWith("audio/") -> caps.toAudioCodec(mime, info)?.also(audio::add)
                }
            }
        }

        return DeviceProfile(
            deviceModel          = "${Build.MANUFACTURER} ${Build.MODEL}",
            androidVersion       = Build.VERSION.SDK_INT,
            videoCodecs          = video.distinct(),
            audioCodecs          = audio.distinct(),
            hdrFormats           = display.hdrFormats(),
            maxDecoderInstances  = estimateMaxDecoderInstances(list),
        )
    }

    private fun CodecCapabilities.toVideoCodecs(
        mime: String,
        info: MediaCodecInfo,
    ): List<VideoCodec> {
        val vc = videoCapabilities ?: return emptyList()
        val hw = info.isHardwareAcceleratedCompat()

        // profileLevels is the cross-product of every (profile, level) the
        // decoder advertises. We keep each entry — different profiles matter
        // for HDR10 vs HDR10+ vs DV negotiation.
        return profileLevels.map { pl ->
            VideoCodec(
                mimeType              = mime,
                profile               = pl.profile,
                level                 = pl.level,
                maxWidth              = vc.supportedWidths?.upper ?: 0,
                maxHeight             = vc.supportedHeights?.upper ?: 0,
                maxFrameRate          = vc.supportedFrameRates?.upper?.toInt() ?: 0,
                isHardwareAccelerated = hw,
            )
        }
    }

    private fun CodecCapabilities.toAudioCodec(
        mime: String,
        info: MediaCodecInfo,
    ): AudioCodec? {
        val ac = audioCapabilities ?: return null
        return AudioCodec(
            mimeType              = mime,
            maxChannels           = ac.maxInputChannelCount,
            isHardwareAccelerated = info.isHardwareAcceleratedCompat(),
        )
    }

    private fun Display?.hdrFormats(): List<HdrFormat> {
        if (this == null) return emptyList()
        val caps = hdrCapabilities ?: return emptyList()
        // Explicit loop instead of mapNotNull — Android's @HdrType IntDef
        // annotation on supportedHdrTypes confuses Kotlin 2.x overload
        // resolution for extension functions on IntArray.
        val out = mutableListOf<HdrFormat>()
        for (type in caps.supportedHdrTypes) {
            val format = when (type) {
                Display.HdrCapabilities.HDR_TYPE_HDR10        -> HdrFormat.HDR10
                Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS   -> HdrFormat.HDR10_PLUS
                Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION -> HdrFormat.DOLBY_VISION
                Display.HdrCapabilities.HDR_TYPE_HLG          -> HdrFormat.HLG
                else -> null
            }
            if (format != null) out += format
        }
        return out
    }

    /**
     * isHardwareAccelerated was added in API 29 (Android 10). Pre-Q, the
     * convention is that codec names containing "OMX.google." / "c2.android"
     * are software; everything else is hardware. This heuristic isn't
     * perfect but matches how ExoPlayer itself probes.
     */
    private fun MediaCodecInfo.isHardwareAcceleratedCompat(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            isHardwareAccelerated
        } else {
            val n = name.lowercase()
            !n.startsWith("omx.google.") && !n.startsWith("c2.android.")
        }

    /**
     * Max concurrent decoder instances — used for watch-party/picture-in-
     * picture scenarios. We approximate from codec count; more rigorous
     * probing requires actually instantiating MediaCodec which is too
     * expensive for a cold-start probe.
     */
    private fun estimateMaxDecoderInstances(list: MediaCodecList): Int =
        list.codecInfos.count { !it.isEncoder }.coerceAtMost(8)
}
