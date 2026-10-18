package app.aurorapro.tv

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.aurorapro.tv.data.*
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

enum class Page { SERVER, LOGIN, PAIR, PROFILES, HOME, MOVIES, SHOWS, SEARCH, DETAIL, PLAYER }

data class TvState(
    val page: Page = Page.SERVER,
    val server: String = "",
    val busy: Boolean = false,
    val signingOut: Boolean = false,
    val error: String? = null,
    val user: User? = null,
    val profiles: List<Profile> = emptyList(),
    val profile: Profile? = null,
    // The profile the server session is bound to, when known: read at sign-in
    // and set by each accepted activation. Its PIN is never asked for, because
    // the server does not check it (any digits would pass).
    val boundProfileId: Long? = null,
    val profileReturnPage: Page? = null,
    val home: HomeData? = null,
    val items: List<Media> = emptyList(),
    val detail: Media? = null,
    val files: List<MediaFile> = emptyList(),
    val seasons: List<Season> = emptyList(),
    val season: Int? = null,
    val episodes: List<Episode> = emptyList(),
    val episode: Episode? = null,
    val suggestedEpisode: Episode? = null,
    val grant: DeviceGrant? = null,
    val target: PlayTarget? = null,
    val continuation: EpisodeContinuation? = null,
    val continuationLoading: Boolean = false,
    val continuationError: String? = null,
    val query: String = "",
    val searchKind: String = "all",
    val browsePage: Int = 0,
    val browsePages: Int = 1,
    val browseTotal: Long = 0,
    val browseSort: String = "added",
    val browseGenre: String = "",
    val genres: List<String> = emptyList(),
    val pairExpiresAt: Long = 0,
    val pairMessage: String? = null,
    // A locked profile waiting for its PIN (or the account password), and why
    // the last attempt was refused.
    val pinPrompt: Profile? = null,
    val pinError: String? = null,
)

class TvViewModel(application: Application) : AndroidViewModel(application) {
    private data class PlaybackRefresh(val target: PlayTarget, val episode: Episode?)
    private val preferences = application.getSharedPreferences("aurora_tv", 0)
    private val mutable = MutableStateFlow(TvState(server = preferences.getString("server", "").orEmpty()))
    val state = mutable.asStateFlow()
    var client: AuroraClient? = null
        private set
    private var job: Job? = null
    private var continuationJob: Job? = null
    private var operationSequence = 0L
    private var returnPage = Page.HOME
    private var pendingPlaybackSave: Job? = null
    private var pendingPlaybackRefresh: PlaybackRefresh? = null
    var focusedMediaKey: String? = null

    init { if (state.value.server.isNotEmpty()) connect(state.value.server) }

    private fun update(block: (TvState) -> TvState) { mutable.value = block(mutable.value) }
    private fun perform(block: suspend () -> Unit) {
        if (state.value.signingOut) return
        val operation = ++operationSequence
        job?.cancel()
        continuationJob?.cancel()
        job = viewModelScope.launch {
            update { it.copy(busy = true, error = null, continuation = null, continuationLoading = false, continuationError = null) }
            try { block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                if (operation == operationSequence) update { it.copy(error = if (e is AuroraException || e is IllegalArgumentException) e.message
                    else "Couldn't reach Aurora. Check your server connection and try again.") }
            } finally {
                // A cancelled predecessor must not make the current operation
                // appear idle, especially while profile activation is pending.
                if (operation == operationSequence) update { it.copy(busy = false) }
            }
        }
    }

    fun connect(address: String) = perform {
        pendingPlaybackSave = null
        pendingPlaybackRefresh = null
        val origin = serverAddress(address)
        client?.disconnect()
        client = null
        val api = withContext(Dispatchers.IO) {
            AuroraClient(origin, SessionCookies(origin, EncryptedCookies(getApplication(), origin)))
        }
        api.checkServer()
        client = api
        preferences.edit().putString("server", origin.toString()).apply()
        update { TvState(page = Page.LOGIN, server = origin.toString(), busy = true) }
        try { signedIn(api.me()) }
        catch (e: AuroraException) { if (e.status != 401) throw e }
    }

    private suspend fun signedIn(user: User) {
        val api = requireNotNull(client)
        var profiles = api.profiles()
        if (profiles.isEmpty()) profiles = listOf(api.createDefaultProfile(user.username))
        // Unknown on a failed read, which only means the prompt asks as before.
        val bound = try { api.activeProfile().id } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
        update { it.copy(page = Page.PROFILES, user = user, profiles = profiles, profile = null, boundProfileId = bound,
            profileReturnPage = null, grant = null) }
    }

