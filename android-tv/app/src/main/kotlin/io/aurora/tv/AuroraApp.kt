package io.aurora.tv

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import dagger.hilt.android.HiltAndroidApp

/**
 * Hilt application root.
 *
 * Also implements [SingletonImageLoader.Factory] so Coil 3 has a deterministic
 * network configuration. Without this, Coil 3 relies on ServiceLoader-based
 * auto-discovery to find a network fetcher — which is unreliable under
 * R8/ProGuard and inconsistent across transitive dep graphs. The symptom of
 * auto-discovery failing is that image requests silently never fire, leaving
 * AsyncImage / SubcomposeAsyncImage stuck in their loading slot. Explicit
 * registration eliminates that class of failure.
 *
 * Crossfade is intentionally OFF (the previous `.crossfade(true)` default).
 * On a TV poster grid, the per-image 100-200ms fade-in animation reads as
 * "the app is slow loading images" rather than "smooth transition." With
 * 50 posters loading near-simultaneously on the Movies tab, the staggered
 * fades create a visibly-painty first-paint experience. Snapping each
 * image in directly feels far snappier; the trade-off (no smoothing of
 * loading-to-loaded transitions) is invisible at TV viewing distance.
 */
@HiltAndroidApp
class AuroraApp : Application(), SingletonImageLoader.Factory {

    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .components {
                // Explicit OkHttp fetcher registration — replaces Coil 3's
                // unreliable ServiceLoader discovery.
                add(OkHttpNetworkFetcherFactory())
            }
            .build()
}
