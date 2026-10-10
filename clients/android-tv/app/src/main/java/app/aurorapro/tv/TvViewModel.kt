package app.aurorapro.tv

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.aurorapro.tv.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

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
    val query: String = "",
)

class TvViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("aurora_tv", 0)
    private val mutable = MutableStateFlow(TvState(server = preferences.getString("server", "").orEmpty()))
    val state = mutable.asStateFlow()
    var client: AuroraClient? = null
        private set
    private var job: Job? = null
    private var operationSequence = 0L
    private var returnPage = Page.HOME
    var focusedMediaKey: String? = null

    init { if (state.value.server.isNotEmpty()) connect(state.value.server) }

    private fun update(block: (TvState) -> TvState) { mutable.value = block(mutable.value) }
    private fun perform(block: suspend () -> Unit) {
        if (state.value.signingOut) return
        val operation = ++operationSequence
        job?.cancel()
        job = viewModelScope.launch {
            update { it.copy(busy = true, error = null) }
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
        update { it.copy(page = Page.PROFILES, user = user, profiles = profiles, profile = null, profileReturnPage = null, grant = null) }
    }

    private suspend fun newAuthenticationAttempt(): AuroraClient {
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
        update { it.copy(page = Page.PAIR, grant = grant, busy = false) }
        val expiresAt = android.os.SystemClock.elapsedRealtime() + grant.expiresIn * 1000L
        while (android.os.SystemClock.elapsedRealtime() < expiresAt) {
            delay(grant.interval.coerceIn(5, 30) * 1000L)
            val poll = api.pollPairing(grant.deviceCode)
            when (poll.status) {
                "authorized" -> { signedIn(poll.user ?: api.me()); return@perform }
                "authorization_pending" -> Unit
                else -> { update { it.copy(grant = null, error = "This code expired. Choose New code to try again.") }; return@perform }
            }
        }
        update { it.copy(grant = null, error = "This code expired. Choose New code to try again.") }
    }

    fun selectProfile(profile: Profile) {
        if (state.value.busy) return
        perform {
            val api = requireNotNull(client)
            // Once activation starts, its server outcome may be uncertain on a
            // network failure. Do not return to content labelled with the old
            // profile; remain at the picker until a selection is acknowledged.
            update { it.copy(profile = null, profileReturnPage = null, home = null, items = emptyList(), detail = null) }
            api.activate(profile)
            update { it.copy(page = Page.HOME, profile = profile) }
            val home = api.home(profile.id)
            update { it.copy(home = home) }
        }
    }

    fun navigate(page: Page) = perform {
        val profile = requireNotNull(state.value.profile)
        update { it.copy(page = page, profileReturnPage = if (page == Page.PROFILES) it.page else null, target = null, error = null) }
        val api = requireNotNull(client)
        when (page) {
            Page.HOME -> { val home = api.home(profile.id); update { it.copy(home = home) } }
            Page.MOVIES, Page.SHOWS -> {
                update { it.copy(items = emptyList()) }
                val items = api.browse(if (page == Page.MOVIES) "movie" else "show", profile.id)
                update { it.copy(items = items) }
            }
            Page.PROFILES -> { val profiles = api.profiles(); update { it.copy(profiles = profiles) } }
            Page.SEARCH -> update { it.copy(items = emptyList()) }
            else -> Unit
        }
    }

    fun search(query: String) = perform {
        update { it.copy(query = query, items = emptyList()) }
        val items = requireNotNull(client).search(query.trim(), requireNotNull(state.value.profile).id)
        update { it.copy(items = items) }
    }

    fun detail(media: Media) = perform {
        returnPage = state.value.page
        update { it.copy(page = Page.DETAIL, detail = media, files = emptyList(), seasons = emptyList(),
            episodes = emptyList(), episode = null, suggestedEpisode = null, season = null) }
        val api = requireNotNull(client)
        val detail = api.media(media.id)
        update { it.copy(detail = detail) }
        if (detail.isShow) {
            val seasons = api.seasons(detail.id).sortedWith(compareBy<Season> { it.number == 0 }.thenBy { it.number })
            update { it.copy(seasons = seasons) }
            seasons.firstOrNull()?.let { loadSeason(it.number) }
            val next = api.nextEpisode(detail.id)
            update { it.copy(suggestedEpisode = next) }
        } else { val files = api.files(detail.id); update { it.copy(files = files) } }
    }

    private suspend fun loadSeason(number: Int) {
        val episodes = requireNotNull(client).episodes(requireNotNull(state.value.detail).id, number)
        update { it.copy(season = number, episodes = episodes, episode = null, files = emptyList()) }
    }
    fun season(number: Int) = perform { loadSeason(number) }
    fun episode(episode: Episode) = perform {
        update { it.copy(episode = episode, files = emptyList()) }
        val files = requireNotNull(client).episodeFiles(episode.id)
        update { it.copy(files = files) }
    }
    fun play(file: MediaFile, restart: Boolean = false) = perform {
        val snapshot = state.value
        val media = requireNotNull(snapshot.detail)
        val profile = requireNotNull(snapshot.profile)
        val progress = requireNotNull(client).progress(media.id, profile.id, snapshot.episode?.id)
        val resume = if (restart || progress.completed) 0 else progress.positionMs
        update { it.copy(page = Page.PLAYER, target = PlayTarget(media, file, profile, snapshot.episode?.id, resume)) }
    }
    fun back() {
        if (state.value.signingOut) return
        // Consume Back during activation instead of cancelling a request that
        // can still commit remotely. An idle picker can return without mutation.
        if (state.value.page == Page.PROFILES && state.value.busy) return
        operationSequence++
        job?.cancel()
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
        update { TvState(server = it.server) }
    }
    fun signOut() = perform {
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