    private suspend fun newAuthenticationAttempt(): AuroraClient {
        pendingPlaybackSave = null
        pendingPlaybackRefresh = null
        val previous = requireNotNull(client)
        previous.disconnect()
        val api = withContext(Dispatchers.IO) { previous.nextSession() }
        client = api
        return api
    }

    fun login(username: String, password: String) = perform {
        signedIn(newAuthenticationAttempt().login(username.trim(), password))
    }

    fun pair() = perform {
        val api = newAuthenticationAttempt()
        val grant = api.beginPairing()
        val expiresAt = android.os.SystemClock.elapsedRealtime() + grant.expiresIn.coerceAtMost(600) * 1000L
        update { it.copy(page = Page.PAIR, grant = grant, busy = false, pairExpiresAt = expiresAt, pairMessage = null) }
        while (android.os.SystemClock.elapsedRealtime() < expiresAt) {
            delay(grant.interval.coerceIn(5, 30) * 1000L)
            val poll = try { api.pollPairing(grant.deviceCode) }
            catch (e: IOException) {
                if (e is AuroraException && e.status in setOf(400, 404)) break
                if (e is AuroraException && e.status !in setOf(429, 500, 502, 503, 504)) throw e
                update { it.copy(pairMessage = "Waiting for your server connection. You can retry with a new code.") }
                continue
            }
            update { it.copy(pairMessage = null) }
            when (poll.status) {
                "authorized" -> { signedIn(poll.user ?: api.me()); return@perform }
                "authorization_pending" -> Unit
                else -> break
            }
        }
        update { it.copy(grant = null, error = "This code expired or the server restarted. Choose New code to try again.") }
    }

    fun selectProfile(profile: Profile) {
        if (state.value.busy) return
        // A locked profile asks first; the session's own profile never does.
        val bound = profile.id == state.value.profile?.id || profile.id == state.value.boundProfileId
        if (profile.hasPin && !bound) {
            update { it.copy(pinPrompt = profile, pinError = null, error = null) }
            return
        }
        activateProfile(profile, pin = null, password = null)
    }

    // Sends the PIN, or the account password when usePassword is set, for the
    // profile the prompt is asking about.
    fun submitUnlock(secret: String, usePassword: Boolean) {
        val profile = state.value.pinPrompt ?: return
        if (state.value.busy || secret.isEmpty()) return
        if (usePassword) activateProfile(profile, pin = null, password = secret)
        else activateProfile(profile, pin = secret, password = null)
    }

    fun cancelUnlock() {
        if (state.value.busy) return
        update { it.copy(pinPrompt = null, pinError = null) }
    }

    private fun activateProfile(profile: Profile, pin: String?, password: String?) = perform {
        val api = requireNotNull(client)
        val before = state.value
        pendingPlaybackRefresh = null
        // Once activation starts, its server outcome may be uncertain on a
        // network failure. Do not return to content labelled with the old
        // profile; remain at the picker until a selection is acknowledged.
        update { it.copy(profile = null, profileReturnPage = null, home = null, items = emptyList(), detail = null,
            query = "", searchKind = "all", browsePage = 0, browseGenre = "", browseSort = "added", genres = emptyList(),
            pinError = null) }
        try {
            api.activate(profile, pin, password)
        } catch (e: AuroraException) {
            // A refused unlock is certain: the server kept the session's
            // binding. Keep asking rather than surfacing a page-level error,
            // and put back the profile and return page, so Back and the
            // picker still reflect the profile the session is acting as.
            val refusal = when (e.reason) {
                "profile_pin_required" -> null
                "profile_pin_invalid" -> if (password != null) "That password is not right." else "That PIN is not right."
                "profile_pin_locked" -> "Too many wrong attempts. Try again in 15 minutes."
                else -> throw e
            }
            // Put back the content cleared above too, so Back from the picker
            // returns to the page as it was rather than an empty one.
            update { it.copy(pinPrompt = profile, pinError = refusal,
                profile = before.profile, profileReturnPage = before.profileReturnPage,
                home = before.home, items = before.items, detail = before.detail, query = before.query,
                searchKind = before.searchKind, browsePage = before.browsePage, browseGenre = before.browseGenre,
                browseSort = before.browseSort, genres = before.genres) }
            return@perform
        }
        update { it.copy(page = Page.HOME, profile = profile, boundProfileId = profile.id, pinPrompt = null, pinError = null) }
        awaitPlaybackSave()
        val home = api.home(profile.id)
        update { it.copy(home = home) }
    }

