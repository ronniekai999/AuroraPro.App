package app.aurorapro.tv

import android.os.Bundle
import android.os.SystemClock
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.*
import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.PlayerScreen
import app.aurorapro.tv.playback.playbackClock
import app.aurorapro.tv.playback.sourceLabel
import app.aurorapro.tv.ui.*
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Keep visible hero actions in place. The TV pivot otherwise scrolls the top
// of a fully visible hero out of view when its primary button receives focus.
@OptIn(ExperimentalFoundationApi::class)
private val heroScrollSpec = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = when {
        offset < 0 -> offset
        offset + size > containerSize -> offset + size - containerSize
        else -> 0f
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AuroraTheme { AuroraApp() } }
    }
}

@Composable
fun AuroraTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(primary = AuroraColors.Purple, onPrimary = Color.White,
        background = AuroraColors.Background, surface = AuroraColors.Surface, onSurface = Color.White)) {
        androidx.compose.material3.MaterialTheme(colorScheme = androidx.compose.material3.darkColorScheme(
            primary = AuroraColors.Focus, background = AuroraColors.Background, surface = AuroraColors.Surface)) {
            CompositionLocalProvider(LocalContentColor provides Color.White, content = content)
        }
    }
}

@Composable
fun TvAction(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
             primary: Boolean = false, selected: Boolean = false) =
    AuroraAction(label, onClick, modifier, enabled, primary, selected)

@Composable
internal fun AuroraApp(vm: TvViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val screens = rememberSaveableStateHolder()
    var accountOpen by rememberSaveable(state.user?.id) { mutableStateOf(false) }
    BackHandler(enabled = state.page !in setOf(Page.SERVER, Page.HOME, Page.PLAYER) &&
        (state.page != Page.PROFILES || state.profileReturnPage != null || state.busy)) { vm.back() }
    val api = vm.client
    if (state.page == Page.PLAYER && state.target != null && api != null) {
        PlayerScreen(api, state.target!!, onClose = vm::back)
        return
    }
    Box(Modifier.fillMaxSize().auroraBackground()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 36.dp, vertical = 22.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.page !in setOf(Page.SERVER, Page.LOGIN, Page.PAIR)) Row(Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically) {
                AuroraBrand()
                Spacer(Modifier.weight(1f))
                state.profile?.let { profile ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ProfileOrb(profile, 28.dp)
                        TvAction(profile.name, { accountOpen = true }, enabled = !state.signingOut)
                    }
                }
            }
            state.error?.let { Text(it, color = Color(0xFFFFBAAE), fontSize = 13.sp) }
            if (state.busy) Text("Loading…", color = AuroraColors.Focus, fontSize = 12.sp)
            screens.SaveableStateProvider(state.page.name) {
                when (state.page) {
                    Page.SERVER -> ServerForm(state.server, state.busy, vm::connect)
                    Page.LOGIN -> LoginForm(state.server, state.busy, vm::login, vm::pair, vm::changeServer)
                    Page.PAIR -> PairScreen(state, api, vm::pair, vm::back)
                    Page.PROFILES -> ProfilesScreen(state, vm)
                    Page.DETAIL -> DetailScreen(state, api, vm)
                    else -> {
                        Navigation(state, vm)
                        when (state.page) {
                            Page.HOME -> HomeScreen(state.home, api, vm::detail, { vm.navigate(Page.HOME) },
                                vm.focusedMediaKey, { vm.focusedMediaKey = it })
                            Page.MOVIES, Page.SHOWS -> BrowseScreen(state, api, vm)
                            Page.SEARCH -> SearchScreen(state, api, vm)
                            else -> Unit
                        }
                    }
                }
            }
        }
    }
    if (accountOpen && state.profile != null) Dialog(onDismissRequest = { if (!state.signingOut) accountOpen = false }) {
        var confirm by remember { mutableStateOf(false) }
        Column(Modifier.width(380.dp).background(AuroraColors.Surface, RoundedCornerShape(20.dp)).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AuroraTitle(state.profile!!.name, size = 26)
            TvAction("Switch profile", { accountOpen = false; vm.navigate(Page.PROFILES) }, Modifier.fillMaxWidth(), !state.signingOut)
            TvAction("Change server", { accountOpen = false; vm.changeServer() }, Modifier.fillMaxWidth(), !state.signingOut)
            if (confirm) Text("Aurora signs this account out on all devices.", color = AuroraColors.Muted, fontSize = 14.sp)
            TvAction(if (confirm) "Confirm sign out" else "Sign out", {
                if (confirm) { accountOpen = false; vm.signOut() } else confirm = true
            }, Modifier.fillMaxWidth(), !state.signingOut)
            TvAction("Close", { accountOpen = false }, Modifier.fillMaxWidth(), !state.signingOut)
        }
    }
}

