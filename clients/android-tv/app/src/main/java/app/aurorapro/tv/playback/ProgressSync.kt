package app.aurorapro.tv.playback

import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** A local deadline is a retryable failure; cancellation of the owner still propagates. */
internal suspend fun syncProgress(timeoutMs: Long = 15_000, save: suspend () -> Unit): Boolean {
    return try {
        withContext(NonCancellable) { withTimeout(timeoutMs) { save() } }
        currentCoroutineContext().ensureActive()
        true
    } catch (_: Exception) {
        currentCoroutineContext().ensureActive()
        false
    }
}