    fun navigate(page: Page) = perform {
        val profile = requireNotNull(state.value.profile)
        update { it.copy(page = page, profileReturnPage = if (page == Page.PROFILES) it.page else null, target = null, error = null) }
        val api = requireNotNull(client)
        when (page) {
            Page.HOME -> { awaitPlaybackSave(); val home = api.home(profile.id); update { it.copy(home = home) } }
            Page.MOVIES, Page.SHOWS -> {
                update { it.copy(items = emptyList(), browsePage = 0, browseGenre = "", browseSort = "added", genres = emptyList()) }
                loadBrowse(1)
                val type = if (page == Page.MOVIES) "movie" else "show"
                val genres = try { api.genres(type) } catch (e: IOException) {
                    if (e is AuroraException && e.status == 401) throw e
                    emptyList()
                }
                update { it.copy(genres = genres) }
            }
            Page.PROFILES -> { val profiles = api.profiles(); update { it.copy(profiles = profiles) } }
            Page.SEARCH -> if (state.value.query.isNotBlank()) {
                val items = api.search(state.value.query, profile.id); update { it.copy(items = items) }
            } else update { it.copy(items = emptyList()) }
            else -> Unit
        }
    }

    private suspend fun loadBrowse(page: Int) {
        val snapshot = state.value
        val response = requireNotNull(client).browsePage(if (snapshot.page == Page.MOVIES) "movie" else "show",
            requireNotNull(snapshot.profile).id, page, snapshot.browseSort, snapshot.browseGenre)
        update { it.copy(items = (if (page == 1) response.data else it.items + response.data).distinctBy { media -> media.id },
            browsePage = response.page, browsePages = response.totalPages, browseTotal = response.totalItems) }
    }
    fun browseFilter(sort: String = state.value.browseSort, genre: String = state.value.browseGenre) = perform {
        update { it.copy(browseSort = sort, browseGenre = genre, browsePage = 0, items = emptyList()) }
        loadBrowse(1)
    }
    fun loadMore() {
        val snapshot = state.value
        if (snapshot.busy || snapshot.page !in setOf(Page.MOVIES, Page.SHOWS) || snapshot.browsePage >= snapshot.browsePages) return
        perform { loadBrowse(snapshot.browsePage + 1) }
    }
    fun searchKind(kind: String) { update { it.copy(searchKind = kind) } }
    fun search(query: String, immediate: Boolean = false) = perform {
        update { it.copy(query = query, items = if (it.query.trim() == query.trim()) it.items else emptyList()) }
        if (query.isBlank()) { update { it.copy(items = emptyList()) }; return@perform }
        if (!immediate) delay(300)
        val items = requireNotNull(client).search(query.trim(), requireNotNull(state.value.profile).id)
        update { it.copy(items = items) }
    }

    fun detail(media: Media) = perform {
        pendingPlaybackRefresh = null
        returnPage = state.value.page
        update { it.copy(page = Page.DETAIL, detail = media, files = emptyList(), seasons = emptyList(),
            episodes = emptyList(), episode = null, suggestedEpisode = null, season = null) }
        val api = requireNotNull(client)
        awaitPlaybackSave()
        val detail = api.media(media.id)
        update { it.copy(detail = detail) }
        if (detail.isShow) {
            val seasons = api.seasons(detail.id).sortedWith(compareBy<Season> { it.number == 0 }.thenBy { it.number })
            update { it.copy(seasons = seasons) }
            // Continue Watching names a particular in-progress episode. The
            // next-episode endpoint instead finds the first unfinished episode,
            // which can be an earlier episode or special the viewer skipped.
            val resumeId = media.userProgress?.takeUnless { it.completed }?.episodeId
            var resumeEpisode: Episode? = null
            var resumeEpisodes: Pair<Int, List<Episode>>? = null
            if (resumeId != null) {
                for (season in seasons.sortedBy { if (it.number == media.resumeSeason) 0 else 1 }) {
                    val episodes = api.episodes(detail.id, season.number)
                    resumeEpisode = episodes.firstOrNull { it.id == resumeId }
                    if (resumeEpisode != null) { resumeEpisodes = season.number to episodes; break }
                }
            }
            val next = resumeEpisode ?: api.nextEpisode(detail.id)
            update { it.copy(suggestedEpisode = next) }
            val nextSeason = next?.let { episodeSeason(it, seasons) }
            if (resumeEpisodes != null) {
                update { it.copy(season = resumeEpisodes.first, episodes = resumeEpisodes.second) }
            } else (seasons.firstOrNull { it.number == nextSeason } ?: seasons.firstOrNull())?.let { loadSeason(it.number) }
        } else { val files = api.files(detail.id); update { it.copy(files = files) } }
    }

