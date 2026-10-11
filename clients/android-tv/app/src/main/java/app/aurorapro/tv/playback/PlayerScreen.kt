package app.aurorapro.tv.playback

import android.os.SystemClock
import android.view.KeyEvent
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.*
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.*
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.edit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.*
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import app.aurorapro.tv.TvAction
import app.aurorapro.tv.data.*
import app.aurorapro.tv.ui.*
import kotlinx.coroutines.*

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun PlayerScreen(api: AuroraClient, target: PlayTarget, continuation: EpisodeContinuation? = null,
                 continuationLoading: Boolean = false, continuationError: String? = null,
                 onRetryContinuation: () -> Unit = {}, onAdvance: (Job) -> Boolean = { false }, onClose: (Job) -> Unit) {
    // Every title owns all its effects, tracks, source clock and cleanup. A new
    // player must never inherit the outgoing episode's mutable remembered state.
    key(api, target) {
        PlaybackContent(api, target, continuation, continuationLoading, continuationError, onRetryContinuation, onAdvance, onClose)
    }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
private fun PlaybackContent(api: AuroraClient, target: PlayTarget, continuation: EpisodeContinuation?,
                            continuationLoading: Boolean, continuationError: String?,
                            onRetryContinuation: () -> Unit, onAdvance: (Job) -> Boolean, onClose: (Job) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val preferences = remember { context.getSharedPreferences("aurora_tv", 0) }
    var autoplay by remember { mutableStateOf(preferences.getBoolean("autoplay", true)) }
    val episodeAutoplay = remember { EpisodeAutoplay() }
    var nextPrompt by remember { mutableStateOf(EpisodePrompt()) }
    var markers by remember { mutableStateOf<List<SkipMarker>>(emptyList()) }
    var dismissedMarker by remember { mutableStateOf<SkipMarker?>(null) }
    var readyGeneration by remember { mutableIntStateOf(0) }
    var started by remember { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    val scope = rememberCoroutineScope { Dispatchers.Main.immediate }
    val report = remember(target.file) { deviceCapabilityReport(context, target.file) }
    val player = remember(api, target) {
        val data = DefaultDataSource.Factory(context, OkHttpDataSource.Factory(api.http))
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(data)).build().apply {
            trackSelectionParameters = trackSelectionParameters.buildUpon()
                .setPreferredAudioLanguage(target.profile.language)
                .setPreferredTextLanguage(target.profile.subtitleLang.ifBlank { target.profile.language })
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, target.profile.subtitleMode == "off").build()
        }
    }
    val mediaSession = remember(player) { MediaSession.Builder(context, player).setId(java.util.UUID.randomUUID().toString()).build() }
    var timeline by remember { mutableStateOf(SourceTimeline(0, target.file.durationMs)) }
    var sessionId by remember { mutableStateOf<String?>(null) }
    var decision by remember { mutableStateOf<StreamDecision?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(true) }
    var position by remember { mutableLongStateOf(target.resumeMs) }
    var fallbackUsed by remember { mutableStateOf(false) }
    var loadJob by remember { mutableStateOf<Job?>(null) }
    var progressMessage by remember { mutableStateOf<String?>(null) }
    var hasLoaded by remember { mutableStateOf(false) }
    val progress = remember(player) { PlaybackProgress() }
    val finalProgressSaved = remember(player) { CompletableDeferred<Unit>() }
    var active by remember { mutableStateOf(true) }
    var playRequested by remember { mutableStateOf(true) }
    var pausingForLoad by remember { mutableStateOf(false) }
    var playing by remember { mutableStateOf(false) }
    var ended by remember { mutableStateOf(false) }
    var overlay by remember { mutableStateOf(true) }
    var revealKey by remember { mutableStateOf<Int?>(null) }
    var interaction by remember { mutableIntStateOf(0) }
    var panel by remember { mutableStateOf<String?>(null) }
    var scrubbing by remember { mutableStateOf(false) }
    var tracks by remember { mutableStateOf(Tracks.EMPTY) }
    var quality by remember { mutableStateOf<String?>(null) } // Exact dimensions; null is Auto.
    var profiles by remember { mutableStateOf<List<QualityProfile>>(emptyList()) }
    var audioChoice by remember { mutableStateOf<String?>(null) }
    var sourceAudioIndex by remember { mutableStateOf<Int?>(null) }
    var sourceAudioChannels by remember { mutableStateOf<Int?>(null) }
    var sourceAudioUnknown by remember { mutableStateOf(false) }
    var sourceAudioTracks by remember { mutableStateOf<List<AudioTrack>>(emptyList()) }
    var textChoice by remember { mutableStateOf<String?>(if (target.profile.subtitleMode == "off") "off" else null) }
    var textPreference by remember { mutableStateOf<SubtitleIdentity?>(null) }
    var loadGeneration by remember { mutableIntStateOf(0) }
    var textGeneration by remember { mutableIntStateOf(0) }
    var trackMessage by remember { mutableStateOf<String?>(null) }
    var output by remember { mutableStateOf("Waiting for video…") }
    var decoder by remember { mutableStateOf("Waiting for decoder…") }
    var actualRemux by remember { mutableStateOf(false) }
    var actualAudioCopy by remember { mutableStateOf<Boolean?>(null) }
    val surfaceFocus = remember { FocusRequester() }
    val playFocus = remember { FocusRequester() }
    val nextUpFocus = remember { FocusRequester() }

    fun reveal() { overlay = true; interaction++ }
    fun close() { onClose(finalProgressSaved) }
    fun sourcePosition() = if (hasLoaded) timeline.sourcePosition(player.currentPosition) else position
    fun checkpoint() = progress.checkpoint(sourcePosition(), timeline.durationMs)
    fun applySelections(current: Tracks) {
        val textChoices = mediaTrackChoices(current, C.TRACK_TYPE_TEXT)
        val manualText = textPreference?.let { preference ->
            textChoices.firstOrNull { textGeneration == loadGeneration && it.key == textChoice }
                ?: matchingSubtitleIndex(preference, textChoices.map { it.subtitleIdentity() })?.let { textChoices[it] }
        }
        val builder = player.trackSelectionParameters.buildUpon()
            .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
            .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
            .clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, textChoice == "off" || (textPreference != null && manualText == null))
        mediaTrackChoices(current, C.TRACK_TYPE_VIDEO).firstOrNull { it.key == quality }?.let {
            builder.setOverrideForType(TrackSelectionOverride(it.group.mediaTrackGroup, listOf(it.index)))
        }
        mediaTrackChoices(current, C.TRACK_TYPE_AUDIO).firstOrNull { it.key == audioChoice }?.let {
            builder.setOverrideForType(TrackSelectionOverride(it.group.mediaTrackGroup, listOf(it.index)))
        }
        if (manualText != null) {
            builder.setOverrideForType(TrackSelectionOverride(manualText.group.mediaTrackGroup, listOf(manualText.index)))
            textChoice = manualText.key; textPreference = manualText.subtitleIdentity(); textGeneration = loadGeneration
            trackMessage = null
        } else if (textPreference != null && !busy && (textChoices.isNotEmpty() || player.playbackState == Player.STATE_READY)) {
            trackMessage = "Your selected subtitles aren't available in this stream. Choose subtitles in Settings."
            reveal()
        }
        val next = builder.build()
        if (next != player.trackSelectionParameters) player.trackSelectionParameters = next
    }
    suspend fun persist() {
        val snapshot = checkpoint() ?: return
        val synced = syncProgress { api.saveProgress(target, snapshot.positionMs, snapshot.durationMs) }
        progressMessage = if (synced) null else "Watch progress couldn't sync. Aurora will retry."
    }
    suspend fun load(at: Long, force: Boolean) {
        // A replacement can outlive this screen. Keep the outgoing playable
        // position before stop resets the item, rather than the requested seek.
        progress.beginLoad(sourcePosition(), timeline.durationMs)
        busy = true; error = null; loadGeneration++
        hasLoaded = false; readyGeneration = 0
        pausingForLoad = true
        // Cancel the old HLS loader before retiring its server session. Pausing
        // alone still lets Media3 buffer from URLs that deletion will invalidate.
        try { player.pause(); player.stop() } finally { pausingForLoad = false }
        position = timeline.seekPosition(at)
        val oldSession = sessionId
        sessionId = null
        if (oldSession != null) withContext(NonCancellable) { withTimeoutOrNull(15_000) { runCatching { api.deleteSession(oldSession) } } }
        currentCoroutineContext().ensureActive()
        val stream = decision ?: api.streamInfo(target, report.caps).let {
            sourceAudioTracks = it.audioTracks
            markers = validSkipMarkers(it.markers, it.stream.durationMs.takeIf { ms -> ms > 0 } ?: target.file.durationMs)
            it.stream
        }.also { decision = it }
        val duration = stream.durationMs.takeIf { it > 0 } ?: target.file.durationMs
        val url: String
        val start: Long
        if (!force && stream.decision == "direct_play") {
            timeline = SourceTimeline(0, duration)
            actualRemux = false; actualAudioCopy = true; profiles = emptyList()
            url = api.endpoint(stream.streamUrl).toString()
            start = position
        } else {
            // Media3 overrides apply to the current item only. Carry the chosen
            // original-file audio ordinal into FFmpeg's 0:a:N mapping as well.
            val sessionDecision = stream.copy(audioTrackIndex = sourceAudioIndex ?: stream.audioTrackIndex,
                audioChannels = sourceAudioChannels ?: stream.audioChannels)
            val session = withContext(NonCancellable) { withTimeout(110_000) { api.createSession(target, sessionDecision, position, force) } }
            sessionId = session.id
            currentCoroutineContext().ensureActive()
            actualRemux = session.remux ?: (!force && stream.remux)
            // Old servers expose only the full-transcode copy flag. It cannot
            // establish whether a remux copied audio, so leave that unknown.
            actualAudioCopy = session.audioCopy ?: session.audioPassthrough.takeUnless { actualRemux }
            profiles = session.profiles
            timeline = SourceTimeline(session.startSec * 1000, duration)
            url = api.endpoint(session.playlist).toString()
            start = timeline.playerPosition(position)
        }
        tracks = Tracks.EMPTY
        applySelections(Tracks.EMPTY) // Keep manual captions disabled until their new group is identified.
        output = "Waiting for video…"
        val item = MediaItem.Builder().setUri(url).setMediaId(loadGeneration.toString())
            .setMediaMetadata(MediaMetadata.Builder().setTitle(target.media.title).build())
        if (sessionId != null) item.setMimeType(MimeTypes.APPLICATION_M3U8)
        player.setMediaItem(item.build(), start)
        hasLoaded = true
        player.prepare()
        player.playWhenReady = playRequested && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        busy = false
    }
    fun scheduleLoad(at: Long, force: Boolean = fallbackUsed) {
        val previous = loadJob
        loadJob = scope.replacePlaybackLoad(previous) {
            try { load(at, force) }
            catch (_: Exception) {
                currentCoroutineContext().ensureActive()
                busy = false; error = "Playback couldn't start. Retry or return to the title."; reveal()
            }
        }
    }
    fun seek(at: Long) {
        val source = timeline.seekPosition(at)
        episodeAutoplay.seek(); nextPrompt = EpisodePrompt(); position = source; ended = false
        if (dismissedMarker?.let { source < it.startMs } == true) dismissedMarker = null
        val local = timeline.playerPosition(source)
        if (hasLoaded && (sessionId == null || (source >= timeline.offsetMs && player.duration > 0 && local <= player.duration)))
            player.seekTo(local)
        else scheduleLoad(source)
    }
    fun togglePlay() {
        if (ended) { episodeAutoplay.replay(); dismissedMarker = null; playRequested = true; seek(0); player.play() }
        else {
            playRequested = !playRequested
            player.playWhenReady = playRequested && !busy
        }
        reveal()
    }
    val ready = hasLoaded && readyGeneration == loadGeneration
    fun advance() {
        if (!hasLoaded || readyGeneration != loadGeneration || player.currentMediaItem?.mediaId != loadGeneration.toString() ||
            busy || error != null || continuation == null) { return }
        if (onAdvance(finalProgressSaved)) {
            episodeAutoplay.consume(); playRequested = false; player.pause()
        }
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!pausingForLoad) { playRequested = playWhenReady; if (!playWhenReady) { episodeAutoplay.pause(); reveal() } }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) { playing = isPlaying; if (!isPlaying) episodeAutoplay.pause() }
            override fun onPlaybackStateChanged(playbackState: Int) {
                ended = playbackState == Player.STATE_ENDED && hasLoaded && readyGeneration == loadGeneration &&
                    player.currentMediaItem?.mediaId == loadGeneration.toString()
                if (ended) reveal()
                if (playbackState == Player.STATE_READY && hasLoaded &&
                    player.currentMediaItem?.mediaId == loadGeneration.toString()) {
                    progress.onReady()
                    readyGeneration = loadGeneration
                    applySelections(player.currentTracks)
                }
            }
            override fun onTracksChanged(newTracks: Tracks) { tracks = newTracks; applySelections(newTracks) }
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                output = if (videoSize.width > 0 && videoSize.height > 0) "${videoSize.width}×${videoSize.height}" else "Waiting for video…"
            }
            override fun onPlayerError(playbackError: PlaybackException) {
                if (busy || !hasLoaded) return // An outgoing load cannot fail its replacement.
                dismissedMarker = null
                val at = sourcePosition()
                if (!fallbackUsed && playbackError.errorCode in setOf(
                    PlaybackException.ERROR_CODE_DECODING_FAILED, PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
                    PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
                    PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED)) {
                    if (sourceAudioUnknown) error = "Aurora can't identify this audio track for compatibility playback. Choose Automatic audio, then Retry."
                    else { fallbackUsed = true; scheduleLoad(at, true) }
                } else error = "Playback stopped. Check your connection, then choose Retry."
                reveal()
            }
        }
        val analytics = object : AnalyticsListener {
            override fun onVideoDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String,
                                                    initializedTimestampMs: Long, initializationDurationMs: Long) { decoder = decoderName }
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) started = true
            if (event == Lifecycle.Event.ON_STOP) { started = false; episodeAutoplay.pause(); playRequested = false; player.pause(); reveal(); scope.launch { persist() } }
        }
        player.addListener(listener)
        player.addAnalyticsListener(analytics)
        lifecycle.addObserver(observer)
        onDispose {
            active = false
            val finalCheckpoint = checkpoint()
            val pending = loadJob
            pending?.cancel()
            lifecycle.removeObserver(observer)
            player.removeListener(listener)
            player.removeAnalyticsListener(analytics)
            mediaSession.release()
            player.release()
            val cleanup = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            // Enqueue synchronously during disposal, before another screen can
            // resume this row. The client lock also covers reads and later saves.
            val finalSave = cleanup.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    if (finalCheckpoint != null) runCatching {
                        api.saveFinalProgress(target, finalCheckpoint.positionMs, finalCheckpoint.durationMs)
                    }
                } finally { finalProgressSaved.complete(Unit) }
            }
            cleanup.launch {
                withTimeoutOrNull(125_000) {
                    try {
                        pending?.join()
                        finalSave.join()
                    } finally {
                        withContext(NonCancellable) { withTimeoutOrNull(15_000) {
                            sessionId?.let { runCatching { api.deleteSession(it) } }
                        } }
                    }
                }
                cleanup.cancel()
            }
        }
    }
    LaunchedEffect(player) { scheduleLoad(target.resumeMs, false) }
    LaunchedEffect(player) {
        while (isActive && active) {
            delay(1000); position = sourcePosition()
        }
    }
    LaunchedEffect(player) {
        // Progress requests can wait on the server or a previous save. The
        // playback clock and marker/countdown controls must keep sampling.
        while (isActive && active) {
            delay(15_000); persist()
        }
    }
    LaunchedEffect(sessionId) {
        val id = sessionId ?: return@LaunchedEffect
        while (isActive) { delay(20_000); runCatching { api.keepAlive(id) } }
    }
    val creditsStart = if (target.episodeId != null) markers.firstOrNull { it.kind == "credits" }?.startMs else null
    LaunchedEffect(position, creditsStart, ended, playing, ready, continuation, autoplay, busy, error, panel, scrubbing, started, playRequested) {
        nextPrompt = episodeAutoplay.sample(position, creditsStart, ended, playing, ready, continuation != null, autoplay,
            busy || error != null || panel != null || scrubbing || !started || !playRequested, SystemClock.elapsedRealtime())
        if (nextPrompt.advance) advance()
    }
    LaunchedEffect(nextPrompt.offered) { if (nextPrompt.offered && panel == null) reveal() }
    LaunchedEffect(overlay, interaction, playing, busy, panel, scrubbing, error, trackMessage, nextPrompt.offered) {
        if (overlay && playing && !busy && panel == null && !scrubbing && error == null && trackMessage == null && !nextPrompt.offered) {
            delay(5000); overlay = false
        }
    }
    LaunchedEffect(overlay, panel) {
        if (panel == null) {
            if (overlay && nextPrompt.offered && !ended) nextUpFocus.requestFocus()
            else if (overlay) playFocus.requestFocus() else surfaceFocus.requestFocus()
        }
    }
    BackHandler {
        when { panel != null -> { panel = null; reveal() }; overlay -> overlay = false; else -> close() }
    }
    val root = Modifier.fillMaxSize().background(Color.Black).focusRequester(surfaceFocus).onPreviewKeyEvent { event ->
        val code = event.nativeKeyEvent.keyCode
        val down = event.nativeKeyEvent.action == KeyEvent.ACTION_DOWN
        val transport = code in setOf(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, KeyEvent.KEYCODE_MEDIA_REWIND)
        if (transport) {
            if (down) {
                when (code) {
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> togglePlay()
                    KeyEvent.KEYCODE_MEDIA_PLAY -> { if (ended) togglePlay() else { playRequested = true; player.playWhenReady = !busy; reveal() } }
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> { playRequested = false; player.pause(); reveal() }
                    KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> if (!busy) { seek(sourcePosition() + 30_000); reveal() }
                    KeyEvent.KEYCODE_MEDIA_REWIND -> if (!busy) { seek(sourcePosition() - 30_000); reveal() }
                }
            }
            true
        } else if (code == revealKey) {
            // Swallow the whole reveal gesture, including Up after focus moves
            // to the newly composed buttons. It must never activate a hidden action.
            if (down) reveal() else revealKey = null
            true
        } else if (down && code in setOf(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT,
                KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER)) {
            val hidden = !overlay
            if (hidden) revealKey = code
            reveal()
            hidden
        } else false
    }.focusable()
    Box(root) {
        AndroidView(factory = { PlayerView(it).apply {
            this.player = player; keepScreenOn = true; useController = false
            isFocusable = false; descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
        } }, modifier = Modifier.fillMaxSize(), onRelease = { it.player = null }, update = { it.player = player })
        if (busy) Text("Preparing your stream…", Modifier.align(Alignment.Center), color = AuroraColors.Focus)
        val skip = if (ready && !busy && error == null) activeSkipMarker(markers, position, target.episodeId != null,
            if (sessionId == null) null else timeline.sourcePosition(player.bufferedPosition), dismissedMarker) else null
        if (!overlay && panel == null && (skip != null || nextPrompt.offered)) {
            Column(Modifier.align(Alignment.BottomEnd).padding(36.dp).background(AuroraColors.Surface, RoundedCornerShape(16.dp)).padding(16.dp)) {
                Text(nextPrompt.seconds?.let { "Next episode in $it sec" } ?: if (nextPrompt.offered) "Next episode available" else skip!!.label())
                Text("Press OK for controls", color = AuroraColors.Muted, fontSize = 12.sp)
            }
        }
        if (overlay && panel == null) {
            Row(Modifier.align(Alignment.TopStart).fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = .9f),
                Color.Transparent))).padding(32.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    AuroraTitle(target.media.title, size = 24)
                    if (target.seasonNumber != null && target.episodeNumber != null) {
                        Text("S${target.seasonNumber}E${target.episodeNumber}" + target.episodeTitle.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty(),
                            color = AuroraColors.Muted, fontSize = 13.sp)
                    }
                }
                Text(if (sessionId == null && decision?.decision == "direct_play") "Original" else "Output · $output",
                    color = AuroraColors.Muted, fontSize = 12.sp)
            }
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Brush.verticalGradient(
                listOf(Color.Transparent, Color.Black.copy(alpha = .95f)))).padding(horizontal = 36.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                error?.let { Text(it, color = Color(0xFFFFBAAE), fontSize = 13.sp) }
                progressMessage?.let { Text(it, color = Color(0xFFFFBAAE), fontSize = 12.sp) }
                trackMessage?.let { Text(it, color = Color(0xFFFFBAAE), fontSize = 12.sp) }
                if (nextPrompt.offered && continuation != null) {
                    Text(nextPrompt.seconds?.let { "Next episode in $it sec · ${continuation.label}" } ?: "Up next · ${continuation.label}",
                        color = AuroraColors.Focus, fontSize = 16.sp, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                }
                if (skip != null || target.episodeId != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (skip != null) {
                            TvAction(skip.label(), { dismissedMarker = skip; reveal(); seek(skipDestination(skip)) }, primary = true)
                        }
                        if (continuation != null) {
                            TvAction("Next episode", { advance() }, enabled = ready && !busy && error == null)
                            if (nextPrompt.offered && !ended) {
                                TvAction("Watch credits", {
                                    episodeAutoplay.cancel(); nextPrompt = EpisodePrompt(); reveal(); playFocus.requestFocus()
                                }, Modifier.focusRequester(nextUpFocus))
                            }
                        } else if (continuationLoading) {
                            Text("Finding next episode…", color = AuroraColors.Muted, fontSize = 13.sp)
                        } else if (continuationError != null) {
                            Text(continuationError, color = Color(0xFFFFBAAE), fontSize = 13.sp)
                            TvAction("Retry next episode", onRetryContinuation)
                        } else if (ended && target.seasonNumber != null && target.episodeNumber != null) {
                            Text("No later playable episodes are available.", color = AuroraColors.Muted, fontSize = 13.sp)
                        }
                    }
                }
                PlayerTimeline(position, timeline.durationMs, !busy, { scrubbing = it }, { reveal(); seek(it) })
                Text(playbackClock(position) + " / " + playbackClock(timeline.durationMs), color = AuroraColors.Muted, fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    TvAction("Back to title", ::close)
                    TvAction("−30 sec", { reveal(); seek(sourcePosition() - 30_000) }, enabled = !busy)
                    TvAction(if (ended) "Replay" else if (playRequested) "Pause" else "Resume", { togglePlay() },
                        Modifier.focusRequester(playFocus), primary = true)
                    TvAction("+30 sec", { reveal(); seek(sourcePosition() + 30_000) }, enabled = !busy)
                    TvAction("Settings", { panel = "settings"; reveal() }, enabled = !busy)
                    if (error != null) TvAction("Retry", { scheduleLoad(position); reveal() })
                }
            }
        }
        val qualityTracks = mediaTrackChoices(tracks, C.TRACK_TYPE_VIDEO).distinctBy { it.key }
        val direct = sessionId == null && decision?.decision == "direct_play" && !fallbackUsed
        panel?.let { current ->
            when (current) {
                "info" -> PlaybackPanel {
                    val backFocus = remember { FocusRequester() }
                    LaunchedEffect(Unit) { backFocus.requestFocus() }
                    Column(Modifier.width(540.dp).heightIn(max = 400.dp).background(AuroraColors.Surface, RoundedCornerShape(20.dp)).padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        AuroraTitle("Playback information", size = 24)
                        Text(playbackPathLabel(direct, actualRemux, actualAudioCopy), color = AuroraColors.Focus)
                        Text("Source · " + sourceLabel(target.file), fontSize = 13.sp, color = AuroraColors.Muted)
                        Text("Output · $output\nActive decoder · $decoder", fontSize = 13.sp, color = AuroraColors.Muted)
                        Text(if (fallbackUsed) "The original stream could not be decoded. H.264/AAC compatibility playback is active."
                            else decision?.transcodeReason?.ifBlank { "The server selected original playback." }.orEmpty(), fontSize = 13.sp)
                        Text(report.explanation, fontSize = 12.sp, color = AuroraColors.Muted)
                        TvAction("Back to settings", { panel = "settings" }, Modifier.focusRequester(backFocus))
                    }
                }
                else -> {
                    val options = when (current) {
                        "audio" -> listOf("auto" to "Automatic · " + target.profile.language) + mediaTrackChoices(tracks, C.TRACK_TYPE_AUDIO).map { it.key to it.label }
                        "subtitles" -> listOf("off" to "Off", "auto" to "Automatic") + mediaTrackChoices(tracks, C.TRACK_TYPE_TEXT).map { it.key to it.label }
                        "quality" -> if (direct) listOf("original" to "Original · " + sourceLabel(target.file)) else
                            listOf("auto" to "Auto") + qualityTracks.map { choice ->
                                val profile = profiles.firstOrNull { "${it.width}x${it.height}" == choice.key }
                                choice.key to (profile?.name?.let { "$it · " }.orEmpty() + choice.label)
                            }
                        else -> listOf("quality" to "Quality", "audio" to "Audio", "subtitles" to "Subtitles",
                            "autoplay" to "Auto-play next episode · ${if (autoplay) "On" else "Off"}", "info" to "Playback information")
                    }
                    val selected = when (current) { "audio" -> audioChoice ?: "auto"; "subtitles" -> textChoice ?: "auto"
                        "quality" -> if (direct) "original" else quality ?: "auto"; else -> null }
                    PlaybackChoices(current, when (current) { "audio" -> "Choose audio"; "subtitles" -> "Choose subtitles"; "quality" -> "Playback quality"; else -> "Playback settings" },
                        options, selected, { key ->
                            when (current) {
                                "audio" -> {
                                    val restoreSourceAudio = key == "auto" && !direct && sourceAudioIndex != null
                                    audioChoice = key.takeUnless { it == "auto" }
                                    if (key == "auto") { sourceAudioIndex = null; sourceAudioChannels = null; sourceAudioUnknown = false }
                                    else if (direct) {
                                        mediaTrackChoices(tracks, C.TRACK_TYPE_AUDIO).firstOrNull { it.key == key }?.let { choice ->
                                            val format = choice.group.getTrackFormat(choice.index)
                                            sourceAudioIndex = resolveSourceAudioIndex(sourceAudioTracks, format.language, format.sampleMimeType,
                                                format.channelCount, format.label)
                                            sourceAudioUnknown = sourceAudioIndex == null
                                            sourceAudioChannels = format.channelCount.takeIf { it > 0 }
                                        }
                                    }
                                    applySelections(player.currentTracks); panel = null
                                    if (restoreSourceAudio) scheduleLoad(sourcePosition())
                                }
                                "subtitles" -> {
                                    textChoice = key.takeUnless { it == "auto" }
                                    textPreference = mediaTrackChoices(tracks, C.TRACK_TYPE_TEXT).firstOrNull { it.key == key }?.subtitleIdentity()
                                    textGeneration = loadGeneration; trackMessage = null
                                    applySelections(player.currentTracks); panel = null
                                }
                                "quality" -> {
                                    panel = null
                                    val next = key.takeUnless { it == "auto" || it == "original" }
                                    if (!direct && next != quality) {
                                        quality = next
                                        // New HLS anchor keeps a lazy rendition switch coherent at the source position.
                                        scheduleLoad(sourcePosition())
                                    }
                                }
                                else -> if (key == "autoplay") {
                                    autoplay = !autoplay
                                    preferences.edit { putBoolean("autoplay", autoplay) }
                                } else panel = key
                            }
                            reveal()
                        }, { panel = if (current == "settings") null else "settings"; reveal() })
                }
            }
        }
    }
}

