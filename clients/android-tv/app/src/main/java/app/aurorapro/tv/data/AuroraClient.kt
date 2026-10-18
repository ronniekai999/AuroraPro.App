package app.aurorapro.tv.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

val apiJson = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

// reason is the server's stable `error.reason`, when it sent one (the profile
// lock's profile_pin_required, profile_pin_invalid and profile_pin_locked).
class AuroraException(val status: Int, message: String, val reason: String? = null) : IOException(message)
private data class CookieSnapshot(val header: String)
private object LogoutRequest
private data class ProgressKey(val profile: Long, val media: Long, val episode: Long?)

class AuroraClient(val origin: HttpUrl, val cookies: SessionCookies) {
    // This client is bound to one account/origin. Share row ownership across
    // player generations, including a predecessor's detached final save.
    private val progressLocks = ConcurrentHashMap<ProgressKey, Mutex>()
    private fun progressLock(media: Long, profile: Long, episode: Long?) =
        progressLocks.computeIfAbsent(ProgressKey(profile, media, episode)) { Mutex() }
    private val refreshLock = Any()
    @Volatile private var retired = false
    private val baseClient = OkHttpClient.Builder()
        .cookieJar(cookies)
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .callTimeout(100, TimeUnit.SECONDS)
        .addInterceptor { chain ->
            if (retired && chain.request().tag(LogoutRequest::class.java) == null) throw IOException("This Aurora session has ended.")
            if (!origin.sameOrigin(chain.request().url)) throw IOException("A server response pointed outside your Aurora server.")
            chain.proceed(chain.request().newBuilder().header("User-Agent", "AuroraPro-AndroidTV/${app.aurorapro.tv.BuildConfig.VERSION_NAME}")
                .tag(CookieSnapshot::class.java, CookieSnapshot(cookies.header(chain.request().url))).build())
        }.build()
    private val refreshClient = baseClient.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()

    val http: OkHttpClient = baseClient.newBuilder().authenticator(Authenticator { _, response ->
        val path = response.request.url.encodedPath
        val noRefresh = setOf("/api/auth/login", "/api/auth/refresh", "/api/auth/logout",
            "/api/auth/device/start", "/api/auth/device/poll")
        var attempts = 0
        var prior: Response? = response
        while (prior != null) { attempts++; prior = prior.priorResponse }
        if (attempts > 1 || path in noRefresh) return@Authenticator null
        synchronized(refreshLock) {
            if (retired) return@synchronized null
            val current = cookies.header(response.request.url)
            // OkHttp's bridge removes its injected Cookie header from response.request.
            // Compare the original request snapshot so an old cookie isn't mistaken for a refresh.
            if (current.isNotEmpty() && current != response.request.tag(CookieSnapshot::class.java)?.header) {
                return@synchronized response.request.newBuilder().removeHeader("Cookie")
                    .tag(CookieSnapshot::class.java, CookieSnapshot(current)).build()
            }
            val refresh = Request.Builder().url(endpoint("/api/auth/refresh"))
                .post("{}".toRequestBody("application/json".toMediaType())).build()
            val ok = try { refreshClient.newCall(refresh).execute().use { it.isSuccessful } } catch (_: IOException) { false }
            if (ok) response.request.newBuilder().removeHeader("Cookie")
                .tag(CookieSnapshot::class.java, CookieSnapshot(cookies.header(response.request.url))).build() else null
        }
    }).build()
    private val profileClient = http.newBuilder().callTimeout(15, TimeUnit.SECONDS).build()

    private fun checkedBody(response: Response): String {
        val text = response.body?.string().orEmpty()
        if (!response.isSuccessful) {
            val field = runCatching { apiJson.parseToJsonElement(text).jsonObject["error"] }.getOrNull()
            val message = runCatching {
                when (field) {
                    is JsonPrimitive -> field.content
                    is JsonObject -> field["message"]?.jsonPrimitive?.content
                    else -> null
                }
            }.getOrNull()?.take(240) ?: "Aurora could not complete this request (${response.code})."
            val reason = runCatching { (field as? JsonObject)?.get("reason")?.jsonPrimitive?.content }.getOrNull()
            throw AuroraException(response.code, message, reason)
        }
        return text
    }

