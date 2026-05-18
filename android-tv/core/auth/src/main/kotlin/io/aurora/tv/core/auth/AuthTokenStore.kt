package io.aurora.tv.core.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Secure persistence for JWT access + refresh tokens.
 *
 * Why EncryptedSharedPreferences rather than DataStore?
 *  - DataStore doesn't yet ship a first-class encryption layer (Proto-level
 *    encryption is possible but manual).
 *  - EncryptedSharedPreferences wraps the Android Keystore transparently;
 *    the key never leaves secure hardware on devices that have it.
 *  - Android TV devices vary — some Shield/Chromecast models have TEE,
 *    others fall back to software; the Keystore abstraction hides this.
 *
 * Only tokens live here. User-visible profile data (name, avatar) goes in
 * DataStore-unencrypted to keep startup reads fast (encrypted reads
 * synchronously decrypt and add ~5-15ms per read on mid-tier boxes).
 */
@Singleton
class AuthTokenStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "aurora_auth_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun saveTokens(access: String, refresh: String) {
        prefs.edit()
            .putString(KEY_ACCESS, access)
            .putString(KEY_REFRESH, refresh)
            .apply()
    }

    fun accessToken(): String? = prefs.getString(KEY_ACCESS, null)
    fun refreshToken(): String? = prefs.getString(KEY_REFRESH, null)

    fun clear() {
        prefs.edit().clear().apply()
    }

    private companion object {
        const val KEY_ACCESS  = "jwt_access"
        const val KEY_REFRESH = "jwt_refresh"
    }
}