@Composable
private fun ServerForm(saved: String, busy: Boolean, onConnect: (String) -> Unit) {
    var address by rememberSaveable(saved) { mutableStateOf(saved) }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    fun connect() { if (!busy && address.isNotBlank()) { keyboard?.hide(); focus.clearFocus(); onConnect(address) } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 600.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            AuroraBrand(large = true)
            AuroraTitle("Your cinema, on the big screen.", size = 36)
            Text("Connect to your AuroraPro server to start watching.", color = AuroraColors.Muted)
            OutlinedTextField(address, { address = it }, label = { androidx.compose.material3.Text("Server address") },
                singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { connect() }))
            TvAction("Connect", { connect() }, enabled = !busy && address.isNotBlank(), primary = true)
        }
    }
}

@Composable
private fun LoginForm(server: String, busy: Boolean, onLogin: (String, String) -> Unit, onPair: () -> Unit, onServer: () -> Unit) {
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    val phoneFocus = remember { FocusRequester() }
    var initialFocus by remember { mutableStateOf(true) }
    val passwordFocus = remember { FocusRequester() }
    LaunchedEffect(busy) {
        if (!busy && initialFocus) { phoneFocus.requestFocus(); initialFocus = false }
    }
    fun submit() { if (!busy && username.isNotBlank() && password.isNotEmpty()) { keyboard?.hide(); onLogin(username, password); password = "" } }
    Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(36.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            AuroraBrand(large = true)
            AuroraTitle("Welcome back.", size = 42)
            Text("Your movies, your shows,\nand your people.", color = AuroraColors.Muted, fontSize = 19.sp)
            Text("Connected to " + server.removePrefix("https://").removePrefix("http://").trimEnd('/'),
                color = AuroraColors.Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Column(Modifier.weight(1f).background(AuroraColors.Surface, RoundedCornerShape(20.dp))
            .border(1.dp, Color.White.copy(alpha = .1f), RoundedCornerShape(20.dp)).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AuroraTitle("Sign in", size = 26)
            TvAction("Sign in with your phone", { keyboard?.hide(); onPair() }, Modifier.fillMaxWidth().focusRequester(phoneFocus), !busy, primary = true)
            Text("Or use your Aurora username and password", color = AuroraColors.Muted, fontSize = 12.sp)
            OutlinedTextField(username, { username = it }, label = { androidx.compose.material3.Text("Username") },
                singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }))
            OutlinedTextField(password, { password = it }, label = { androidx.compose.material3.Text("Password") },
                singleLine = true, visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth().focusRequester(passwordFocus), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvAction("Sign in", { submit() }, enabled = !busy && username.isNotBlank() && password.isNotEmpty())
                TvAction("Change server", onServer, enabled = !busy)
            }
        }
    }
}

