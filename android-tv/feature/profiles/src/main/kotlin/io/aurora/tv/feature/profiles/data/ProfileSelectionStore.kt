package io.aurora.tv.feature.profiles.data

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
 * Persistence for the currently-selected profile id.
 *
 * Mirrors the shape of [io.aurora.tv.core.auth.ServerUrlStore]: a small
 * DataStore-Preferences-backed singleton with both a cold flow and a
 * one-shot suspend accessor. Same reasoning applies — profile selection
 * is non-sensitive (it's just an opaque id), so plain DataStore-Prefs
 * keeps reads fast versus the encrypted store.
 *
 * Why a dedicated store rather than reusing AuthTokenStore or
 * ServerUrlStore: profile selection has its own lifecycle that's
 * orthogonal to auth. A user signing out should clear tokens but might
 * sign back in to the same account and want the previously-picked
 * profile still active. Conversely, switching profiles shouldn't touch
 * any auth state. Keeping selection in its own store makes both
 * lifecycles independent.
 *
 * Future surfaces (Home's Continue Watching, parental gating, etc.) can
 * read the current selection via [selectedProfileId] / [current] to
 * scope their queries with the server's `?profile_id=` filter.
 */
@Singleton
class ProfileSelectionStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val store: DataStore<Preferences> = context.profileSelectionDataStore

    /** Cold flow that emits the current selection (or null if never set). */
    val selectedProfileId: Flow<String?> = store.data.map { it[KEY_SELECTED_PROFILE_ID] }

    /** One-shot read; suspends until the first emission. */
    suspend fun current(): String? = selectedProfileId.first()

    suspend fun setSelectedProfileId(id: String) {
        store.edit { it[KEY_SELECTED_PROFILE_ID] = id }
    }

    suspend fun clear() {
        store.edit { it.remove(KEY_SELECTED_PROFILE_ID) }
    }

    private companion object {
        val KEY_SELECTED_PROFILE_ID = stringPreferencesKey("selected_profile_id")
    }
}

// Top-level extension — same idiom as ServerUrlStore. A single DataStore
// instance per process, keyed by name. Constructing inside a non-Singleton
// would trip "DataStore created twice" at runtime.
private val Context.profileSelectionDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "aurora_profile_selection",
)
