package app.aurorapro.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.*
import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.PlayerScreen
import coil3.compose.AsyncImage
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter

private val Purple = Color(0xFFA78BFA)
private val Background = Color(0xFF08090F)
private val HeadingFont = FontFamily(Font(R.font.bricolage))

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AuroraTheme { AuroraApp() } }
    }
}

@Composable
fun AuroraTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(primary = Purple, onPrimary = Background,
        background = Background, surface = Color(0xFF181B29), onSurface = Color.White)) {
        androidx.compose.material3.MaterialTheme(colorScheme = androidx.compose.material3.darkColorScheme(primary = Purple)) {
            CompositionLocalProvider(LocalContentColor provides Color.White, content = content)
        }
    }
}

@Composable
fun TvAction(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 44.dp),
        colors = ButtonDefaults.colors(containerColor = Color(0xFF24263A), contentColor = Color.White,
            focusedContainerColor = Purple, focusedContentColor = Background)) { Text(label, fontSize = 15.sp) }
}

@Composable
private fun Title(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, fontFamily = HeadingFont, fontSize = 32.sp, color = Color.White)
}

@Composable
internal fun AuroraApp(vm: TvViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val screens = rememberSaveableStateHolder()
    BackHandler(enabled = state.page !in setOf(Page.SERVER, Page.HOME) &&
        (state.page != Page.PROFILES || state.profileReturnPage != null || state.busy)) { vm.back() }
    val api = vm.client
    if (state.page == Page.PLAYER && state.target != null && api != null) {
        PlayerScreen(api, state.target!!, onClose = vm::back)
        return
    }
    Box(Modifier.fillMaxSize().background(Background)) {
        Column(Modifier.fillMaxSize().padding(horizontal = 42.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("AURORA", fontFamily = HeadingFont, fontSize = 23.sp, color = Purple)
                Text("PRO", fontSize = 11.sp, color = Color(0xFF67E8F9))
                Spacer(Modifier.weight(1f))
                state.profile?.let { Text(it.name, color = Color(0xFFD4C9F5), fontSize = 14.sp) }
            }
            state.error?.let { Text(it, color = Color(0xFFFFBAAE), fontSize = 15.sp) }
            if (state.busy) Text("Loading…", color = Purple, fontSize = 14.sp)
            screens.SaveableStateProvider(state.page.name) { when (state.page) {
                Page.SERVER -> ServerForm(state.server, state.busy, vm::connect)
                Page.LOGIN -> LoginForm(state.busy, vm::login, vm::pair, vm::changeServer)
                Page.PAIR -> PairScreen(state, api, vm::pair, vm::back)
                Page.PROFILES -> {
                    Title("Who's watching?")
                    LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                        items(state.profiles, key = { it.id }) { profile ->
                            TvAction(profile.name, { vm.selectProfile(profile) }, enabled = !state.busy)
                        }
                    }
                    if (state.profileReturnPage != null) TvAction("Back", vm::back, enabled = !state.busy)
                    TvAction("Change server", vm::changeServer, enabled = !state.busy)
                }
                Page.DETAIL -> DetailScreen(state, api, vm)
                else -> {
                    Navigation(state, vm)
                    when (state.page) {
                        Page.HOME -> HomeScreen(state.home, api, vm::detail, { vm.navigate(Page.HOME) }, vm.focusedMediaKey, { vm.focusedMediaKey = it })
                        Page.MOVIES, Page.SHOWS -> {
                            Title(if (state.page == Page.MOVIES) "Movies" else "TV shows")
                            MediaGrid(state.items, api, vm::detail, state.page.name, vm.focusedMediaKey, { vm.focusedMediaKey = it })
                            if (!state.busy && state.items.isEmpty()) Text("Your library has no titles to show yet.")
                        }
                        Page.SEARCH -> SearchScreen(state, api, vm::search, vm::detail, vm.focusedMediaKey, { vm.focusedMediaKey = it })
                        else -> Unit
                    }
                }
            } }
        }
    }
}

