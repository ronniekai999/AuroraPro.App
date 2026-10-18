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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.tv.material3.*
import app.aurorapro.tv.data.*
import app.aurorapro.tv.playback.PlayerScreen
import app.aurorapro.tv.playback.playbackClock
import app.aurorapro.tv.playback.sourceBadges
import app.aurorapro.tv.playback.sourceLabel
import app.aurorapro.tv.ui.*
import app.aurorapro.tv.ui.AuroraLayout.Gutter
import app.aurorapro.tv.ui.AuroraLayout.TopBar
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Keep visible hero actions in place. The TV pivot otherwise scrolls the top
// of a fully visible hero out of view when its primary button receives focus.
// Items brought in from below stop an overscan margin above the screen edge.
@OptIn(ExperimentalFoundationApi::class)
private fun heroScrollSpec(endMargin: Float) = object : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = when {
        offset < 0 -> offset
        offset + size > containerSize - endMargin -> offset + size - (containerSize - endMargin)
        else -> 0f
    }
}

@Composable
private fun rememberHeroScrollSpec(): BringIntoViewSpec {
    val density = androidx.compose.ui.platform.LocalDensity.current
    return remember(density) { heroScrollSpec(with(density) { 27.dp.toPx() }) }
}

private val HeroHeight = 292.dp
private val CardShape = RoundedCornerShape(12.dp)

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
             primary: Boolean = false, selected: Boolean = false, icon: ImageVector? = null) =
    AuroraAction(label, onClick, modifier, enabled, primary, selected, icon)

@Composable
internal fun AuroraApp(vm: TvViewModel = viewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val screens = rememberSaveableStateHolder()
    var accountOpen by rememberSaveable(state.user?.id) { mutableStateOf(false) }
    BackHandler(enabled = state.page !in setOf(Page.SERVER, Page.HOME, Page.PLAYER) &&
        (state.page != Page.PROFILES || state.profileReturnPage != null || state.busy || state.pinPrompt != null)) { vm.back() }
    val api = vm.client
    if (state.page == Page.PLAYER && state.target != null && api != null) {
        val target = state.target!!
        PlayerScreen(api, target, state.continuation, state.continuationLoading, state.continuationError,
            onRetryContinuation = vm::retryContinuation, onAdvance = { vm.advanceEpisode(target, it) }, onClose = vm::playbackClosed)
        return
    }
    Box(Modifier.fillMaxSize().auroraBackground()) {
        // Composed first so remote focus enters the chrome before the page, as it did
        // when the chrome sat above the content; drawn last so it overlays full-bleed art.
        val chrome = state.page !in setOf(Page.SERVER, Page.LOGIN, Page.PAIR)
        if (chrome) TopBar(state, vm, { accountOpen = true }, Modifier.zIndex(1f))
        // An error takes its own space below the page, so it can never cover a focused control.
        Column(Modifier.fillMaxSize()) {
          Box(Modifier.weight(1f).fillMaxWidth()) {
            screens.SaveableStateProvider(state.page.name) {
              when (state.page) {
                Page.SERVER -> ServerForm(state.server, state.busy, vm::connect)
                Page.LOGIN -> LoginForm(state.server, state.busy, vm::login, vm::pair, vm::changeServer)
                Page.PAIR -> PairScreen(state, api, vm::pair, vm::back)
                Page.PROFILES -> ProfilesScreen(state, vm)
                Page.DETAIL -> DetailScreen(state, api, vm)
                Page.HOME -> HomeScreen(state.home, api, vm::detail, { vm.navigate(Page.HOME) },
                    vm.focusedMediaKey, { vm.focusedMediaKey = it })
                Page.MOVIES, Page.SHOWS -> BrowseScreen(state, api, vm)
                Page.SEARCH -> SearchScreen(state, api, vm)
                else -> Unit
              }
            }
          }
          state.error?.let { ErrorBanner(it) }
        }
        // Signed-in pages show loading in the top bar; the sign-in pages keep this corner empty.
        if (state.busy && !chrome) Text("Loading…", Modifier.align(Alignment.TopEnd).padding(top = 28.dp, end = Gutter),
            color = AuroraColors.Focus, fontSize = 14.sp)
    }
    if (accountOpen && state.profile != null) Dialog(onDismissRequest = { if (!state.signingOut) accountOpen = false }) {
        var confirm by remember { mutableStateOf(false) }
        Column(Modifier.width(400.dp).background(AuroraColors.Surface, RoundedCornerShape(24.dp))
            .border(1.dp, AuroraColors.GlassBorder, RoundedCornerShape(24.dp)).padding(28.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                ProfileOrb(state.profile!!, 52.dp)
                Column {
                    AuroraTitle(state.profile!!.name, size = 26)
                    state.user?.let { Text("Signed in as ${it.username}", color = AuroraColors.Muted, fontSize = 13.sp) }
                }
            }
            // Administration is a web-only scope exception (docs/android-tv-plan.md); say where it lives.
            if (state.user?.role == "admin") Text("Manage this server from the Aurora web app at " +
                (api?.endpoint("/v2/admin")?.toString() ?: "/v2/admin") + ".", color = AuroraColors.Muted, fontSize = 13.sp)
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
private fun TopBar(state: TvState, vm: TvViewModel, onAccount: () -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(TopBar).padding(horizontal = Gutter), verticalAlignment = Alignment.CenterVertically) {
        AuroraBrand()
        if (state.page in setOf(Page.HOME, Page.MOVIES, Page.SHOWS, Page.SEARCH)) {
            Spacer(Modifier.width(36.dp))
            Row(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(Triple(Page.HOME, "Home", AuroraIcons.Home), Triple(Page.MOVIES, "Movies", AuroraIcons.Movies),
                    Triple(Page.SHOWS, "TV shows", AuroraIcons.Shows), Triple(Page.SEARCH, "Search", AuroraIcons.Search))
                    .forEach { (page, label, icon) ->
                        TvAction(label, { vm.navigate(page) }, enabled = !state.signingOut, selected = state.page == page, icon = icon)
                    }
            }
        }
        // Loading takes only leftover space, so it never squeezes the navigation or profile.
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            if (state.busy) Text("Loading…", Modifier.padding(horizontal = 12.dp), color = AuroraColors.Focus, fontSize = 13.sp,
                maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
        }
        state.profile?.let { profile ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ProfileOrb(profile, 34.dp)
                TvAction(profile.name, onAccount, Modifier.widthIn(max = 200.dp), enabled = !state.signingOut)
            }
        }
    }
}

@Composable
private fun ErrorBanner(error: String) {
    Box(Modifier.fillMaxWidth().padding(start = Gutter, end = Gutter, top = 8.dp, bottom = 24.dp), contentAlignment = Alignment.Center) {
        Text(error, Modifier.background(Color(0xF0241418), RoundedCornerShape(16.dp))
            .border(1.dp, AuroraColors.Error.copy(alpha = .35f), RoundedCornerShape(16.dp))
            .padding(horizontal = 20.dp, vertical = 12.dp), color = AuroraColors.Error, fontSize = 14.sp)
    }
}

@Composable
private fun auroraFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = AuroraColors.Focus, unfocusedBorderColor = AuroraColors.GlassBorder,
    focusedContainerColor = Color.White.copy(alpha = .06f), unfocusedContainerColor = Color.White.copy(alpha = .04f),
    focusedLabelColor = AuroraColors.Focus, unfocusedLabelColor = AuroraColors.Muted, cursorColor = AuroraColors.Focus,
    focusedTextColor = Color.White, unfocusedTextColor = Color.White)