@Composable
private fun PairScreen(state: TvState, api: AuroraClient?, onNew: () -> Unit, onBack: () -> Unit) {
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(state.pairExpiresAt) { while (true) { delay(1000); now = SystemClock.elapsedRealtime() } }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
        AuroraBrand()
        Spacer(Modifier.height(24.dp))
        AuroraTitle("Sign in with your phone")
        Spacer(Modifier.height(18.dp))
        state.grant?.let { grant ->
            val url = api?.endpoint(grant.verificationUri, mapOf("code" to grant.userCode))?.toString().orEmpty()
            val qr = remember(url) {
                val matrix = MultiFormatWriter().encode(url, BarcodeFormat.QR_CODE, 240, 240)
                android.graphics.Bitmap.createBitmap(240, 240, android.graphics.Bitmap.Config.ARGB_8888).apply {
                    setPixels(IntArray(240 * 240) { i -> if (matrix[i % 240, i / 240]) android.graphics.Color.BLACK else android.graphics.Color.WHITE },
                        0, 240, 0, 0, 240, 240)
                }.asImageBitmap()
            }
            Row(horizontalArrangement = Arrangement.spacedBy(32.dp), verticalAlignment = Alignment.CenterVertically) {
                androidx.compose.foundation.Image(qr, "Scan to open Aurora device sign-in", Modifier.size(164.dp))
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("1  Scan the QR code\n2  Sign in to AuroraPro\n3  Approve this TV", fontSize = 17.sp, color = AuroraColors.Muted)
                    Text(grant.userCode, fontFamily = AuroraHeading, fontSize = 34.sp, color = AuroraColors.Focus)
                    Text("Or open " + api?.endpoint(grant.verificationUri) + "\nand enter the code.",
                        fontSize = 12.sp, color = AuroraColors.Muted)
                    Text("Code expires in " + playbackClock((state.pairExpiresAt - now).coerceAtLeast(0)),
                        fontSize = 12.sp, color = AuroraColors.Focus)
                }
            }
        }
        state.pairMessage?.let { Text(it, fontSize = 13.sp, color = AuroraColors.Muted) }
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            TvAction("New code", onNew, enabled = !state.busy)
            TvAction("Use a password", onBack)
        }
    }
}

@Composable
private fun ProfilesScreen(state: TvState, vm: TvViewModel) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        AuroraTitle("Who's watching?", size = 36)
        Text("Choose your Aurora profile.", color = AuroraColors.Muted, modifier = Modifier.padding(top = 10.dp, bottom = 26.dp))
        LazyRow(Modifier.width((state.profiles.size * 148 + 4).coerceAtMost(800).dp).focusRestorer(),
            contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            items(state.profiles, key = { it.id }) { profile ->
                var focused by remember { mutableStateOf(false) }
                val requester = remember { FocusRequester() }
                val initial = (state.profile?.id ?: state.profiles.firstOrNull { it.isDefault }?.id ?: state.profiles.firstOrNull()?.id) == profile.id
                LaunchedEffect(state.busy) { if (initial && !state.busy) requester.requestFocus() }
                Card({ if (!state.busy) vm.selectProfile(profile) },
                    Modifier.width(128.dp).focusRequester(requester).onFocusChanged { focused = it.isFocused },
                    border = CardDefaults.border(focusedBorder = Border.None),
                    colors = CardDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent)) {
                    Column(Modifier.fillMaxWidth().padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        ProfileOrb(profile, 96.dp, focused || state.profile?.id == profile.id)
                        Text(profile.name, fontFamily = AuroraHeading, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (focused) AuroraColors.Focus else Color.White)
                        Text(if (state.profile?.id == profile.id) "Selected" else if (profile.isDefault) "Default profile" else if (profile.maxAgeRating.isNotBlank()) profile.maxAgeRating else "Profile",
                            color = AuroraColors.Muted, fontSize = 11.sp)
                    }
                }
            }
        }
        Spacer(Modifier.height(26.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.profileReturnPage != null) TvAction("Back", vm::back, enabled = !state.busy)
            TvAction("Change server", vm::changeServer, enabled = !state.busy)
        }
    }
}

