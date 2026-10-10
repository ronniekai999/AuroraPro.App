package app.aurorapro.tv.playback

import kotlinx.coroutines.*

/** A replacement retains ownership of its predecessor until late creation settles. */
internal fun CoroutineScope.replacePlaybackLoad(previous: Job?, load: suspend () -> Unit): Job {
    previous?.cancel()
    return launch(start = CoroutineStart.UNDISPATCHED) {
        withContext(NonCancellable) { previous?.join() }
        currentCoroutineContext().ensureActive()
        load()
    }
}