private val FieldShape = RoundedCornerShape(14.dp)

/** Glass card used by the sign-in screens. */
@Composable
private fun GlassPanel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.background(Brush.verticalGradient(listOf(Color(0xE61C1828), Color(0xE60E0C16))), RoundedCornerShape(24.dp))
        .border(1.dp, AuroraColors.GlassBorder, RoundedCornerShape(24.dp)).padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp), content = content)
}

@Composable
private fun ServerForm(saved: String, busy: Boolean, onConnect: (String) -> Unit) {
    var address by rememberSaveable(saved) { mutableStateOf(saved) }
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    fun connect() { if (!busy && address.isNotBlank()) { keyboard?.hide(); focus.clearFocus(); onConnect(address) } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 620.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            AuroraBrand(large = true)
            AuroraTitle("Your cinema, on the big screen.", size = 40)
            Text("Connect to your AuroraPro server to start watching.", color = AuroraColors.Muted, fontSize = 17.sp)
            GlassPanel(Modifier.fillMaxWidth()) {
                OutlinedTextField(address, { address = it }, label = { androidx.compose.material3.Text("Server address") },
                    singleLine = true, modifier = Modifier.fillMaxWidth(), shape = FieldShape, colors = auroraFieldColors(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go), keyboardActions = KeyboardActions(onGo = { connect() }))
                Text("For example https://media.example.com or http://192.168.1.20:8080", color = AuroraColors.Muted, fontSize = 13.sp)
                TvAction("Connect", { connect() }, enabled = !busy && address.isNotBlank(), primary = true, icon = AuroraIcons.Forward)
            }
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
    Row(Modifier.fillMaxSize().padding(horizontal = 64.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(56.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            AuroraBrand(large = true)
            AuroraTitle("Welcome back.", size = 52)
            Text("Your movies, your shows,\nand your people.", color = AuroraColors.Muted, fontSize = 20.sp, lineHeight = 28.sp)
            Text("Connected to " + server.removePrefix("https://").removePrefix("http://").trimEnd('/'),
                color = AuroraColors.Muted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        GlassPanel(Modifier.weight(1f)) {
            AuroraTitle("Sign in", size = 28)
            TvAction("Sign in with your phone", { keyboard?.hide(); onPair() }, Modifier.fillMaxWidth().focusRequester(phoneFocus), !busy,
                primary = true, icon = AuroraIcons.Phone)
            Text("Or use your Aurora username and password", color = AuroraColors.Muted, fontSize = 13.sp)
            OutlinedTextField(username, { username = it }, label = { androidx.compose.material3.Text("Username") },
                singleLine = true, modifier = Modifier.fillMaxWidth(), shape = FieldShape, colors = auroraFieldColors(),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }))
            OutlinedTextField(password, { password = it }, label = { androidx.compose.material3.Text("Password") },
                singleLine = true, visualTransformation = PasswordVisualTransformation(), shape = FieldShape, colors = auroraFieldColors(),
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
    Row(Modifier.fillMaxSize().padding(horizontal = 64.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(56.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            AuroraBrand()
            AuroraTitle("Sign in with your phone", size = 40)
            state.grant?.let { grant ->
                listOf("Scan the QR code", "Sign in to AuroraPro", "Approve this TV").forEachIndexed { i, step ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Box(Modifier.size(30.dp).background(AuroraColors.Primary.copy(alpha = .35f), CircleShape)
                            .border(1.dp, AuroraColors.Focus.copy(alpha = .6f), CircleShape), contentAlignment = Alignment.Center) {
                            Text("${i + 1}", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = AuroraColors.Focus)
                        }
                        Text(step, fontSize = 18.sp, color = Color.White.copy(alpha = .9f))
                    }
                }
                Text("Or open " + api?.endpoint(grant.verificationUri) + "\nand enter the code.",
                    fontSize = 13.sp, color = AuroraColors.Muted, lineHeight = 19.sp)
            }
            state.pairMessage?.let { Text(it, fontSize = 13.sp, color = AuroraColors.Muted) }
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                TvAction("New code", onNew, enabled = !state.busy, icon = AuroraIcons.Restart)
                TvAction("Use a password", onBack)
            }
        }
        state.grant?.let { grant ->
            val url = api?.endpoint(grant.verificationUri, mapOf("code" to grant.userCode))?.toString().orEmpty()
            val qr = remember(url) {
                val matrix = MultiFormatWriter().encode(url, BarcodeFormat.QR_CODE, 240, 240)
                android.graphics.Bitmap.createBitmap(240, 240, android.graphics.Bitmap.Config.ARGB_8888).apply {
                    setPixels(IntArray(240 * 240) { i -> if (matrix[i % 240, i / 240]) android.graphics.Color.BLACK else android.graphics.Color.WHITE },
                        0, 240, 0, 0, 240, 240)
                }.asImageBitmap()
            }
            GlassPanel(Modifier.width(340.dp)) {
                Box(Modifier.fillMaxWidth().aspectRatio(1f).background(Color.White, RoundedCornerShape(18.dp)).padding(10.dp)) {
                    androidx.compose.foundation.Image(qr, "Scan to open Aurora device sign-in", Modifier.fillMaxSize())
                }
                Text(grant.userCode, Modifier.align(Alignment.CenterHorizontally), fontFamily = AuroraHeading,
                    fontWeight = FontWeight.Bold, fontSize = 36.sp, letterSpacing = 3.sp, color = AuroraColors.Focus)
                Text("Code expires in " + playbackClock((state.pairExpiresAt - now).coerceAtLeast(0)),
                    Modifier.align(Alignment.CenterHorizontally), fontSize = 13.sp, color = AuroraColors.Muted)
            }
        }
    }
}

@Composable
private fun ProfilesScreen(state: TvState, vm: TvViewModel) {
    state.pinPrompt?.let { locked -> ProfileUnlockPanel(locked, state, vm); return }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text("Who's watching?", fontFamily = AuroraHeading, fontWeight = FontWeight.Bold, fontSize = 44.sp,
            style = TextStyle(brush = Brush.horizontalGradient(listOf(Color.White, AuroraColors.Focus))))
        Text("Choose your Aurora profile.", color = AuroraColors.Muted, fontSize = 17.sp, modifier = Modifier.padding(top = 10.dp, bottom = 22.dp))
        LazyRow(Modifier.width((state.profiles.size * 172 + 24).coerceAtMost(860).dp).focusRestorer(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 20.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            items(state.profiles, key = { it.id }) { profile ->
                var focused by remember { mutableStateOf(false) }
                val requester = remember { FocusRequester() }
                val initial = (state.profile?.id ?: state.profiles.firstOrNull { it.isDefault }?.id ?: state.profiles.firstOrNull()?.id) == profile.id
                LaunchedEffect(state.busy) { if (initial && !state.busy) requester.requestFocus() }
                Card({ if (!state.busy) vm.selectProfile(profile) },
                    Modifier.width(148.dp).focusRequester(requester).onFocusChanged { focused = it.isFocused },
                    scale = CardDefaults.scale(focusedScale = 1.08f),
                    border = CardDefaults.border(focusedBorder = Border.None),
                    glow = CardDefaults.glow(),
                    colors = CardDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent)) {
                    Column(Modifier.fillMaxWidth().padding(10.dp), horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        ProfileOrb(profile, 116.dp, focused || state.profile?.id == profile.id)
                        Text(profile.name, fontFamily = AuroraHeading, fontWeight = FontWeight.SemiBold, fontSize = 19.sp, maxLines = 1,
                            overflow = TextOverflow.Ellipsis, color = if (focused) Color.White else Color.White.copy(alpha = .82f))
                        Text(if (state.profile?.id == profile.id) "Selected" else if (profile.hasPin) "Locked" else if (profile.isDefault) "Default profile" else if (profile.maxAgeRating.isNotBlank()) profile.maxAgeRating else "Profile",
                            color = if (focused) AuroraColors.Focus else AuroraColors.Muted, fontSize = 12.sp)
                    }
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.profileReturnPage != null) TvAction("Back", vm::back, enabled = !state.busy, icon = AuroraIcons.Back)
            TvAction("Change server", vm::changeServer, enabled = !state.busy)
        }
    }
}

// The PIN prompt for a locked profile. The server checks the PIN; a refusal
// comes back as state.pinError. The account password stands in for a
// forgotten PIN.
@Composable
private fun ProfileUnlockPanel(profile: Profile, state: TvState, vm: TvViewModel) {
    var usePassword by remember(profile.id) { mutableStateOf(false) }
    var secret by remember(profile.id, usePassword) { mutableStateOf("") }
    val field = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    // A refused attempt clears the field for the next one.
    LaunchedEffect(state.pinError) { if (state.pinError != null) secret = "" }
    LaunchedEffect(profile.id, usePassword) { field.requestFocus() }
    // The field is disabled while an attempt is checked, which drops focus;
    // give it back once the answer is in.
    LaunchedEffect(state.busy) { if (!state.busy) field.requestFocus() }
    val ready = if (usePassword) secret.isNotEmpty() else secret.length == 4
    val submit = { if (ready && !state.busy) { keyboard?.hide(); vm.submitUnlock(secret, usePassword) } }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        GlassPanel(Modifier.width(460.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                ProfileOrb(profile, 72.dp, true)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    AuroraTitle("${profile.name} is locked", size = 26)
                    Text(if (usePassword) "Enter the account password." else "Enter this profile's 4-digit PIN.",
                        color = AuroraColors.Muted, fontSize = 14.sp)
                }
            }
            OutlinedTextField(secret, { typed -> secret = if (usePassword) typed else typed.filter(Char::isDigit).take(4) },
                label = { androidx.compose.material3.Text(if (usePassword) "Account password" else "PIN") },
                singleLine = true, visualTransformation = PasswordVisualTransformation(), shape = FieldShape, colors = auroraFieldColors(),
                modifier = Modifier.fillMaxWidth().focusRequester(field), enabled = !state.busy,
                keyboardOptions = KeyboardOptions(keyboardType = if (usePassword) KeyboardType.Password else KeyboardType.NumberPassword,
                    imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }))
            state.pinError?.let { Text(it, color = Color(0xFFFCA5A5), fontSize = 14.sp) }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TvAction(if (state.busy) "Checking…" else "Unlock", { submit() }, enabled = ready && !state.busy, primary = true)
                TvAction("Cancel", vm::cancelUnlock, enabled = !state.busy)
            }
            TvAction(if (usePassword) "Use the PIN instead" else "Forgot the PIN? Use the account password",
                { usePassword = !usePassword }, Modifier.fillMaxWidth(), enabled = !state.busy)
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun HomeScreen(home: HomeData?, api: AuroraClient?, onMedia: (Media) -> Unit, onRefresh: () -> Unit,
                       focusedKey: String?, onFocused: (String) -> Unit) {
    val scroll = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val hero = home?.hero?.item ?: home?.recent?.firstOrNull()
    val scrolled by remember { derivedStateOf { scroll.firstVisibleItemIndex > 0 || scroll.firstVisibleItemScrollOffset > 48 } }
    Box(Modifier.fillMaxSize()) {
        AuroraBackdrop(hero?.let { api?.image(it.backdropPath.ifBlank { it.posterPath }, "w1280") }, dimmed = scrolled)
        CompositionLocalProvider(LocalBringIntoViewSpec provides rememberHeroScrollSpec()) {
          LazyColumn(Modifier.fillMaxSize().padding(top = TopBar), state = scroll,
              contentPadding = PaddingValues(bottom = 36.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Column(Modifier.fillMaxWidth().heightIn(min = HeroHeight).padding(horizontal = Gutter, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.Bottom)) {
                    if (hero != null) {
                        val match = home?.hero?.takeIf { it.item.id == hero.id }?.match?.takeIf { it > 0 }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(AuroraIcons.Sparkle, null, Modifier.size(14.dp), tint = AuroraColors.Focus)
                            Text(home?.hero?.reason?.takeIf { it.isNotBlank() } ?: "FROM YOUR LIBRARY",
                                color = AuroraColors.Focus, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        AuroraTitle(hero.title, Modifier.widthIn(max = 620.dp), size = 50)
                        MetaLine(listOf(hero.year?.toString().orEmpty(), runtimeLabel(hero.runtimeMinutes), hero.genres.take(2).joinToString(" · ")),
                            Modifier.widthIn(max = 620.dp), badges = listOfNotNull(hero.contentRating.takeIf { it.isNotBlank() }),
                            leading = if (match != null) { { MatchBadge(match) } } else null)
                        Text(hero.overview, Modifier.widthIn(max = 560.dp), maxLines = 2, overflow = TextOverflow.Ellipsis,
                            color = Color.White.copy(alpha = .8f), fontSize = 16.sp, lineHeight = 23.sp)
                        val heroKey = "hero." + hero.id
                        val requester = remember { FocusRequester() }
                        LaunchedEffect(Unit) { if (focusedKey == heroKey) requester.requestFocus() }
                        TvAction("View title", { onMedia(hero) }, Modifier.padding(top = 4.dp).focusRequester(requester).onFocusChanged {
                            if (it.isFocused) { onFocused(heroKey); scope.launch { scroll.animateScrollToItem(0) } }
                        }, primary = true)
                    } else {
                        AuroraTitle("Welcome to your cinema.", size = 44)
                        if (home != null) Text("Nothing here yet. New titles appear here once Aurora adds them to your libraries.",
                            color = AuroraColors.Muted, fontSize = 16.sp)
                    }
                }
            }
            if (!home?.continuing.isNullOrEmpty()) item {
                Rail("Continue watching") {
                    items(home!!.continuing.distinctBy { it.mediaId }, key = { it.mediaId }) { item ->
                        ContinueCard(item, api, "continue." + item.mediaId, focusedKey, onFocused) { onMedia(item.media()) }
                    }
                }
            }
            item {
                Rail("Recently added") {
                    items(home?.recent.orEmpty().distinctBy { it.id }, key = { it.id }) { item ->
                        MediaCard(item, api, "recent." + item.id, focusedKey, onFocused) { onMedia(item) }
                    }
                }
            }
            item { TvAction("Refresh Home", onRefresh, Modifier.padding(start = Gutter, top = 8.dp), icon = AuroraIcons.Restart) }
          }
        }
    }
}

@Composable
private fun Rail(title: String, content: LazyListScope.() -> Unit) {
    Column {
        AuroraSectionTitle(title, Modifier.padding(horizontal = Gutter))
        // Vertical padding leaves room for the focused card's scale and halo.
        LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(20.dp),
            contentPadding = PaddingValues(horizontal = Gutter, vertical = 14.dp), content = content)
    }
}

/** Landscape art with the remaining time, for picking up where a viewer left off. */
@Composable
private fun ContinueCard(item: ContinueItem, api: AuroraClient?, focusKey: String, focusedKey: String?,
                         onFocused: (String) -> Unit, onClick: () -> Unit) {
    val requester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(focusKey) { if (focusKey == focusedKey) requester.requestFocus() }
    val remaining = ((item.durationMs - item.positionMs) / 60_000).coerceAtLeast(1)
    val episode = if (item.season != null && item.episode != null) "S${item.season} · E${item.episode}" else null
    Card(onClick, Modifier.width(272.dp).focusRequester(requester).onFocusChanged { focused = it.isFocused; if (it.isFocused) onFocused(focusKey) },
        shape = CardDefaults.shape(CardShape), scale = CardDefaults.scale(focusedScale = 1.05f),
        border = CardDefaults.border(focusedBorder = Border.None), glow = CardDefaults.glow(),
        colors = CardDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).focusRing(focused, CardShape).clip(CardShape)) {
            AuroraArtwork(api?.image(item.backdropPath.ifBlank { item.posterPath }, "w780"), Modifier.fillMaxSize(), fallback = item.title)
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(.55f to Color.Transparent, 1f to Color.Black.copy(alpha = .8f))))
            if (item.durationMs > 0) WatchProgress(Progress(item.positionMs, item.durationMs),
                Modifier.align(Alignment.BottomCenter).padding(horizontal = 12.dp, vertical = 10.dp))
        }
        Text(item.title, Modifier.padding(top = 10.dp, start = 2.dp), maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontSize = 15.sp, fontWeight = if (focused) FontWeight.SemiBold else FontWeight.Medium,
            color = if (focused) Color.White else Color.White.copy(alpha = .88f))
        if (item.durationMs > 0) Text(listOfNotNull(episode, "$remaining min left").joinToString("  ·  "),
            Modifier.padding(top = 2.dp, start = 2.dp), color = AuroraColors.Muted, fontSize = 12.sp, maxLines = 1)
    }
}