// Keep settings in the video window. Separate dialog windows over a SurfaceView
// can stall the Android 9 window compositor during remote focus transitions.
@Composable
private fun PlaybackPanel(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .78f)), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun PlaybackChoices(id: String, title: String, choices: List<Pair<String, String>>, selected: String?,
                            onSelect: (String) -> Unit, onClose: () -> Unit) {
    key(id) {
        val initial = choices.indexOfFirst { it.first == selected }.coerceAtLeast(0)
        val list = rememberLazyListState(initialFirstVisibleItemIndex = initial)
        val firstFocus = remember { FocusRequester() }
        LaunchedEffect(Unit) { firstFocus.requestFocus() }
        PlaybackPanel {
            Column(Modifier.width(480.dp).heightIn(max = 390.dp).background(AuroraColors.Surface, RoundedCornerShape(20.dp)).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)) {
                AuroraTitle(title, size = 24)
                LazyColumn(Modifier.weight(1f, fill = false), state = list, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(choices, key = { it.first }) { (choice, label) ->
                        val focus = if (choice == choices.getOrNull(initial)?.first) Modifier.focusRequester(firstFocus) else Modifier
                        TvAction((if (selected == choice) "✓  " else "") + label, { onSelect(choice) }, focus.fillMaxWidth(), selected = selected == choice)
                    }
                }
                TvAction("Close", onClose, if (choices.isEmpty()) Modifier.focusRequester(firstFocus) else Modifier)
            }
        }
    }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal data class MediaTrackChoice(val key: String, val label: String, val group: Tracks.Group, val index: Int)

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
private fun MediaTrackChoice.subtitleIdentity(): SubtitleIdentity {
    val format = group.getTrackFormat(index)
    val roles = format.roleFlags and (C.ROLE_FLAG_COMMENTARY or C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND or C.ROLE_FLAG_DESCRIBES_VIDEO)
    return subtitleIdentity(format.language, format.label, format.selectionFlags and C.SELECTION_FLAG_FORCED != 0, roles,
        format.sampleMimeType in setOf("application/pgs", "application/dvbsubs", "application/vobsub"))
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal fun mediaTrackChoices(tracks: Tracks, type: Int): List<MediaTrackChoice> {
    val result = mutableListOf<MediaTrackChoice>()
    val ordinals = mutableMapOf<String, Int>()
    for (group in tracks.groups.filter { it.type == type }) for (index in 0 until group.length) {
        if (!group.isTrackSupported(index)) continue
        val format = group.getTrackFormat(index)
        if (type == C.TRACK_TYPE_VIDEO) {
            if (format.width > 0 && format.height > 0) result += MediaTrackChoice("${format.width}x${format.height}",
                "${format.width}×${format.height}", group, index)
        } else {
            val language = format.language.orEmpty()
            val base = "$language|${format.label.orEmpty()}|${format.roleFlags}"
            val ordinal = ordinals.getOrDefault(base, 0)
            ordinals[base] = ordinal + 1
            val label = format.label?.takeIf { it.isNotBlank() } ?: language.takeIf { it.isNotBlank() && it != "und" }
                ?.let { java.util.Locale.forLanguageTag(it).getDisplayLanguage(java.util.Locale.ENGLISH) } ?: "Track ${result.size + 1}"
            result += MediaTrackChoice("$base|$ordinal", label + if (format.selectionFlags and C.SELECTION_FLAG_FORCED != 0) " · Forced" else "", group, index)
        }
    }
    return result
}

@Composable
private fun PlayerTimeline(position: Long, duration: Long, enabled: Boolean, onScrub: (Boolean) -> Unit, onSeek: (Long) -> Unit) {
    var focused by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<Long?>(null) }
    val shown = preview ?: position
    val fraction = if (duration > 0) (shown.toDouble() / duration).toFloat().coerceIn(0f, 1f) else 0f
    Box(Modifier.fillMaxWidth().height(32.dp).border(if (focused) 2.dp else 0.dp,
        if (focused) AuroraColors.Focus else Color.Transparent, RoundedCornerShape(8.dp))
        .onFocusChanged { focused = it.isFocused; if (!focused) { preview = null; onScrub(false) } }
        .onPreviewKeyEvent { event ->
            val code = event.nativeKeyEvent.keyCode
            if (enabled && duration > 0 && code in setOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT)) {
                if (event.nativeKeyEvent.action == KeyEvent.ACTION_DOWN) {
                    preview = ((preview ?: position) + if (code == KeyEvent.KEYCODE_DPAD_RIGHT) 10_000 else -10_000).coerceIn(0, (duration - 1000).coerceAtLeast(0))
                    onScrub(true)
                } else { preview?.let(onSeek); preview = null; onScrub(false) }
                true
            } else false
        }.semantics {
            contentDescription = "Playback timeline"
            progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
            if (enabled && duration > 0) setProgress { value -> onSeek((duration * value.coerceIn(0f, 1f)).toLong()); true }
        }.focusable(enabled), contentAlignment = Alignment.CenterStart) {
        Box(Modifier.fillMaxWidth().height(4.dp).background(Color.White.copy(alpha = .3f), RoundedCornerShape(4.dp)))
        if (fraction > 0) Box(Modifier.fillMaxWidth(fraction).height(4.dp).background(AuroraColors.Purple, RoundedCornerShape(4.dp)))
    }
}
