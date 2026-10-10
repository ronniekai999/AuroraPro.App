package app.aurorapro.tv

import android.media.MediaCodecInfo.CodecProfileLevel
import app.aurorapro.tv.data.MediaFile
import app.aurorapro.tv.playback.*
import org.junit.Assert.*
import org.junit.Test

class SourceVideoSupportTest {
    @Test fun matching4kHardwareIsNotCappedAt720pAndHdrSupportIsStillRequired() {
        val source = MediaFile(1, videoCodec = "hevc", videoProfile = "Main 10", videoPixFmt = "yuv420p10le",
            resolution = "3840x2160", videoFps = 24.0, colorTransfer = "smpte2084")
        val hardware = PlaybackDecoder(profiles = setOf(CodecProfileLevel.HEVCProfileMain10), hardwareAccelerated = true,
            supportsVideo = { width, height, fps -> width <= 3840 && height <= 2160 && fps <= 60 })
        fun caps(file: MediaFile, hdr: Boolean) = playbackCapabilities(file, hdr) { mime ->
            if (mime == "video/hevc") listOf(hardware) else emptyList()
        }.split(',').toSet()
        assertTrue("A compatible 4K source retains original HEVC capability", "hevc_main10" in caps(source, true))
        assertFalse("A 4K display cannot bypass missing HDR support", "hevc" in caps(source, false))
        assertFalse("Frame-rate limits still apply", "hevc" in caps(source.copy(videoFps = 120.0), true))
    }

    @Test fun secureOrTunneledOnlyDecodersCannotEstablishPlaybackSupport() {
        val source = MediaFile(1, videoCodec = "hevc", videoProfile = "Main 10", videoPixFmt = "yuv420p10le",
            resolution = "1920x1080", videoFps = 24.0)
        val decoder = PlaybackDecoder(profiles = setOf(CodecProfileLevel.HEVCProfileMain10),
            hardwareAccelerated = true, supportsVideo = { _, _, _ -> true })
        for (special in listOf(decoder.copy(requiresSecure = true), decoder.copy(requiresTunneled = true))) {
            val caps = playbackCapabilities(source, hdrOkay = true) { mime ->
                when (mime) {
                    "video/hevc", "audio/mp4a-latm" -> listOf(special)
                    else -> emptyList()
                }
            }.split(',').toSet()
            assertFalse("Special decoder must not establish HEVC support", "hevc" in caps)
            assertFalse("Special decoder must not establish Main10 support", "hevc_main10" in caps)
            assertFalse("Special audio playback must not establish AAC support", "aac" in caps)
            assertTrue("Server transcoding remains available", "hls_native" in caps)
        }
    }

    @Test fun anOrdinaryDecoderStillEstablishesSourceSupportAmongSpecialDecoders() {
        val source = MediaFile(1, videoCodec = "h264", videoProfile = "High", videoPixFmt = "yuv420p",
            resolution = "1920x1080", videoFps = 24.0)
        val decoder = PlaybackDecoder(profiles = setOf(CodecProfileLevel.AVCProfileHigh),
            hardwareAccelerated = true, supportsVideo = { width, height, fps -> width <= 1920 && height <= 1080 && fps <= 30 })
        val candidates = listOf(decoder.copy(requiresSecure = true), decoder, decoder.copy(requiresTunneled = true))
        val caps = playbackCapabilities(source, hdrOkay = true) { mime ->
            if (mime == "video/avc") candidates else emptyList()
        }.split(',').toSet()
        assertTrue("The ordinary decoder supports this source", "h264" in caps)
        val tooLarge = playbackCapabilities(source.copy(resolution = "3840x2160"), hdrOkay = true) { mime ->
            if (mime == "video/avc") candidates else emptyList()
        }.split(',').toSet()
        assertFalse("Other decoders cannot bypass the ordinary decoder's size limit", "h264" in tooLarge)
    }