    private suspend fun loadSeason(number: Int) {
        val episodes = requireNotNull(client).episodes(requireNotNull(state.value.detail).id, number)
        update { it.copy(season = number, episodes = episodes, episode = null, files = emptyList()) }
    }
    fun season(number: Int) = perform { loadSeason(number) }
    private suspend fun loadEpisode(episode: Episode) {
        episodeSeason(episode, state.value.seasons)?.let { if (it != state.value.season) loadSeason(it) }
        update { it.copy(episode = episode, files = emptyList()) }
        // Season/continuation responses include matching versions from sibling
        // libraries. The legacy files endpoint only knows this episode's rows.
        val files = episode.files.ifEmpty { requireNotNull(client).episodeFiles(episode.id) }
        update { it.copy(files = files) }
    }
    fun episode(episode: Episode) = perform { loadEpisode(episode) }
    fun continueSeries() = perform {
        val next = state.value.suggestedEpisode ?: return@perform
        loadEpisode(next)
        val file = state.value.files.firstOrNull()
        if (file == null) update { it.copy(error = "This episode has no playable version yet. Choose another episode.") }
        else preparePlayback(file)
    }
    private suspend fun preparePlayback(file: MediaFile, restart: Boolean = false) {
        val snapshot = state.value
        val media = requireNotNull(snapshot.detail)
        val profile = requireNotNull(snapshot.profile)
        val progress = requireNotNull(client).progress(media.id, profile.id, snapshot.episode?.id)
        val resume = if (restart || progress.completed) 0 else progress.positionMs
        val target = PlayTarget(media, file, profile, snapshot.episode?.id, resume,
            snapshot.episode?.let { episodeSeason(it, snapshot.seasons) }, snapshot.episode?.number, snapshot.episode?.title.orEmpty())
        update { it.copy(page = Page.PLAYER, target = target) }
        resolveContinuation(target)
    }
    fun play(file: MediaFile, restart: Boolean = false) = perform { preparePlayback(file, restart) }

    private fun resolveContinuation(target: PlayTarget) {
        continuationJob?.cancel()
        val api = requireNotNull(client)
        update { it.copy(continuation = null, continuationError = null, continuationLoading = target.episodeId != null) }
        if (target.episodeId == null) return
        continuationJob = viewModelScope.launch {
            try {
                val next = withTimeout(15_000) { api.followingEpisode(target) }
                if (client === api && state.value.page == Page.PLAYER && state.value.target === target)
                    update { it.copy(continuation = next, continuationLoading = false) }
            } catch (e: CancellationException) {
                // A timeout offers Retry, while a superseded player remains retired.
                if (e is kotlinx.coroutines.TimeoutCancellationException && client === api && state.value.target === target)
                    update { it.copy(continuationLoading = false, continuationError = "Couldn't load the next episode. Try again.") }
                else throw e
            } catch (_: Exception) {
                if (client === api && state.value.page == Page.PLAYER && state.value.target === target)
                    update { it.copy(continuationLoading = false, continuationError = "Couldn't load the next episode. Try again.") }
            }
        }
    }

    fun retryContinuation() { state.value.target?.takeIf { state.value.page == Page.PLAYER }?.let { resolveContinuation(it) } }

    private fun trackPlaybackSave(saved: Job) {
        val previous = pendingPlaybackSave
        pendingPlaybackSave = viewModelScope.launch { previous?.join(); saved.join() }
    }

    fun advanceEpisode(from: PlayTarget, finalProgressSaved: Job): Boolean {
        val snapshot = state.value
        if (snapshot.page != Page.PLAYER || snapshot.target !== from) return false
        val next = snapshot.continuation ?: return false
        trackPlaybackSave(finalProgressSaved)
        val target = PlayTarget(from.media, next.file, from.profile, next.episode.id,
            seasonNumber = next.season, episodeNumber = next.episode.number, episodeTitle = next.episode.title)
        // Replacing the target disposes the old player and saves its captured
        // profile/episode checkpoint. The next episode starts at zero, as on web.
        update { it.copy(target = target, episode = next.episode, season = next.season,
            episodes = if (it.season == next.season) it.episodes else emptyList(), files = next.episode.files,
            suggestedEpisode = next.episode, home = null) }
        resolveContinuation(target)
        return true
    }

    private suspend fun awaitPlaybackSave() {
        val pending = pendingPlaybackSave ?: return
        pending.join()
        if (pendingPlaybackSave === pending) pendingPlaybackSave = null
    }

