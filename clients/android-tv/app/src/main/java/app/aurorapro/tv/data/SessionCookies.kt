package app.aurorapro.tv.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl

interface CookiePersistence {
    fun read(): List<String>
    fun write(cookies: List<String>)
}

class EncryptedCookies(context: Context, origin: HttpUrl) : CookiePersistence {
    private val preferences = context.getSharedPreferences("aurora_sessions", Context.MODE_PRIVATE)
    private val storageKey = MessageDigest.getInstance("SHA-256").digest(origin.toString().toByteArray())
        .joinToString("") { "%02x".format(it) }
    private val alias = "aurora_tv_session_v1"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
        }.generateKey()
    }

    override fun read(): List<String> {
        val saved = preferences.getString(storageKey, null) ?: return emptyList()
        return try {
            val bytes = Base64.decode(saved, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.updateAAD(storageKey.toByteArray())
            Json.decodeFromString<List<String>>(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).decodeToString())
        } catch (_: Exception) {
            // Restore/key loss invalidates the session; it must never fall back to plaintext.
            preferences.edit().remove(storageKey).commit()
            emptyList()
        }
    }

    override fun write(cookies: List<String>) {
        if (cookies.isEmpty()) {
            check(preferences.edit().remove(storageKey).commit()) { "Could not clear the saved session." }
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(storageKey.toByteArray())
        val bytes = cipher.iv + cipher.doFinal(Json.encodeToString(cookies).toByteArray())
        check(preferences.edit().putString(storageKey, Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()) {
            "Could not save the session."
        }
    }
}

/** Exact-origin isolation also prevents a server redirect from receiving our session cookies. */
class SessionCookies(private val origin: HttpUrl, private val persistence: CookiePersistence) : CookieJar {
    private val cookies = persistence.read().mapNotNull { Cookie.parse(origin, it) }.toMutableList()
    private var retired = false

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, incoming: List<Cookie>) {
        if (retired || !origin.sameOrigin(url)) return
        incoming.filter { it.name in setOf("aurora_access", "aurora_refresh") }.forEach { cookie ->
            cookies.removeAll { it.name == cookie.name && it.path == cookie.path }
            if (cookie.expiresAt > System.currentTimeMillis() && cookie.matches(url)) cookies.add(cookie)
        }
        persistence.write(cookies.map { it.toString() })
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        if (retired || !origin.sameOrigin(url)) return emptyList()
        return cookies.filter { it.expiresAt > System.currentTimeMillis() && it.matches(url) }
    }

    @Synchronized
    fun clear() {
        if (retired) return
        cookies.clear(); persistence.write(emptyList())
    }

    /** A retired jar can never persist a late response over the next account's cookies. */
    @Synchronized
    fun retire(clearSaved: Boolean = true) {
        if (retired) return
        retired = true
        if (clearSaved) { cookies.clear(); persistence.write(emptyList()) }
    }

    @Synchronized
    fun nextSession(): SessionCookies {
        check(retired) { "The previous session must be retired first." }
        return SessionCookies(origin, persistence)
    }

    fun header(url: HttpUrl): String = loadForRequest(url).joinToString("; ") { "${it.name}=${it.value}" }
}