@Composable
private fun Navigation(state: TvState, vm: TvViewModel) {
    Row(Modifier.fillMaxWidth().focusRestorer(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        listOf(Page.HOME to "Home", Page.MOVIES to "Movies", Page.SHOWS to "TV shows", Page.SEARCH to "Search",
            Page.PROFILES to "Profiles").forEach { (page, label) ->
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                TvAction(label, { vm.navigate(page) }, enabled = !state.signingOut, selected = state.page == page)
                Box(Modifier.padding(top = 4.dp).height(2.dp).width(24.dp)
                    .background(if (state.page == page) AuroraColors.Purple else Color.Transparent))
            }
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun HomeScreen(home: HomeData?, api: AuroraClient?, onMedia: (Media) -> Unit, onRefresh: () -> Unit,
                       focusedKey: String?, onFocused: (String) -> Unit) {
    val scroll = rememberLazyListState()
    val scope = rememberCoroutineScope()
    CompositionLocalProvider(LocalBringIntoViewSpec provides heroScrollSpec) {
      LazyColumn(Modifier.fillMaxSize(), state = scroll, verticalArrangement = Arrangement.spacedBy(24.dp)) {
        item {
            val hero = home?.hero?.item ?: home?.recent?.firstOrNull()
            if (hero != null) {
                Box(Modifier.fillMaxWidth().height(300.dp).clip(RoundedCornerShape(18.dp))) {
                    AuroraArtwork(api?.image(hero.backdropPath.ifBlank { hero.posterPath }, "w1280"), Modifier.fillMaxSize())
                    Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(AuroraColors.Background,
                        AuroraColors.Background.copy(alpha = .7f), Color.Transparent))))
                    Column(Modifier.padding(26.dp).widthIn(max = 480.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(home?.hero?.reason?.takeIf { it.isNotBlank() } ?: "FROM YOUR LIBRARY",
                            color = AuroraColors.Focus, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        AuroraTitle(hero.title)
                        Text(hero.overview, maxLines = 2, overflow = TextOverflow.Ellipsis, color = AuroraColors.Muted, fontSize = 14.sp)
                        val heroKey = "hero." + hero.id
                        val requester = remember { FocusRequester() }
                        LaunchedEffect(Unit) { if (focusedKey == heroKey) requester.requestFocus() }
                        TvAction("View title", { onMedia(hero) }, Modifier.focusRequester(requester).onFocusChanged {
                            if (it.isFocused) { onFocused(heroKey); scope.launch { scroll.animateScrollToItem(0) } }
                        }, primary = true)
                    }
                }
            } else AuroraTitle("Welcome to your cinema.")
        }
        if (!home?.continuing.isNullOrEmpty()) item {
            MediaRail("Continue watching", home!!.continuing.map { it.media() }, api, onMedia, "continue", focusedKey, onFocused)
        }
        item { MediaRail("Recently added", home?.recent.orEmpty(), api, onMedia, "recent", focusedKey, onFocused) }
        item { TvAction("Refresh Home", onRefresh) }
      }
    }
}

@Composable
private fun MediaRail(title: String, media: List<Media>, api: AuroraClient?, onMedia: (Media) -> Unit,
                      prefix: String, focusedKey: String?, onFocused: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        AuroraTitle(title, size = 22)
        LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(8.dp)) {
            items(media.distinctBy { it.id }, key = { it.id }) { item ->
                MediaCard(item, api, "$prefix." + item.id, focusedKey, onFocused) { onMedia(item) }
            }
        }
    }
}

@Composable
internal fun MediaCard(media: Media, api: AuroraClient?, focusKey: String, focusedKey: String?, onFocused: (String) -> Unit, onClick: () -> Unit) {
    val requester = remember { FocusRequester() }
    LaunchedEffect(focusKey) { if (focusKey == focusedKey) requester.requestFocus() }
    Card(onClick, Modifier.focusRequester(requester).onFocusChanged { if (it.isFocused) onFocused(focusKey) }.width(138.dp),
        shape = CardDefaults.shape(RoundedCornerShape(10.dp)),
        colors = CardDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = AuroraColors.Raised)) {
        Column {
            Box {
                AuroraArtwork(api?.image(media.posterPath), Modifier.fillMaxWidth().height(207.dp).clip(RoundedCornerShape(10.dp)))
                WatchProgress(media.userProgress, Modifier.align(Alignment.BottomCenter))
            }
            Text(media.title, Modifier.padding(horizontal = 6.dp, vertical = 8.dp).height(38.dp),
                maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 13.sp)
        }
    }
}