@Composable
private fun ServerForm(saved: String, busy: Boolean, onConnect: (String) -> Unit) {
    var address by rememberSaveable(saved) { mutableStateOf(saved) }
    Column(Modifier.width(540.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Title("Your cinema, on the big screen.")
        Text("Connect to your AuroraPro server to start watching.", color = Color(0xFFB5B8C9))
        OutlinedTextField(address, { address = it }, label = { androidx.compose.material3.Text("Server address") },
            singleLine = true, modifier = Modifier.fillMaxWidth())
        TvAction("Connect", { onConnect(address) }, enabled = !busy && address.isNotBlank())
    }
}

@Composable
private fun LoginForm(busy: Boolean, onLogin: (String, String) -> Unit, onPair: () -> Unit, onServer: () -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    // Passwords remain in memory and are never saved into instance state.
    var password by remember { mutableStateOf("") }
    Column(Modifier.width(440.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Title("Welcome back.")
        TvAction("Sign in with your phone", onPair, enabled = !busy)
        Text("Or use your Aurora username and password", color = Color(0xFFB5B8C9), fontSize = 14.sp)
        OutlinedTextField(username, { username = it }, label = { androidx.compose.material3.Text("Username") },
            singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(password, { password = it }, label = { androidx.compose.material3.Text("Password") },
            singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TvAction("Sign in", { onLogin(username, password); password = "" },
                enabled = !busy && username.isNotBlank() && password.isNotEmpty())
            TvAction("Change server", onServer)
        }
    }
}

@Composable
private fun PairScreen(state: TvState, api: AuroraClient?, onNew: () -> Unit, onBack: () -> Unit) {
    Title("Sign in with your phone")
    state.grant?.let { grant ->
        val url = api?.endpoint(grant.verificationUri, mapOf("code" to grant.userCode))?.toString().orEmpty()
        val qr = remember(url) {
            val matrix = MultiFormatWriter().encode(url, BarcodeFormat.QR_CODE, 240, 240)
            android.graphics.Bitmap.createBitmap(240, 240, android.graphics.Bitmap.Config.ARGB_8888).apply {
                val pixels = IntArray(240 * 240) { i -> if (matrix[i % 240, i / 240]) android.graphics.Color.BLACK else android.graphics.Color.WHITE }
                setPixels(pixels, 0, 240, 0, 0, 240, 240)
            }.asImageBitmap()
        }
        Row(horizontalArrangement = Arrangement.spacedBy(32.dp), verticalAlignment = Alignment.CenterVertically) {
            androidx.compose.foundation.Image(qr, contentDescription = "Scan to open Aurora device sign-in", modifier = Modifier.size(180.dp))
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Scan the code, sign in, then approve this TV.", fontSize = 18.sp)
                Text(grant.userCode, fontFamily = HeadingFont, fontSize = 38.sp, color = Purple)
                Text("Or open ${api?.endpoint(grant.verificationUri)}\nand enter the code. Expires in 10 minutes.", fontSize = 14.sp)
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        TvAction("New code", onNew, enabled = !state.busy)
        TvAction("Use a password", onBack)
    }
}

@Composable
private fun Navigation(state: TvState, vm: TvViewModel) {
    var confirmSignOut by remember { mutableStateOf(false) }
    Row(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        listOf(Page.HOME to "Home", Page.MOVIES to "Movies", Page.SHOWS to "TV shows", Page.SEARCH to "Search",
            Page.PROFILES to "Profiles").forEach { (page, label) -> TvAction(label, { vm.navigate(page) }, enabled = !state.signingOut) }
        TvAction(if (confirmSignOut) "Confirm sign out" else "Sign out", {
            if (confirmSignOut) vm.signOut() else confirmSignOut = true
        }, enabled = !state.busy)
        if (confirmSignOut) TvAction("Cancel", { confirmSignOut = false })
    }
    if (confirmSignOut) Text("Aurora signs this account out on all devices.", color = Color(0xFFB5B8C9), fontSize = 14.sp)
}

@Composable
private fun HomeScreen(home: HomeData?, api: AuroraClient?, onMedia: (Media) -> Unit, onRefresh: () -> Unit,
                       focusedKey: String?, onFocused: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item {
            val hero = home?.hero?.item ?: home?.recent?.firstOrNull()
            if (hero != null) {
                Box(Modifier.fillMaxWidth().height(210.dp)) {
                    AsyncImage(api?.image(hero.backdropPath, "w1280"), null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Background, Background.copy(alpha = .15f)))))
                    Column(Modifier.padding(24.dp).widthIn(max = 500.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(home?.hero?.reason?.takeIf { it.isNotBlank() } ?: "FROM YOUR LIBRARY", color = Purple, fontSize = 13.sp)
                        Title(hero.title)
                        Text(hero.overview, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Color(0xFFD2D4E0), fontSize = 14.sp)
                        val heroKey = "hero.${hero.id}"
                        val requester = remember { FocusRequester() }
                        LaunchedEffect(Unit) { if (focusedKey == heroKey) requester.requestFocus() }
                        TvAction("View title", { onMedia(hero) }, Modifier.focusRequester(requester)
                            .onFocusChanged { if (it.isFocused) onFocused(heroKey) })
                    }
                }
            } else Title("Welcome to your cinema.")
        }
        if (!home?.continuing.isNullOrEmpty()) item {
            MediaRail("Continue watching", home.continuing.map { it.media() }, api, onMedia, "continue", focusedKey, onFocused)
        }
        item { MediaRail("Recently added", home?.recent.orEmpty(), api, onMedia, "recent", focusedKey, onFocused) }
        item { TvAction("Refresh Home", onRefresh) }
    }
}

@Composable
private fun MediaRail(title: String, media: List<Media>, api: AuroraClient?, onMedia: (Media) -> Unit,
                      prefix: String, focusedKey: String?, onFocused: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, fontFamily = HeadingFont, fontSize = 21.sp)
        LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(6.dp)) {
            items(media.distinctBy { it.id }, key = { it.id }) { item ->
                MediaCard(item, api, "$prefix.${item.id}", focusedKey, onFocused) { onMedia(item) }
            }
        }
    }
}