    @Test fun scannerDimensionsRetainActualWidthAndFrameRate() {
        assertEquals(SourceVideoSize(3840, 2160), sourceVideoSize("3840x2160"))
        assertEquals(SourceVideoSize(4096, 2160), sourceVideoSize("4096x2160"))
        assertEquals(SourceVideoSize(2560, 1080), sourceVideoSize("2560x1080"))
        assertEquals(SourceVideoSize(720, 480), sourceVideoSize("720x480"))
        val limitedTv: (Int, Int, Double) -> Boolean = { width, height, fps -> width <= 1920 && height <= 1080 && fps <= 30.0 }
        val source = MediaFile(1, resolution = "1920x1080", videoFps = 29.97)
        assertTrue(supportsSourceVideo(source, limitedTv))
        assertFalse(supportsSourceVideo(source.copy(resolution = "3840x2160"), limitedTv))
        assertFalse(supportsSourceVideo(source.copy(resolution = "2560x1080"), limitedTv))
        assertFalse(supportsSourceVideo(source.copy(videoFps = 60.0), limitedTv))
    }

    @Test fun unknownGeometryOrFrameRateNeverBypassesDecoderValidation() {
        for (resolution in listOf("", "1080p", "2160p", "4k", "0x1080", "1920x0", "999999999999x1080")) {
            assertFalse(supportsSourceVideo(MediaFile(1, resolution = resolution, videoFps = 30.0)) { _, _, _ ->
                fail("Unknown source geometry must not be accepted"); true
            })
        }
        for (fps in listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY)) {
            assertFalse(supportsSourceVideo(MediaFile(1, resolution = "1920x1080", videoFps = fps)) { _, _, _ -> true })
        }
        assertFalse(supportsSourceVideo(MediaFile(1, resolution = "1920x1080", videoFps = 30.0)) { _, _, _ -> error("Broken decoder") })
    }

    @Test fun main10NeverClaimsTwelveBitRangeExtensionsOrUnknownHevc() {
        val source = MediaFile(1, videoCodec = "hevc", videoProfile = "Main 10", videoPixFmt = "yuv420p10le")
        assertEquals(VideoSourceProfile.HEVC_MAIN10, sourceVideoProfile(source))
        assertEquals(VideoSourceProfile.HEVC_MAIN, sourceVideoProfile(source.copy(videoProfile = "Main", videoPixFmt = "yuv420p")))
        assertNull(sourceVideoProfile(source.copy(videoPixFmt = "yuv420p12le")))
        assertNull(sourceVideoProfile(source.copy(videoPixFmt = "yuv422p10le")))
        assertNull(sourceVideoProfile(source.copy(videoPixFmt = "yuv444p10le")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "Rext")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "Main 12", videoPixFmt = "yuv420p12le")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "")))
        assertNull(sourceVideoProfile(source.copy(videoPixFmt = "")))
        assertNull(sourceVideoProfile(source.copy(videoCodec = "h264")))
    }

    @Test fun h264ClaimsKnownEightBit420ProfilesOnly() {
        val source = MediaFile(1, videoCodec = "h264", videoProfile = "High", videoPixFmt = "yuv420p")
        assertEquals(VideoSourceProfile.AVC_HIGH, sourceVideoProfile(source))
        assertEquals(VideoSourceProfile.AVC_MAIN, sourceVideoProfile(source.copy(videoProfile = "Main")))
        assertEquals(VideoSourceProfile.AVC_CONSTRAINED_BASELINE, sourceVideoProfile(source.copy(videoProfile = "Constrained Baseline")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "High 4:4:4 Predictive", videoPixFmt = "yuv444p")))
        assertNull(sourceVideoProfile(source.copy(videoPixFmt = "yuv422p")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "High 10", videoPixFmt = "yuv420p10le")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "")))
        assertNull(sourceVideoProfile(source.copy(videoPixFmt = "")))
    }

    @Test fun vp9AndAv1RejectChromaBitDepthAndUnknownProfileCombinations() {
        val source = MediaFile(1, videoCodec = "vp9", videoProfile = "Profile 0", videoPixFmt = "yuv420p")
        assertEquals(VideoSourceProfile.VP9_PROFILE0, sourceVideoProfile(source))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "Profile 1", videoPixFmt = "yuv444p")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "Profile 2", videoPixFmt = "yuv420p10le")))
        assertNull(sourceVideoProfile(source.copy(videoProfile = "")))
        val av1 = source.copy(videoCodec = "av1", videoProfile = "Main")
        assertEquals(VideoSourceProfile.AV1_MAIN8, sourceVideoProfile(av1))
        assertNull(sourceVideoProfile(av1.copy(videoProfile = "High", videoPixFmt = "yuv444p")))
        assertNull(sourceVideoProfile(av1.copy(videoPixFmt = "yuv420p10le")))
        assertNull(sourceVideoProfile(av1.copy(videoProfile = "")))
    }
}