/** Poster card. Its title sits inside the card so the focused node carries the title for the remote and TalkBack. */
@Composable
internal fun MediaCard(media: Media, api: AuroraClient?, focusKey: String, focusedKey: String?, onFocused: (String) -> Unit,
                       width: Dp? = 140.dp, onClick: () -> Unit) {
    val requester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(focusKey) { if (focusKey == focusedKey) requester.requestFocus() }
    Card(onClick, Modifier.focusRequester(requester).onFocusChanged { focused = it.isFocused; if (it.isFocused) onFocused(focusKey) }
        .then(if (width != null) Modifier.width(width) else Modifier.fillMaxWidth()),
        shape = CardDefaults.shape(CardShape), scale = CardDefaults.scale(focusedScale = 1.06f),
        border = CardDefaults.border(focusedBorder = Border.None), glow = CardDefaults.glow(),
        colors = CardDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent)) {
        Box(Modifier.fillMaxWidth().aspectRatio(2f / 3f).focusRing(focused, CardShape).clip(CardShape)) {
            AuroraArtwork(api?.image(media.posterPath), Modifier.fillMaxSize(), fallback = media.title)
            WatchProgress(media.userProgress, Modifier.align(Alignment.BottomCenter).padding(horizontal = 10.dp, vertical = 9.dp))
        }
        Text(media.title, Modifier.padding(top = 10.dp, start = 2.dp, end = 2.dp), maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontSize = 14.sp, fontWeight = if (focused) FontWeight.SemiBold else FontWeight.Medium,
            color = if (focused) Color.White else Color.White.copy(alpha = .86f))
        val caption = listOfNotNull(media.year?.toString(), media.contentRating.takeIf { it.isNotBlank() }).joinToString("  ·  ")
        if (caption.isNotEmpty()) Text(caption, Modifier.padding(top = 2.dp, start = 2.dp), color = AuroraColors.Muted, fontSize = 12.sp, maxLines = 1)
    }
}

