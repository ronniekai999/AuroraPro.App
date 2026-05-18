package io.aurora.tv.feature.search

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.aurora.tv.core.ui.media.MediaItem
import io.aurora.tv.feature.search.data.SearchStubData
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update

/**
 * Search-screen ViewModel.
 *
 * Phase 0 filters an in-memory corpus (`SearchStubData.ITEMS`). The query
 * is held in a StateFlow<String> so the keyboard can append/backspace/clear
 * by mutating it directly; `results` is derived via `map { … }.stateIn(...)`.
 *
 * P1 will swap this for a server-side search; at that point `results`
 * becomes the API client's Flow and the `corpus` constant disappears
 * entirely. The `combine(_query, _corpus)` dance the original phase-0
 * implementation used was overkill since the corpus never re-emits —
 * dropped in favor of a straight map.
 *
 * Match logic: case-insensitive substring against title, any genre, or
 * the year. The year branch is ASCII digits, so we just use plain
 * `contains(needle)` there; the title/genre branches use
 * `contains(needle, ignoreCase = true)` and rely on Kotlin's matcher
 * to do locale-correct case folding. We deliberately do NOT call
 * `needle.lowercase()` first — in Turkish locale, `"I".lowercase()`
 * collapses to `"ı"` (dotless i), which then doesn't fold back to ASCII
 * `i` under `ignoreCase = true`. Letting the matcher handle casing keeps
 * search behavior locale-correct.
 *
 * Empty query returns the full corpus so the empty state is the "browse
 * the index" surface, not a black void.
 */
@HiltViewModel
class SearchViewModel @Inject constructor() : ViewModel() {

    private val _query = MutableStateFlow("")
    val query: StateFlow<String> = _query.asStateFlow()

    private val corpus: List<MediaItem> = SearchStubData.ITEMS

    val results: StateFlow<List<MediaItem>> = _query
        .map { q -> filterCorpus(q) }
        .stateIn(
            scope        = viewModelScope,
            started      = SharingStarted.WhileSubscribed(5_000),
            initialValue = corpus,
        )

    fun appendChar(c: Char) {
        _query.update { it + c }
    }

    fun backspace() {
        _query.update { current -> if (current.isNotEmpty()) current.dropLast(1) else current }
    }

    fun clear() {
        _query.value = ""
    }

    private fun filterCorpus(query: String): List<MediaItem> {
        val needle = query.trim()
        if (needle.isEmpty()) return corpus
        return corpus.filter { item ->
            item.title.contains(needle, ignoreCase = true) ||
                item.genres.any { it.contains(needle, ignoreCase = true) } ||
                item.year.toString().contains(needle)
        }
    }
}