    fun playbackClosed(finalProgressSaved: Job) {
        if (state.value.page != Page.PLAYER) return
        // The player completes this after disposal saves its last playable
        // checkpoint. Retain the barrier if Back cancels the detail refresh.
        trackPlaybackSave(finalProgressSaved)
        back()
    }

    private fun returnFromPlayback(refresh: PlaybackRefresh) = perform {
        val target = refresh.target
        pendingPlaybackRefresh = refresh
        val snapshot = state.value
        val api = requireNotNull(client)
        update { it.copy(page = Page.DETAIL, profileReturnPage = null, target = null, suggestedEpisode = null, home = null) }
        awaitPlaybackSave()
        val progress = api.progress(target.media.id, target.profile.id, target.episodeId)
        val detail = api.media(target.media.id).copy(userProgress = progress)
        val episodes = if (detail.isShow && snapshot.season != null) api.episodes(detail.id, snapshot.season) else snapshot.episodes
        val episode = snapshot.episode?.let { selected ->
            (episodes.firstOrNull { it.id == selected.id } ?: selected).let {
                if (it.id == target.episodeId) it.copy(progress = progress) else it
            }
        }
        // Keep a partially watched later episode ahead of skipped specials or
        // earlier episodes. A completed episode must use the server's next one.
        val playedEpisode = episodes.firstOrNull { it.id == target.episodeId } ?: refresh.episode
        val next = if (detail.isShow) {
            if (!progress.completed && playedEpisode != null) playedEpisode.copy(progress = progress) else api.nextEpisode(detail.id)
        } else null
        val home = api.home(target.profile.id)
        // Preserve the selected version, season, and saved detail focus.
        update { it.copy(detail = detail, episodes = episodes, episode = episode, suggestedEpisode = next, home = home) }
        pendingPlaybackRefresh = null
    }

    fun back() {
        if (state.value.signingOut) return
        // Consume Back during activation instead of cancelling a request that
        // can still commit remotely. An idle picker can return without mutation.
        if (state.value.page == Page.PROFILES && state.value.busy) return
        if (state.value.pinPrompt != null) { cancelUnlock(); return }
        state.value.target?.takeIf { state.value.page == Page.PLAYER }?.let {
            returnFromPlayback(PlaybackRefresh(it, state.value.episode)); return
        }
        val destination = when (state.value.page) {
            Page.DETAIL -> returnPage
            Page.PROFILES -> state.value.profileReturnPage
            Page.MOVIES, Page.SHOWS, Page.SEARCH -> Page.HOME
            else -> null
        }
        if (destination == Page.HOME && (state.value.home == null || pendingPlaybackSave != null)) {
            navigate(Page.HOME); return
        }
        // Visiting Profiles cancels the foreground refresh. Returning without
        // switching profiles still owes this detail a refresh, even if its
        // progress save had already finished before cancellation.
        if (destination == Page.DETAIL) pendingPlaybackRefresh?.let { returnFromPlayback(it); return }
        operationSequence++
        job?.cancel()
        continuationJob?.cancel()
        update { it.copy(page = when (it.page) {
            Page.PLAYER -> Page.DETAIL
            Page.DETAIL -> returnPage
            Page.PAIR -> Page.LOGIN
            Page.LOGIN -> Page.SERVER
            Page.PROFILES -> it.profileReturnPage ?: it.page
            Page.MOVIES, Page.SHOWS, Page.SEARCH -> Page.HOME
            else -> it.page
        }, profileReturnPage = null, target = null, grant = null, busy = false, error = null) }
    }
    fun changeServer() {
        if (state.value.signingOut) return
        if (state.value.page == Page.PROFILES && state.value.busy) return
        operationSequence++
        job?.cancel()
        continuationJob?.cancel()
        pendingPlaybackSave = null
        pendingPlaybackRefresh = null
        update { TvState(server = it.server) }
    }
    fun signOut() = perform {
        pendingPlaybackSave = null
        pendingPlaybackRefresh = null
        val previous = requireNotNull(client)
        update { it.copy(signingOut = true) }
        try { previous.logout() }
        finally {
            // Keep the Main-thread transition inside NonCancellable too. A
            // cancelled return from IO must not leave a retired client on Home.
            withContext(NonCancellable) {
                client = withContext(Dispatchers.IO) { previous.nextSession() }
                update { TvState(page = Page.LOGIN, server = it.server) }
            }
        }
    }
}

internal fun episodeSeason(episode: Episode, seasons: List<Season>): Int? = episode.season
    ?: seasons.firstOrNull { episode.seasonId != 0L && it.id == episode.seasonId }?.number
