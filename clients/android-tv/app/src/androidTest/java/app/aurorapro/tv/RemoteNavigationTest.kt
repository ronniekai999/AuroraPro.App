package app.aurorapro.tv

import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import app.aurorapro.tv.data.Media
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/** Real key events exercise TV focus traversal and activation without a server or touch input. */
@OptIn(ExperimentalTestApi::class)
class RemoteNavigationTest {
    @get:Rule val compose = createComposeRule()
    @Test fun dpadMovesFocusAndSelectActivatesExactlyOnce() {
        var selections = 0
        compose.setContent { AuroraTheme { Row {
            TvAction("Home", {})
            TvAction("Movies", { selections++ })
            TvAction("Unavailable", {}, enabled = false)
        } } }
        compose.onNodeWithText("Home").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Home").performKeyInput { pressKey(Key.DirectionRight) }
        compose.onNodeWithText("Movies").assertIsFocused().performKeyInput { pressKey(Key.DirectionCenter) }
        compose.runOnIdle { assertEquals(1, selections) }
        compose.onNodeWithText("Unavailable").assertIsNotEnabled()
    }

    @Test fun returningFromDetailsRestoresTheSelectedTitle() {
        var focusedKey: String? = null
        compose.setContent {
            var detail by remember { mutableStateOf(false) }
            val screens = rememberSaveableStateHolder()
            AuroraTheme { screens.SaveableStateProvider(if (detail) "detail" else "home") {
                if (detail) TvAction("Back", { detail = false })
                else Row {
                    for (id in 1L..2L) {
                        MediaCard(Media(id, "Movie $id"), null, "recent.$id", focusedKey, { focusedKey = it }) { detail = true }
                    }
                }
            } }
        }
        compose.onNodeWithText("Movie 2").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Movie 2").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.onNodeWithText("Back").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithText("Back").performKeyInput { pressKey(Key.DirectionCenter) }
        compose.onNodeWithText("Movie 2").assertIsFocused()
    }
}
