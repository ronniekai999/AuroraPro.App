package io.aurora.tv.navigation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import io.aurora.tv.core.auth.ui.SignInScreen
import io.aurora.tv.core.ui.NavTab
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.feature.detail.DetailScreen
import io.aurora.tv.feature.account.AccountScreen
import io.aurora.tv.feature.home.HomeScreen
import io.aurora.tv.feature.movies.MoviesScreen
import io.aurora.tv.feature.profiles.WhosWatchingScreen
import io.aurora.tv.feature.search.SearchScreen
import io.aurora.tv.feature.settings.SettingsScreen
import io.aurora.tv.feature.shows.ShowsScreen
import io.aurora.tv.feature.watchparty.WatchPartyScreen

/**
 * Central nav graph: SignIn → Profiles → Home → (Movies | Detail).
 *
 * Nav philosophy: no inter-feature references. Each feature exports a top-
 * level Composable that takes callbacks; this host wires them to routes.
 * Features stay independently testable, and adding a new screen is just
 * another `composable<Route.X>` block here.
 *
 * === SHARED ROUTING HELPERS ===
 * Two callbacks defined once and reused across screens:
 *
 *   `navigateToDetail` — every screen with a poster-clickable item passes
 *   this through. Encodes the focal MediaItem as JSON for the nav arg.
 *
 *   `onTabSelected` — every screen with a TopNavBar passes this through.
 *   Routes Home / Movies / Shows to their destinations, no-ops the rest
 *   (My Library, Requests) until their screens exist. Single source of
 *   routing logic so adding a destination is a one-line change here,
 *   not a ripple across every screen that has the bar.
 *
 *   `navigateToSearch` — Search isn't a tab; it's a dedicated overlay
 *   destination triggered by a magnifying-glass icon. The icon entry
 *   point ships with Slice F; the routing helper is here pre-emptively
 *   so the wire-up at that time is a one-line callback pass-through.
 *
 * Routing for the Home tab uses `popUpTo(Route.Home, inclusive = false)`
 * rather than `navigate(Route.Home)` so deeper navigations (Detail or
 * future Movies → Detail chains) collapse cleanly back to the existing
 * Home entry rather than stacking new copies of it.
 */
@Composable
fun AuroraNavHost(modifier: Modifier = Modifier) {
    val navController = rememberNavController()

    // Detail navigation extracts the server-side numeric id from the UI's
    // string id (formatted "aurora-${serverId}" by MediaItemMapper). The
    // detail screen then re-fetches fresh data from /api/media/{id} on
    // entry — no nav-arg JSON snapshot to go stale.
    //
    // If the id can't be parsed (e.g., legacy stub items with a non-
    // numeric suffix) we silently no-op rather than crash. In practice
    // every real server-sourced MediaItem produces a parseable Long here.
    val navigateToDetail: (MediaItem) -> Unit = { item ->
        val numericId = item.id.removePrefix("aurora-").toLongOrNull()
        if (numericId != null) {
            navController.navigate(Route.Detail(id = numericId))
        }
    }

    // Search has no tab in the bar — it's reached from a dedicated
    // affordance (the magnifying-glass icon in the right cluster).
    val navigateToSearch: () -> Unit = {
        navController.navigate(Route.Search) { launchSingleTop = true }
    }

    // Three more right-cluster overlay destinations. Same pattern as
    // Search — each is reached from a TopNavBar icon (Groups, Settings,
    // Profile). Phase 0 placeholders; the full screens will swap in
    // without affecting the routing layer.
    val navigateToWatchParty: () -> Unit = {
        navController.navigate(Route.WatchParty) { launchSingleTop = true }
    }
    val navigateToSettings: () -> Unit = {
        navController.navigate(Route.Settings) { launchSingleTop = true }
    }
    val navigateToAccount: () -> Unit = {
        navController.navigate(Route.Account) { launchSingleTop = true }
    }

    val onTabSelected: (NavTab) -> Unit = { tab ->
        when (tab) {
            NavTab.Home -> {
                // Pop back to existing Home rather than stack a new instance.
                // If we're already on Home, popBackStack(Home, inclusive=false)
                // is a no-op; if we're elsewhere, it collapses the back stack
                // down to Home.
                navController.popBackStack(Route.Home, inclusive = false)
            }
            NavTab.Movies -> {
                navController.navigate(Route.Movies) {
                    // Don't stack multiple Movies entries when the user
                    // clicks the tab repeatedly.
                    launchSingleTop = true
                }
            }
            NavTab.Shows -> {
                navController.navigate(Route.Shows) {
                    launchSingleTop = true
                }
            }
            // MyLibrary and Requests still no-op until their
            // destinations exist. Adding one is a single new branch here.
            else -> Unit
        }
    }

    NavHost(
        navController    = navController,
        startDestination = Route.SignIn,
        modifier         = modifier,
    ) {
        composable<Route.SignIn> {
            SignInScreen(
                onSignedIn = {
                    navController.navigate(Route.Profiles) {
                        popUpTo(Route.SignIn) { inclusive = true }
                    }
                },
            )
        }

        composable<Route.Profiles> {
            WhosWatchingScreen(
                onProfilePicked = { navController.navigate(Route.Home) },
            )
        }

        composable<Route.Home> {
            HomeScreen(
                onItemClick   = navigateToDetail,
                onTabSelected = onTabSelected,
                onSearch      = navigateToSearch,
                onWatchParty  = navigateToWatchParty,
                onSettings    = navigateToSettings,
                onAccount     = navigateToAccount,
            )
        }

        composable<Route.Movies> {
            MoviesScreen(
                onItemClick   = navigateToDetail,
                onTabSelected = onTabSelected,
                onSearch      = navigateToSearch,
                onWatchParty  = navigateToWatchParty,
                onSettings    = navigateToSettings,
                onAccount     = navigateToAccount,
            )
        }

        composable<Route.Shows> {
            ShowsScreen(
                onItemClick   = navigateToDetail,
                onTabSelected = onTabSelected,
                onSearch      = navigateToSearch,
                onWatchParty  = navigateToWatchParty,
                onSettings    = navigateToSettings,
                onAccount     = navigateToAccount,
            )
        }

        composable<Route.Search> {
            SearchScreen(
                onItemClick = navigateToDetail,
                onBack      = { navController.popBackStack() },
            )
        }

        composable<Route.WatchParty> {
            WatchPartyScreen(
                onBack = { navController.popBackStack() },
            )
        }

        composable<Route.Settings> {
            SettingsScreen(
                onBack = { navController.popBackStack() },
            )
        }

        composable<Route.Account> {
            AccountScreen(
                onBack    = { navController.popBackStack() },
                // Sign out unwinds the entire back stack to SignIn. P1
                // wires real auth-token clearing; for now the
                // user-experience contract is "I clicked sign-out, I'm
                // back at the sign-in screen."
                onSignOut = {
                    navController.navigate(Route.SignIn) {
                        popUpTo(navController.graph.id) { inclusive = true }
                    }
                },
            )
        }

        composable<Route.Detail> { entry ->
            val route: Route.Detail = entry.toRoute()
            DetailScreen(
                mediaId       = route.id,
                onItemClick   = navigateToDetail,
                onTabSelected = onTabSelected,
                onSearch      = navigateToSearch,
                onWatchParty  = navigateToWatchParty,
                onSettings    = navigateToSettings,
                onAccount     = navigateToAccount,
            )
        }
    }
}
