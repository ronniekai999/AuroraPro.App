package io.aurora.tv.core.auth

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Persistence for the current server's base URL (e.g. "https://aurorapro.app").
 *
 * Why a separate store from AuthTokenStore: tokens are sensitive (encrypted)
 * but the server URL is just a host — it sits in DNS and the TLS cert anyway,
 * so encrypting it adds latency for no security gain. Plain DataStore-Prefs
 * keeps reads fast (~tens of microseconds vs. 5-15ms for the encrypted store
 * on mid-tier hardware).
 *
 * The previous Phase 0 implementation kept the server URL only in
 * `AuthState.SignedIn`, which is in-memory — surviving recomposition but
 * NOT process death. After process death the user would need to sign in
 * again just to recover the URL. This store closes that gap.
 *
 * URL is normalized to remove a trailing slash on save so Retrofit's
 * baseUrl + endpoint-path concatenation produces a clean URL regardless
 * of what the user typed.
 */
@Singleton
class ServerUrlStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val store: DataStore<Preferences> = context.serverUrlDataStore

    /** Cold flow that emits the current URL (or null if never set). */
    val serverUrl: Flow<String?> = store.data.map { it[KEY_SERVER_URL] }

    /** One-shot read, suspends until the first emission. */
    suspend fun current(): String? = serverUrl.first()

    suspend fun setServerUrl(url: String) {
        val normalized = url.trim().trimEnd('/')
        store.edit { it[KEY_SERVER_URL] = normalized }
    }

    suspend fun clear() {
        store.edit { it.remove(KEY_SERVER_URL) }
    }

    private companion object {
        val KEY_SERVER_URL = stringPreferencesKey("server_url")
    }
}

// Top-level extension is the canonical DataStore-Prefs idiom: a single
// instance per process, keyed by name. Keeping this internal-style at the
// file level (not inside the class) avoids the "DataStore created twice"
// runtime error that fires when an instance is constructed inside a
// non-Singleton class.
private val Context.serverUrlDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "aurora_server_url",
)