@Composable
internal fun MediaCard(media: Media, api: AuroraClient?, focusKey: String, focusedKey: String?, onFocused: (String) -> Unit, onClick: () -> Unit) {
    val requester = remember { FocusRequester() }
    LaunchedEffect(Unit) { if (focusKey == focusedKey) requester.requestFocus() }
    Card(onClick, modifier = Modifier.focusRequester(requester).onFocusChanged { if (it.isFocused) onFocused(focusKey) }
        .width(138.dp), shape = CardDefaults.shape(RoundedCornerShape(10.dp))) {
        Column {
            AsyncImage(api?.image(media.posterPath), contentDescription = null, contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxWidth().height(180.dp).background(Color(0xFF23253A)))
            Text(media.title, Modifier.padding(10.dp), maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
        }
    }
}

@Composable
private fun MediaGrid(media: List<Media>, api: AuroraClient?, onMedia: (Media) -> Unit,
                      prefix: String, focusedKey: String?, onFocused: (String) -> Unit) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(18.dp)) {
        items(media.chunked(5)) { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) { row.forEach { item ->
                key(item.id) { MediaCard(item, api, "$prefix.${item.id}", focusedKey, onFocused) { onMedia(item) } }
            } }
        }
    }
}

@Composable
private fun SearchScreen(state: TvState, api: AuroraClient?, onSearch: (String) -> Unit, onMedia: (Media) -> Unit,
                         focusedKey: String?, onFocused: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf(state.query) }
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(query, { query = it }, label = { androidx.compose.material3.Text("Search your library") }, singleLine = true,
            modifier = Modifier.width(420.dp))
        TvAction("Search", { onSearch(query) }, enabled = !state.busy && query.isNotBlank())
    }
    MediaGrid(state.items, api, onMedia, "SEARCH", focusedKey, onFocused)
    if (!state.busy && state.query.isNotBlank() && state.items.isEmpty()) Text("No titles found. Try another search.")
}

@Composable
private fun DetailScreen(state: TvState, api: AuroraClient?, vm: TvViewModel) {
    val media = state.detail ?: return
    LazyColumn(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                AsyncImage(api?.image(media.posterPath), null, contentScale = ContentScale.Crop, modifier = Modifier.size(120.dp, 170.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Title(media.title)
                    Text(listOfNotNull(media.year?.toString(), media.contentRating.takeIf { it.isNotEmpty() },
                        media.genres.joinToString(" · ").takeIf { it.isNotEmpty() }).joinToString("   "), color = Purple, fontSize = 14.sp)
                    Text(media.overview, maxLines = 4, overflow = TextOverflow.Ellipsis, color = Color(0xFFB5B8C9), fontSize = 15.sp)
                    TvAction("Back", vm::back)
                }
            }
        }
        if (media.isShow) {
            state.suggestedEpisode?.let { next -> item {
                TvAction("Continue series · ${next.title}", { vm.episode(next) }, enabled = !state.busy)
            } }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(state.seasons, key = { it.number }) { season ->
                        TvAction(if (season.number == 0) "Specials" else "Season ${season.number}", { vm.season(season.number) }, enabled = !state.busy)
                    }
                }
            }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(state.episodes, key = { it.id }) { episode ->
                        TvAction("${episode.number}. ${episode.title}", { vm.episode(episode) }, enabled = !state.busy)
                    }
                }
            }
            state.episode?.let { episode -> item { Text("Episode ${episode.number} · ${episode.title}", fontSize = 20.sp) } }
        }
        items(state.files, key = { it.id }) { file ->
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(listOf(file.versionTag, file.resolution, file.videoCodec).filter { it.isNotEmpty() }.joinToString(" · ")
                    .ifEmpty { "Available version" }, Modifier.width(260.dp), fontSize = 14.sp)
                TvAction("Play / Resume", { vm.play(file) }, enabled = !state.busy)
                TvAction("Start over", { vm.play(file, restart = true) }, enabled = !state.busy)
            }
        }
        if (!state.busy && state.files.isEmpty() && (!media.isShow || state.episode != null)) {
            item { Text("No playable files are available for this title yet.", color = Color(0xFFB5B8C9)) }
        }
    }
}