@Composable
private fun MediaGrid(media: List<Media>, api: AuroraClient?, onMedia: (Media) -> Unit,
                      prefix: String, focusedKey: String?, onFocused: (String) -> Unit, footer: (@Composable () -> Unit)? = null) {
    val scroll = rememberLazyGridState()
    LazyVerticalGrid(GridCells.Adaptive(128.dp), Modifier.fillMaxSize().focusRestorer(), state = scroll,
        contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 12.dp, bottom = 36.dp),
        horizontalArrangement = Arrangement.spacedBy(22.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
        items(media.distinctBy { it.id }, key = { it.id }) { item ->
            MediaCard(item, api, "$prefix." + item.id, focusedKey, onFocused, width = null) { onMedia(item) }
        }
        if (footer != null) item(span = { GridItemSpan(maxLineSpan) }) { footer() }
    }
}

/** Page heading for the catalog screens, below the shared top bar. */
@Composable
private fun PageHeader(title: String, detail: String, actions: @Composable RowScope.() -> Unit = {}) {
    Row(Modifier.fillMaxWidth().padding(start = Gutter, end = Gutter, top = TopBar + 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        AuroraTitle(title, size = 36)
        if (detail.isNotBlank()) Text(detail, Modifier.padding(start = 4.dp, top = 8.dp), fontSize = 14.sp, color = AuroraColors.Muted)
        Spacer(Modifier.weight(1f))
        actions()
    }
}

@Composable
private fun BrowseScreen(state: TvState, api: AuroraClient?, vm: TvViewModel) {
    var picker by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        PageHeader(if (state.page == Page.MOVIES) "Movies" else "TV shows",
            if (state.browseTotal > 0) "${state.items.size} of ${state.browseTotal}" else "${state.items.size} titles") {
            TvAction("Sort: " + sortName(state.browseSort), { picker = "sort" }, enabled = !state.busy, icon = AuroraIcons.Sort)
            TvAction("Genre: " + state.browseGenre.ifBlank { "All" }, { picker = "genre" }, enabled = !state.busy, icon = AuroraIcons.Filter)
        }
        MediaGrid(state.items, api, vm::detail, state.page.name, vm.focusedMediaKey, { vm.focusedMediaKey = it }) {
            when {
                state.busy -> Text("Loading titles…", color = AuroraColors.Muted)
                state.items.isEmpty() -> Text("No titles match these filters.", color = AuroraColors.Muted)
                state.browsePage < state.browsePages -> Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TvAction("Load more titles", vm::loadMore, primary = true)
                }
                else -> Text("You're all caught up.", color = AuroraColors.Muted, fontSize = 13.sp)
            }
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
        Column(Modifier.width(480.dp).heightIn(max = 400.dp).background(AuroraColors.Surface, RoundedCornerShape(24.dp))
            .border(1.dp, AuroraColors.GlassBorder, RoundedCornerShape(24.dp)).padding(26.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AuroraTitle(title, size = 24)
            LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(vertical = 12.dp, horizontal = 18.dp)) {
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
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PageHeader("Find your next watch", "")
        Row(Modifier.padding(horizontal = Gutter), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(query, { vm.search(it) }, label = { androidx.compose.material3.Text("Search movies and TV shows") },
                singleLine = true, modifier = Modifier.weight(1f), shape = RoundedCornerShape(percent = 50), colors = auroraFieldColors(),
                leadingIcon = { Icon(AuroraIcons.Search, null, Modifier.size(20.dp), tint = AuroraColors.Muted) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { vm.search(query, immediate = true) }))
            TvAction("Search", { vm.search(query, immediate = true) }, enabled = query.isNotBlank(), primary = true, icon = AuroraIcons.Search)
            if (voiceAvailable) TvAction("Voice search", {
                voiceMessage = null
                try { voiceSearch.launch(voiceIntent) }
                catch (_: ActivityNotFoundException) { voiceMessage = "Voice search is unavailable. Use the search field." }
            }, icon = AuroraIcons.Mic)
        }
        voiceMessage?.let { Text(it, Modifier.padding(horizontal = Gutter), color = AuroraColors.Muted, fontSize = 13.sp) }
        Row(Modifier.padding(horizontal = Gutter), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            listOf("all" to "All", "movie" to "Movies", "show" to "TV shows").forEach { (kind, label) ->
                TvAction(label, { vm.searchKind(kind) }, selected = state.searchKind == kind)
            }
            val count = results.size
            Text(if (state.busy) "Searching…" else if (query.isBlank()) "Search your Aurora library" else "$count results",
                Modifier.padding(start = 8.dp), fontSize = 14.sp, color = AuroraColors.Muted)
        }
        MediaGrid(results, api, vm::detail,
            "SEARCH", vm.focusedMediaKey, { vm.focusedMediaKey = it }) {
            if (!state.busy && results.isEmpty()) Text(if (query.isBlank()) "Type a title or genre to start."
                else "No titles found. Try another search.", color = AuroraColors.Muted)
        }
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
    LaunchedEffect(state.busy) {
        if (restoreFocus && detailFocusKey == "episode-play" && file != null && !state.busy) {
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
    val scrolled by remember { derivedStateOf { scroll.firstVisibleItemIndex > 0 || scroll.firstVisibleItemScrollOffset > 48 } }
    val rating = media.rating?.takeIf { it > 0 }
    Box(Modifier.fillMaxSize()) {
      AuroraBackdrop(api?.image(media.backdropPath.ifBlank { media.posterPath }, "w1280"), dimmed = scrolled)
      CompositionLocalProvider(LocalBringIntoViewSpec provides rememberHeroScrollSpec()) {
        // Item order is load-bearing: episode selection scrolls to the version section by index.
        LazyColumn(Modifier.fillMaxSize().padding(top = TopBar), state = scroll,
            contentPadding = PaddingValues(bottom = 36.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
          item {
            Row(Modifier.fillMaxWidth().heightIn(min = if (media.isShow) 0.dp else 330.dp).padding(horizontal = Gutter, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                // A series keeps its poster smaller so the episode row starts above the fold.
                AuroraArtwork(api?.image(media.posterPath), Modifier.width(if (media.isShow) 140.dp else 176.dp).aspectRatio(2f / 3f)
                    .border(1.dp, AuroraColors.GlassBorder, CardShape).clip(CardShape), fallback = media.title)
                Column(Modifier.widthIn(max = 600.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
                    AuroraEyebrow(if (media.isShow) "SERIES" else "MOVIE")
                    AuroraTitle(media.title, size = 44)
                    MetaLine(listOf(media.year?.toString().orEmpty(), runtimeLabel(media.runtimeMinutes),
                        media.genres.take(2).joinToString(" · ")),
                        badges = listOfNotNull(media.contentRating.takeIf { it.isNotBlank() }) +
                            (if (media.isShow) emptyList() else file?.let(::sourceBadges).orEmpty()),
                        leading = if (rating != null) { { RatingLabel(rating) } } else null)
                    Text(media.overview, maxLines = 3, overflow = TextOverflow.Ellipsis, color = Color.White.copy(alpha = .8f),
                        fontSize = 15.sp, lineHeight = 22.sp)
                    // Padding leaves room for the focus scale and halo; the offset keeps buttons aligned with the text.
                    LazyRow(Modifier.offset(x = (-16).dp), horizontalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp)) {
                        if (file != null) item {
                            TvAction(if (media.isShow) "Play / Resume episode" else "Play / Resume", { vm.play(file) }, restoreModifier("play", initial = true),
                                enabled = !state.busy, primary = true, icon = AuroraIcons.Play)
                        } else if (media.isShow && state.suggestedEpisode != null) item {
                            TvAction("Continue series", vm::continueSeries, restoreModifier("continue", initial = true), enabled = !state.busy,
                                primary = true, icon = AuroraIcons.Play)
                        }
                        if (file != null) item { TvAction("Start over", { vm.play(file, restart = true) }, restoreModifier("start"),
                            enabled = !state.busy, icon = AuroraIcons.Restart) }
                        item { TvAction("Back", vm::back, restoreModifier("back", initial = file == null && state.suggestedEpisode == null),
                            icon = AuroraIcons.Back) }
                    }
                }
            }
          }
          if (media.isShow) {
            state.suggestedEpisode?.let { next -> item {
                Row(Modifier.padding(horizontal = Gutter), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.size(8.dp).background(AuroraColors.Cyan, CircleShape))
                    Text("Up next · " + episodeName(next, episodeSeason(next, state.seasons)), color = AuroraColors.Focus,
                        fontSize = 16.sp, fontWeight = FontWeight.Medium)
                }
            } }
            item {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(horizontal = Gutter, vertical = 12.dp)) {
                    items(state.seasons, key = { it.number }) { season ->
                        TvAction(if (season.number == 0) "Specials" else "Season ${season.number}", { vm.season(season.number) },
                            restoreModifier("season.${season.number}"),
                            enabled = !state.busy, selected = state.season == season.number)
                    }
                }
            }
            item {
                LazyRow(Modifier.focusRestorer(), horizontalArrangement = Arrangement.spacedBy(20.dp),
                    contentPadding = PaddingValues(horizontal = Gutter, vertical = 14.dp)) {
                    items(state.episodes, key = { it.id }) { episode ->
                        EpisodeCard(episode, state.season, episode.id == state.episode?.id, api,
                            restoreModifier("episode.${episode.id}")) { if (!state.busy) { pendingEpisodeFocus = episode.id; vm.episode(episode) } }
                    }
                }
            }
          }
          item {
            Column(Modifier.padding(horizontal = Gutter), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                state.episode?.let { AuroraTitle(episodeName(it, state.season), size = 24) }
                file?.let {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Source · " + sourceLabel(it), color = AuroraColors.Muted, fontSize = 14.sp)
                        if (media.isShow) sourceBadges(it).forEach { badge -> AuroraBadge(badge, emphasis = true) }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (state.files.size > 1) TvAction("Choose version", { showVersions = true }, restoreModifier("versions"), icon = AuroraIcons.Versions)
                        if (media.isShow) {
                            TvAction("Play / Resume", { vm.play(it) }, Modifier.focusRequester(episodePlayFocus)
                                .onFocusChanged { if (it.isFocused) detailFocusKey = "episode-play" }, enabled = !state.busy, primary = true,
                                icon = AuroraIcons.Play)
                            TvAction("Start over", { vm.play(it, restart = true) }, restoreModifier("episode-start"), enabled = !state.busy,
                                icon = AuroraIcons.Restart)
                        }
                    }
                }
                if (!state.busy && file == null && (!media.isShow || state.episode != null))
                    Text("No playable version is available yet.", color = AuroraColors.Muted)
            }
          }
        }
      }
    }
    if (showVersions) ChoiceDialog("Choose a version", state.files.map { it.id.toString() to sourceLabel(it) },
        file?.id?.toString(), { versionId = it.toLong(); showVersions = false }, { showVersions = false })
}

@Composable
private fun RatingLabel(rating: Double) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Text("★", color = AuroraColors.Star, fontSize = 14.sp)
        Text("%.1f".format(rating), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun EpisodeCard(episode: Episode, season: Int?, selected: Boolean, api: AuroraClient?, modifier: Modifier, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val watched = episode.progress?.completed == true
    Card(onClick, modifier.width(256.dp).onFocusChanged { focused = it.isFocused },
        shape = CardDefaults.shape(CardShape), scale = CardDefaults.scale(focusedScale = 1.05f),
        border = CardDefaults.border(focusedBorder = Border.None), glow = CardDefaults.glow(),
        colors = CardDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent)) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).focusRing(focused, CardShape)
            .then(if (selected && !focused) Modifier.border(1.5.dp, Color.White.copy(alpha = .6f), CardShape) else Modifier).clip(CardShape)) {
            AuroraArtwork(api?.image(episode.stillPath, "w500"), Modifier.fillMaxSize(), fallback = episode.title.takeIf { it.isNotBlank() })
            Text("E${episode.number}", Modifier.align(Alignment.TopStart).padding(10.dp).clearAndSetSemantics {}
                .background(Color.Black.copy(alpha = .6f), RoundedCornerShape(6.dp)).padding(horizontal = 7.dp, vertical = 2.dp),
                fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
            if (watched) Box(Modifier.align(Alignment.TopEnd).padding(10.dp).size(24.dp)
                .background(AuroraColors.Primary, CircleShape), contentAlignment = Alignment.Center) {
                Icon(AuroraIcons.Check, null, Modifier.size(15.dp))
            }
            if (!watched) WatchProgress(episode.progress, Modifier.align(Alignment.BottomCenter).padding(horizontal = 10.dp, vertical = 9.dp))
        }
        Text(episodeName(episode, season), Modifier.padding(top = 10.dp, start = 2.dp), fontFamily = AuroraHeading,
            fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (selected) AuroraColors.Focus else Color.White)
        Text(listOfNotNull(episode.runtimeMinutes.takeIf { it > 0 }?.let { "$it min" }, if (watched) "Watched" else null)
            .joinToString(" · ").ifBlank { "Episode ${episode.number}" }, Modifier.padding(top = 2.dp, start = 2.dp),
            color = AuroraColors.Muted, fontSize = 12.sp)
        Text(episode.overview.ifBlank { "Select this episode to choose a version and play." }, Modifier.padding(top = 4.dp, start = 2.dp)
            .height(36.dp), maxLines = 2, overflow = TextOverflow.Ellipsis, color = AuroraColors.Muted, fontSize = 12.sp, lineHeight = 17.sp)
    }
}

internal fun episodeName(episode: Episode, season: Int?): String =
    (if (season != null) "S$season · E${episode.number}" else "Episode ${episode.number}") +
        episode.title.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
