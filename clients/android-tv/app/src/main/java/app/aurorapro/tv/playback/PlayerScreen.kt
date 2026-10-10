package app.aurorapro.tv.playback

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import app.aurorapro.tv.TvAction
import app.aurorapro.tv.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun PlayerScreen(api: AuroraClient, target: PlayTarget, onClose: () -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Media3 access must stay on Android's main looper, including after HTTP callbacks.
    val scope = rememberCoroutineScope { Dispatchers.Main.immediate }
    val player = remember(api, target) {
        val data = DefaultDataSource.Factory(context, OkHttpDataSource.Factory(api.http))
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(data)).build().apply {
            trackSelectionParameters = trackSelectionParameters.buildUpon()
                .setPreferredAudioLanguage(target.profile.language)
                .setPreferredTextLanguage(target.profile.subtitleLang.ifBlank { target.profile.language })
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, target.profile.subtitleMode == "off").build()
        }
    }
    val mediaSession = remember(player) { MediaSession.Builder(context, player).build() }
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
    var active by remember { mutableStateOf(true) }
    var playRequested by remember { mutableStateOf(true) }
    var pausingForLoad by remember { mutableStateOf(false) }
    val progressLock = remember { Mutex() }

    fun sourcePosition() = if (hasLoaded) timeline.sourcePosition(player.currentPosition) else position

    suspend fun persist() {
        if (!hasLoaded) return
        val snapshot = sourcePosition()
        val synced = syncProgress {
            progressLock.withLock { api.saveProgress(target, snapshot, timeline.durationMs) }
        }
        progressMessage = if (synced) null else "Watch progress couldn't sync. Aurora will retry."
    }

    // Session creation and deletion are serialized; cancellation still deletes a returned session.
    suspend fun load(at: Long, force: Boolean) {
        busy = true; error = null
        pausingForLoad = true
        try { player.pause() } finally { pausingForLoad = false }
        position = timeline.seekPosition(at)
        hasLoaded = false
        val oldSession = sessionId
        sessionId = null
        if (oldSession != null) withContext(NonCancellable) { withTimeoutOrNull(15_000) { runCatching { api.deleteSession(oldSession) } } }
        currentCoroutineContext().ensureActive()
        val stream = decision ?: api.streamInfo(target, deviceCapabilities(context, target.file)).stream.also { decision = it }
        val duration = stream.durationMs.takeIf { it > 0 } ?: target.file.durationMs
        val url: String
        val start: Long
        if (!force && stream.decision == "direct_play") {
            timeline = SourceTimeline(0, duration)
            url = api.endpoint(stream.streamUrl).toString()
            start = position
        } else {
            // NonCancellable prevents a cancelled call from orphaning a newly-created FFmpeg session.
            val session = withContext(NonCancellable) { withTimeout(110_000) { api.createSession(target, stream, position, force) } }
            sessionId = session.id
            currentCoroutineContext().ensureActive()
            timeline = SourceTimeline(session.startSec * 1000, duration)
            url = api.endpoint(session.playlist).toString()
            start = timeline.playerPosition(position)
        }
        val item = MediaItem.Builder().setUri(url).setMediaMetadata(MediaMetadata.Builder().setTitle(target.media.title).build())
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
                busy = false; error = "Playback couldn't start. Retry or return to the title."
            }
        }
    }

    fun seek(at: Long) {
        val source = timeline.seekPosition(at)
        val local = timeline.playerPosition(source)
        if (hasLoaded && (sessionId == null || (source >= timeline.offsetMs && player.duration > 0 && local <= player.duration))) {
            player.seekTo(local)
        } else scheduleLoad(source)
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!pausingForLoad) playRequested = playWhenReady
            }
            override fun onPlayerError(playbackError: PlaybackException) {
                val at = sourcePosition()
                if (!fallbackUsed && playbackError.errorCode in setOf(
                        PlaybackException.ERROR_CODE_DECODING_FAILED, PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
                        PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
                        PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED)) {
                    fallbackUsed = true
                    scheduleLoad(at, true)
                } else error = "Playback stopped. Check your connection, then choose Retry."
            }
        }
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) { playRequested = false; player.pause(); scope.launch { persist() } }
        }
        player.addListener(listener)
        lifecycle.addObserver(observer)
        onDispose {
            active = false
            val finalPosition = sourcePosition()
            val finalDuration = timeline.durationMs
            val shouldSave = hasLoaded
            val pending = loadJob
            pending?.cancel()
            lifecycle.removeObserver(observer)
            player.removeListener(listener)
            mediaSession.release()
            player.release()
            // Independent bounded cleanup survives removal of this composable.
            val cleanup = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            cleanup.launch {
                withTimeoutOrNull(125_000) {
                    try {
                        pending?.join()
                        // A slow progress request must not consume the deletion
                        // budget for a newly returned encoder session.
                        if (shouldSave) withTimeoutOrNull(15_000) {
                            progressLock.withLock { runCatching { api.saveProgress(target, finalPosition, finalDuration) } }
                        }
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
        withContext(Dispatchers.Main.immediate) {
            var ticks = 0
            while (isActive && active) {
                delay(1000)
                position = sourcePosition()
                ticks++
                if (ticks % 15 == 0) persist()
            }
        }
    }
    LaunchedEffect(sessionId) {
        val id = sessionId ?: return@LaunchedEffect
        while (isActive) { delay(20_000); runCatching { api.keepAlive(id) } }
    }
    BackHandler { onClose() }
    Column(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(factory = { PlayerView(it).apply {
            this.player = player
            keepScreenOn = true
            useController = true
            setShowSubtitleButton(true)
            setShowFastForwardButton(false)
            setShowRewindButton(false)
            requestFocus()
        } }, modifier = Modifier.fillMaxWidth().weight(1f), update = { it.player = player })
        Column(Modifier.padding(horizontal = 24.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("${target.media.title}   ${clock(position)} / ${clock(timeline.durationMs)}" + if (busy) "   Loading…" else "")
            error?.let { Text(it, color = Color(0xFFFFBAAE)) }
            progressMessage?.let { Text(it, color = Color(0xFFFFBAAE)) }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvAction("Back to title", onClose)
                TvAction("−30 sec", { seek(sourcePosition() - 30_000) }, enabled = !busy)
                TvAction("+30 sec", { seek(sourcePosition() + 30_000) }, enabled = !busy)
                if (error != null) TvAction("Retry", { scheduleLoad(position) })
            }
        }
    }
}

private fun clock(ms: Long): String {
    val seconds = ms.coerceAtLeast(0) / 1000
    return "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60)
}