@Composable
private fun MediaGrid(media: List<Media>, api: AuroraClient?, onMedia: (Media) -> Unit,
                      prefix: String, focusedKey: String?, onFocused: (String) -> Unit, footer: (@Composable () -> Unit)? = null) {
    val scroll = rememberLazyGridState()
    LazyVerticalGrid(GridCells.Adaptive(138.dp), Modifier.fillMaxSize().focusRestorer(), state = scroll,
        contentPadding = PaddingValues(8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        items(media.distinctBy { it.id }, key = { it.id }) { item ->
            MediaCard(item, api, "$prefix." + item.id, focusedKey, onFocused) { onMedia(item) }
        }
        if (footer != null) item(span = { GridItemSpan(maxLineSpan) }) { footer() }
    }
}

@Composable
private fun BrowseScreen(state: TvState, api: AuroraClient?, vm: TvViewModel) {
    var picker by remember { mutableStateOf<String?>(null) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        AuroraTitle(if (state.page == Page.MOVIES) "Movies" else "TV shows", size = 28)
        Spacer(Modifier.weight(1f))
        Text(if (state.browseTotal > 0) "${state.items.size} of ${state.browseTotal}" else "${state.items.size} titles",
            fontSize = 12.sp, color = AuroraColors.Muted)
        TvAction("Sort: " + sortName(state.browseSort), { picker = "sort" }, enabled = !state.busy)
        TvAction("Genre: " + state.browseGenre.ifBlank { "All" }, { picker = "genre" }, enabled = !state.busy)
    }
    MediaGrid(state.items, api, vm::detail, state.page.name, vm.focusedMediaKey, { vm.focusedMediaKey = it }) {
        when {
            state.busy -> Text("Loading titles…", color = AuroraColors.Muted)
            state.items.isEmpty() -> Text("No titles match these filters.", color = AuroraColors.Muted)
            state.browsePage < state.browsePages -> TvAction("Load more titles", vm::loadMore, primary = true)
            else -> Text("You're all caught up.", color = AuroraColors.Muted, fontSize = 12.sp)
        }
    }
    picker?.let { kind ->
        val options = if (kind == "sort") listOf("added" to "Recently added", "title" to "Title A–Z", "year" to "Newest year", "rating" to "Rating")
            else listOf("" to "All genres") + state.genres.map { it to it }
        ChoiceDialog(if (kind == "sort") "Sort titles" else "Choose a genre", options,
            if (kind == "sort") state.browseSort else state.browseGenre, { choice ->
                picker = null
                if (kind == "sort") vm.browseFilter(sort = choice) else vm.browseFilter(genre = choice)
            }, { picker = null })
    }
}

private fun sortName(sort: String) = when (sort) { "title" -> "A–Z"; "year" -> "Year"; "rating" -> "Rating"; else -> "Recent" }

@Composable
internal fun ChoiceDialog(title: String, choices: List<Pair<String, String>>, selected: String?,
                          onSelect: (String) -> Unit, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose) {
        Column(Modifier.width(480.dp).heightIn(max = 390.dp).background(AuroraColors.Surface, RoundedCornerShape(20.dp)).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AuroraTitle(title, size = 24)
            LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(choices, key = { it.first }) { (key, label) ->
                    TvAction((if (selected == key) "✓  " else "") + label, { onSelect(key) }, Modifier.fillMaxWidth(), selected = selected == key)
                }
            }
            TvAction("Close", onClose)
        }
    }
}