    fun endpoint(path: String, parameters: Map<String, String> = emptyMap()): HttpUrl {
        val url = origin.resolve(path) ?: throw IOException("Invalid server response.")
        require(origin.sameOrigin(url) && url.username.isEmpty() && url.password.isEmpty()) { "Invalid server address." }
        return url.newBuilder().apply { parameters.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
    }

    private suspend fun body(path: String, method: String = "GET", json: JsonObject? = null,
                             parameters: Map<String, String> = emptyMap()): String {
        val request = Request.Builder().url(endpoint(path, parameters)).apply {
            if (method != "GET") method(method, if (method == "DELETE") null else
                (json?.toString() ?: "{}").toRequestBody("application/json".toMediaType()))
        }.build()
        return suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (!continuation.isCancelled) continuation.resumeWithException(e)
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        try {
                            val text = checkedBody(it)
                            if (!continuation.isCancelled) continuation.resume(text)
                        } catch (e: Exception) {
                            if (!continuation.isCancelled) continuation.resumeWithException(e)
                        }
                    }
                }
            })
        }
    }

    private suspend inline fun <reified T> get(path: String, parameters: Map<String, String> = emptyMap()): T =
        apiJson.decodeFromString(body(path, parameters = parameters))

    private suspend inline fun <reified T> list(path: String, parameters: Map<String, String> = emptyMap()): List<T> {
        val element = apiJson.parseToJsonElement(body(path, parameters = parameters))
        if (element is JsonNull) return emptyList()
        val items = if (element is JsonArray) element else (element as? JsonObject)?.let { it["data"] ?: it["items"] }
            ?: throw IOException("Aurora returned an unexpected list response.")
        if (items is JsonNull) return emptyList()
        return apiJson.decodeFromString(items.toString())
    }

    suspend fun checkServer() { body("/api/health") }
    suspend fun me(): User = get("/api/auth/me")
    suspend fun login(username: String, password: String): User {
        val response = apiJson.decodeFromString<LoginResponse>(body("/api/auth/login", "POST", buildJsonObject {
            put("username", username); put("password", password)
        }))
        return response.user ?: me()
    }
    suspend fun logout() = withContext(NonCancellable + Dispatchers.IO) {
        synchronized(refreshLock) {
            if (retired) return@synchronized
            // Finish any rotation first, so logout revokes the newest refresh token.
            // Retire this client permanently: background player cleanup belongs to it,
            // and must never authenticate as an account that signs in afterwards.
            retired = true
            try {
                val request = Request.Builder().url(endpoint("/api/auth/logout"))
                    .tag(LogoutRequest::class.java, LogoutRequest)
                    .post("{}".toRequestBody("application/json".toMediaType())).build()
                refreshClient.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw AuroraException(response.code, "Aurora couldn't complete sign-out (${response.code}).")
                }
            } finally { cookies.retire() }
        }
    }

    suspend fun disconnect() = withContext(NonCancellable + Dispatchers.IO) {
        synchronized(refreshLock) {
            retired = true
            cookies.retire(clearSaved = false)
        }
    }

    fun nextSession(): AuroraClient {
        check(retired) { "The previous client must be retired first." }
        return AuroraClient(origin, cookies.nextSession())
    }
    suspend fun profiles(): List<Profile> = list("/api/profiles/")
    // A locked profile needs `pin`, or the account `password` in its place;
    // without one the server refuses with reason profile_pin_required.
    suspend fun activate(profile: Profile, pin: String? = null, password: String? = null): Unit = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            pin?.let { put("pin", it) }
            password?.let { put("password", it) }
        }.toString()
        synchronized(refreshLock) {
            // Bind the session that is current under the rotation lock. If
            // activation wins, refresh copies its new profile; if refresh wins,
            // activation sends the replacement token. Execute on this IO thread
            // so a 401 authenticator can acquire the same monitor reentrantly.
            val request = Request.Builder().url(endpoint("/api/profiles/${profile.id}/activate"))
                .post(body.toRequestBody("application/json".toMediaType())).build()
            profileClient.newCall(request).execute().use { checkedBody(it) }
            Unit
        }
    }
    suspend fun createDefaultProfile(name: String): Profile = apiJson.decodeFromString(
        body("/api/profiles/", "POST", buildJsonObject { put("name", name) }))

    suspend fun home(profileId: Long): HomeData = coroutineScope {
        val recent = async { list<Media>("/api/media/recent", mapOf("limit" to "30", "profile_id" to "$profileId")) }
        val continuing = async { list<ContinueItem>("/api/progress/continue", mapOf("profile_id" to "$profileId")) }
        val hero = async {
            withTimeoutOrNull(8_000) {
                try { get<HeroResponse>("/api/me/hero", mapOf("profile_id" to "$profileId")).picks.firstOrNull() }
                catch (e: IOException) { if (e is AuroraException && e.status == 401) throw e else null }
            }
        }
        HomeData(recent.await(), continuing.await(), hero.await())
    }
    suspend fun browse(type: String, profileId: Long): List<Media> = list("/api/media/",
        mapOf("type" to type, "per_page" to "80", "profile_id" to "$profileId"))
    suspend fun browsePage(type: String, profileId: Long, page: Int = 1, sort: String = "added", genre: String = ""): MediaPage {
        val element = apiJson.parseToJsonElement(body("/api/media/", parameters = mapOf(
            "type" to type, "per_page" to "40", "page" to "$page", "profile_id" to "$profileId",
            "sort_by" to sort, "genre" to genre)))
        // Array responses are supported for older servers and contract fixtures.
        return when (element) {
            is JsonNull -> MediaPage()
            is JsonArray -> apiJson.decodeFromString<List<Media>>(element.toString()).let { MediaPage(it, totalItems = it.size.toLong()) }
            else -> apiJson.decodeFromString(element.toString())
        }
    }
    suspend fun genres(type: String): List<String> {
        val element = apiJson.parseToJsonElement(body("/api/media/genres", parameters = mapOf("type" to type))).jsonObject
        return apiJson.decodeFromString(element["genres"]?.toString() ?: "[]")
    }
    suspend fun search(query: String, profileId: Long): List<Media> = list("/api/media/search",
        mapOf("q" to query, "profile_id" to "$profileId", "limit" to "50"))
    suspend fun media(id: Long): Media = get("/api/media/$id")
    suspend fun files(id: Long): List<MediaFile> = list("/api/media/$id/files")
    suspend fun episodeFiles(id: Long): List<MediaFile> = list("/api/media/episodes/$id/files")
    suspend fun seasons(id: Long): List<Season> = list("/api/media/$id/seasons")
    suspend fun episodes(id: Long, season: Int): List<Episode> = list("/api/media/$id/seasons/$season/episodes")
    suspend fun nextEpisode(id: Long): Episode? = try { get("/api/media/$id/next-episode") }
        catch (e: AuroraException) { if (e.status == 404) null else throw e }

    // Resume finds the first unfinished episode. In-player advancement instead
    // follows season/episode order, including rewatched episodes, like the web.
    suspend fun followingEpisode(target: PlayTarget): EpisodeContinuation? {
        if (target.episodeId == null) return null
        val season = target.seasonNumber ?: return null
        val number = target.episodeNumber ?: return null
        fun playable(episodes: List<Episode>, seasonNumber: Int, after: Int? = null): EpisodeContinuation? {
            for (episode in episodes.sortedBy { it.number }) {
                if (after != null && episode.number <= after) continue
                if (episode.id == target.episodeId) continue
                val file = episode.files.firstOrNull { target.file.versionTag.isNotBlank() && it.versionTag == target.file.versionTag }
                    ?: episode.files.firstOrNull() ?: continue
                return EpisodeContinuation(episode, file, seasonNumber)
            }
            return null
        }
        playable(episodes(target.media.id, season), season, number)?.let { return it }
        for (later in seasons(target.media.id).filter { it.number > season }.sortedBy { it.number }) {
            playable(episodes(target.media.id, later.number), later.number)?.let { return it }
        }
        return null
    }

    suspend fun progress(mediaId: Long, profileId: Long, episodeId: Long?): Progress =
        progressLock(mediaId, profileId, episodeId).withLock {
            try {
                get("/api/progress/$mediaId", buildMap {
                    put("profile_id", "$profileId"); episodeId?.let { put("episode_id", "$it") }
                })
            } catch (e: AuroraException) { if (e.status == 404) Progress() else throw e }
        }

    suspend fun saveProgress(target: PlayTarget, positionMs: Long, durationMs: Long) {
        progressLock(target.media.id, target.profile.id, target.episodeId).withLock {
            putProgress(target, positionMs, durationMs)
        }
    }

    internal suspend fun saveFinalProgress(target: PlayTarget, positionMs: Long, durationMs: Long) {
        progressLock(target.media.id, target.profile.id, target.episodeId).withLock {
            // Allow an already-running periodic save to finish before starting
            // the bounded final PUT. A subsequent resume read waits behind it.
            withTimeout(15_000) { putProgress(target, positionMs, durationMs) }
        }
    }

    private suspend fun putProgress(target: PlayTarget, positionMs: Long, durationMs: Long) {
        body("/api/progress/${target.media.id}", "PUT", buildJsonObject {
            put("profile_id", target.profile.id); target.episodeId?.let { put("episode_id", it) }
            put("position_ms", positionMs.coerceAtLeast(0)); put("duration_ms", durationMs.coerceAtLeast(0))
        })
    }

    suspend fun streamInfo(target: PlayTarget, caps: String): StreamInfo = get("/api/stream/info/${target.file.id}",
        mapOf("type" to target.fileType, "caps" to caps, "audio_lang" to target.profile.language))

    suspend fun createSession(target: PlayTarget, decision: StreamDecision, positionMs: Long, force: Boolean): StreamSession =
        apiJson.decodeFromString(body("/api/stream/sessions", "POST", buildJsonObject {
            put("file_id", target.file.id); put("file_type", target.fileType); put("start_sec", positionMs.coerceAtLeast(0) / 1000)
            put("remux", !force && decision.remux)
            put("audio_passthrough", !force && decision.audioPassthrough)
            if (decision.audioTrackIndex >= 0) put("audio_track_index", decision.audioTrackIndex)
            put("audio_channels", decision.audioChannels)
            put("audio_codec_out", if (force) "aac" else decision.audioCodecOut)
            put("video_codec_out", if (force) "h264" else decision.videoCodecOut)
            put("video_codec", target.file.videoCodec)
            put("hdr_tonemap", decision.hdrTonemap || (force && target.file.colorTransfer in setOf("smpte2084", "arib-std-b67")))
        }))

    suspend fun keepAlive(id: String) { body("/api/stream/sessions/$id/keepalive", "POST") }
    suspend fun deleteSession(id: String) { body("/api/stream/sessions/$id", "DELETE") }

    suspend fun beginPairing(): DeviceGrant {
        val grant: DeviceGrant = try {
            apiJson.decodeFromString(body("/api/auth/device/start", "POST",
                buildJsonObject { put("device_name", "AuroraPro Android TV") }))
        } catch (e: AuroraException) {
            if (e.status == 404 || e.status == 405) throw AuroraException(e.status,
                "Phone sign-in needs the Android TV pairing update on your AuroraPro server. Use your password, or update the server and try again.")
            throw e
        }
        endpoint(grant.verificationUri)
        require(grant.deviceCode.isNotBlank() && grant.userCode.isNotBlank() && grant.expiresIn > 0) {
            "Aurora returned an invalid sign-in code. Try again."
        }
        return grant
    }
    suspend fun pollPairing(code: String): DevicePoll = apiJson.decodeFromString(body("/api/auth/device/poll", "POST",
        buildJsonObject { put("device_code", code) }))

    fun image(path: String, size: String = "w500"): String? {
        if (path.isBlank()) return null
        if (path.startsWith("https://") || path.startsWith("http://")) return path
        return endpoint("/api/images/$size/${path.trimStart('/')}").toString()
    }
}