@Composable
private fun SearchScreen(state: TvState, api: AuroraClient?, vm: TvViewModel) {
    val query = state.query
    val results = state.items.filter { state.searchKind == "all" || it.type == state.searchKind }
    val context = LocalContext.current
    val voiceIntent = remember(state.profile?.language) {
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_LANGUAGE, state.profile?.language ?: "en")
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Search AuroraPro")
    }
    val voiceAvailable = remember(context) { voiceIntent.resolveActivity(context.packageManager) != null }
    var voiceMessage by remember { mutableStateOf<String?>(null) }
    val voiceSearch = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()?.takeIf { it.isNotBlank() }?.let { vm.search(it, immediate = true) }
    }
    AuroraTitle("Find your next watch", size = 28)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(query, { vm.search(it) }, label = { androidx.compose.material3.Text("Search movies and TV shows") },
            singleLine = true, modifier = Modifier.weight(1f), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { vm.search(query, immediate = true) }))
        TvAction("Search", { vm.search(query, immediate = true) }, enabled = query.isNotBlank(), primary = true)
        if (voiceAvailable) TvAction("Voice search", {
            voiceMessage = null
            try { voiceSearch.launch(voiceIntent) }
            catch (_: ActivityNotFoundException) { voiceMessage = "Voice search is unavailable. Use the search field." }
        })
    }
    voiceMessage?.let { Text(it, color = AuroraColors.Muted, fontSize = 12.sp) }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        listOf("all" to "All", "movie" to "Movies", "show" to "TV shows").forEach { (kind, label) ->
            TvAction(label, { vm.searchKind(kind) }, selected = state.searchKind == kind)
        }
        val count = results.size
        Text(if (state.busy) "Searching…" else if (query.isBlank()) "Search your Aurora library" else "$count results",
            fontSize = 12.sp, color = AuroraColors.Muted)
    }
    MediaGrid(results, api, vm::detail,
        "SEARCH", vm.focusedMediaKey, { vm.focusedMediaKey = it }) {
        if (!state.busy && results.isEmpty()) Text(if (query.isBlank()) "Type a title or genre to start."
            else "No titles found. Try another search.", color = AuroraColors.Muted)
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun DetailScreen(state: TvState, api: AuroraClient?, vm: TvViewModel) {
    val media = state.detail ?: return
    var versionId by rememberSaveable(media.id, state.episode?.id) { mutableStateOf<Long?>(null) }
    var showVersions by remember { mutableStateOf(false) }
    val file = state.files.firstOrNull { it.id == versionId } ?: state.files.firstOrNull()
    val scroll = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val episodePlayFocus = remember { FocusRequester() }
    var pendingEpisodeFocus by remember { mutableStateOf<Long?>(null) }
    var detailFocusKey by rememberSaveable(media.id) { mutableStateOf("") }
    var restoreFocus by remember(media.id) { mutableStateOf(true) }
    @Composable fun restoreModifier(key: String, initial: Boolean = false): Modifier {
        val requester = remember(key) { FocusRequester() }
        LaunchedEffect(state.busy) {
            if (!state.busy && restoreFocus && (detailFocusKey == key || (detailFocusKey.isEmpty() && initial))) {
                requester.requestFocus()
                restoreFocus = false
            }
        }
        return Modifier.focusRequester(requester).onFocusChanged { if (it.isFocused) {
            detailFocusKey = key
            if (key in setOf("play", "continue", "start", "back")) scope.launch { scroll.animateScrollToItem(0) }
        } }
    }
    LaunchedEffect(Unit) {
        if (detailFocusKey == "episode-play" && file != null && !state.busy) {
            episodePlayFocus.requestFocus()
            restoreFocus = false
        }
    }
    LaunchedEffect(state.episode?.id, state.busy, state.files) {
        if (!state.busy && file != null && pendingEpisodeFocus == state.episode?.id && pendingEpisodeFocus != null) {
            scroll.animateScrollToItem(if (state.suggestedEpisode != null) 4 else 3)
            episodePlayFocus.requestFocus()
            pendingEpisodeFocus = null
        }
    }
    CompositionLocalProvider(LocalBringIntoViewSpec provides heroScrollSpec) {
      LazyColumn(Modifier.fillMaxSize(), state = scroll, verticalArrangement = Arrangement.spacedBy(20.dp)) {
        item {
            Box(Modifier.fillMaxWidth().height(310.dp).clip(RoundedCornerShape(18.dp))) {
                AuroraArtwork(api?.image(media.backdropPath.ifBlank { media.posterPath }, "w1280"), Modifier.fillMaxSize())
                Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(AuroraColors.Background,
                    AuroraColors.Background.copy(alpha = .78f), Color.Transparent))))
                Column(Modifier.padding(24.dp).widthIn(max = 600.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(if (media.isShow) "SERIES" else "MOVIE", color = AuroraColors.Focus, fontSize = 11.sp)
                    AuroraTitle(media.title, size = 34)
                    Text(listOfNotNull(media.year?.toString(), media.contentRating.takeIf { it.isNotBlank() },
                        media.runtimeMinutes.takeIf { it > 0 }?.let { "$it min" }, media.genres.take(2).joinToString(" · ").takeIf { it.isNotBlank() })
                        .joinToString("  ·  "), color = AuroraColors.Muted, fontSize = 13.sp)
                    Text(media.overview, maxLines = 2, overflow = TextOverflow.Ellipsis, color = AuroraColors.Muted, fontSize = 14.sp)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(4.dp)) {
                        if (file != null) item {
                            TvAction(if (media.isShow) "Play / Resume episode" else "Play / Resume", { vm.play(file) }, restoreModifier("play", initial = true), enabled = !state.busy, primary = true)
                        } else if (media.isShow && state.suggestedEpisode != null) item {
                            TvAction("Continue series", vm::continueSeries, restoreModifier("continue", initial = true), enabled = !state.busy, primary = true)
                        }
                        if (file != null) item { TvAction("Start over", { vm.play(file, restart = true) }, restoreModifier("start"), enabled = !state.busy) }
                        item { TvAction("Back", vm::back, restoreModifier("back", initial = file == null && state.suggestedEpisode == null)) }
                    }
                }
            }
        }
        if (media.isShow) {
            state.suggestedEpisode?.let { next -> item {
                Text("Up next · " + episodeName(next, episodeSeason(next, state.seasons)), color = AuroraColors.Focus, fontSize = 14.sp)
            } }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(6.dp)) {
                    items(state.seasons, key = { it.number }) { season ->
                        TvAction(if (season.number == 0) "Specials" else "Season ${season.number}", { vm.season(season.number) },
                            restoreModifier("season.${season.number}"),
                            enabled = !state.busy, selected = state.season == season.number)
                    }
                }
            }
            item {
                LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(8.dp)) {
                    items(state.episodes, key = { it.id }) { episode ->
                        Card({ if (!state.busy) { pendingEpisodeFocus = episode.id; vm.episode(episode) } }, restoreModifier("episode.${episode.id}").width(230.dp),
                            colors = CardDefaults.colors(containerColor = AuroraColors.Surface, focusedContainerColor = AuroraColors.Raised)) {
                            Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Box {
                                    AuroraArtwork(api?.image(episode.stillPath, "w500"), Modifier.fillMaxWidth().height(120.dp).clip(RoundedCornerShape(10.dp)))
                                    WatchProgress(episode.progress, Modifier.align(Alignment.BottomCenter))
                                }
                                Text(episodeName(episode, state.season), fontFamily = AuroraHeading, fontSize = 15.sp,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis, color = if (episode.id == state.episode?.id) AuroraColors.Focus else Color.White)
                                Text(listOfNotNull(episode.runtimeMinutes.takeIf { it > 0 }?.let { "$it min" },
                                    if (episode.progress?.completed == true) "Watched" else null).joinToString(" · ").ifBlank { "Episode ${episode.number}" },
                                    color = AuroraColors.Muted, fontSize = 11.sp)
                                Text(episode.overview.ifBlank { "Select this episode to choose a version and play." }, maxLines = 2,
                                    overflow = TextOverflow.Ellipsis, color = AuroraColors.Muted, fontSize = 12.sp, modifier = Modifier.height(36.dp))
                            }
                        }
                    }
                }
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                state.episode?.let { AuroraTitle(episodeName(it, state.season), size = 24) }
                file?.let {
                    Text("Source · " + sourceLabel(it), color = AuroraColors.Muted, fontSize = 13.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (state.files.size > 1) TvAction("Choose version", { showVersions = true }, restoreModifier("versions"))
                        if (media.isShow) {
                            TvAction("Play / Resume", { vm.play(it) }, Modifier.focusRequester(episodePlayFocus)
                                .onFocusChanged { if (it.isFocused) detailFocusKey = "episode-play" }, enabled = !state.busy, primary = true)
                            TvAction("Start over", { vm.play(it, restart = true) }, restoreModifier("episode-start"), enabled = !state.busy)
                        }
                    }
                }
                if (!state.busy && file == null && (!media.isShow || state.episode != null))
                    Text("No playable version is available yet.", color = AuroraColors.Muted)
            }
        }
      }
    }
    if (showVersions) ChoiceDialog("Choose a version", state.files.map { it.id.toString() to sourceLabel(it) },
        file?.id?.toString(), { versionId = it.toLong(); showVersions = false }, { showVersions = false })
}

internal fun episodeName(episode: Episode, season: Int?): String =
    (if (season != null) "S$season · E${episode.number}" else "Episode ${episode.number}") +
        episode.title.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
